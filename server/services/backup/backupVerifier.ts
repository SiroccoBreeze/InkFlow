import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getStorageDir } from '../../db/sqlite';
import { CURRENT_SCHEMA_VERSION, getUserVersion } from '../../db/migrations';
import { calculateContentHash, parseFrontmatter } from '../documentService';
import { readBackupManifest } from './backupManifest';
import {
  REQUIRED_TABLES,
  computeDocumentAssetReferences,
  expectedManagedFilePaths,
  loadDatabaseBackupState,
  type DatabaseBackupState,
} from './backupValidation';
import {
  BACKUP_DATABASE_RELATIVE_PATH,
  BACKUP_MANIFEST_FILE_NAME,
  BackupError,
  isBackupSnapshotId,
  type BackupManifest,
  type SnapshotMode,
} from './types';

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export type BackupVerificationKind = 'staging' | 'published';

export interface BackupVerificationIssue {
  code: string;
  path?: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  details?: Record<string, unknown>;
}

export interface BackupVerificationCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface BackupVerificationReport {
  ok: boolean;
  kind: BackupVerificationKind;
  backupId: string;
  directory: string;
  verifiedAt: string;
  manifest: BackupManifest;
  formatVersion: number;
  schemaVersion: number;
  snapshotMode: SnapshotMode;
  counts: {
    documents: number;
    revisions: number;
    assets: number;
    files: number;
    totalFileBytes: number;
    databaseBytes: number;
  };
  checks: BackupVerificationCheck[];
  issues: BackupVerificationIssue[];
  warnings: BackupVerificationIssue[];
  /** Whether this build's migration chain can open the snapshot schema. */
  restorableWithThisBuild: boolean;
  /** The verifier never writes to the snapshot, the manifest or production. */
  readOnly: true;
}

export interface BackupVerificationOptions {
  kind?: BackupVerificationKind;
  /** Required for staging verification; must match the staging directory name. */
  expectedId?: string;
  maxEntries?: number;
  maxManifestBytes?: number;
  /**
   * Test/diagnostic hook used to prove that verification does not hold the
   * consistency gate while it hashes files. Production callers never set it.
   */
  testHooks?: {
    beforeHashing?: () => Promise<void>;
    /** Runs after a document/revision read+hash and before semantic parsing. */
    afterFileRead?: (relativePath: string) => Promise<void>;
  };
}

interface LayoutInspection {
  files: Map<string, number>;
  directories: Set<string>;
  issues: BackupVerificationIssue[];
  entryCount: number;
}

interface HashedFile {
  sha256: string;
  size: number;
}

function isSafeId(value: string): boolean {
  return (
    SAFE_ID_RE.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('.')
  );
}

/**
 * Parses a snapshot-relative path into its managed role.
 *
 * The manifest parser already enforces the allowed roots and rejects hidden
 * segments; this adds the exact `documents/<id>/index.md`,
 * `revisions/<doc>/<revision>.md` and `assets/<file>` shape, so a tampered
 * manifest cannot smuggle an arbitrary nested path into a backup.
 */
