import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import { documentService, calculateContentHash, parseFrontmatter } from '../services/documentService';
import { getDatabase, closeDatabase } from '../db/sqlite';

// Isolated database + storage for this suite.
const testDbPath = path.join(os.tmpdir(), `inkflow_save_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_save_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'save-reliability-init-key-abcdef0123456789';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/v1', apiRouter);

let db: any;
let ownerToken: string;

const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

function filePath(docId: string): string {
  return path.join(testDataDir, 'documents', docId, 'index.md');
}

function readBody(docId: string): string {
  const raw = fs.readFileSync(filePath(docId), 'utf-8');
  return parseFrontmatter(raw).body.trim();
}

function revisionCount(docId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM document_revisions WHERE document_id = ?').get(docId) as any).c;
}

async function createDoc(markdown: string, extra: Record<string, any> = {}) {
  const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const res = await request(app)
    .post('/api/v1/documents')
    .set(auth())
    .send({
      title: `保存可靠性测试 ${unique}`,
      slug: `save-reliability-${unique}`,
      rawMarkdown: markdown,
      category: '安全与数据主权',
      tags: [],
      ...extra,
    });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; versionCount: number };
}

async function updateDoc(docId: string, markdown: string, expectedVersionCount: number) {
  // Keep the document's own title/slug: deriving a shared slug would hit the
  // (owner_id, slug) unique index before the behaviour under test is exercised.
  const row = db.prepare('SELECT title, slug FROM documents WHERE id = ?').get(docId) as any;
  return request(app)
    .put(`/api/v1/documents/${docId}`)
    .set(auth())
    .send({
      title: row?.title || '保存可靠性测试',
      slug: row?.slug,
      rawMarkdown: markdown,
      category: '安全与数据主权',
      tags: [],
      expectedVersionCount,
    });
}

function artifacts(docId: string): string[] {
  const folder = path.join(testDataDir, 'documents', docId);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(n => n === 'index.md.bak' || n === '.save.pending' || n.endsWith('.tmp'));
}

describe('Document save reliability', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'save_owner',
      password: 'SaveReliabilityPassword!',
      email: 'save@inkflow.local',
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

  // -------------------------------------------------------------------------
  it('saves normally: file, SQLite metadata, revision and FTS stay consistent', async () => {
    const created = await createDoc('# 正常保存\n\nv1');
    const updated = await updateDoc(created.id, '# 正常保存\n\nv2', created.versionCount);

    expect(updated.status).toBe(200);
    expect(updated.body.data.versionCount).toBe(created.versionCount + 1);
    expect(readBody(created.id)).toBe('# 正常保存\n\nv2');

    const row = db.prepare('SELECT version_count, content_hash FROM documents WHERE id = ?').get(created.id) as any;
    expect(row.version_count).toBe(created.versionCount + 1);
    expect(row.content_hash).toBe(calculateContentHash('# 正常保存\n\nv2'));
    expect(revisionCount(created.id)).toBe(2);

    const fts = db.prepare('SELECT body FROM documents_fts WHERE document_id = ?').get(created.id) as any;
    expect(fts.body).toContain('v2');
    expect(artifacts(created.id)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it('rejects a stale expectedVersionCount with 409 and changes nothing', async () => {
    const created = await createDoc('# 并发\n\nv1');
    const first = await updateDoc(created.id, '# 并发\n\nv2', created.versionCount);
    expect(first.status).toBe(200);

    const stale = await updateDoc(created.id, '# 并发\n\nold-client', created.versionCount);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.currentVersionCount).toBe(created.versionCount + 1);

    expect(readBody(created.id)).toBe('# 并发\n\nv2');
    expect((db.prepare('SELECT version_count FROM documents WHERE id = ?').get(created.id) as any).version_count).toBe(
      created.versionCount + 1
    );
    expect(revisionCount(created.id)).toBe(2);
  });

  // -------------------------------------------------------------------------
  it('requires expectedVersionCount for HTTP updates', async () => {
    const created = await createDoc('# 缺少版本号\n\nv1');
    const res = await request(app)
      .put(`/api/v1/documents/${created.id}`)
      .set(auth())
      .send({ title: '缺少版本号', rawMarkdown: '# 缺少版本号\n\nv2', category: '未分类', tags: [] });

    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
    expect(readBody(created.id)).toBe('# 缺少版本号\n\nv1');
  });

  // -------------------------------------------------------------------------
  it('does not overwrite an existing document through a duplicate POST', async () => {
    const created = await createDoc('# 重复创建\n\nv1');
    const duplicate = await request(app)
      .post('/api/v1/documents')
      .set(auth())
      .send({ id: created.id, title: '重复创建', rawMarkdown: '# 覆盖尝试', category: '未分类', tags: [] });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DOCUMENT_EXISTS');
    expect(readBody(created.id)).toBe('# 重复创建\n\nv1');
  });

  // -------------------------------------------------------------------------
  it('rolls the Markdown file back when the database update fails', async () => {
    const created = await createDoc('# DB 失败\n\nv1');
    const triggerName = `fail_update_${created.id.replace(/[^A-Za-z0-9]/g, '_')}`;

    db.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON documents
      WHEN NEW.id = '${created.id}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated database failure');
      END;
    `);

    try {
      const failed = await updateDoc(created.id, '# DB 失败\n\nv2', created.versionCount);
      expect(failed.status).toBe(500);
      expect(failed.body.error.code).toBe('SAVE_FAILED');

      // File restored, DB untouched, no half-created history row or leftover artifacts.
      expect(readBody(created.id)).toBe('# DB 失败\n\nv1');
      expect((db.prepare('SELECT version_count FROM documents WHERE id = ?').get(created.id) as any).version_count).toBe(
        created.versionCount
      );
      expect(revisionCount(created.id)).toBe(1);
      expect(artifacts(created.id)).toEqual([]);
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }

    // Retrying after the DB is healthy succeeds with the same expected version.
    const retried = await updateDoc(created.id, '# DB 失败\n\nv2', created.versionCount);
    expect(retried.status).toBe(200);
    expect(readBody(created.id)).toBe('# DB 失败\n\nv2');
  });

  // -------------------------------------------------------------------------
  it('rolls back file and DB when the revision snapshot cannot be written', async () => {
    const created = await createDoc('# 快照失败\n\nv1');
    const revFolder = path.join(testDataDir, 'revisions', created.id);
    fs.rmSync(revFolder, { recursive: true, force: true });
    // A regular file where the revision folder should be makes mkdir fail.
    fs.writeFileSync(revFolder, 'block revision folder');

    try {
      const failed = await updateDoc(created.id, '# 快照失败\n\nv2', created.versionCount);
      expect(failed.status).toBe(500);

      expect(readBody(created.id)).toBe('# 快照失败\n\nv1');
      expect((db.prepare('SELECT version_count FROM documents WHERE id = ?').get(created.id) as any).version_count).toBe(
        created.versionCount
      );
      expect(revisionCount(created.id)).toBe(1);
      expect(artifacts(created.id)).toEqual([]);
    } finally {
      fs.rmSync(revFolder, { force: true });
    }

    const retried = await updateDoc(created.id, '# 快照失败\n\nv2', created.versionCount);
    expect(retried.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  it('rolls back file and DB when the FTS index update fails', async () => {
    const created = await createDoc('# FTS 失败\n\nv1');
    db.exec('DROP TABLE documents_fts');

    try {
      const failed = await updateDoc(created.id, '# FTS 失败\n\nv2', created.versionCount);
      expect(failed.status).toBe(500);

      expect(readBody(created.id)).toBe('# FTS 失败\n\nv1');
      expect((db.prepare('SELECT version_count FROM documents WHERE id = ?').get(created.id) as any).version_count).toBe(
        created.versionCount
      );
      expect(artifacts(created.id)).toEqual([]);
    } finally {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          document_id UNINDEXED,
          title,
          body,
          category,
          tags,
          tokenize = 'unicode61'
        );
      `);
    }

    const retried = await updateDoc(created.id, '# FTS 失败\n\nv2', created.versionCount);
    expect(retried.status).toBe(200);
    const fts = db.prepare('SELECT body FROM documents_fts WHERE document_id = ?').get(created.id) as any;
    expect(fts.body).toContain('v2');
  });

  // -------------------------------------------------------------------------
  it('serialises two concurrent saves: exactly one wins and the other gets 409', async () => {
    const created = await createDoc('# 双客户端\n\nv1');
    const [a, b] = await Promise.all([
      updateDoc(created.id, '# 双客户端\n\nclient-A', created.versionCount),
      updateDoc(created.id, '# 双客户端\n\nclient-B', created.versionCount),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    expect(readBody(created.id)).toBe(parseFrontmatter(winner.body.data.rawMarkdown).body.trim());
    expect((db.prepare('SELECT version_count FROM documents WHERE id = ?').get(created.id) as any).version_count).toBe(
      created.versionCount + 1
    );
    expect(revisionCount(created.id)).toBe(2);
  });

  // -------------------------------------------------------------------------
  it('recovers an interrupted save from the backup when the DB was not committed', async () => {
    const created = await createDoc('# 崩溃恢复\n\nv1');
    const folder = path.join(testDataDir, 'documents', created.id);
    const rawV1 = fs.readFileSync(filePath(created.id), 'utf-8');

    // Simulate: new file renamed into place, crash before the DB commit.
    fs.writeFileSync(path.join(folder, 'index.md.bak'), rawV1, 'utf-8');
    fs.writeFileSync(path.join(folder, '.save.pending'), new Date().toISOString(), 'utf-8');
    fs.writeFileSync(filePath(created.id), '# 崩溃恢复\n\nuncommitted', 'utf-8');

    await documentService.recoverPendingSaves();

    expect(readBody(created.id)).toBe('# 崩溃恢复\n\nv1');
    expect(fs.existsSync(path.join(folder, 'index.md.bak'))).toBe(false);
    expect(fs.existsSync(path.join(folder, '.save.pending'))).toBe(false);
  });

  it('discards a stale backup when the DB already reflects the new file', async () => {
    const created = await createDoc('# 已提交恢复\n\nv1');
    const updated = await updateDoc(created.id, '# 已提交恢复\n\nv2', created.versionCount);
    expect(updated.status).toBe(200);

    const folder = path.join(testDataDir, 'documents', created.id);
    fs.writeFileSync(path.join(folder, 'index.md.bak'), '# 已提交恢复\n\nv1', 'utf-8');
    fs.writeFileSync(path.join(folder, '.save.pending'), new Date().toISOString(), 'utf-8');

    await documentService.recoverPendingSaves();

    expect(readBody(created.id)).toBe('# 已提交恢复\n\nv2');
    expect(fs.existsSync(path.join(folder, 'index.md.bak'))).toBe(false);
    expect(fs.existsSync(path.join(folder, '.save.pending'))).toBe(false);
  });

  it('removes an uncommitted orphan file left by an interrupted create', async () => {
    const orphanId = `doc_orphan_${Date.now().toString(36)}`;
    const folder = path.join(testDataDir, 'documents', orphanId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.md'), '# never committed', 'utf-8');
    fs.writeFileSync(path.join(folder, '.save.pending'), new Date().toISOString(), 'utf-8');

    await documentService.recoverPendingSaves();

    expect(fs.existsSync(folder)).toBe(false);
  });
});
