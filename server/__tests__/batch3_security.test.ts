import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import { documentService } from '../services/documentService';
import { getDatabase, closeDatabase, generateId, hashPassword } from '../db/sqlite';
import { renderMarkdown } from '../../src/services/markdown';

// Isolated database + storage for this suite (Batch 3: SEC-006 … SEC-011)
const testDbPath = path.join(os.tmpdir(), `inkflow_b3_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`);
const testDataDir = path.join(os.tmpdir(), `inkflow_b3_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
const INIT_KEY = 'batch3-test-init-key-abcdef0123456789';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1', apiRouter);

describe('InkFlow Batch 3 Security Hardening', () => {
  let db: any;
  let ownerId: string;
  let ownerToken: string;

  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
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
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // SEC-006
  // -------------------------------------------------------------------------
  describe('SEC-006 First-run owner initialization guard', () => {
    it('rejects initialization without the one-time key (401)', async () => {
      const res = await request(app).post('/api/v1/auth/init').send({
        username: 'attacker',
        password: 'AttackerPass123!',
      });
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('INVALID_INIT_KEY');
      expect(authService.isInitialized()).toBe(false);
    });

    it('rejects initialization with a wrong key (403)', async () => {
      const res = await request(app).post('/api/v1/auth/init').send({
        initKey: 'totally-wrong-key-value',
        username: 'attacker',
        password: 'AttackerPass123!',
      });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('INVALID_INIT_KEY');
      expect(authService.isInitialized()).toBe(false);
    });

    it('reports initialization availability honestly via /auth/status', async () => {
      const res = await request(app).get('/api/v1/auth/status');
      expect(res.status).toBe(200);
      expect(res.body.data.isInitialized).toBe(false);
      expect(res.body.data.canInitialize).toBe(true);
    });

    it('accepts the correct key exactly once and permanently closes initialization', async () => {
      const first = await request(app).post('/api/v1/auth/init').send({
        initKey: INIT_KEY,
        username: 'batch3_owner',
        password: 'Batch3OwnerPassword!',
        email: 'batch3@inkflow.local',
      });
      expect(first.status).toBe(201);
      expect(first.body.data?.token).toBeDefined();
      expect(first.body.data?.recoveryCode).toMatch(/^INK-/);

      ownerId = first.body.data.user.id;
      ownerToken = first.body.data.token;

      // Same key, same request → permanently rejected
      const second = await request(app).post('/api/v1/auth/init').send({
        initKey: INIT_KEY,
        username: 'intruder',
        password: 'IntruderPassword123!',
      });
      expect(second.status).toBe(403);
      expect(second.body.error?.code).toBe('ALREADY_INITIALIZED');

      // Only one owner exists
      const count = (db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'owner'").get() as any).c;
      expect(count).toBe(1);

      // One-way marker persisted
      const marker = db.prepare("SELECT value FROM system_settings WHERE key = 'owner_initialized'").get() as any;
      expect(marker?.value).toBe('1');
    });

    it('only one of two concurrent initializations can succeed', async () => {
      // Real concurrency must be exercised across separate OS processes: Node's built-in
      // sqlite driver is synchronous, so two async calls in one process never truly race.
      const { spawn } = await import('node:child_process');
      const concurrencyDbPath = path.join(
        os.tmpdir(),
        `inkflow_b3_race_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
      );
      const workerScript = path.join(testDataDir, `race_worker_${Date.now()}.mjs`);
      await fsPromises.mkdir(testDataDir, { recursive: true });
      await fsPromises.writeFile(
        workerScript,
        `
import { authService } from ${JSON.stringify(path.resolve(__dirname, '../services/authService.ts'))};
const username = process.argv[2];
const result = authService.initializeOwner({
  initKey: process.env.INKFLOW_INIT_KEY,
  username,
  password: username + '-Password-123456!',
});
process.stdout.write(JSON.stringify({ success: result.success, message: result.message || result.code || '' }));
`,
        'utf-8'
      );

      const tsxBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
      const runWorker = (username: string) =>
        new Promise<{ success: boolean; message?: string }>(resolve => {
          const child = spawn(tsxBin, [workerScript, username], {
            env: {
              ...process.env,
              INKFLOW_DB_PATH: concurrencyDbPath,
              INKFLOW_DATA_DIR: testDataDir,
              INKFLOW_INIT_KEY: INIT_KEY,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          child.stdout.on('data', d => (stdout += d.toString()));
          child.on('close', () => {
            try {
              resolve(JSON.parse(stdout));
            } catch {
              resolve({ success: false, message: 'worker-failed' });
            }
          });
        });

      try {
        const results = await Promise.all([runWorker('race_owner_a'), runWorker('race_owner_b')]);
        const successes = results.filter(r => r.success);
        expect(successes.length).toBe(1);

        const { DatabaseSync } = await import('node:sqlite');
        const checkDb = new DatabaseSync(concurrencyDbPath);
        const ownerCount = (checkDb.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'owner'").get() as any).c;
        checkDb.close();
        expect(ownerCount).toBe(1);
      } finally {
        for (const suffix of ['', '-wal', '-shm']) {
          const p = `${concurrencyDbPath}${suffix}`;
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        if (fs.existsSync(workerScript)) fs.unlinkSync(workerScript);
      }
    });

    it('rolls back completely when initialization fails mid-transaction (no half-initialized state)', () => {
      // Simulate a conflicting username from a pre-existing non-owner account on a fresh DB.
      const rollbackDbPath = path.join(
        os.tmpdir(),
        `inkflow_b3_rollback_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
      );
      const previousDbPath = process.env.INKFLOW_DB_PATH;
      process.env.INKFLOW_DB_PATH = rollbackDbPath;

      try {
        closeDatabase();
        const rollbackDb = getDatabase();
        const now = new Date().toISOString();
        rollbackDb
          .prepare(`
            INSERT INTO users (id, username, email, password_hash, role, is_active, created_at, updated_at)
            VALUES ('usr_conflict', 'owner', NULL, ?, 'reader', 1, ?, ?)
          `)
          .run(hashPassword('whatever123'), now, now);

        const result = authService.initializeOwner({
          initKey: INIT_KEY,
          username: 'owner',
          password: 'RollbackPassword123!',
        });

        expect(result.success).toBe(false);
        // Nothing was committed: no owner user, no session, no marker
        const ownerCount = (rollbackDb.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'owner'").get() as any).c;
        expect(ownerCount).toBe(0);
        const sessionCount = (rollbackDb.prepare('SELECT COUNT(*) as c FROM sessions').get() as any).c;
        expect(sessionCount).toBe(0);
        const marker = rollbackDb.prepare("SELECT value FROM system_settings WHERE key = 'owner_initialized'").get() as any;
        expect(marker).toBeUndefined();
        // Initialization remains possible after the failed attempt
        expect(authService.isInitialized()).toBe(false);
      } finally {
        closeDatabase();
        process.env.INKFLOW_DB_PATH = previousDbPath;
        for (const suffix of ['', '-wal', '-shm']) {
          const p = `${rollbackDbPath}${suffix}`;
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        db = getDatabase();
      }
    });

    it('disables initialization entirely when INKFLOW_INIT_KEY is not configured', async () => {
      const savedKey = process.env.INKFLOW_INIT_KEY;
      delete process.env.INKFLOW_INIT_KEY;
      try {
        // With an owner already present the status endpoint must still report initialized
        const status = await request(app).get('/api/v1/auth/status');
        expect(status.body.data.canInitialize).toBe(false);
        expect(authService.isInitializationKeyConfigured()).toBe(false);
      } finally {
        process.env.INKFLOW_INIT_KEY = savedKey;
      }
    });
  });

  // -------------------------------------------------------------------------
  // SEC-007
  // -------------------------------------------------------------------------
  describe('SEC-007 Asset anonymous access uses exact document↔asset associations', () => {
    async function createAsset(filename = 'diagram.png'): Promise<string> {
      const assetsDir = path.join(testDataDir, 'assets');
      await fsPromises.mkdir(assetsDir, { recursive: true });
      const assetId = generateId('ast');
      const diskName = `${assetId}.png`;
      await fsPromises.writeFile(path.join(assetsDir, diskName), Buffer.from('89504e470d0a1a0a', 'hex'));
      db.prepare(`
        INSERT INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
        VALUES (?, ?, ?, ?, 'image/png', 8, 'x', ?)
      `).run(assetId, ownerId, filename, `assets/${diskName}`, new Date().toISOString());
      return assetId;
    }

    async function createDocWithAsset(
      opts: { visibility: 'public' | 'private' | 'unlisted'; status: 'draft' | 'published' | 'archived'; body: string },
      docId: string
    ) {
      return documentService.saveDocument(
        {
          id: docId,
          title: `Doc ${docId}`,
          slug: docId,
          rawMarkdown: opts.body,
          category: '安全与数据主权',
          tags: [],
          visibility: opts.visibility,
          status: opts.status,
        },
        ownerId
      );
    }

    it('allows anonymous access to an asset referenced by a public+published document', async () => {
      const assetId = await createAsset('public-diagram.png');
      await createDocWithAsset(
        {
          visibility: 'public',
          status: 'published',
          body: `# 公开文章\n\n![图](${`/api/v1/assets/file/${assetId}`})`,
        },
        'doc-asset-public'
      );

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
    });

    it('denies anonymous access to assets referenced only by private documents', async () => {
      const assetId = await createAsset('private-diagram.png');
      await createDocWithAsset(
        {
          visibility: 'private',
          status: 'published',
          body: `# 私有文章\n\n![图](/api/v1/assets/file/${assetId})`,
        },
        'doc-asset-private'
      );

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(403);
    });

    it('denies anonymous access to assets referenced only by public drafts', async () => {
      const assetId = await createAsset('draft-diagram.png');
      await createDocWithAsset(
        {
          visibility: 'public',
          status: 'draft',
          body: `# 草稿\n\n![图](/api/v1/assets/file/${assetId})`,
        },
        'doc-asset-draft'
      );

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(403);
    });

    it('denies anonymous access to assets referenced only by archived documents', async () => {
      const assetId = await createAsset('archived-diagram.png');
      await createDocWithAsset(
        {
          visibility: 'public',
          status: 'archived',
          body: `# 归档\n\n![图](/api/v1/assets/file/${assetId})`,
        },
        'doc-asset-archived'
      );

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(403);
    });

    it('denies anonymous access to an unreferenced asset', async () => {
      const assetId = await createAsset('orphan.png');
      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(403);
    });

    it('does not grant access merely because a similar filename appears in a public document', async () => {
      const assetId = await createAsset('secret-plans.png');
      await createDocWithAsset(
        {
          visibility: 'public',
          status: 'published',
          body: `# 公开文章\n\n这里提到了 secret-plans.png 这个文件名，但没有真正引用附件。`,
        },
        'doc-asset-filename-only'
      );

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(403);
    });

    it('does not grant access through a forged/unknown asset id', async () => {
      const randomId = `ast_forged_${crypto.randomBytes(6).toString('hex')}`;
      const res = await request(app).get(`/api/v1/assets/file/${randomId}`);
      expect(res.status).toBe(404);
    });

    it('does not grant access to assets of a document that was unpublished after being public', async () => {
      const assetId = await createAsset('unpublish-diagram.png');
      const docId = 'doc-asset-unpublished';
      await createDocWithAsset(
        {
          visibility: 'public',
          status: 'published',
          body: `# 曾公开\n\n![图](/api/v1/assets/file/${assetId})`,
        },
        docId
      );
      expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(200);

      await createDocWithAsset(
        {
          visibility: 'private',
          status: 'draft',
          body: `# 曾公开\n\n![图](/api/v1/assets/file/${assetId})`,
        },
        docId
      );
      expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(403);
    });

    it('still lets the owner access private assets', async () => {
      const assetId = await createAsset('owner-only.png');
      const res = await request(app)
        .get(`/api/v1/assets/file/${assetId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // SEC-011
  // -------------------------------------------------------------------------
  describe('SEC-011 New documents default to private drafts', () => {
    it('creates a private draft when visibility/status are omitted', async () => {
      const res = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: '默认新文档', rawMarkdown: '# 默认新文档\n\n正文', category: '未分类', tags: [] });

      expect(res.status).toBe(201);
      expect(res.body.data.visibility).toBe('private');
      expect(res.body.data.status).toBe('draft');

      const raw = fs.readFileSync(
        path.join(testDataDir, 'documents', res.body.data.id, 'index.md'),
        'utf-8'
      );
      expect(raw).toContain('visibility: "private"');
      expect(raw).toContain('status: "draft"');
    });

    it('publishes only when the owner explicitly sets public + published', async () => {
      const res = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: '显式发布文档',
          rawMarkdown: '# 显式发布\n\n正文',
          category: '未分类',
          tags: [],
          visibility: 'public',
          status: 'published',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.visibility).toBe('public');
      expect(res.body.data.status).toBe('published');

      const anon = await request(app).get(`/api/v1/documents/${res.body.data.id}`);
      expect(anon.status).toBe(200);
    });

    it('keeps an existing published document public when an update omits status', async () => {
      const created = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: '保持公开',
          rawMarkdown: '# 保持公开\n\nv1',
          category: '未分类',
          tags: [],
          visibility: 'public',
          status: 'published',
        });

      const updated = await request(app)
        .put(`/api/v1/documents/${created.body.data.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: '保持公开', rawMarkdown: '# 保持公开\n\nv2', category: '未分类', tags: [] });

      expect(updated.status).toBe(200);
      expect(updated.body.data.visibility).toBe('public');
      expect(updated.body.data.status).toBe('published');
    });

    it('rejects invalid visibility/status values from the owner API', async () => {
      const badVis = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: 'x', rawMarkdown: '# x', visibility: 'everyone', status: 'published' });
      expect(badVis.status).toBe(400);

      const badStatus = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: 'x', rawMarkdown: '# x', visibility: 'public', status: 'live' });
      expect(badStatus.status).toBe(400);
    });

    it('forbids anonymous users from creating or changing publication state', async () => {      const createRes = await request(app)
        .post('/api/v1/documents')
        .send({ title: '匿名创建', rawMarkdown: '# x', visibility: 'public', status: 'published' });
      expect(createRes.status).toBe(401);

      const updateRes = await request(app)
        .put('/api/v1/documents/doc-asset-private')
        .send({ status: 'published', visibility: 'public' });
      expect(updateRes.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // SEC-010
  // -------------------------------------------------------------------------
  describe('SEC-010 Markdown sanitizer hardening', () => {
    it('always strips srcset from images', () => {
      const html = renderMarkdown(`<img src="https://example.com/a.png" srcset="https://example.com/a@2x.png 2x">`);
      expect(html).not.toContain('srcset');
      expect(html).toContain('src="https://example.com/a.png"');
    });

    it('rejects data URIs whose decoded bytes do not match the declared MIME', () => {
      // Declares PNG but carries GIF bytes
      const gifBytesBase64 = Buffer.from('GIF89a\x01\x00\x01\x00', 'binary').toString('base64');
      const html = renderMarkdown(`<img src="data:image/png;base64,${gifBytesBase64}">`);
      expect(html).not.toContain('src="data:image/png');
    });

    it('rejects non-base64, malformed and oversized-scheme data URIs', () => {
      expect(renderMarkdown(`<img src="data:image/png,rawbytes">`)).not.toContain('src="data:');
      expect(renderMarkdown(`<img src="data:image/png;base64,!!!!">`)).not.toContain('src="data:');
      expect(renderMarkdown(`<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">`)).not.toContain('src="data:');
      expect(renderMarkdown(`<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">`)).not.toContain(
        'src="data:'
      );
    });

    it('accepts a genuinely valid PNG data URI', () => {
      const validPng =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const html = renderMarkdown(`![Pixel](${validPng})`);
      expect(html).toContain('src="data:image/png;base64,');
    });

    it('blocks protocol-relative and control-character-obfuscated hrefs', () => {
      expect(renderMarkdown(`<a href="//evil.example/x">x</a>`)).not.toContain('//evil.example');
      expect(renderMarkdown(`<a href="java\tscript:alert(1)">x</a>`)).not.toContain('javascript:');
      expect(renderMarkdown(`<a href="data :text/html;base64,PHNjcmlwdD4=">x</a>`)).not.toContain('data :text/html');
      expect(renderMarkdown(`<a href="file:///etc/passwd">x</a>`)).not.toContain('file:///etc/passwd');
    });

    it('cannot be bypassed through nested attributes or encoded payloads', () => {
      const nested = `<img src=x onerror="alert(1)" srcdoc="<script>alert(2)</script>"><iframe srcdoc="<script>alert(3)</script>"></iframe>`;
      const html = renderMarkdown(nested);
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('srcdoc');
      expect(html).not.toContain('<iframe');
      expect(html).not.toContain('alert(');

      const encoded = `[x](&#106;avascript:alert(1))`;
      const encodedHtml = renderMarkdown(encoded);
      expect(encodedHtml).not.toContain('javascript:alert');
    });

    it('preserves ordinary markdown features (headings, tables, code blocks, links, images)', () => {
      const md = [
        '## 标题二',
        '',
        '| A | B |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '```ts',
        'const a = 1;',
        '```',
        '',
        '[普通链接](https://example.com/page)',
        '',
        '![普通图片](https://example.com/pic.png)',
      ].join('\n');

      const html = renderMarkdown(md);
      expect(html).toContain('<h2');
      expect(html).toContain('<table');
      expect(html).toContain('language-typescript');
      expect(html).toContain('href="https://example.com/page"');
      expect(html).toContain('src="https://example.com/pic.png"');
    });
  });

  // -------------------------------------------------------------------------
  // Public API field exposure
  // -------------------------------------------------------------------------
  // Public API field exposure
  // -------------------------------------------------------------------------
  describe('Anonymous API responses do not leak internal fields', () => {
    it('omits file_path, owner_id and content_hash from public document list/detail', async () => {
      await documentService.saveDocument(
        {
          id: 'doc-public-fields',
          title: '公开字段检查',
          slug: 'public-fields',
          rawMarkdown: '# 公开字段检查\n\n正文',
          category: '未分类',
          tags: [],
          visibility: 'public',
          status: 'published',
        },
        ownerId
      );

      const detail = await request(app).get('/api/v1/documents/doc-public-fields');
      expect(detail.status).toBe(200);
      expect(detail.body.data.file_path).toBeUndefined();
      expect(detail.body.data.owner_id).toBeUndefined();
      expect(detail.body.data.content_hash).toBeUndefined();

      const list = await request(app).get('/api/v1/documents?pageSize=100');
      expect(list.status).toBe(200);
      for (const doc of list.body.data) {
        expect(doc.file_path).toBeUndefined();
        expect(doc.owner_id).toBeUndefined();
        expect(doc.content_hash).toBeUndefined();
      }
    });

    it('still provides internal fields to the owner', async () => {
      const res = await request(app)
        .get('/api/v1/documents/doc-public-fields')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.file_path).toBeDefined();
      expect(res.body.data.owner_id).toBe(ownerId);
    });
  });

  // -------------------------------------------------------------------------
  // Additional audit findings (rate limiting, share passwords, path handling)
  // -------------------------------------------------------------------------
  describe('Additional audit hardening', () => {
    it('password-protected shares accept the correct password and reject wrong ones', async () => {
      const docId = 'doc-share-password';
      await documentService.saveDocument(
        {
          id: docId,
          title: '受保护的分享文档',
          slug: 'share-password',
          rawMarkdown: '# 受保护\n\n正文',
          category: '未分类',
          tags: [],
          visibility: 'unlisted',
          status: 'published',
        },
        ownerId
      );

      const create = await request(app)
        .post('/api/v1/shares')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ documentId: docId, password: 'SharePass123!' });
      expect(create.status).toBe(201);
      const token = create.body.data.token;

      const noPassword = await request(app).post('/api/v1/shares/access').send({ token });
      expect(noPassword.status).toBe(403);

      const wrongPassword = await request(app)
        .post('/api/v1/shares/access')
        .send({ token, password: 'WrongPass123!' });
      expect(wrongPassword.status).toBe(403);

      const correctPassword = await request(app)
        .post('/api/v1/shares/access')
        .send({ token, password: 'SharePass123!' });
      expect(correctPassword.status).toBe(200);
      // Share recipients must not receive internal paths / owner ids
      expect(correctPassword.body.data.doc.file_path).toBeUndefined();
      expect(correctPassword.body.data.doc.owner_id).toBeUndefined();
    });

    it('rejects document ids that could escape the documents directory', async () => {
      const traversal = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          id: '../../etc/passwd',
          title: '逃逸尝试',
          rawMarkdown: '# x',
          visibility: 'private',
          status: 'draft',
        });
      // Either rejected outright (400/500) or never written outside storage/documents
      expect([400, 500]).toContain(traversal.status);
      expect(fs.existsSync(path.join(testDataDir, '..', 'etc', 'passwd'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Path traversal hardening for asset storage paths
  // -------------------------------------------------------------------------
  describe('Asset storage path containment', () => {
    it('never serves a file outside the storage root via a crafted storage_path', async () => {
      const evilId = generateId('ast_evil');
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
        VALUES (?, ?, 'evil.png', '../../../../etc/passwd', 'image/png', 1, 'x', ?)
      `).run(evilId, ownerId, now);

      const res = await request(app)
        .get(`/api/v1/assets/file/${evilId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('root:');
    });

    it('never follows a symlink that escapes the storage root', async () => {
      const assetsDir = path.join(testDataDir, 'assets');
      await fsPromises.mkdir(assetsDir, { recursive: true });

      const outsideDir = path.join(testDataDir, '..', `inkflow_outside_${crypto.randomBytes(4).toString('hex')}`);
      await fsPromises.mkdir(outsideDir, { recursive: true });
      const secretPath = path.join(outsideDir, 'secret.txt');
      await fsPromises.writeFile(secretPath, 'TOP_SECRET_OUTSIDE_STORAGE');

      const linkName = `ast_link_${crypto.randomBytes(4).toString('hex')}.txt`;
      const linkPath = path.join(assetsDir, linkName);
      await fsPromises.symlink(secretPath, linkPath);

      const linkId = generateId('ast_link');
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
        VALUES (?, ?, 'link.txt', ?, 'text/plain', 1, 'x', ?)
      `).run(linkId, ownerId, `assets/${linkName}`, now);

      try {
        // Even an authenticated owner must not read through an escaping symlink
        const res = await request(app)
          .get(`/api/v1/assets/file/${linkId}`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(res.status).toBe(404);
        expect(res.text).not.toContain('TOP_SECRET_OUTSIDE_STORAGE');
      } finally {
        await fsPromises.rm(linkPath, { force: true });
        await fsPromises.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });
});