export function parseManagedSnapshotPath(relativePath: string):
  | { kind: 'database' }
  | { kind: 'document'; documentId: string }
  | { kind: 'revision'; documentId: string; revisionId: string }
  | { kind: 'asset'; fileName: string }
  | null {
  if (relativePath === BACKUP_DATABASE_RELATIVE_PATH) return { kind: 'database' };

  const segments = relativePath.split('/');
  if (segments.length !== 2 && segments.length !== 3) return null;

  if (
    segments.length === 3 &&
    segments[0] === 'documents' &&
    segments[2] === 'index.md' &&
    isSafeId(segments[1])
  ) {
    return { kind: 'document', documentId: segments[1] };
  }

  if (
    segments.length === 3 &&
    segments[0] === 'revisions' &&
    segments[2].endsWith('.md') &&
    isSafeId(segments[1])
  ) {
    const revisionId = segments[2].slice(0, -3);
    if (isSafeId(revisionId)) {
      return { kind: 'revision', documentId: segments[1], revisionId };
    }
    return null;
  }

  if (segments.length === 2 && segments[0] === 'assets' && isSafeId(segments[1])) {
    return { kind: 'asset', fileName: segments[1] };
  }

  return null;
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function decodeFrontmatterString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // buildFrontmatterBlock escapes double quotes in titles. parseFrontmatter
  // strips the surrounding quotes but does not unescape, so normalize here.
  return value.replace(/\\"/g, '"');
}

function verifyDocumentContent(params: {
  document: DatabaseBackupState['documents'][number];
  raw: string;
  actualSha256: string;
  issues: BackupVerificationIssue[];
  bodyByDocumentId: Map<string, string>;
}): boolean {
  const { document, raw, actualSha256, issues, bodyByDocumentId } = params;
  let ok = true;

  if (actualSha256 !== document.documentHash) {
    ok = false;
    issues.push({
      code: 'DOCUMENT_HASH_MISMATCH',
      path: document.canonicalPath,
      message: `文档 ${document.id} 的 document_hash 与快照内容不一致`,
      expected: document.documentHash,
      actual: actualSha256,
    });
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  bodyByDocumentId.set(document.id, body);

  const bodyHash = calculateContentHash(body);
  if (bodyHash !== document.contentHash) {
    ok = false;
    issues.push({
      code: 'DOCUMENT_CONTENT_HASH_MISMATCH',
      path: document.canonicalPath,
      message: `文档 ${document.id} 的正文哈希与数据库 content_hash 不一致`,
      expected: document.contentHash,
      actual: bodyHash,
    });
  }

  const frontmatterId = decodeFrontmatterString(frontmatter.id);
  if (frontmatterId === null) {
    ok = false;
    issues.push({
      code: 'DOCUMENT_FRONTMATTER_ID_MISSING',
      path: document.canonicalPath,
      message: `文档 ${document.id} 的 frontmatter 缺少 id`,
    });
  } else if (frontmatterId !== document.id) {
    ok = false;
    issues.push({
      code: 'DOCUMENT_FRONTMATTER_ID_MISMATCH',
      path: document.canonicalPath,
      message: `文档 ${document.id} 的 frontmatter id 不一致`,
      expected: document.id,
      actual: frontmatterId,
    });
  }

  const frontmatterContentHash = decodeFrontmatterString(frontmatter.content_hash);
  if (frontmatterContentHash === null) {
    ok = false;
    issues.push({
      code: 'DOCUMENT_FRONTMATTER_CONTENT_HASH_MISSING',
      path: document.canonicalPath,
      message: `文档 ${document.id} 的 frontmatter 缺少 content_hash`,
    });
  } else if (frontmatterContentHash !== document.contentHash) {
    ok = false;
    issues.push({
      code: 'DOCUMENT_FRONTMATTER_CONTENT_HASH_MISMATCH',
      path: document.canonicalPath,
      message: `文档 ${document.id} 的 frontmatter content_hash 与数据库不一致`,
      expected: document.contentHash,
      actual: frontmatterContentHash,
    });
  }

  // Every real document written by InkFlow has a title in frontmatter. A
  // missing/empty title is a hard failure, not a reason to skip the check.
  const frontmatterTitle = decodeFrontmatterString(frontmatter.title);
  if (frontmatterTitle === null || frontmatterTitle.trim() === '') {
    ok = false;
    issues.push({
      code: 'DOCUMENT_FRONTMATTER_TITLE_MISSING',
      path: document.canonicalPath,
      message: `文档 ${document.id} 的 frontmatter 缺少 title`,
    });
  } else if (frontmatterTitle !== document.title) {
    ok = false;
    issues.push({
      code: 'DOCUMENT_FRONTMATTER_TITLE_MISMATCH',
      path: document.canonicalPath,
      message: `文档 ${document.id} 的 frontmatter title 与数据库不一致`,
      expected: document.title,
      actual: frontmatterTitle,
    });
  }

  return ok;
}

function verifyRevisionContent(params: {
  revision: DatabaseBackupState['revisions'][number];
  raw: string;
  issues: BackupVerificationIssue[];
}): boolean {
  const { revision, raw, issues } = params;
  let ok = true;

  const { frontmatter, body } = parseFrontmatter(raw);
  const bodyHash = calculateContentHash(body);
  if (bodyHash !== revision.contentHash) {
    ok = false;
    issues.push({
      code: 'REVISION_CONTENT_HASH_MISMATCH',
      path: revision.canonicalPath,
      message: `历史版本 ${revision.id} 的正文哈希与数据库 content_hash 不一致`,
      expected: revision.contentHash,
      actual: bodyHash,
    });
  }

  const frontmatterId = decodeFrontmatterString(frontmatter.id);
  if (frontmatterId === null) {
    ok = false;
    issues.push({
      code: 'REVISION_FRONTMATTER_ID_MISSING',
      path: revision.canonicalPath,
      message: `历史版本 ${revision.id} 的 frontmatter 缺少 id`,
    });
  } else if (frontmatterId !== revision.documentId) {
    ok = false;
    issues.push({
      code: 'REVISION_FRONTMATTER_ID_MISMATCH',
      path: revision.canonicalPath,
      message: `历史版本 ${revision.id} 的 frontmatter id 与所属文档不一致`,
      expected: revision.documentId,
      actual: frontmatterId,
    });
  }

  const frontmatterContentHash = decodeFrontmatterString(frontmatter.content_hash);
  if (frontmatterContentHash === null) {
    ok = false;
    issues.push({
      code: 'REVISION_FRONTMATTER_CONTENT_HASH_MISSING',
      path: revision.canonicalPath,
      message: `历史版本 ${revision.id} 的 frontmatter 缺少 content_hash`,
    });
  } else if (frontmatterContentHash !== revision.contentHash) {
    ok = false;
    issues.push({
      code: 'REVISION_FRONTMATTER_CONTENT_HASH_MISMATCH',
      path: revision.canonicalPath,
      message: `历史版本 ${revision.id} 的 frontmatter content_hash 与数据库不一致`,
      expected: revision.contentHash,
      actual: frontmatterContentHash,
    });
  }

  // Real revision snapshots (checked against existing storage files) contain a
  // title. Missing/empty titles fail; there is no legacy exception in this format.
  const frontmatterTitle = decodeFrontmatterString(frontmatter.title);
  if (frontmatterTitle === null || frontmatterTitle.trim() === '') {
    ok = false;
    issues.push({
      code: 'REVISION_FRONTMATTER_TITLE_MISSING',
      path: revision.canonicalPath,
      message: `历史版本 ${revision.id} 的 frontmatter 缺少 title`,
    });
  } else if (frontmatterTitle !== revision.title) {
    ok = false;
    issues.push({
      code: 'REVISION_FRONTMATTER_TITLE_MISMATCH',
      path: revision.canonicalPath,
      message: `历史版本 ${revision.id} 的 frontmatter title 与数据库不一致`,
      expected: revision.title,
      actual: frontmatterTitle,
    });
  }

  return ok;
}

async function lstatRegularFile(filePath: string, label: string): Promise<fsSync.Stats> {
  let stat: fsSync.Stats;
  try {
    stat = await fs.lstat(filePath);
  } catch (err: any) {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `${label}不可访问：${err?.message || err}`,
      { path: filePath },
      { cause: err }
    );
  }
  if (stat.isSymbolicLink()) {
    throw new BackupError('BACKUP_VERIFICATION_TARGET_INVALID', `${label}是符号链接，已拒绝：${filePath}`, {
      path: filePath,
    });
  }
  return stat;
}

/**
 * Resolves and validates a snapshot directory. Only `backups/<id>` (published)
 * and `backups/.staging/<id>` (staging) are accepted; symlinks and traversal are
 * rejected before anything is read.
 */
async function resolveSnapshotDirectory(
  directory: string,
  kind: BackupVerificationKind,
  expectedId?: string
): Promise<{ directory: string; backupId: string }> {
  const backupsRoot = path.join(getStorageDir(), 'backups');
  let backupsRootReal: string;
  try {
    backupsRootReal = await fs.realpath(backupsRoot);
  } catch (err: any) {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `备份根目录不可访问：${err?.message || err}`,
      { path: backupsRoot },
      { cause: err }
    );
  }

  const requested = path.resolve(directory);
  const stat = await lstatRegularFile(requested, '验证目标');
  if (!stat.isDirectory()) {
    throw new BackupError('BACKUP_VERIFICATION_TARGET_INVALID', `验证目标不是目录：${requested}`, {
      path: requested,
    });
  }

  let realDirectory: string;
  try {
    realDirectory = await fs.realpath(requested);
  } catch (err: any) {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `无法解析验证目标真实路径：${err?.message || err}`,
      { path: requested },
      { cause: err }
    );
  }

  if (!isStrictlyInside(backupsRootReal, realDirectory)) {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `验证目标不在备份根目录内：${requested}`,
      { path: requested }
    );
  }

  const relative = path.relative(backupsRootReal, realDirectory);
  const segments = relative.split(path.sep);
  const backupId = segments[segments.length - 1];

  if (!isBackupSnapshotId(backupId)) {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `验证目标的目录名不是合法备份 ID：${backupId}`,
      { backupId }
    );
  }
  if (expectedId !== undefined && backupId !== expectedId) {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `验证目标 ID 不匹配：期望 ${expectedId}，实际 ${backupId}`,
      { expectedId, backupId }
    );
  }

  if (kind === 'staging') {
    if (segments.length !== 2 || segments[0] !== '.staging') {
      throw new BackupError(
        'BACKUP_VERIFICATION_TARGET_INVALID',
        `staging 验证目标必须位于 backups/.staging/<id>：${requested}`,
        { path: requested }
      );
    }
  } else if (segments.length !== 1 || segments[0] === '.staging') {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `已发布备份必须位于 backups/<id>（不在 .staging 中）：${requested}`,
      { path: requested }
    );
  }

  return { directory: realDirectory, backupId };
}

