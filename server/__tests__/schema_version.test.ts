import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { initDatabaseSchema } from '../db/schema';
import {
  BASELINE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  getUserVersion,
} from '../db/migrations';
import {
  normalizeStorageRelativePath,
  resolveInsideRoot,
  toStorageRelativePath,
} from '../utils/storagePaths';

const LEGACY_DOCUMENTS_DDL = `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    category_id TEXT,
    category_name TEXT NOT NULL DEFAULT '未分类',
    file_path TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    status TEXT NOT NULL DEFAULT 'draft',
    content_hash TEXT NOT NULL,
    word_count INTEGER NOT NULL DEFAULT 0,
    reading_time INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0,
    version_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT
  );
`;

function insertLegacyDocument(db: DatabaseSync, id: string, filePath: string): void {
  db.prepare(`
    INSERT INTO documents (
      id, owner_id, slug, title, category_name, file_path,
      visibility, status, content_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    'usr_owner',
    id,
    `Legacy ${id}`,
    '未分类',
    filePath,
    'private',
    'draft',
    'abcd',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
}

function createLegacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(LEGACY_DOCUMENTS_DDL);
  db.exec(`
    CREATE TABLE document_revisions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      snapshot_path TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('Database schema versioning', () => {
  it('initializes a brand-new database at the current version', () => {
    const db = new DatabaseSync(':memory:');
    initDatabaseSchema(db);

    expect(getUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const migrations = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as any[];
    expect(migrations.map(row => row.version)).toEqual([BASELINE_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION]);
    expect(migrations.map(row => row.name)).toContain('baseline');
    expect(migrations.map(row => row.name)).toContain('normalize-storage-paths');

    // Re-running startup must be a no-op.
    initDatabaseSchema(db);
    expect(getUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('migrates a pre-versioning database and normalizes Windows storage paths', () => {
    const db = createLegacyDatabase();
    insertLegacyDocument(db, 'doc_legacy', 'documents\\doc_legacy\\index.md');
    db.prepare(`
      INSERT INTO document_revisions (id, document_id, title, content_hash, snapshot_path, version_number, note, created_at)
      VALUES ('rev_legacy', 'doc_legacy', 'Legacy', 'abcd', 'revisions\\doc_legacy\\rev_legacy.md', 1, 'v1', ?)
    `).run('2026-01-01T00:00:00.000Z');
    db.prepare(`
      INSERT INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
      VALUES ('ast_legacy', 'usr_owner', 'a.png', 'assets\\ast_legacy.png', 'image/png', 3, 'abc', ?)
    `).run('2026-01-01T00:00:00.000Z');

    initDatabaseSchema(db);

    expect(getUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      (db.prepare('SELECT file_path FROM documents WHERE id = ?').get('doc_legacy') as any).file_path
    ).toBe('documents/doc_legacy/index.md');
    expect(
      (db.prepare('SELECT snapshot_path FROM document_revisions WHERE id = ?').get('rev_legacy') as any)
        .snapshot_path
    ).toBe('revisions/doc_legacy/rev_legacy.md');
    expect(
      (db.prepare('SELECT storage_path FROM assets WHERE id = ?').get('ast_legacy') as any).storage_path
    ).toBe('assets/ast_legacy.png');

    // document_hash migration still ran.
    const columns = (db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c => c.name);
    expect(columns).toContain('document_hash');
    db.close();
  });

  it('refuses to open a database written by a newer build', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA user_version = 99');

    expect(() => initDatabaseSchema(db)).toThrow(/高于当前程序支持/);
    expect(getUserVersion(db)).toBe(99);

    // No schema was created before the version check.
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r => r.name);
    expect(tables).not.toContain('users');
    db.close();
  });

  it('rolls back a failed migration without losing data', () => {
    const db = createLegacyDatabase();
    insertLegacyDocument(db, 'doc_bad', '../escape/index.md');

    expect(() => initDatabaseSchema(db)).toThrow(
      /数据库结构迁移失败（schema v2: normalize-storage-paths）/
    );

    // Baseline was recorded; the failed v2 migration was rolled back.
    expect(getUserVersion(db)).toBe(BASELINE_SCHEMA_VERSION);
    expect(
      (db.prepare('SELECT file_path FROM documents WHERE id = ?').get('doc_bad') as any).file_path
    ).toBe('../escape/index.md');

    // Fixing the bad value lets the next startup complete normally.
    db.prepare('UPDATE documents SET file_path = ? WHERE id = ?').run('documents/doc_bad/index.md', 'doc_bad');
    initDatabaseSchema(db);
    expect(getUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});

describe('Storage path normalization', () => {
  it('converts Windows separators and keeps contained relative paths', () => {
    expect(normalizeStorageRelativePath('documents\\doc_a\\index.md')).toBe('documents/doc_a/index.md');
    expect(normalizeStorageRelativePath('./assets/ast_a.png')).toBe('assets/ast_a.png');
    expect(normalizeStorageRelativePath('assets/ast_a.png')).toBe('assets/ast_a.png');
    expect(normalizeStorageRelativePath('  assets\\ast_a.png  ')).toBe('assets/ast_a.png');
  });

  it('rejects traversal, absolute, drive and malformed paths', () => {
    for (const bad of [
      '',
      '.',
      '..',
      '../escape.md',
      'assets/../../escape.png',
      '/etc/passwd',
      'C:\\Windows\\system.ini',
      'C:/Windows/system.ini',
      '\\\\server\\share\\file',
      'assets//ast.png',
      'assets/./ast.png',
      'assets/\0ast.png',
    ]) {
      expect(normalizeStorageRelativePath(bad)).toBeNull();
    }
  });

  it('resolves inside the storage root only', () => {
    const root = path.resolve('/tmp/inkflow-storage');
    expect(resolveInsideRoot(root, 'assets\\ast.png')).toBe(path.join(root, 'assets', 'ast.png'));
    expect(resolveInsideRoot(root, 'assets/ast.png')).toBe(path.join(root, 'assets', 'ast.png'));
    expect(resolveInsideRoot(root, '../outside.png')).toBeNull();
    expect(resolveInsideRoot(root, '/etc/passwd')).toBeNull();
    expect(toStorageRelativePath(root, path.join(root, 'documents', 'doc_a', 'index.md'))).toBe(
      'documents/doc_a/index.md'
    );
  });
});
