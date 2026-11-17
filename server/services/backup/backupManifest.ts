import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStorageRelativePath } from '../../utils/storagePaths';
import {
  BACKUP_DATABASE_RELATIVE_PATH,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_MANIFEST_FILE_NAME,
  BackupError,
  type BackupFileEntry,
  type BackupManifest,
  type SnapshotMode,
} from './types';

const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_MODES: readonly SnapshotMode[] = ['hardlink', 'copy', 'mixed'];
const FILE_PREFIXES = ['documents/', 'revisions/', 'assets/'];
const DATABASE_PREFIX = 'database/';

/** `package.json` version of the running application, without loading it as a module. */
export function getApplicationVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const parsed = JSON.parse(fsSync.readFileSync(packagePath, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertSnapshotRelativePath(value: unknown, label: string, prefixes: string[]): string {
  if (typeof value !== 'string') {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `${label} 必须是字符串`);
  }
  const normalized = normalizeStorageRelativePath(value);
  if (!normalized || normalized !== value) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `${label} 不是安全的 POSIX 相对路径：${JSON.stringify(value)}`);
  }
  if (!prefixes.some(prefix => normalized.startsWith(prefix))) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `${label} 不在允许的快照目录中：${normalized}`);
  }
  if (path.posix.basename(normalized).startsWith('.')) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `${label} 指向隐藏文件：${normalized}`);
  }
  return normalized;
}

/**
 * Strictly validates a manifest produced by this format version. Unknown formats
 * and unknown format versions are refused so a future restore implementation can
 * never misinterpret a package it does not understand.
 */