async function inspectLayout(
  directory: string,
  manifest: BackupManifest,
  maxEntries: number
): Promise<LayoutInspection> {
  const files = new Map<string, number>();
  const directories = new Set<string>();
  const issues: BackupVerificationIssue[] = [];
  let entryCount = 0;
  let limitReached = false;

  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch (err: any) {
      issues.push({
        code: 'DIRECTORY_UNREADABLE',
        path: relativeDir || '.',
        message: `目录不可读：${relativeDir || '.'}：${err?.message || err}`,
      });
      return;
    }

    for (const entry of entries) {
      if (limitReached) return;
      entryCount++;
      if (entryCount > maxEntries) {
        limitReached = true;
        issues.push({
          code: 'TOO_MANY_ENTRIES',
          message: `快照条目数超过上限 ${maxEntries}`,
        });
        return;
      }

      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);

      let stat: fsSync.Stats;
      try {
        stat = await fs.lstat(absolutePath);
      } catch (err: any) {
        issues.push({
          code: 'ENTRY_UNREADABLE',
          path: relativePath,
          message: `条目无法读取：${relativePath}：${err?.message || err}`,
        });
        continue;
      }

      if (stat.isSymbolicLink()) {
        issues.push({
          code: 'SYMLINK_PRESENT',
          path: relativePath,
          message: `快照中出现符号链接：${relativePath}`,
        });
        continue;
      }
      if (stat.isDirectory()) {
        directories.add(relativePath);
        // Windows junctions may not always be reported as symlinks by Dirent;
        // resolve the directory and refuse anything that escapes the snapshot.
        try {
          const realChild = await fs.realpath(absolutePath);
          if (!isStrictlyInside(directory, realChild)) {
            issues.push({
              code: 'DIRECTORY_ESCAPES_ROOT',
              path: relativePath,
              message: `快照目录解析到快照根目录之外：${relativePath}`,
            });
            continue;
          }
        } catch (err: any) {
          issues.push({
            code: 'DIRECTORY_UNREADABLE',
            path: relativePath,
            message: `目录真实路径不可解析：${relativePath}：${err?.message || err}`,
          });
          continue;
        }
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        issues.push({
          code: 'NON_REGULAR_ENTRY',
          path: relativePath,
          message: `快照中出现非普通文件（FIFO/socket/设备）：${relativePath}`,
        });
        continue;
      }

      files.set(relativePath, stat.size);
    }
  };

  await walk(directory, '');

  // Hidden files, database sidecars and structurally invalid paths are never
  // produced by the creator. Report them explicitly (the exact-set comparison
  // below would also catch them as extra files).
  for (const relativePath of files.keys()) {
    if (relativePath === BACKUP_MANIFEST_FILE_NAME) continue;
    if (relativePath.split('/').some(segment => segment.startsWith('.'))) {
      issues.push({
        code: 'HIDDEN_FILE',
        path: relativePath,
        message: `快照中出现隐藏文件/目录：${relativePath}`,
      });
    }
    const baseName = path.posix.basename(relativePath);
    if (
      relativePath.startsWith('database/') &&
      /-(wal|shm|journal)$/i.test(baseName)
    ) {
      issues.push({
        code: 'DATABASE_SIDECAR_PRESENT',
        path: relativePath,
        message: `数据库快照包含旁文件（不是自包含单文件）：${relativePath}`,
      });
    }
    if (relativePath !== BACKUP_MANIFEST_FILE_NAME) {
      const parsed = parseManagedSnapshotPath(relativePath);
      if (!parsed) {
        issues.push({
          code: 'INVALID_SNAPSHOT_PATH',
          path: relativePath,
          message: `快照路径不符合受管布局：${relativePath}`,
        });
      }
    }
  }

  // Case-insensitive conflicts would make a restore ambiguous on Windows/macOS.
  const lowerCasePaths = new Map<string, string>();
  for (const relativePath of files.keys()) {
    const key = relativePath.toLowerCase();
    const previous = lowerCasePaths.get(key);
    if (previous) {
      issues.push({
        code: 'CASE_CONFLICT',
        path: relativePath,
        message: `快照路径存在大小写冲突：${previous} 与 ${relativePath}`,
        expected: previous,
        actual: relativePath,
      });
    } else {
      lowerCasePaths.set(key, relativePath);
    }
  }

  const expectedFiles = new Map<string, number>();
  expectedFiles.set(BACKUP_MANIFEST_FILE_NAME, files.get(BACKUP_MANIFEST_FILE_NAME) ?? 0);
  expectedFiles.set(manifest.database.path, manifest.database.size);
  for (const file of manifest.files) expectedFiles.set(file.path, file.size);

  const expectedDirectories = new Set<string>();
  for (const relativePath of expectedFiles.keys()) {
    const segments = relativePath.split('/');
    for (let index = 1; index < segments.length; index++) {
      expectedDirectories.add(segments.slice(0, index).join('/'));
    }
  }

  for (const [relativePath, expectedSize] of expectedFiles.entries()) {
    const actualSize = files.get(relativePath);
    if (actualSize === undefined) {
      issues.push({
        code: 'MISSING_FILE',
        path: relativePath,
        message: `manifest 声明的文件缺失：${relativePath}`,
      });
      continue;
    }
    if (
      relativePath !== BACKUP_MANIFEST_FILE_NAME &&
      actualSize !== expectedSize
    ) {
      issues.push({
        code: 'SIZE_MISMATCH',
        path: relativePath,
        message: `文件大小与 manifest 不一致：${relativePath}`,
        expected: expectedSize,
        actual: actualSize,
      });
    }
  }

  for (const relativePath of files.keys()) {
    if (!expectedFiles.has(relativePath)) {
      issues.push({
        code: 'EXTRA_FILE',
        path: relativePath,
        message: `快照中存在 manifest 未声明的文件：${relativePath}`,
      });
    }
  }

  for (const relativePath of directories) {
    if (!expectedDirectories.has(relativePath)) {
      issues.push({
        code: 'EXTRA_DIRECTORY',
        path: relativePath,
        message: `快照中存在 manifest 未声明的目录：${relativePath}`,
      });
    }
  }

  return { files, directories, issues, entryCount };
}

