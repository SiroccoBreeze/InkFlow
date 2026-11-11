import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { initDatabaseSchema } from '../db/schema';

const DOCUMENT_COLUMNS = [
  'id TEXT PRIMARY KEY',
  'owner_id TEXT NOT NULL',
  'slug TEXT NOT NULL',
  'title TEXT NOT NULL',
  'description TEXT',
  'category_id TEXT',
  "category_name TEXT NOT NULL DEFAULT '未分类'",
  'file_path TEXT NOT NULL',
  "visibility TEXT NOT NULL DEFAULT 'private'",
  "status TEXT NOT NULL DEFAULT 'draft'",
  'content_hash TEXT NOT NULL',
  'word_count INTEGER NOT NULL DEFAULT 0',
  'reading_time INTEGER NOT NULL DEFAULT 1',
  'pinned INTEGER NOT NULL DEFAULT 0',
  'version_count INTEGER NOT NULL DEFAULT 1',
  'created_at TEXT NOT NULL',
  'updated_at TEXT NOT NULL',
  'published_at TEXT',
];

/** Creates a `documents` table with 2000 columns so ALTER TABLE would fail. */
function createMaxColumnLegacyDb(db: DatabaseSync): void {
  const filler = Array.from({ length: 2000 - DOCUMENT_COLUMNS.length }, (_, i) => `f${i} TEXT`);
  db.exec(`CREATE TABLE documents (${[...DOCUMENT_COLUMNS, ...filler].join(', ')});`);
  db.prepare(`
    INSERT INTO documents (
      id, owner_id, slug, title, category_name, file_path,
      visibility, status, content_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'doc_legacy',
    'usr_owner',
    'legacy',
    'Legacy',
    '未分类',
    'documents/doc_legacy/index.md',
    'private',
    'draft',
    'abcd',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
}

describe('documents.document_hash schema migration', () => {
  it('adds the column to a legacy documents table without data loss', () => {
    const db = new DatabaseSync(':memory:');
    // Simulate an installation created before document_hash existed.
    db.exec(`
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
      INSERT INTO documents (
        id, owner_id, slug, title, category_name, file_path,
        visibility, status, content_hash, created_at, updated_at
      ) VALUES (
        'doc_legacy', 'usr_owner', 'legacy', 'Legacy', '未分类', 'documents/doc_legacy/index.md',
        'private', 'draft', 'abcd', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);

    initDatabaseSchema(db);

    const columns = (db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c => c.name);
    expect(columns).toContain('document_hash');

    const row = db.prepare('SELECT id, title, document_hash FROM documents WHERE id = ?').get('doc_legacy') as any;
    expect(row.title).toBe('Legacy');
    expect(row.document_hash).toBeNull();

    // Running the migration twice must be a no-op.
    initDatabaseSchema(db);
    const columnsAfter = (db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c => c.name);
    expect(columnsAfter.filter(c => c === 'document_hash')).toHaveLength(1);

    db.close();
  });

  it('initializes a brand-new database with document_hash', () => {
    const db = new DatabaseSync(':memory:');
    initDatabaseSchema(db);
    const columns = (db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c => c.name);
    expect(columns).toContain('document_hash');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r => r.name);
    expect(tables).toEqual(expect.arrayContaining(['documents', 'document_revisions', 'documents_fts']));
    db.close();
  });

  it('throws (and preserves data) when the migration cannot add the column', () => {
    const db = new DatabaseSync(':memory:');
    createMaxColumnLegacyDb(db);

    expect(() => initDatabaseSchema(db)).toThrow(/数据库结构迁移失败（documents\.document_hash）/);

    const columns = (db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c => c.name);
    expect(columns).not.toContain('document_hash');
    const row = db.prepare('SELECT title FROM documents WHERE id = ?').get('doc_legacy') as any;
    expect(row.title).toBe('Legacy');
    db.close();
  });

  it('does not start the HTTP server when migration fails', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `inkflow_bad_migration_${crypto.randomBytes(3).toString('hex')}_`));
    const dbDir = path.join(dataDir, 'database');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbFile = path.join(dbDir, 'knowledge_hub.sqlite');

    const db = new DatabaseSync(dbFile);
    createMaxColumnLegacyDb(db);
    db.close();

    try {
      // Cross-platform: invoke the tsx CLI through the current Node binary
      // instead of relying on the platform-specific .bin shim.
      const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const result = spawnSync(process.execPath, [tsxCli, 'server.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          INKFLOW_DATA_DIR: dataDir,
          INKFLOW_DB_PATH: '',
          PORT: '0',
        },
        encoding: 'utf8',
        timeout: 30000,
      });

      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      expect(result.status).not.toBe(0);
      expect(output).toMatch(/数据库结构迁移失败/);
      expect(output).not.toMatch(/InkFlow Knowledge Hub running on/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
