import type { DatabaseSync } from 'node:sqlite';
import { normalizeStorageRelativePath } from '../utils/storagePaths';

/**
 * Database schema versioning.
 *
 * The version is stored in SQLite's built-in `PRAGMA user_version` so it travels
 * with the database file (and therefore with every backup/restore). Every applied
 * migration is also recorded in `schema_migrations` for auditability.
 *
 * Rules:
 *  - version 0 means "created before versioning existed"; it is upgraded as if it
 *    were the baseline (v1) and then migrated forward;
 *  - a database whose version is newer than this build is refused, never
 *    downgraded or silently modified;
 *  - each migration runs in its own transaction; a failure rolls back that
 *    migration and aborts startup without deleting or recreating data.
 */

export const BASELINE_SCHEMA_VERSION = 1;

/**
 * v1: baseline schema (includes documents.document_hash, handled by schema.ts).
 * v2: canonical POSIX storage paths (Windows backslashes → '/').
 */
export const CURRENT_SCHEMA_VERSION = 2;

export interface SchemaMigration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as any;
  const value = Number(row?.user_version ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function setUserVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`非法的 Schema 版本号：${version}`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
}

function recordMigration(db: DatabaseSync, version: number, name: string): void {
  db.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(version) DO UPDATE SET name = excluded.name
  `).run(version, name, new Date().toISOString());
}

/**
 * Asserts that this build can open the database. Must run BEFORE any schema DDL:
 * opening a newer database with an older build could silently corrupt it.
 */
export function assertSchemaVersionSupported(db: DatabaseSync): void {
  const version = getUserVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `数据库 Schema 版本 ${version} 高于当前程序支持的 ${CURRENT_SCHEMA_VERSION}。` +
        '已停止启动以避免旧程序修改新数据；请升级 InkFlow 后再打开该数据库。'
    );
  }
}

/** Records the baseline version for a brand-new or pre-versioning database. */
export function markBaselineIfNeeded(db: DatabaseSync, hadVersion: boolean): void {
  if (hadVersion) return;
  setUserVersion(db, BASELINE_SCHEMA_VERSION);
  recordMigration(db, BASELINE_SCHEMA_VERSION, 'baseline');
}

function normalizeColumn(
  db: DatabaseSync,
  table: 'documents' | 'document_revisions' | 'assets',
  column: 'file_path' | 'snapshot_path' | 'storage_path'
): void {
  const rows = db.prepare(`SELECT rowid AS rid, ${column} AS value FROM ${table}`).all() as Array<{
    rid: number;
    value: string | null;
  }>;
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);

  for (const row of rows) {
    if (row.value === null) continue;
    const normalized = normalizeStorageRelativePath(row.value);
    if (!normalized) {
      throw new Error(`${table}.${column} 包含非法的存储路径：${JSON.stringify(row.value)}`);
    }
    if (normalized !== row.value) {
      update.run(normalized, row.rid);
    }
  }
}

function migrateToPosixStoragePaths(db: DatabaseSync): void {
  // Values that were already POSIX are left untouched. Invalid values abort the
  // migration instead of being silently rewritten.
  normalizeColumn(db, 'documents', 'file_path');
  normalizeColumn(db, 'document_revisions', 'snapshot_path');
  normalizeColumn(db, 'assets', 'storage_path');
}

const MIGRATIONS: SchemaMigration[] = [
  {
    version: 2,
    name: 'normalize-storage-paths',
    up: migrateToPosixStoragePaths,
  },
];

/**
 * Applies every migration newer than `fromVersion`, in ascending order.
 * Returns the list of applied versions.
 */
export function runSchemaMigrations(db: DatabaseSync, fromVersion: number): number[] {
  const pending = MIGRATIONS.filter(migration => migration.version > fromVersion).sort(
    (a, b) => a.version - b.version
  );
  const applied: number[] = [];

  for (const migration of pending) {
    if (migration.version > CURRENT_SCHEMA_VERSION) continue;

    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      setUserVersion(db, migration.version);
      recordMigration(db, migration.version, migration.name);
      db.exec('COMMIT');
      applied.push(migration.version);
    } catch (err: any) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled the transaction back.
      }
      throw new Error(
        `数据库结构迁移失败（schema v${migration.version}: ${migration.name}）：` +
          `${err?.message || err}。已回滚该迁移并停止启动；请修复数据后重试，` +
          '不要删除数据库或重新初始化以绕过迁移。',
        { cause: err }
      );
    }
  }

  // Defensive: the recorded version must match the code expectation after all
  // supported migrations have run.
  const finalVersion = getUserVersion(db);
  if (finalVersion < CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `数据库 Schema 迁移未完成：当前版本 ${finalVersion}，期望 ${CURRENT_SCHEMA_VERSION}。`
    );
  }

  return applied;
}