interface FileReadResult {
  buffer: Buffer;
  sha256: string;
  size: number;
}

function openFlagsNoFollow(): number {
  const noFollow =
    process.platform === 'win32' || fsSync.constants.O_NOFOLLOW === undefined
      ? 0
      : fsSync.constants.O_NOFOLLOW;
  return fsSync.constants.O_RDONLY | noFollow;
}

function statChanged(before: fsSync.Stats, after: fsSync.Stats): boolean {
  return (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.ino !== after.ino
  );
}

function sameFileIdentity(expected: fsSync.Stats, actual: fsSync.Stats): boolean {
  return (
    expected.size === actual.size &&
    expected.ino === actual.ino &&
    expected.dev === actual.dev &&
    expected.mtimeMs === actual.mtimeMs
  );
}

/**
 * Hashes a file without following a final symlink. The verifier never trusts a
 * previously observed Dirent/lstat state, so O_NOFOLLOW closes the race where an
 * entry is swapped between layout inspection and hashing. On Windows O_NOFOLLOW
 * is unavailable; the final lstat→open window is a documented residual risk.
 */
async function hashFileNoFollow(filePath: string): Promise<HashedFile> {
  // Re-check immediately before opening: on Windows O_NOFOLLOW is unavailable,
  // and a swapped final entry must never be followed.
  const pre = await fs.lstat(filePath);
  if (pre.isSymbolicLink() || !pre.isFile()) {
    throw new Error('不是普通文件');
  }

  const handle = await fs.open(filePath, openFlagsNoFollow());
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(pre, before)) {
      throw new Error('文件在检查与打开之间被替换或修改');
    }
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    let bytes = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, before.size - position),
        position
      );
      if (bytesRead <= 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
      position += bytesRead;
    }
    const after = await handle.stat();
    if (bytes !== before.size || statChanged(before, after)) {
      throw new Error('文件在哈希期间发生变化');
    }
    return { sha256: hash.digest('hex'), size: before.size };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Reads a file once through a no-follow handle and computes its SHA-256 from the
 * same bytes. Document/revision semantic checks use this result, so the verified
 * hash and the parsed frontmatter/body can never come from two different reads.
 */
async function readFileNoFollow(filePath: string): Promise<FileReadResult> {
  const pre = await fs.lstat(filePath);
  if (pre.isSymbolicLink() || !pre.isFile()) {
    throw new Error('不是普通文件');
  }

  const handle = await fs.open(filePath, openFlagsNoFollow());
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(pre, before)) {
      throw new Error('文件在检查与打开之间被替换或修改');
    }
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (buffer.length !== before.size || statChanged(before, after)) {
      throw new Error('文件在读取期间发生变化');
    }
    return {
      buffer,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      size: buffer.length,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function tableKind(db: DatabaseSync, name: string): string | null {
  const row = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')")
    .get(name) as { type?: string } | undefined;
  return row?.type ?? null;
}

/**
 * Core data tables must be ordinary tables. `sqlite_master.type` reports both
 * ordinary and virtual tables as 'table', so reject `CREATE VIRTUAL TABLE` too;
 * a same-named VIEW or virtual table must never be trusted as the schema.
 */
function isRealTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')")
    .get(name) as { type?: string; sql?: string } | undefined;
  return (
    row?.type === 'table' && !/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? '')
  );
}

/** `documents_fts` is an FTS5 virtual table, not an ordinary table/view. */
function isFts5VirtualTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = ? AND type = 'table'")
    .get(name) as { sql?: string } | undefined;
  const sql = row?.sql ?? '';
  return /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql) && /\bfts5\b/i.test(sql);
}

function readSqliteHeader(filePath: string): Promise<{ valid: boolean; walMode: boolean }> {
  return fs.open(filePath, openFlagsNoFollow()).then(async handle => {
    try {
      const buffer = Buffer.alloc(100);
      const { bytesRead } = await handle.read(buffer, 0, 100, 0);
      if (bytesRead < 100) return { valid: false, walMode: false };
      const magic = buffer.subarray(0, 16).toString('binary');
      const valid = magic === 'SQLite format 3\u0000';
      // Offset 18/19: file format write/read version. 2 means WAL.
      const walMode = buffer[18] === 2 || buffer[19] === 2;
      return { valid, walMode };
    } finally {
      await handle.close().catch(() => {});
    }
  });
}

/**
 * Core read-only verifier shared by staging pre-publication checks and
 * on-demand verification of an already published backup.
 *
 * It never opens the production database and never writes to the snapshot
 * directory. `manifest.json` is re-read from disk and every declared SHA-256 is
 * recomputed from the packaged bytes.
 */
