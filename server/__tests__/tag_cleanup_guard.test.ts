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
});
