import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import { documentService } from '../services/documentService';
import { fileStorage } from '../services/fileStorageService';
import { getDatabase, closeDatabase } from '../db/sqlite';

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_txn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_txn_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'transaction-safety-init-key-abcdef0123456789';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/v1', apiRouter);

let db: any;
let ownerToken: string;
let ownerId: string;

const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

function indexPath(docId: string): string {
  return path.join(testDataDir, 'documents', docId, 'index.md');
}

function revisionCount(docId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM document_revisions WHERE document_id = ?').get(docId) as any).c;
}

async function createDoc() {
  const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const res = await request(app)
    .post('/api/v1/documents')
    .set(auth())
    .send({
      title: `事务安全测试 ${unique}`,
      slug: `txn-safety-${unique}`,
      rawMarkdown: '# 原始正文\n\n不应被失败保存修改',
      category: '安全与数据主权',
      tags: ['原始标签'],
      visibility: 'private',
      status: 'draft',
    });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; versionCount: number; slug: string; title: string };
}

describe('SQLite transactions never span an await', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'txn_owner',
      password: 'TransactionPassword!',
      email: 'txn@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerToken = init.token!;
    ownerId = init.user.id;
  });

  afterAll(() => {
    closeDatabase();
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const p = `${testDbPath}${suffix}`;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('keeps unrelated DB writes out of a document-save transaction', async () => {
    const created = await createDoc();
    const originalMarkdown = fs.readFileSync(indexPath(created.id), 'utf-8');
    const beforeRevisions = revisionCount(created.id);
    const tagName = `txn-during-save-${crypto.randomBytes(4).toString('hex')}`;

    let beganTransactionDuringSave = false;
    let transactionStartError: string | null = null;
    let insertedUnrelatedRow = false;

    const originalSaveRevision = fileStorage.saveRevisionSnapshot.bind(fileStorage);
    const revisionSpy = vi
      .spyOn(fileStorage, 'saveRevisionSnapshot')
      .mockImplementation(async (documentId, revisionId, content) => {
        // This runs while the save is awaiting file I/O. If the save had already
        // opened BEGIN IMMEDIATE, this second transaction would fail and other
        // writes would silently join the save transaction.
        try {
          db.exec('BEGIN IMMEDIATE');
          db.exec('COMMIT');
          beganTransactionDuringSave = true;
        } catch (err: any) {
          transactionStartError = err?.message || String(err);
        }

        db.prepare(`
          INSERT INTO tags (id, owner_id, name, slug, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          `tag_${crypto.randomBytes(4).toString('hex')}`,
          ownerId,
          tagName,
          tagName.toLowerCase(),
          new Date().toISOString()
        );
        insertedUnrelatedRow = true;

        return originalSaveRevision(documentId, revisionId, content);
      });

    // Make the save fail AFTER the file writes, inside the DB transaction.
    const syncSpy = vi.spyOn(documentService, 'syncDocumentAssets').mockImplementationOnce(() => {
      throw new Error('simulated failure after revision snapshot');
    });

    try {
      const res = await request(app)
        .put(`/api/v1/documents/${created.id}`)
        .set(auth())
        .send({
          title: created.title,
          slug: created.slug,
          rawMarkdown: '# 新正文\n\n这次保存必须完整回滚',
          category: '安全与数据主权',
          tags: ['原始标签'],
          visibility: 'private',
          status: 'draft',
          expectedVersionCount: created.versionCount,
        });

      expect(res.status).toBe(500);
    } finally {
      revisionSpy.mockRestore();
      syncSpy.mockRestore();
    }

    // No transaction was open while the snapshot file was being written.
    expect(transactionStartError).toBeNull();
    expect(beganTransactionDuringSave).toBe(true);

    // The unrelated write survives: it was committed before the save transaction
    // started and must not be rolled back with it.
    expect(insertedUnrelatedRow).toBe(true);
    expect(
      db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName)
    ).toBeTruthy();

    // The document itself rolled back completely: file, version, revision rows.
    expect(fs.readFileSync(indexPath(created.id), 'utf-8')).toBe(originalMarkdown);
    const row = db.prepare('SELECT version_count, document_hash FROM documents WHERE id = ?').get(created.id) as any;
    expect(row.version_count).toBe(created.versionCount);
    expect(revisionCount(created.id)).toBe(beforeRevisions);

    // No leftover save artifacts from the failed attempt.
    expect(fs.existsSync(path.join(testDataDir, 'documents', created.id, '.save.pending'))).toBe(false);
    expect(fs.existsSync(path.join(testDataDir, 'documents', created.id, 'index.md.bak'))).toBe(false);
  });
});