export function validateBackupManifest(input: unknown): BackupManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'manifest 必须是 JSON 对象');
  }
  const raw = input as Record<string, unknown>;

  if (raw.format !== BACKUP_FORMAT) {
    throw new BackupError(
      'BACKUP_MANIFEST_INVALID',
      `不支持的备份格式：${JSON.stringify(raw.format)}（期望 ${BACKUP_FORMAT}）`
    );
  }
  if (raw.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      'BACKUP_MANIFEST_INVALID',
      `不支持的备份格式版本：${JSON.stringify(raw.formatVersion)}（期望 ${BACKUP_FORMAT_VERSION}）`
    );
  }
  if (typeof raw.applicationVersion !== 'string' || !raw.applicationVersion.trim()) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'applicationVersion 必须是非空字符串');
  }
  if (typeof raw.createdAt !== 'string' || !raw.createdAt) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'createdAt 必须是 ISO-8601 UTC 时间字符串');
  }
  const createdAtDate = new Date(raw.createdAt);
  if (Number.isNaN(createdAtDate.getTime()) || createdAtDate.toISOString() !== raw.createdAt) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'createdAt 必须是 ISO-8601 UTC 时间字符串');
  }
  if (!isSafeInteger(raw.schemaVersion)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'schemaVersion 必须是非负整数');
  }
  if (!isSafeInteger(raw.fileCount) || !isSafeInteger(raw.totalSize)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'fileCount/totalSize 必须是非负安全整数');
  }
  if (!SNAPSHOT_MODES.includes(raw.snapshotMode as SnapshotMode)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `无效的 snapshotMode：${JSON.stringify(raw.snapshotMode)}`);
  }
  // Format v1 guarantees that session rows were removed from the database copy.
  if (raw.sessionsExcluded !== true) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'format v1 要求 sessionsExcluded=true');
  }

  if (!raw.database || typeof raw.database !== 'object' || Array.isArray(raw.database)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'database 必须是对象');
  }
  const databaseRaw = raw.database as Record<string, unknown>;
  const databasePath = assertSnapshotRelativePath(
    databaseRaw.path,
    'database.path',
    [DATABASE_PREFIX]
  );
  if (databasePath !== BACKUP_DATABASE_RELATIVE_PATH) {
    throw new BackupError(
      'BACKUP_MANIFEST_INVALID',
      `format v1 的数据库路径必须是 ${BACKUP_DATABASE_RELATIVE_PATH}`
    );
  }
  if (!isSafeInteger(databaseRaw.size) || databaseRaw.size <= 0) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'database.size 必须是正整数');
  }
  if (typeof databaseRaw.sha256 !== 'string' || !SHA256_RE.test(databaseRaw.sha256)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'database.sha256 必须是 64 位小写十六进制 SHA-256');
  }

  if (!Array.isArray(raw.files)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'files 必须是数组');
  }
  const seen = new Set<string>();
  const seenCaseInsensitive = new Set<string>();
  let totalSize = 0;
  const files: BackupFileEntry[] = [];

  for (const [index, entry] of raw.files.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BackupError('BACKUP_MANIFEST_INVALID', `files[${index}] 必须是对象`);
    }
    const fileRaw = entry as Record<string, unknown>;
    const filePath = assertSnapshotRelativePath(fileRaw.path, `files[${index}].path`, FILE_PREFIXES);
    if (!isSafeInteger(fileRaw.size)) {
      throw new BackupError('BACKUP_MANIFEST_INVALID', `files[${index}].size 必须是非负整数`);
    }
    if (typeof fileRaw.sha256 !== 'string' || !SHA256_RE.test(fileRaw.sha256)) {
      throw new BackupError(
        'BACKUP_MANIFEST_INVALID',
        `files[${index}].sha256 必须是 64 位小写十六进制 SHA-256`
      );
    }
    if (filePath === databasePath) {
      throw new BackupError('BACKUP_MANIFEST_INVALID', `文件路径与数据库快照路径重复：${filePath}`);
    }
    if (seen.has(filePath) || seenCaseInsensitive.has(filePath.toLowerCase())) {
      throw new BackupError('BACKUP_MANIFEST_INVALID', `manifest 包含重复或大小写冲突的路径：${filePath}`);
    }
    seen.add(filePath);
    seenCaseInsensitive.add(filePath.toLowerCase());

    totalSize += fileRaw.size;
    if (!Number.isSafeInteger(totalSize)) {
      throw new BackupError('BACKUP_MANIFEST_INVALID', '文件总大小溢出安全整数范围');
    }
    files.push({ path: filePath, size: fileRaw.size, sha256: fileRaw.sha256 });
  }

  if (raw.fileCount !== files.length) {
    throw new BackupError(
      'BACKUP_MANIFEST_INVALID',
      `fileCount (${raw.fileCount}) 与 files 数量 (${files.length}) 不一致`
    );
  }
  if (raw.totalSize !== totalSize) {
    throw new BackupError(
      'BACKUP_MANIFEST_INVALID',
      `totalSize (${raw.totalSize}) 与文件大小之和 (${totalSize}) 不一致`
    );
  }

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    applicationVersion: raw.applicationVersion,
    createdAt: raw.createdAt,
    schemaVersion: raw.schemaVersion,
    database: {
      path: databasePath,
      size: databaseRaw.size,
      sha256: databaseRaw.sha256,
    },
    files,
    fileCount: files.length,
    totalSize,
    snapshotMode: raw.snapshotMode as SnapshotMode,
    sessionsExcluded: true,
  };
}

export function buildBackupManifest(input: {
  applicationVersion: string;
  createdAt: string;
  schemaVersion: number;
  database: { path: string; size: number; sha256: string };
  files: BackupFileEntry[];
  snapshotMode: SnapshotMode;
}): BackupManifest {
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    applicationVersion: input.applicationVersion,
    createdAt: input.createdAt,
    schemaVersion: input.schemaVersion,
    database: { ...input.database },
    files,
    fileCount: files.length,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    snapshotMode: input.snapshotMode,
    sessionsExcluded: true,
  };
  // Validate our own output before it can become a "successful" backup.
  return validateBackupManifest(manifest);
}

export async function writeBackupManifest(directory: string, manifest: BackupManifest): Promise<string> {
  const manifestPath = path.join(directory, BACKUP_MANIFEST_FILE_NAME);
  const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  await fs.rename(tempPath, manifestPath);
  return manifestPath;
}

export async function readBackupManifest(manifestPath: string): Promise<BackupManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `无法读取 manifest：${manifestPath}`, undefined, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'manifest 不是合法 JSON', undefined, {
      cause: err,
    });
  }
  return validateBackupManifest(parsed);
}
