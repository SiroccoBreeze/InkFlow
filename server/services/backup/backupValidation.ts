import path from 'node:path';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { normalizeStorageRelativePath } from '../../utils/storagePaths';
import { extractAssetReferences, parseFrontmatter, calculateContentHash, calculateDocumentHash } from '../documentService';
import { getUserVersion } from '../../db/migrations';
import { BackupError, type BackupFileEntry } from './types';
import type { SnapshotInventoryEntry } from './backupSnapshot';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const CONTENT_HASH_RE = /^[a-f0-9]{16}$/;
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const ASSET_FILE_NAME_RE = /^[A-Za-z0-9._-]{1,200}$/;

export const CRITICAL_TABLES = [
  'documents',
  'document_revisions',
  'assets',
  'document_assets',
  'document_tags',
] as const;

export type CriticalTable = (typeof CRITICAL_TABLES)[number];

const REQUIRED_TABLES = [
  'users',
  'sessions',
  'categories',
  'tags',
  'documents',
  'document_tags',
  'document_revisions',
  'shares',
  'assets',
  'document_assets',
  'documents_fts',
  'recovery_codes',
  'system_settings',
  'schema_migrations',
  'asset_deletions',
] as const;

export interface DatabaseBackupState {
  schemaVersion: number;
  documents: Array<{
    id: string;
    canonicalPath: string;
    /** Full-file SHA-256 commit marker. Required after pending-save recovery. */
    documentHash: string;
    /** Body-only content hash stored in the documents row and frontmatter. */
    contentHash: string;
  }>;
  revisions: Array<{
    id: string;
    documentId: string;
    canonicalPath: string;
    /** Body-only content hash stored in the revision row. */
    contentHash: string;
  }>;
  assets: Array<{ id: string; canonicalPath: string; size: number; checksum: string }>;
  documentAssetIds: Map<string, Set<string>>;
  criticalCounts: Record<CriticalTable, number>;
}

function assertSafeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value) || value.startsWith('.')) {
    throw new BackupError('BACKUP_INCONSISTENT_STATE', `${label} 不是合法的存储标识符：${JSON.stringify(value)}`);
  }
  return value;
}

function canonicalExpectedPath(raw: unknown, expectedPath: string, label: string): string {
  const normalized = normalizeStorageRelativePath(raw);
  if (!normalized || normalized !== expectedPath) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `${label} 与 Markdown SSOT 布局不一致：数据库值 ${JSON.stringify(raw)}，期望 ${expectedPath}`,
      { expected: expectedPath, actual: raw }
    );
  }
  return normalized;
}

function canonicalAssetPath(raw: unknown, assetId: string): string {
  const normalized = normalizeStorageRelativePath(raw);
  if (!normalized) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `附件 ${assetId} 的 storage_path 不是安全的相对路径：${JSON.stringify(raw)}`
    );
  }
  const segments = normalized.split('/');
  const fileName = segments[1];
  if (segments.length !== 2 || segments[0] !== 'assets' || !fileName) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `附件 ${assetId} 的 storage_path 不是受管理的 assets/<file>：${normalized}`
    );
  }
  if (fileName.startsWith('.') || !ASSET_FILE_NAME_RE.test(fileName)) {
    throw new BackupError('BACKUP_INCONSISTENT_STATE', `附件文件名不合法：${normalized}`);
  }
  const impliedId = path.posix.parse(fileName).name;
  if (impliedId !== assetId) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `附件 ${assetId} 的文件名与 ID 不匹配：${normalized}`
    );
  }
  return normalized;
}

