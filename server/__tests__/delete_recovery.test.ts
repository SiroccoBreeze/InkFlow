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
import { ensureInitialPhysicalDocs } from '../services/seedData';
import { getDatabase, closeDatabase } from '../db/sqlite';

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_delete_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_delete_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'delete-recovery-init-key-abcdef0123456789';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/v1', apiRouter);

let db: any;
let ownerToken: string;

const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

function docFolder(id: string) {
  return path.join(testDataDir, 'documents', id);
}

function markerPath(id: string) {
  return path.join(docFolder(id), '.delete.pending');
}

async function createDoc(tags: string[] = []) {
  const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const res = await request(app)
    .post('/api/v1/documents')
    .set(auth())
    .send({
      title: `删除恢复测试 ${unique}`,
      slug: `delete-recovery-${unique}`,
      rawMarkdown: '# 删除恢复测试\n\n正文',
      category: '安全与数据主权',
      tags,
      visibility: 'private',
      status: 'draft',
    });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; versionCount: number; slug: string; title: string };
}

describe('Document deletion recovery', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'delete_recovery_owner',
      password: 'DeleteRecoveryPassword!',
      email: 'delete-recovery@inkflow.local',
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

  it('marks a failed disk cleanup, prevents re-import, and recovers idempotently', async () => {
    const created = await createDoc();

    // Fail the first revision-folder removal: the document folder (and its marker)
    // must stay intact so the whole cleanup can be retried.
    const revDeleteSpy = vi
      .spyOn(fileStorage, 'deleteRevisionFolderStrict')
      .mockRejectedValueOnce(new Error('simulated EACCES deleting revisions'));

    let deletionSucceeded = false;
    try {
      const res = await request(app).delete(`/api/v1/documents/${created.id}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);
      expect(res.body.data.diskCleanupPending).toBe(true);
      deletionSucceeded = true;
    } finally {
      revDeleteSpy.mockRestore();
    }
    expect(deletionSucceeded).toBe(true);

    // DB deletion committed; disk folder + marker remain.
    expect(db.prepare('SELECT id FROM documents WHERE id = ?').get(created.id)).toBeUndefined();
    expect(fs.existsSync(docFolder(created.id))).toBe(true);
    expect(fs.existsSync(markerPath(created.id))).toBe(true);

    // A restart must NOT re-import the deleted document or seed starter docs while
    // a pending deletion is still present.
    await ensureInitialPhysicalDocs();
    expect((db.prepare('SELECT COUNT(*) AS c FROM documents').get() as any).c).toBe(0);
    expect(docFolder(created.id)).toBeTruthy();
    expect(fs.existsSync(markerPath(created.id))).toBe(true);

    const recovered = await documentService.recoverPendingDeletions();
    expect(recovered).toBe(1);
    expect(fs.existsSync(docFolder(created.id))).toBe(false);

    // Idempotent: a second recovery run does nothing.
    expect(await documentService.recoverPendingDeletions()).toBe(0);
    expect(fs.existsSync(docFolder(created.id))).toBe(false);
    expect((db.prepare('SELECT id FROM documents WHERE id = ?').get(created.id))).toBeUndefined();
  });

  it('recovers a delete that crashed after the SQLite commit', async () => {
    const created = await createDoc();
    await fileStorage.markDocumentDeletePending(created.id);
    // Simulate the committed DB delete happening just before the process died.
    db.prepare('DELETE FROM documents WHERE id = ?').run(created.id);

    expect(await documentService.recoverPendingDeletions()).toBe(1);
    expect(fs.existsSync(docFolder(created.id))).toBe(false);
    expect(fs.existsSync(markerPath(created.id))).toBe(false);
  });

  it('cancels a marker when the DB row still exists (crash before delete commit)', async () => {
    const created = await createDoc();
    await fileStorage.markDocumentDeletePending(created.id);

    const recovered = await documentService.recoverPendingDeletions();
    expect(recovered).toBe(1); // treated as resolved (cancelled)
    expect((db.prepare('SELECT id FROM documents WHERE id = ?').get(created.id) as any)?.id).toBe(created.id);
    expect(fs.existsSync(docFolder(created.id))).toBe(true);
    expect(fs.existsSync(markerPath(created.id))).toBe(false);
  });

  it('never deletes a folder whose marker belongs to another document', async () => {
    const folderId = `doc_safe_${Date.now().toString(36)}`;
    const folder = docFolder(folderId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.md'), '# unrelated data', 'utf-8');
    fs.writeFileSync(
      path.join(folder, '.delete.pending'),
      JSON.stringify({ docId: 'doc_someone_else', reason: 'document-deleted' }),
      'utf-8'
    );

    const recovered = await documentService.recoverPendingDeletions();
    expect(recovered).toBe(0);
    expect(fs.existsSync(folder)).toBe(true);
    expect(fs.readFileSync(path.join(folder, 'index.md'), 'utf-8')).toContain('unrelated data');
    expect(fs.existsSync(path.join(folder, '.delete.pending'))).toBe(true);

    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('blocks saves while deletion recovery is still failing (prevents resurrection)', async () => {
    const created = await createDoc();
    await fileStorage.markDocumentDeletePending(created.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(created.id);

    const revDeleteSpy = vi
      .spyOn(fileStorage, 'deleteRevisionFolderStrict')
      .mockRejectedValue(new Error('simulated EACCES deleting revisions'));
    try {
      const blocked = await request(app)
        .put(`/api/v1/documents/${created.id}`)
        .set(auth())
        .send({
          title: created.title,
          slug: created.slug,
          rawMarkdown: '# 复活尝试\n\nshould not be written',
          category: '安全与数据主权',
          tags: [],
          visibility: 'private',
          status: 'draft',
          expectedVersionCount: created.versionCount,
        });
      expect(blocked.status).toBe(503);
      expect(blocked.body.error.code).toBe('DELETE_RECOVERY_REQUIRED');
      expect(fs.existsSync(docFolder(created.id))).toBe(true);
      expect(fs.existsSync(markerPath(created.id))).toBe(true);
      expect(db.prepare('SELECT id FROM documents WHERE id = ?').get(created.id)).toBeUndefined();
    } finally {
      revDeleteSpy.mockRestore();
    }

    // Once cleanup works, recovery finishes and the save can recreate the document.
    const saved = await request(app)
      .put(`/api/v1/documents/${created.id}`)
      .set(auth())
      .send({
        title: created.title,
        slug: created.slug,
        rawMarkdown: '# 复活尝试\n\nrecreated',
        category: '安全与数据主权',
        tags: [],
        visibility: 'private',
        status: 'draft',
        expectedVersionCount: created.versionCount,
      });
    expect(saved.status).toBe(200);
    expect(fs.existsSync(markerPath(created.id))).toBe(false);
    expect(db.prepare('SELECT id FROM documents WHERE id = ?').get(created.id)).toBeTruthy();
  });
});
