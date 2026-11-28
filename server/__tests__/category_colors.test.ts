import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import { getDatabase, closeDatabase } from '../db/sqlite';

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_category_colors_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_category_colors_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'category-color-init-key-abcdef0123456789';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/v1', apiRouter);

let db: any;
let ownerToken: string;

const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
const suffix = crypto.randomBytes(3).toString('hex');

describe('Category colors', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'category_color_owner',
      password: 'CategoryColorPassword!',
      email: 'category-color@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerToken = init.token!;
  });

  afterAll(() => {
    closeDatabase();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      const walPath = `${testDbPath}-wal`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      const shmPath = `${testDbPath}-shm`;
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('returns a color for every seeded default category', async () => {
    const res = await request(app).get('/api/v1/categories');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const category of res.body.data) {
      expect(category.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('creates a category with a normalized color and rejects invalid colors', async () => {
    const name = `颜色测试-${suffix}`;
    const created = await request(app)
      .post('/api/v1/categories')
      .set(auth())
      .send({ name, slug: `color-${suffix}`, color: '#ABC' });
    expect(created.status).toBe(201);
    expect(created.body.data.color).toBe('#aabbcc');

    const invalid = await request(app)
      .post('/api/v1/categories')
      .set(auth())
      .send({ name: `非法颜色-${suffix}`, color: 'red' });
    expect(invalid.status).toBe(400);

    const duplicate = await request(app)
      .post('/api/v1/categories')
      .set(auth())
      .send({ name, color: '#0284c7' });
    expect(duplicate.status).toBe(409);
  });

  it('updates color and name in place, renaming documents without duplicating rows', async () => {
    const oldName = `可改色分类-${suffix}`;
    const newName = `已改色分类-${suffix}`;
    const created = await request(app)
      .post('/api/v1/categories')
      .set(auth())
      .send({ name: oldName, slug: `renamable-${suffix}`, color: '#0284c7' });
    expect(created.status).toBe(201);
    const categoryId = created.body.data.id as string;

    const doc = await request(app)
      .post('/api/v1/documents')
      .set(auth())
      .send({
        title: `分类颜色文档 ${suffix}`,
        slug: `category-color-doc-${suffix}`,
        rawMarkdown: '# 分类颜色文档\n\n正文',
        category: oldName,
        tags: [],
        visibility: 'private',
        status: 'draft',
      });
    expect(doc.status).toBe(201);

    const updated = await request(app)
      .put(`/api/v1/categories/${categoryId}`)
      .set(auth())
      .send({ name: newName, color: '#FF0000' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ id: categoryId, name: newName, color: '#ff0000' });

    const list = await request(app).get('/api/v1/categories');
    const rows = (list.body.data as any[]).filter(
      c => c.name === oldName || c.name === newName
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: categoryId, name: newName, color: '#ff0000' });

    const renamedDoc = db
      .prepare('SELECT category_name FROM documents WHERE title = ?')
      .get(`分类颜色文档 ${suffix}`) as any;
    expect(renamedDoc.category_name).toBe(newName);

    const invalidColor = await request(app)
      .put(`/api/v1/categories/${categoryId}`)
      .set(auth())
      .send({ name: newName, color: 'not-a-color' });
    expect(invalidColor.status).toBe(400);
  });

  it('requires owner authentication to change categories', async () => {
    const res = await request(app)
      .put('/api/v1/categories/cat_arch')
      .send({ name: '架构与系统', color: '#000000' });
    expect(res.status).toBe(401);
  });
});