/** Reads and validates the production DB index used to cross-check the file snapshot. */
export function loadDatabaseBackupState(db: DatabaseSync): DatabaseBackupState {
  const documentRows = db
    .prepare('SELECT id, file_path, document_hash, content_hash FROM documents')
    .all() as any[];
  const revisionRows = db
    .prepare('SELECT id, document_id, snapshot_path, content_hash FROM document_revisions')
    .all() as any[];
  const assetRows = db.prepare('SELECT id, storage_path, size, checksum FROM assets').all() as any[];
  const associationRows = db
    .prepare('SELECT document_id, asset_id FROM document_assets')
    .all() as any[];

  const documents = documentRows.map(row => {
    const id = assertSafeId(row.id, 'documents.id');
    const documentHash = String(row.document_hash ?? '');
    if (!SHA256_HEX_RE.test(documentHash)) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `文档 ${id} 缺少有效的 document_hash（保存恢复未完成），拒绝创建备份`
      );
    }
    const contentHash = String(row.content_hash ?? '');
    if (!CONTENT_HASH_RE.test(contentHash)) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `文档 ${id} 的 content_hash 不是合法正文哈希：${JSON.stringify(row.content_hash)}`
      );
    }
    return {
      id,
      canonicalPath: canonicalExpectedPath(row.file_path, `documents/${id}/index.md`, `文档 ${id} 的 file_path`),
      documentHash,
      contentHash,
    };
  });

  const revisions = revisionRows.map(row => {
    const id = assertSafeId(row.id, 'document_revisions.id');
    const documentId = assertSafeId(row.document_id, 'document_revisions.document_id');
    const contentHash = String(row.content_hash ?? '');
    if (!CONTENT_HASH_RE.test(contentHash)) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `历史版本 ${id} 的 content_hash 不是合法正文哈希：${JSON.stringify(row.content_hash)}`
      );
    }
    return {
      id,
      documentId,
      contentHash,
      canonicalPath: canonicalExpectedPath(
        row.snapshot_path,
        `revisions/${documentId}/${id}.md`,
        `历史版本 ${id} 的 snapshot_path`
      ),
    };
  });

  const assets = assetRows.map(row => {
    const id = assertSafeId(row.id, 'assets.id');
    const size = Number(row.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `附件 ${id} 的 size 不是非负安全整数：${JSON.stringify(row.size)}`
      );
    }
    const checksum = row.checksum === null || row.checksum === undefined ? '' : String(row.checksum);
    if (checksum && !SHA256_HEX_RE.test(checksum)) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `附件 ${id} 的 checksum 不是合法 SHA-256：${JSON.stringify(row.checksum)}`
      );
    }
    return { id, canonicalPath: canonicalAssetPath(row.storage_path, id), size, checksum };
  });

  // The same physical file must never be claimed by two DB rows. Such a conflict
  // would make restore ambiguous even though the bytes are present.
  const assertNoDuplicatePaths = (label: string, values: string[]): void => {
    const seen = new Set<string>();
    for (const value of values) {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        throw new BackupError('BACKUP_INCONSISTENT_STATE', `${label} 存在重复路径：${value}`);
      }
      seen.add(key);
    }
  };
  assertNoDuplicatePaths('documents', documents.map(document => document.canonicalPath));
  assertNoDuplicatePaths('revisions', revisions.map(revision => revision.canonicalPath));
  assertNoDuplicatePaths('assets', assets.map(asset => asset.canonicalPath));

  const documentIds = new Set(documents.map(document => document.id));
  const assetIds = new Set(assets.map(asset => asset.id));
  for (const revision of revisions) {
    if (!documentIds.has(revision.documentId)) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `document_revisions 引用了不存在的文档：${revision.documentId}（历史版本 ${revision.id}）`
      );
    }
  }
  const documentAssetIds = new Map<string, Set<string>>();
  for (const row of associationRows) {
    const documentId = String(row.document_id);
    const assetId = String(row.asset_id);
    if (!documentIds.has(documentId)) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `document_assets 引用了不存在的文档：${documentId}`
      );
    }
    if (!assetIds.has(assetId)) {
      throw new BackupError('BACKUP_INCONSISTENT_STATE', `document_assets 引用了不存在的附件：${assetId}`);
    }
    const set = documentAssetIds.get(documentId) ?? new Set<string>();
    set.add(assetId);
    documentAssetIds.set(documentId, set);
  }

  const criticalCounts = {} as Record<CriticalTable, number>;
  for (const table of CRITICAL_TABLES) {
    criticalCounts[table] = Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any)?.c || 0
    );
  }

  return {
    schemaVersion: getUserVersion(db),
    documents,
    revisions,
    assets,
    documentAssetIds,
    criticalCounts,
  };
}

