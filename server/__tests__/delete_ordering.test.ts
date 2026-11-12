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
  `inkflow_delete_order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_delete_order_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'delete-ordering-init-key-abcdef0123456789';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/v1', apiRouter);

let db: any;
let ownerToken: string;

const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

function revisionFiles(docId: string): string[] {
  const dir = path.join(testDataDir, 'revisions', docId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.md'));
}

function revisionRows(docId: string): any[] {
  return db
    .prepare('SELECT id, version_number FROM document_revisions WHERE document_id = ? ORDER BY version_number ASC')
    .all(docId) as any[];
}

async function createDoc() {
  const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const res = await request(app)
    .post('/api/v1/documents')
    .set(auth())
    .send({
      title: `删除顺序测试 ${unique}`,
      slug: `delete-order-${unique}`,
      rawMarkdown: '# v1\n\n第一版',
      category: '安全与数据主权',
      tags: [],
      visibility: 'private',
      status: 'draft',
    });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; versionCount: number; slug: string; title: string };
}

async function updateDoc(doc: { id: string; versionCount: number; slug: string; title: string }, body: string) {
  const res = await request(app)
    .put(`/api/v1/documents/${doc.id}`)
    .set(auth())
    .send({
      title: doc.title,
      slug: doc.slug,
      rawMarkdown: body,
      category: '安全与数据主权',
      tags: [],
      visibility: 'private',
      status: 'draft',
      expectedVersionCount: doc.versionCount,
    });
  expect(res.status).toBe(200);
  doc.versionCount = res.body.data.versionCount;
}

describe('Deletion ordering is DB-first', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'delete_order_owner',
      password: 'DeleteOrderPassword!',
      email: 'delete-order@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerToken = init.token!;
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

  it('removes revision rows before deleting snapshot files', async () => {
    const doc = await createDoc();
    await updateDoc(doc, '# v2\n\n第二版');
    await updateDoc(doc, '# v3\n\n第三版');

    expect(revisionRows(doc.id)).toHaveLength(3);
    expect(revisionFiles(doc.id)).toHaveLength(3);

    let observedRowsAtFileDeletion: number | null = null;
    const spy = vi
      .spyOn(fileStorage, 'deleteRevisionFiles')
      .mockImplementationOnce(async (documentId: string, revisionIds: string[]) => {
        observedRowsAtFileDeletion = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM document_revisions
               WHERE document_id = ? AND id IN (${revisionIds.map(() => '?').join(',')})`
            )
            .get(documentId, ...revisionIds) as any
        ).c;

        // Simulate a crash right after the DB commit and before unlinking files.
        return { deletedCount: 0, freedBytes: 0, failedIds: revisionIds };
      });

    try {
      const result = await documentService.cleanRevisions({ documentId: doc.id, keepLatest: 1 });
      expect(result.cleanedCount).toBe(2);
    } finally {
      spy.mockRestore();
    }

    // At the moment files were about to be deleted, their rows were already gone.
    expect(observedRowsAtFileDeletion).toBe(0);

    const remainingRows = revisionRows(doc.id);
    expect(remainingRows).toHaveLength(1);
    expect(remainingRows[0].version_number).toBe(3);

    // The simulated crash leaves orphan files (not dangling DB rows).
    expect(revisionFiles(doc.id)).toHaveLength(3);

    // Clean the orphans explicitly so the fixture stays tidy.
    const orphanIds = revisionFiles(doc.id).map(name => name.replace(/\.md$/, ''));
    await fileStorage.deleteRevisionFiles(doc.id, orphanIds);
  });

  it('removes a single revision row before deleting its file', async () => {
    const doc = await createDoc();
    await updateDoc(doc, '# v2\n\n第二版');
    const rows = revisionRows(doc.id);
    const oldest = rows[0];

    let rowStillPresentAtFileDeletion: boolean | null = null;
    const spy = vi
      .spyOn(fileStorage, 'deleteRevisionFiles')
      .mockImplementationOnce(async (documentId: string, revisionIds: string[]) => {
        rowStillPresentAtFileDeletion = Boolean(
          db
            .prepare('SELECT id FROM document_revisions WHERE document_id = ? AND id = ?')
            .get(documentId, revisionIds[0])
        );
        return { deletedCount: 0, freedBytes: 0, failedIds: revisionIds };
      });

    try {
      const deleted = await documentService.deleteSingleRevision(doc.id, oldest.id);
      expect(deleted).toBe(true);
    } finally {
      spy.mockRestore();
    }

    expect(rowStillPresentAtFileDeletion).toBe(false);
    expect(db.prepare('SELECT id FROM document_revisions WHERE id = ?').get(oldest.id)).toBeUndefined();
  });
});