export async function verifyBackupDirectory(
  directory: string,
  options: BackupVerificationOptions = {}
): Promise<BackupVerificationReport> {
  const kind = options.kind ?? 'published';
  const maxEntries = options.maxEntries ?? 100_000;
  const maxManifestBytes = options.maxManifestBytes ?? 16 * 1024 * 1024;

  const target = await resolveSnapshotDirectory(directory, kind, options.expectedId);
  const checks: BackupVerificationCheck[] = [];
  const issues: BackupVerificationIssue[] = [];
  const warnings: BackupVerificationIssue[] = [];

  const addCheck = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  };

  if (process.platform === 'win32' || fsSync.constants.O_NOFOLLOW === undefined) {
    warnings.push({
      code: 'PLATFORM_NO_NOFOLLOW',
      message:
        '当前平台不提供 O_NOFOLLOW：验证读取在 lstat→open 之间仍存在最终组件符号链接替换窗口。' +
        '读取仍通过 fstat、读取前后状态比较及 manifest SHA-256 校验，但该竞态未被完全消除。',
    });
  }

  // 1. Manifest is re-read from disk; never reuse in-memory creation state.
  const manifestPath = path.join(target.directory, BACKUP_MANIFEST_FILE_NAME);
  const manifestStat = await lstatRegularFile(manifestPath, 'manifest.json');
  if (!manifestStat.isFile()) {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `manifest.json 不是普通文件：${manifestPath}`,
      { path: manifestPath }
    );
  }
  if (manifestStat.size > maxManifestBytes) {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `manifest.json 超过大小上限 ${maxManifestBytes} 字节`,
      { size: manifestStat.size }
    );
  }
  const manifest = await readBackupManifest(manifestPath);
  addCheck('manifest', true, `${manifest.fileCount} 个文件`);

  if (manifest.files.length > maxEntries) {
    issues.push({
      code: 'TOO_MANY_ENTRIES',
      message: `manifest 文件数量超过上限 ${maxEntries}`,
      actual: manifest.files.length,
    });
  }

  if (manifest.snapshotMode !== 'copy') {
    warnings.push({
      code: 'HARDLINK_SNAPSHOT_NOT_INDEPENDENT',
      message:
        `快照模式为 ${manifest.snapshotMode}：备份文件与生产文件共享 inode，` +
        '不是独立、不可变备份；对生产文件的原地修改会同时破坏备份。',
    });
  }

  // 2. Exact layout: no unknown files, symlinks, FIFOs, sidecars or extra dirs.
  const layout = await inspectLayout(target.directory, manifest, maxEntries);
  issues.push(...layout.issues);
  addCheck(
    'layout',
    layout.issues.length === 0,
    layout.issues.length === 0 ? `${layout.files.size} 个文件` : `${layout.issues.length} 个问题`
  );

  await options.testHooks?.beforeHashing?.();

  // 3. Recompute the database and every file hash from the packaged bytes.
  const hashed = new Map<string, HashedFile>();
  let databaseBytes = 0;
  const databaseAbsolutePath = path.join(
    target.directory,
    ...manifest.database.path.split('/')
  );
  if (layout.files.has(manifest.database.path)) {
    try {
      const actual = await hashFileNoFollow(databaseAbsolutePath);
      databaseBytes = actual.size;
      if (actual.size !== manifest.database.size) {
        issues.push({
          code: 'DATABASE_SIZE_MISMATCH',
          path: manifest.database.path,
          message: '数据库快照大小与 manifest 不一致',
          expected: manifest.database.size,
          actual: actual.size,
        });
      }
      if (actual.sha256 !== manifest.database.sha256) {
        issues.push({
          code: 'DATABASE_HASH_MISMATCH',
          path: manifest.database.path,
          message: '数据库快照 SHA-256 与 manifest 不一致',
          expected: manifest.database.sha256,
          actual: actual.sha256,
        });
      }
    } catch (err: any) {
      issues.push({
        code: 'DATABASE_HASH_FAILED',
        path: manifest.database.path,
        message: `数据库快照无法计算 SHA-256：${err?.message || err}`,
      });
    }
  }
  addCheck(
    'databaseHash',
    !issues.some(issue =>
      ['DATABASE_SIZE_MISMATCH', 'DATABASE_HASH_MISMATCH', 'DATABASE_HASH_FAILED'].includes(issue.code)
    ),
    databaseBytes > 0 ? `${databaseBytes} 字节` : undefined
  );

  // 4. Database-level checks. A WAL-mode file is rejected rather than opened:
  //    a read-only open could otherwise create a -shm file inside the backup.
  let state: DatabaseBackupState | null = null;
  let ftsRows: Array<{ document_id: string; body: string }> = [];
  if (layout.files.has(manifest.database.path)) {
    let header: { valid: boolean; walMode: boolean };
    try {
      header = await readSqliteHeader(databaseAbsolutePath);
    } catch (err: any) {
      header = { valid: false, walMode: false };
      issues.push({
        code: 'DATABASE_HEADER_UNREADABLE',
        path: manifest.database.path,
        message: `数据库快照文件头不可读：${err?.message || err}`,
      });
    }

    if (!header.valid) {
      issues.push({
        code: 'DATABASE_HEADER_INVALID',
        path: manifest.database.path,
        message: '数据库快照不是合法的 SQLite 文件',
      });
      addCheck('sqliteIntegrity', false, '文件头无效');
    } else if (header.walMode) {
      issues.push({
        code: 'DATABASE_WAL_MODE',
        path: manifest.database.path,
        message: '数据库快照仍处于 WAL 模式，不是自包含单文件；拒绝打开以避免写入旁文件',
      });
      addCheck('sqliteIntegrity', false, 'WAL 模式');
    } else {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(databaseAbsolutePath, { readOnly: true });
        db.exec('PRAGMA query_only = ON;');

        const integrityRows = db.prepare('PRAGMA integrity_check').all() as any[];
        const integrityOk =
          integrityRows.length === 1 &&
          Object.values(integrityRows[0] ?? {}).some(
            value => String(value).toLowerCase() === 'ok'
          );
        addCheck('sqliteIntegrity', integrityOk, integrityOk ? 'ok' : 'failed');
        if (!integrityOk) {
          issues.push({
            code: 'SQLITE_INTEGRITY_FAILED',
            message: '数据库快照未通过 SQLite integrity_check',
            actual: integrityRows.slice(0, 20),
          });
        }

        const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as any[];
        addCheck('foreignKeys', fkViolations.length === 0, `${fkViolations.length} 项`);
        if (fkViolations.length > 0) {
          issues.push({
            code: 'FOREIGN_KEY_VIOLATION',
            message: `数据库快照存在 ${fkViolations.length} 项外键违规`,
            actual: fkViolations.slice(0, 20),
          });
        }

        const schemaVersion = getUserVersion(db);
        const schemaOk = schemaVersion === manifest.schemaVersion;
        addCheck('schemaVersion', schemaOk, `${schemaVersion} / manifest ${manifest.schemaVersion}`);
        if (!schemaOk) {
          issues.push({
            code: 'SCHEMA_VERSION_MISMATCH',
            message: '数据库快照 Schema 版本与 manifest 不一致',
            expected: manifest.schemaVersion,
            actual: schemaVersion,
          });
        }

        const database = db;
        // Core data tables must be real tables. A same-named VIEW would pass
        // SELECT queries but is not the committed schema and must never be
        // trusted for a backup.
        const coreTables = REQUIRED_TABLES.filter(table => table !== 'documents_fts');
        const missingTables = coreTables.filter(table => tableKind(database, table) === null);
        const nonRealCore = coreTables.filter(
          table => tableKind(database, table) !== null && !isRealTable(database, table)
        );
        const coreTablesOk = missingTables.length === 0 && nonRealCore.length === 0;
        addCheck(
          'requiredTables',
          coreTablesOk,
          coreTablesOk ? 'ok' : [...missingTables, ...nonRealCore].join(', ')
        );
        if (missingTables.length > 0) {
          issues.push({
            code: 'REQUIRED_TABLE_MISSING',
            message: `数据库快照缺少表：${missingTables.join(', ')}`,
            actual: missingTables,
          });
        }
        if (nonRealCore.length > 0) {
          issues.push({
            code: 'REQUIRED_TABLE_NOT_REAL',
            message: `数据库快照的核心数据表被 VIEW/虚拟表冒充：${nonRealCore.join(', ')}`,
            actual: nonRealCore,
          });
        }

        // FTS is a separate contract: an FTS5 virtual table, not an ordinary
        // table and not a view.
        const ftsIsVirtual = isFts5VirtualTable(database, 'documents_fts');
        addCheck('ftsSchema', ftsIsVirtual, ftsIsVirtual ? 'fts5 virtual table' : 'invalid');
        if (!ftsIsVirtual) {
          issues.push({
            code: 'FTS_TABLE_INVALID',
            message: 'documents_fts 不是 FTS5 虚拟表（可能是普通表或 VIEW）',
          });
        }

        if (isRealTable(database, 'sessions')) {
          const sessionCount = Number(
            (database.prepare('SELECT COUNT(*) AS c FROM sessions').get() as any)?.c || 0
          );
          addCheck('sessionsExcluded', sessionCount === 0, `${sessionCount} 行`);
          if (sessionCount !== 0) {
            issues.push({
              code: 'SESSIONS_NOT_EXCLUDED',
              message: `数据库快照仍包含 ${sessionCount} 条 sessions 记录`,
              actual: sessionCount,
            });
          }
        } else {
          addCheck('sessionsExcluded', false, 'sessions 不是真实表');
        }

        if (isRealTable(database, 'asset_deletions')) {
          const tombstones = Number(
            (database.prepare('SELECT COUNT(*) AS c FROM asset_deletions').get() as any)?.c || 0
          );
          addCheck('assetDeletions', tombstones === 0, `${tombstones} 行`);
          if (tombstones !== 0) {
            issues.push({
              code: 'UNRESOLVED_ASSET_DELETIONS',
              message: `数据库快照中存在 ${tombstones} 条未解决的附件删除标记`,
              actual: tombstones,
            });
          }
        }

        if (isRealTable(database, 'schema_migrations')) {
          // Normal invariant (see migrations.ts):
          //   user_version = max(schema_migrations.version)
          //   and every version 1..user_version has an audit row.
          // A newer audit row than user_version is impossible in normal code and
          // is a hard issue. Missing/gapped audit rows mean the history cannot be
          // proven; they are explicit warnings, never silently ignored.
          const migrationRows = database
            .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
            .all() as Array<{ version: number }>;
          const versions = Array.from(
            new Set(
              migrationRows
                .map(row => Number(row.version))
                .filter(version => Number.isSafeInteger(version) && version > 0)
            )
          ).sort((a, b) => a - b);
          const maxVersion = versions.length > 0 ? versions[versions.length - 1] : 0;
          const expectedVersions = Array.from(
            { length: Math.max(schemaVersion, 0) },
            (_value, index) => index + 1
          );
          const missingVersions = expectedVersions.filter(version => !versions.includes(version));
          let migrationAuditOk = true;

          if (versions.length === 0) {
            migrationAuditOk = false;
            warnings.push({
              code: 'SCHEMA_MIGRATION_AUDIT_MISSING',
              message: `schema_migrations 没有任何审计记录，无法证明 user_version=${schemaVersion} 的迁移历史`,
            });
          } else {
            if (maxVersion > schemaVersion) {
              migrationAuditOk = false;
              issues.push({
                code: 'SCHEMA_MIGRATION_AUDIT_AHEAD',
                message: `schema_migrations 最大版本 ${maxVersion} 高于 user_version ${schemaVersion}`,
                expected: schemaVersion,
                actual: maxVersion,
              });
            } else if (maxVersion < schemaVersion) {
              migrationAuditOk = false;
              warnings.push({
                code: 'SCHEMA_MIGRATION_AUDIT_INCOMPLETE',
                message: `schema_migrations 最大版本 ${maxVersion} 低于 user_version ${schemaVersion}，迁移审计不完整`,
                expected: schemaVersion,
                actual: maxVersion,
              });
            }
            if (missingVersions.length > 0) {
              migrationAuditOk = false;
              warnings.push({
                code: 'SCHEMA_MIGRATION_AUDIT_GAPS',
                message: `schema_migrations 缺少版本记录：${missingVersions.join(', ')}`,
                details: { missingVersions },
              });
            }
          }
          addCheck('migrationAudit', migrationAuditOk, migrationAuditOk ? 'ok' : 'mismatch');
        }

        if (coreTablesOk) {
          state = loadDatabaseBackupState(database);
          addCheck('databaseState', true);
        } else {
          addCheck('databaseState', false, '核心数据表缺失或被 VIEW 冒充');
        }

        if (ftsIsVirtual) {
          ftsRows = database
            .prepare('SELECT document_id, body FROM documents_fts')
            .all() as Array<{ document_id: string; body: string }>;
        }
      } catch (err: any) {
        addCheck('databaseState', false, err?.message || String(err));
        issues.push({
          code: 'DATABASE_STATE_INVALID',
          message: `数据库快照无法建立可信的索引状态：${err?.message || err}`,
        });
      } finally {
        db?.close();
      }
    }
  }

  // 5. Bidirectional DB <-> packaged file correspondence.
  let documentsOk = true;
  let revisionsOk = true;
  let assetsOk = true;
  let referencesOk = true;
  let ftsOk = true;

  if (state) {
    const expectedPaths = expectedManagedFilePaths(state);
    const manifestPaths = new Set(manifest.files.map(file => file.path));
    const documentPaths = new Set(state.documents.map(document => document.canonicalPath));
    const revisionPaths = new Set(state.revisions.map(revision => revision.canonicalPath));
    const assetPaths = new Set(state.assets.map(asset => asset.canonicalPath));

    for (const relativePath of expectedPaths) {
      if (!manifestPaths.has(relativePath)) {
        issues.push({
          code: 'MISSING_FILE',
          path: relativePath,
          message: `数据库引用但 manifest 未打包的文件：${relativePath}`,
        });
        if (documentPaths.has(relativePath)) documentsOk = false;
        if (revisionPaths.has(relativePath)) revisionsOk = false;
        if (assetPaths.has(relativePath)) assetsOk = false;
      }
    }
    for (const relativePath of manifestPaths) {
      if (!expectedPaths.has(relativePath)) {
        issues.push({
          code: 'UNKNOWN_FILE',
          path: relativePath,
          message: `manifest 中存在数据库未登记的文件：${relativePath}`,
        });
      }
    }

    const manifestByPath = new Map(manifest.files.map(file => [file.path, file]));
    const documentByPath = new Map(
      state.documents.map(document => [document.canonicalPath, document])
    );
    const revisionByPath = new Map(
      state.revisions.map(revision => [revision.canonicalPath, revision])
    );
    const assetIds = new Set(state.assets.map(asset => asset.id));
    const bodyByDocumentId = new Map<string, string>();

    // One read for each document/revision: the SHA-256 and the parsed
    // frontmatter/body come from the same buffer. The manifest hash is checked
    // against that buffer before any semantic decision is made.
    let fileHashFailures = 0;
    for (const file of manifest.files) {
      const document = documentByPath.get(file.path);
      const revision = revisionByPath.get(file.path);
      if (!layout.files.has(file.path)) {
        if (document) documentsOk = false;
        if (revision) revisionsOk = false;
        if (assetPaths.has(file.path)) assetsOk = false;
        continue;
      }
      const absolutePath = path.join(target.directory, ...file.path.split('/'));

      if (document || revision) {
        let read: FileReadResult;
        try {
          read = await readFileNoFollow(absolutePath);
        } catch (err: any) {
          fileHashFailures++;
          if (document) documentsOk = false;
          if (revision) revisionsOk = false;
          issues.push({
            code: 'CONTENT_READ_FAILED',
            path: file.path,
            message: `文件无法安全读取：${file.path}：${err?.message || err}`,
          });
          continue;
        }

        hashed.set(file.path, { sha256: read.sha256, size: read.size });
        if (read.size !== file.size) {
          fileHashFailures++;
          issues.push({
            code: 'SIZE_MISMATCH',
            path: file.path,
            message: `文件大小与 manifest 不一致：${file.path}`,
            expected: file.size,
            actual: read.size,
          });
        }
        if (read.sha256 !== file.sha256) {
          fileHashFailures++;
          issues.push({
            code: 'HASH_MISMATCH',
            path: file.path,
            message: `文件 SHA-256 与 manifest 不一致：${file.path}`,
            expected: file.sha256,
            actual: read.sha256,
          });
        }

        // Parse the exact bytes whose hash was just computed above.
        await options.testHooks?.afterFileRead?.(file.path);
        const raw = read.buffer.toString('utf-8');
        if (document) {
          if (
            !verifyDocumentContent({
              document,
              raw,
              actualSha256: read.sha256,
              issues,
              bodyByDocumentId,
            })
          ) {
            documentsOk = false;
          }
        } else if (revision) {
          if (!verifyRevisionContent({ revision, raw, issues })) {
            revisionsOk = false;
          }
        }
        continue;
      }

      // Assets and any manifest path without database semantics are hashed by
      // streaming; they have no frontmatter to parse.
      try {
        const actual = await hashFileNoFollow(absolutePath);
        hashed.set(file.path, actual);
        if (actual.size !== file.size) {
          fileHashFailures++;
          issues.push({
            code: 'SIZE_MISMATCH',
            path: file.path,
            message: `文件大小与 manifest 不一致：${file.path}`,
            expected: file.size,
            actual: actual.size,
          });
        }
        if (actual.sha256 !== file.sha256) {
          fileHashFailures++;
          issues.push({
            code: 'HASH_MISMATCH',
            path: file.path,
            message: `文件 SHA-256 与 manifest 不一致：${file.path}`,
            expected: file.sha256,
            actual: actual.sha256,
          });
        }
      } catch (err: any) {
        fileHashFailures++;
        issues.push({
          code: 'HASH_FAILED',
          path: file.path,
          message: `文件无法计算 SHA-256：${file.path}：${err?.message || err}`,
        });
      }
    }
    addCheck(
      'fileHashes',
      fileHashFailures === 0 && !issues.some(issue => issue.code === 'MISSING_FILE'),
      fileHashFailures === 0 ? `${hashed.size} 个文件` : `${fileHashFailures} 个失败`
    );

    // Assets: size and the complete SHA-256 anchor. Empty checksums are never
    // silently skipped; an uncalibrated attachment blocks formal verification.
    for (const asset of state.assets) {
      const entry = manifestByPath.get(asset.canonicalPath);
      if (!entry) {
        assetsOk = false;
        continue;
      }

      if (entry.size !== asset.size) {
        assetsOk = false;
        issues.push({
          code: 'ASSET_SIZE_MISMATCH',
          path: asset.canonicalPath,
          message: `附件 ${asset.id} 的数据库大小与快照不一致`,
          expected: asset.size,
          actual: entry.size,
        });
      }

      if (!asset.checksum) {
        assetsOk = false;
        issues.push({
          code: 'ASSET_CHECKSUM_MISSING',
          path: asset.canonicalPath,
          message: `附件 ${asset.id} 缺少 SHA-256 校验和；请先运行显式校准后再备份`,
        });
        continue;
      }
      if (!SHA256_HEX_RE.test(asset.checksum)) {
        assetsOk = false;
        issues.push({
          code: 'ASSET_CHECKSUM_INVALID',
          path: asset.canonicalPath,
          message: `附件 ${asset.id} 的 checksum 不是合法 SHA-256`,
          actual: asset.checksum,
        });
        continue;
      }
      if (entry.sha256 !== asset.checksum) {
        assetsOk = false;
        issues.push({
          code: 'ASSET_CHECKSUM_MISMATCH',
          path: asset.canonicalPath,
          message: `附件 ${asset.id} 的 SHA-256 与数据库 checksum 不一致`,
          expected: asset.checksum,
          actual: entry.sha256,
        });
      }
    }

    // Markdown -> document_assets correspondence, including the rule that a
    // referenced-but-missing asset fails instead of being filtered out.
    for (const document of state.documents) {
      const body = bodyByDocumentId.get(document.id);
      if (body === undefined) {
        referencesOk = false;
        continue;
      }

      const { expected, missing } = computeDocumentAssetReferences(body, assetIds);
      if (missing.length > 0) {
        referencesOk = false;
        issues.push({
          code: 'ASSET_REFERENCE_MISSING',
          path: document.canonicalPath,
          message: `文档 ${document.id} 引用了数据库中不存在的附件：${missing.join(', ')}`,
          actual: missing,
        });
      }

      const actual = state.documentAssetIds.get(document.id) ?? new Set<string>();
      const missingRows = [...expected].filter(assetId => !actual.has(assetId)).sort();
      const extraRows = [...actual].filter(assetId => !expected.has(assetId)).sort();
      if (missingRows.length > 0 || extraRows.length > 0) {
        referencesOk = false;
        issues.push({
          code: 'DOCUMENT_ASSET_LINK_MISMATCH',
          path: document.canonicalPath,
          message: `文档 ${document.id} 的附件关联与 Markdown 不一致`,
          expected: [...expected].sort(),
          actual: [...actual].sort(),
          details: { missing: missingRows, extra: extraRows },
        });
      }
    }

    // FTS is derived data: a mismatch is reported but does not fail the backup
    // because a restore rebuilds it. The row set must still correspond to the
    // documents, otherwise the packaged database is internally inconsistent.
    if (ftsRows.length > 0 || state.documents.length > 0) {
      const ftsIds = new Set(ftsRows.map(row => String(row.document_id)));
      const documentIds = new Set(state.documents.map(document => document.id));
      const missingFts = [...documentIds].filter(id => !ftsIds.has(id)).sort();
      const extraFts = [...ftsIds].filter(id => !documentIds.has(id)).sort();
      if (ftsRows.length !== state.documents.length || missingFts.length || extraFts.length) {
        ftsOk = false;
        warnings.push({
          code: 'FTS_ROW_SET_MISMATCH',
          message: 'documents_fts 行集合与 documents 不一致（派生索引，可由恢复重建）',
          expected: state.documents.length,
          actual: ftsRows.length,
          details: { missing: missingFts, extra: extraFts },
        });
      } else {
        for (const row of ftsRows) {
          const expectedBody = bodyByDocumentId.get(String(row.document_id));
          if (expectedBody !== undefined && String(row.body).trim() !== expectedBody.trim()) {
            warnings.push({
              code: 'FTS_BODY_MISMATCH',
              path: `documents_fts/${row.document_id}`,
              message: `documents_fts 正文与 Markdown 不一致（恢复时会重建）`,
            });
          }
        }
      }
    }
  } else {
    // Database state is unusable, but the packaged file hashes must still be
    // verified against the manifest.
    let fileHashFailures = 0;
    for (const file of manifest.files) {
      if (!layout.files.has(file.path)) continue;
      const absolutePath = path.join(target.directory, ...file.path.split('/'));
      try {
        const actual = await hashFileNoFollow(absolutePath);
        hashed.set(file.path, actual);
        if (actual.size !== file.size) {
          fileHashFailures++;
          issues.push({
            code: 'SIZE_MISMATCH',
            path: file.path,
            message: `文件大小与 manifest 不一致：${file.path}`,
            expected: file.size,
            actual: actual.size,
          });
        }
        if (actual.sha256 !== file.sha256) {
          fileHashFailures++;
          issues.push({
            code: 'HASH_MISMATCH',
            path: file.path,
            message: `文件 SHA-256 与 manifest 不一致：${file.path}`,
            expected: file.sha256,
            actual: actual.sha256,
          });
        }
      } catch (err: any) {
        fileHashFailures++;
        issues.push({
          code: 'HASH_FAILED',
          path: file.path,
          message: `文件无法计算 SHA-256：${file.path}：${err?.message || err}`,
        });
      }
    }
    addCheck(
      'fileHashes',
      fileHashFailures === 0 && !issues.some(issue => issue.code === 'MISSING_FILE'),
      fileHashFailures === 0 ? `${hashed.size} 个文件` : `${fileHashFailures} 个失败`
    );

    documentsOk = false;
    revisionsOk = false;
    assetsOk = false;
    referencesOk = false;
    ftsOk = false;
  }

  addCheck('documents', documentsOk);
  addCheck('revisions', revisionsOk);
  addCheck('assets', assetsOk);
  addCheck('assetReferences', referencesOk);
  addCheck('fts', ftsOk);

  const restorableWithThisBuild = manifest.schemaVersion <= CURRENT_SCHEMA_VERSION;
  if (!restorableWithThisBuild) {
    issues.push({
      code: 'SCHEMA_TOO_NEW',
      message: `备份 Schema 版本 ${manifest.schemaVersion} 高于当前程序支持的 ${CURRENT_SCHEMA_VERSION}`,
      actual: manifest.schemaVersion,
    });
  }

  return {
    ok: issues.length === 0,
    kind,
    backupId: target.backupId,
    directory: target.directory,
    verifiedAt: new Date().toISOString(),
    manifest,
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
    snapshotMode: manifest.snapshotMode,
    counts: {
      documents: state?.documents.length ?? 0,
      revisions: state?.revisions.length ?? 0,
      assets: state?.assets.length ?? 0,
      files: manifest.fileCount,
      totalFileBytes: manifest.totalSize,
      databaseBytes,
    },
    checks,
    issues,
    warnings,
    restorableWithThisBuild,
    readOnly: true,
  };
}