function assertSamePathSet(
  label: string,
  expected: Set<string>,
  actual: Set<string>
): void {
  const missing = [...expected].filter(value => !actual.has(value)).sort();
  const extra = [...actual].filter(value => !expected.has(value)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `数据库记录与磁盘文件不一致（${label}）：数据库中缺失 ${missing.length} 项，磁盘上多出 ${extra.length} 项。` +
        '请先运行索引/附件对账，不要直接修复生产数据。',
      { missing, extra }
    );
  }
}

/**
 * Cross-checks every DB-referenced file against the scanned inventory and refuses
 * to snapshot when either side has something the other does not. No repair is
 * attempted; the caller receives an explicit inconsistency error.
 */
export function assertDatabaseMatchesInventory(
  state: DatabaseBackupState,
  inventory: SnapshotInventoryEntry[]
): void {
  const inventoryByPath = new Map(inventory.map(file => [file.relativePath, file]));

  const diskDocumentFolders = new Set<string>();
  const diskDocumentIndexes = new Set<string>();
  const diskRevisions = new Set<string>();
  const diskAssets = new Set<string>();

  for (const file of inventory) {
    const segments = file.relativePath.split('/');
    if (segments[0] === 'documents' && segments.length >= 2) {
      diskDocumentFolders.add(segments[1]);
      if (segments.length === 3 && segments[2] === 'index.md') {
        diskDocumentIndexes.add(file.relativePath);
      }
    } else if (
      segments[0] === 'revisions' &&
      segments.length === 3 &&
      segments[2].endsWith('.md')
    ) {
      diskRevisions.add(file.relativePath);
    } else if (segments[0] === 'assets') {
      if (segments.length !== 2) {
        throw new BackupError(
          'BACKUP_INCONSISTENT_STATE',
          `assets/ 下出现非受管理的嵌套文件：${file.relativePath}`
        );
      }
      diskAssets.add(file.relativePath);
    }
  }

  const dbDocumentIds = new Set(state.documents.map(document => document.id));
  assertSamePathSet('document folders', dbDocumentIds, diskDocumentFolders);
  assertSamePathSet(
    'documents/index.md',
    new Set(state.documents.map(document => document.canonicalPath)),
    diskDocumentIndexes
  );
  assertSamePathSet(
    'revisions',
    new Set(state.revisions.map(revision => revision.canonicalPath)),
    diskRevisions
  );
  assertSamePathSet('assets', new Set(state.assets.map(asset => asset.canonicalPath)), diskAssets);

  for (const document of state.documents) {
    if (!inventoryByPath.has(document.canonicalPath)) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `文档 ${document.id} 在数据库中，但 Markdown 文件不在快照清单中：${document.canonicalPath}`
      );
    }
  }
  for (const revision of state.revisions) {
    if (!inventoryByPath.has(revision.canonicalPath)) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `历史版本 ${revision.id} 在数据库中，但快照文件不在快照清单中：${revision.canonicalPath}`
      );
    }
  }
  for (const asset of state.assets) {
    const entry = inventoryByPath.get(asset.canonicalPath);
    if (!entry) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `附件 ${asset.id} 在数据库中，但物理文件不在快照清单中：${asset.canonicalPath}`
      );
    }
    if (entry.size !== asset.size) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `附件 ${asset.id} 的数据库大小与物理文件不一致：${asset.canonicalPath}（DB ${asset.size}，磁盘 ${entry.size}）`,
        { assetId: asset.id, path: asset.canonicalPath, expected: asset.size, actual: entry.size }
      );
    }
  }
}

/**
 * Re-derives each document's body hash and `document_assets` rows from the
 * Markdown SSOT (read-only) and compares them with the DB state. This prevents a
 * backup from freezing stale metadata or an attachment association that could
 * grant access to an attachment already removed from the article.
 */
