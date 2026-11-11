import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initDatabaseSchema } from '../db/schema';

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
});