/** Verifies an already published backup. Never writes to it or to production. */
export async function verifyBackupSnapshot(
  backupId: string,
  options: Omit<BackupVerificationOptions, 'kind' | 'expectedId'> = {}
): Promise<BackupVerificationReport> {
  if (!isBackupSnapshotId(backupId)) {
    throw new BackupError(
      'BACKUP_VERIFICATION_TARGET_INVALID',
      `非法的备份 ID：${JSON.stringify(backupId)}`,
      { backupId }
    );
  }
  const backupsRoot = path.join(getStorageDir(), 'backups');
  return verifyBackupDirectory(path.join(backupsRoot, backupId), {
    ...options,
    kind: 'published',
    expectedId: backupId,
  });
}

/**
 * Pre-publication check used by `createBackupSnapshot`. Re-reads the just-written
 * manifest and recomputes every hash from the staged bytes. Any issue aborts the
 * publication.
 */
export async function assertStagingSnapshotValid(
  stagingDir: string,
  backupId: string
): Promise<BackupVerificationReport> {
  const report = await verifyBackupDirectory(stagingDir, {
    kind: 'staging',
    expectedId: backupId,
  });
  if (!report.ok) {
    throw new BackupError(
      'BACKUP_VERIFICATION_FAILED',
      `发布前快照验证失败（${report.issues.length} 项）：${report.issues
        .slice(0, 5)
        .map(issue => issue.message)
        .join('；')}`,
      {
        issues: report.issues.slice(0, 50),
        warnings: report.warnings.slice(0, 50),
      }
    );
  }
  return report;
}