export async function assertAssetAssociationsMatchMarkdown(
  state: DatabaseBackupState,
  readMarkdownStrict: (documentId: string) => Promise<string | null>
): Promise<void> {
  const assetIds = new Set(state.assets.map(asset => asset.id));

  for (const document of state.documents) {
    let raw: string | null;
    try {
      raw = await readMarkdownStrict(document.id);
    } catch (err) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `读取文档 Markdown 失败，无法验证附件关联：${document.id}：${(err as any)?.message || err}`,
        { documentId: document.id },
        { cause: err }
      );
    }
    if (raw === null) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `无法读取文档 Markdown，拒绝创建备份：${document.id}`
      );
    }

    // The DB commit marker must describe exactly the bytes that will be packaged.
    const actualDocumentHash = calculateDocumentHash(raw);
    if (actualDocumentHash !== document.documentHash) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `文档 ${document.id} 的 document_hash 与 Markdown 不一致；请先完成保存恢复再备份。`,
        { documentId: document.id, expected: document.documentHash, actual: actualDocumentHash }
      );
    }

    const { body } = parseFrontmatter(raw);
    const actualContentHash = calculateContentHash(body);
    if (actualContentHash !== document.contentHash) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `文档 ${document.id} 的 content_hash 与 Markdown 正文不一致；请先运行索引对账再备份。`,
        { documentId: document.id, expected: document.contentHash, actual: actualContentHash }
      );
    }

    const expected = new Set(
      extractAssetReferences(body).filter(assetId => assetIds.has(assetId))
    );
    const actual = state.documentAssetIds.get(document.id) ?? new Set<string>();
    const missing = [...expected].filter(assetId => !actual.has(assetId)).sort();
    const extra = [...actual].filter(assetId => !expected.has(assetId)).sort();
    if (missing.length > 0 || extra.length > 0) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `文档 ${document.id} 的附件关联与 Markdown 不一致；请重启服务完成关联重建后再备份。`,
        { documentId: document.id, missing, extra }
      );
    }
  }
}

/**
 * Re-reads every packaged revision and verifies its body against
 * `document_revisions.content_hash`. Path existence alone is not enough: a
 * corrupted or replaced snapshot would restore a revision whose DB row claims
 * different content.
 */
export async function assertRevisionSnapshotsMatchDatabase(
  state: DatabaseBackupState,
  readSnapshot: (relativePath: string) => Promise<string>
): Promise<void> {
  for (const revision of state.revisions) {
    let raw: string;
    try {
      raw = await readSnapshot(revision.canonicalPath);
    } catch (err) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `无法读取历史版本快照：${revision.canonicalPath}：${(err as any)?.message || err}`,
        { revisionId: revision.id, path: revision.canonicalPath },
        { cause: err }
      );
    }
    const { body } = parseFrontmatter(raw);
    const actual = calculateContentHash(body);
    if (actual !== revision.contentHash) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `历史版本 ${revision.id} 的 content_hash 与快照内容不一致；备份已中止。`,
        {
          revisionId: revision.id,
          path: revision.canonicalPath,
          expected: revision.contentHash,
          actual,
        }
      );
    }
  }
}

/**
 * Cross-checks the snapshot's actual SHA-256 values against the DB's commit
 * markers: `documents.document_hash` (full Markdown file, when present) and
 * `assets.checksum` (when non-empty). A mismatch means the DB points at content
 * the snapshot does not contain.
 */
export function assertSnapshotHashesMatchDatabase(
  state: DatabaseBackupState,
  snapshotFiles: BackupFileEntry[]
): void {
  const hashes = new Map(snapshotFiles.map(file => [file.path, file.sha256]));

  for (const document of state.documents) {
    const actual = hashes.get(document.canonicalPath);
    if (actual !== document.documentHash) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `文档 ${document.id} 的 document_hash 与快照内容不一致`,
        { path: document.canonicalPath, expected: document.documentHash, actual: actual ?? null }
      );
    }
  }

  for (const asset of state.assets) {
    if (!asset.checksum) continue;
    const actual = hashes.get(asset.canonicalPath);
    if (actual !== asset.checksum) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `附件 ${asset.id} 的 checksum 与快照内容不一致`,
        { path: asset.canonicalPath, expected: asset.checksum, actual: actual ?? null }
      );
    }
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
      .get(name)
  );
}

