import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import { getDatabase, closeDatabase } from '../db/sqlite';
import { fileStorage } from '../services/fileStorageService';

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_tag_guard_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_tag_guard_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'tag-guard-init-key-abcdef0123456789';
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

async function createDoc(tags: string[]) {
  const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const res = await request(app)
    .post('/api/v1/documents')
    .set(auth())
    .send({
      title: `标签清理测试 ${unique}`,
      slug: `tag-guard-${unique}`,
      rawMarkdown: '# 标签清理测试\n\n正文',
      category: '安全与数据主权',
      tags,
      visibility: 'private',
      status: 'draft',
    });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; versionCount: number; slug: string; title: string };
}

describe('Tag dictionary cleanup guard', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'tag_guard_owner',
      password: 'TagGuardPassword!',
      email: 'tag-guard@inkflow.local',
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

  it('retains the tag while documents still reference it, then deletes after they are updated', async () => {
    const created = await createDoc(['shared']);

    const retained = await request(app).delete('/api/v1/tags/shared').set(auth());
    expect(retained.status).toBe(200);
    expect(retained.body.data.tagDeleted).toBe(false);
    expect(retained.body.data.referencedDocuments).toBeGreaterThanOrEqual(1);

    const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get('shared') as any;
    expect(tagRow?.id).toBeTruthy();
    const assoc = db
      .prepare(
        `SELECT COUNT(*) AS c FROM document_tags dt
         JOIN tags t ON t.id = dt.tag_id
         WHERE t.name = ?`
      )
      .get('shared') as any;
    expect(assoc.c).toBeGreaterThanOrEqual(1);

    // Remove the tag through the versioned save path.
    const updated = await request(app)
      .put(`/api/v1/documents/${created.id}`)
      .set(auth())
      .send({
        title: created.title,
        slug: created.slug,
        rawMarkdown: '# 标签清理测试\n\n正文',
        category: '安全与数据主权',
        tags: [],
        visibility: 'private',
        status: 'draft',
        expectedVersionCount: created.versionCount,
      });
    expect(updated.status).toBe(200);

    const deleted = await request(app).delete('/api/v1/tags/shared').set(auth());
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.tagDeleted).toBe(true);
    expect(db.prepare('SELECT id FROM tags WHERE name = ?').get('shared')).toBeUndefined();
  });

  it('retains the tag when the DB association is missing but Markdown still references it', async () => {
    const tagName = 'ghost-tag';
    const created = await createDoc([tagName]);

    // Simulate an incomplete cache/index: the DB association is gone, but the
    // Markdown SSOT still contains the tag in frontmatter.
    const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any;
    expect(tagRow?.id).toBeTruthy();
    db.prepare('DELETE FROM document_tags WHERE tag_id = ?').run(tagRow.id);

    const retained = await request(app).delete(`/api/v1/tags/${encodeURIComponent(tagName)}`).set(auth());
    expect(retained.status).toBe(200);
    expect(retained.body.data.tagDeleted).toBe(false);
    expect(retained.body.data.referencedDocuments).toBeGreaterThanOrEqual(1);

    // Tag row is preserved because the Markdown scan found a reference.
    expect((db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any)?.id).toBeTruthy();
    const raw = fs.readFileSync(
      path.join(testDataDir, 'documents', created.id, 'index.md'),
      'utf-8'
    );
    expect(raw).toContain(`"${tagName}"`);
  });

  it('cannot delete a tag association created by a save that races the scan', async () => {
    const tagName = `race-${Date.now().toString(36)}`;
    const created = await createDoc([]);
    const tagId = `tag_race_${Date.now().toString(36)}`;
    db.prepare('INSERT INTO tags (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').run(
      tagId,
      ownerId,
      tagName,
      tagName,
      new Date().toISOString()
    );

    const originalRead = fileStorage.readDocumentMarkdownStrict.bind(fileStorage);
    let markScanStarted!: () => void;
    const scanStarted = new Promise<void>(resolve => (markScanStarted = resolve));
    let releaseScan!: () => void;
    const scanGate = new Promise<void>(resolve => (releaseScan = resolve));
    let pausedFirstRead = false;

    const readSpy = vi.spyOn(fileStorage, 'readDocumentMarkdownStrict').mockImplementation(async (docId: string) => {
      if (!pausedFirstRead) {
        pausedFirstRead = true;
        markScanStarted();
        await scanGate;
      }
      return originalRead(docId);
    });

    let prepareCalledWhileScanning = false;
    const originalPrepare = fileStorage.prepareDocumentSave.bind(fileStorage);
    const prepareSpy = vi.spyOn(fileStorage, 'prepareDocumentSave').mockImplementation(async (...args: any[]) => {
      prepareCalledWhileScanning = true;
      return originalPrepare(...(args as [string, string | null, string]));
    });

    try {
      const deletePromise = request(app).delete(`/api/v1/tags/${encodeURIComponent(tagName)}`).set(auth());
      void deletePromise.then(() => {}, () => {});
      await scanStarted;

      const savePromise = request(app)
        .put(`/api/v1/documents/${created.id}`)
        .set(auth())
        .send({
          title: created.title,
          slug: created.slug,
          rawMarkdown: '# 标签清理测试\n\n正文',
          category: '安全与数据主权',
          tags: [tagName],
          visibility: 'private',
          status: 'draft',
          expectedVersionCount: created.versionCount,
        });
      void savePromise.then(() => {}, () => {});

      // The exclusive maintenance lease must keep the save out of its write path.
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(prepareCalledWhileScanning).toBe(false);

      releaseScan();
      const [deleted, saved] = await Promise.all([deletePromise, savePromise]);
      expect(deleted.status).toBe(200);
      expect(saved.status).toBe(200);

      // Either the cleanup retained the tag or the save re-created it. In both
      // cases Markdown, document_tags and the tag dictionary must agree.
      const raw = fs.readFileSync(path.join(testDataDir, 'documents', created.id, 'index.md'), 'utf-8');
      expect(raw).toContain(`"${tagName}"`);
      expect((db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any)?.id).toBeTruthy();
      const assoc = db
        .prepare(
          `SELECT COUNT(*) AS c FROM document_tags dt
           JOIN tags t ON t.id = dt.tag_id
           WHERE t.name = ? AND dt.document_id = ?`
        )
        .get(tagName, created.id) as any;
      expect(assoc.c).toBe(1);
    } finally {
      releaseScan();
      readSpy.mockRestore();
      prepareSpy.mockRestore();
    }
  });

  it('treats a real documents-directory read failure as unknown references (keeps tag)', async () => {
    const tagName = `dir-fail-${Date.now().toString(36)}`;
    const tagId = `tag_dir_${Date.now().toString(36)}`;
    db.prepare('INSERT INTO tags (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').run(
      tagId,
      ownerId,
      tagName,
      tagName,
      new Date().toISOString()
    );

    const documentsDir = path.join(testDataDir, 'documents');
    const movedDir = `${documentsDir}_moved_${Date.now().toString(36)}`;
    fs.renameSync(documentsDir, movedDir);
    // A regular file where the directory should be makes readdir throw ENOTDIR
    // on both Linux and Windows (real filesystem fault, not a method mock).
    fs.writeFileSync(documentsDir, 'not a directory');

    try {
      const res = await request(app).delete(`/api/v1/tags/${encodeURIComponent(tagName)}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.tagDeleted).toBe(false);
      expect(res.body.data.reason).toBe('markdown_scan_failed');
      expect((db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any)?.id).toBeTruthy();
    } finally {
      fs.rmSync(documentsDir, { force: true });
      fs.renameSync(movedDir, documentsDir);
    }
  });

  it('treats a real unreadable index.md as unknown references (keeps tag)', async () => {
    const tagName = `file-fail-${Date.now().toString(36)}`;
    const tagId = `tag_file_${Date.now().toString(36)}`;
    db.prepare('INSERT INTO tags (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').run(
      tagId,
      ownerId,
      tagName,
      tagName,
      new Date().toISOString()
    );

    const docDir = path.join(testDataDir, 'documents', `doc_unreadable_${Date.now().toString(36)}`);
    fs.mkdirSync(path.join(docDir, 'index.md'), { recursive: true }); // index.md is a directory

    try {
      const res = await request(app).delete(`/api/v1/tags/${encodeURIComponent(tagName)}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.tagDeleted).toBe(false);
      expect(res.body.data.reason).toBe('markdown_scan_failed');
      expect((db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any)?.id).toBeTruthy();
    } finally {
      fs.rmSync(docDir, { recursive: true, force: true });
    }
  });

  it('distinguishes a missing index.md (no reference) from a read failure', async () => {
    const tagName = `missing-index-${Date.now().toString(36)}`;
    const tagId = `tag_missing_${Date.now().toString(36)}`;
    db.prepare('INSERT INTO tags (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').run(
      tagId,
      ownerId,
      tagName,
      tagName,
      new Date().toISOString()
    );

    const docDir = path.join(testDataDir, 'documents', `doc_no_index_${Date.now().toString(36)}`);
    fs.mkdirSync(docDir, { recursive: true }); // no index.md

    try {
      const res = await request(app).delete(`/api/v1/tags/${encodeURIComponent(tagName)}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.tagDeleted).toBe(true);
      expect(db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName)).toBeUndefined();
    } finally {
      fs.rmSync(docDir, { recursive: true, force: true });
    }
  });

  it('keeps the tag dictionary when the Markdown scan fails', async () => {
    const tagName = `scan-fail-${Date.now().toString(36)}`;
    const tagId = `tag_scan_${Date.now().toString(36)}`;
    db.prepare('INSERT INTO tags (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').run(
      tagId,
      ownerId,
      tagName,
      tagName,
      new Date().toISOString()
    );

    const readSpy = vi
      .spyOn(fileStorage, 'readDocumentMarkdownStrict')
      .mockRejectedValueOnce(new Error('simulated EACCES while scanning Markdown'));

    try {
      const res = await request(app).delete(`/api/v1/tags/${encodeURIComponent(tagName)}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.tagDeleted).toBe(false);
      expect(res.body.data.reason).toBe('markdown_scan_failed');
      expect((db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any)?.id).toBeTruthy();
    } finally {
      readSpy.mockRestore();
    }
  });

  it('keeps the tag dictionary when the database association check fails', async () => {
    const tagName = `db-fail-${Date.now().toString(36)}`;
    const tagId = `tag_db_${Date.now().toString(36)}`;
    db.prepare('INSERT INTO tags (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').run(
      tagId,
      ownerId,
      tagName,
      tagName,
      new Date().toISOString()
    );

    db.exec('ALTER TABLE document_tags RENAME TO document_tags_broken');
    try {
      const res = await request(app).delete(`/api/v1/tags/${encodeURIComponent(tagName)}`).set(auth());
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('TAG_CLEANUP_FAILED');
      expect((db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any)?.id).toBeTruthy();
    } finally {
      db.exec('ALTER TABLE document_tags_broken RENAME TO document_tags');
    }
  });
});
