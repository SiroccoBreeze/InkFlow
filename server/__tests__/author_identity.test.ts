import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import { documentService, parseFrontmatter } from '../services/documentService';
import { getDatabase, closeDatabase, generateId } from '../db/sqlite';

/**
 * Author identity data flow:
 * - A new document without an author must default to the verified owner name.
 * - An explicit custom byline chosen by the owner is preserved.
 * - An edit that omits the author must never overwrite the recorded byline.
 * - A non-owner principal can never claim someone else's name through `author`.
 * - The resulting Markdown frontmatter and API responses agree.
 */

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_author_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_author_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'author-identity-init-key-abcdef0123456789';
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

function filePath(docId: string): string {
  return path.join(testDataDir, 'documents', docId, 'index.md');
}

function frontmatterOf(docId: string): Record<string, any> {
  return parseFrontmatter(fs.readFileSync(filePath(docId), 'utf-8')).frontmatter;
}

async function createViaApi(body: Record<string, any>) {
  const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  return request(app)
    .post('/api/v1/documents')
    .set(auth())
    .send({
      title: `作者身份测试 ${unique}`,
      slug: `author-identity-${unique}`,
      rawMarkdown: '# 作者身份测试\n\n正文',
      category: '安全与数据主权',
      tags: [],
      status: 'draft',
      ...body,
    });
}

describe('Document author identity', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'author_owner',
      password: 'AuthorIdentityPassword!',
      email: 'author-owner@inkflow.local',
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

  it('defaults a new document without author to the verified owner identity', async () => {
    const res = await createViaApi({});
    expect(res.status).toBe(201);

    const docId = res.body.data.id as string;
    expect(res.body.data.author).toBe('author_owner');
    expect(frontmatterOf(docId).author).toBe('author_owner');

    const single = await request(app).get(`/api/v1/documents/${docId}`).set(auth());
    expect(single.status).toBe(200);
    expect(single.body.data.author).toBe('author_owner');

    const list = await request(app).get('/api/v1/documents').set(auth());
    expect(list.status).toBe(200);
    const listed = list.body.data.find((d: any) => d.id === docId);
    expect(listed?.author).toBe('author_owner');
  });

  it('keeps an explicit custom byline chosen by the owner', async () => {
    const res = await createViaApi({ author: 'Pen Name' });
    expect(res.status).toBe(201);
    expect(res.body.data.author).toBe('Pen Name');
    expect(frontmatterOf(res.body.data.id).author).toBe('Pen Name');
  });

  it('does not overwrite the recorded author when an update omits it', async () => {
    const created = await createViaApi({ author: 'Original Byline' });
    expect(created.status).toBe(201);

    const updated = await request(app)
      .put(`/api/v1/documents/${created.body.data.id}`)
      .set(auth())
      .send({
        title: '作者身份测试（更新）',
        rawMarkdown: '# 作者身份测试\n\n更新后的正文',
        expectedVersionCount: created.body.data.versionCount,
      });

    expect(updated.status).toBe(200);
    expect(updated.body.data.author).toBe('Original Byline');
    expect(frontmatterOf(created.body.data.id).author).toBe('Original Byline');
  });

  it('rejects control characters in the author field', async () => {
    const res = await createViaApi({ author: 'Bad\nAuthor' });
    expect(res.status).toBe(400);
  });

  it('pins a non-owner principal to their own name instead of the requested byline', async () => {
    const readerId = generateId('usr');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, NULL, 'x', 'reader', 1, ?, ?)`
    ).run(readerId, 'reader_user', now, now);

    const docId = `doc_reader_${crypto.randomBytes(4).toString('hex')}`;
    const saved = await documentService.saveDocument(
      {
        id: docId,
        title: '非 Owner 创建',
        slug: `non-owner-${docId}`,
        rawMarkdown: '# 非 Owner 创建\n\n正文',
        category: '安全与数据主权',
        tags: [],
        author: 'Victim Owner',
      },
      readerId,
      'reader create'
    );
    expect(saved.author).toBe('reader_user');
    expect(frontmatterOf(docId).author).toBe('reader_user');

    // An edit by the same reader must not overwrite the existing byline either.
    const edited = await documentService.saveDocument(
      {
        id: docId,
        title: '非 Owner 编辑',
        slug: `non-owner-${docId}`,
        rawMarkdown: '# 非 Owner 编辑\n\n更新',
        category: '安全与数据主权',
        tags: [],
        author: 'Another Victim',
      },
      readerId,
      'reader update'
    );
    expect(edited.author).toBe('reader_user');
    expect(frontmatterOf(docId).author).toBe('reader_user');
  });
});