function assertIntegrity(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA integrity_check').all() as any[];
  const ok =
    rows.length === 1 &&
    Object.values(rows[0] ?? {}).some(value => String(value).toLowerCase() === 'ok');
  if (!ok) {
    throw new BackupError('BACKUP_DATABASE_VALIDATION_FAILED', '数据库快照未通过 SQLite integrity_check', {
      result: rows,
    });
  }

  const fkRows = db.prepare('PRAGMA foreign_key_check').all() as any[];
  if (fkRows.length > 0) {
    throw new BackupError(
      'BACKUP_DATABASE_VALIDATION_FAILED',
      `数据库快照未通过外键检查（${fkRows.length} 项）`,
      { violations: fkRows.slice(0, 20) }
    );
  }
}

/**
 * Removes session rows from the COPY, then VACUUMs the copy so deleted tokens do
 * not linger in free pages. The production database is never opened for writing.
 */
export async function stripSessionsFromDatabaseCopy(databasePath: string): Promise<void> {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(databasePath);
    if (!tableExists(db, 'sessions')) {
      throw new BackupError('BACKUP_DATABASE_VALIDATION_FAILED', '数据库副本缺少 sessions 表');
    }
    // Convert the copy out of WAL so the finished snapshot is one self-contained
    // file (no -wal/-shm sidecars). This only affects the copy.
    db.exec('PRAGMA journal_mode = DELETE;');
    db.exec('PRAGMA secure_delete = ON;');
    db.exec('DELETE FROM sessions;');
    db.exec('VACUUM;');
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError(
      'BACKUP_DATABASE_VALIDATION_FAILED',
      `清理数据库快照中的 sessions 失败：${(err as any)?.message || err}`,
      undefined,
      { cause: err }
    );
  } finally {
    db?.close();
  }

  for (const suffix of ['-wal', '-shm', '-journal']) {
    await fs.rm(`${databasePath}${suffix}`, { force: true }).catch(() => {});
  }
}

/** Reopens the finished copy and verifies integrity, schema version and key data. */
export async function validateDatabaseSnapshot(params: {
  databasePath: string;
  expectedSchemaVersion: number;
  expectedCounts: Record<CriticalTable, number>;
}): Promise<void> {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(params.databasePath, { readOnly: true });

    assertIntegrity(db);

    const schemaVersion = getUserVersion(db);
    if (schemaVersion !== params.expectedSchemaVersion) {
      throw new BackupError(
        'BACKUP_DATABASE_VALIDATION_FAILED',
        `数据库快照 Schema 版本不一致：期望 ${params.expectedSchemaVersion}，实际 ${schemaVersion}`
      );
    }

    for (const table of REQUIRED_TABLES) {
      if (!tableExists(db, table)) {
        throw new BackupError('BACKUP_DATABASE_VALIDATION_FAILED', `数据库快照缺少表：${table}`);
      }
    }

    const sessionCount = Number(
      (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as any)?.c || 0
    );
    if (sessionCount !== 0) {
      throw new BackupError(
        'BACKUP_DATABASE_VALIDATION_FAILED',
        `数据库快照仍包含 ${sessionCount} 条 sessions 记录`
      );
    }

    for (const table of CRITICAL_TABLES) {
      const count = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any)?.c || 0);
      if (count !== params.expectedCounts[table]) {
        throw new BackupError(
          'BACKUP_DATABASE_VALIDATION_FAILED',
          `数据库快照 ${table} 行数不一致：期望 ${params.expectedCounts[table]}，实际 ${count}`
        );
      }
    }
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError(
      'BACKUP_DATABASE_VALIDATION_FAILED',
      `数据库快照验证失败：${(err as any)?.message || err}`,
      undefined,
      { cause: err }
    );
  } finally {
    db?.close();
  }
}
