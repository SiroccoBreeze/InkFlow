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
import {
  documentService,
  extractAssetReferences,
  extractAssetIdFromHref,
} from '../services/documentService';
import { getDatabase, closeDatabase, generateId } from '../db/sqlite';

// Isolated database + storage for this suite (Batch 4: SEC-012 / SEC-013)
const testDbPath = path.join(os.tmpdir(), `inkflow_b4_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`);
const testDataDir = path.join(os.tmpdir(), `inkflow_b4_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
const INIT_KEY = 'batch4-test-init-key-abcdef0123456789';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1', apiRouter);

describe('SEC-013 Asset references are extracted from the Markdown AST', () => {
  let db: any;
  let ownerId: string;
  let ownerToken: string;

  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'batch4_owner',
      password: 'Batch4OwnerPassword!',
      email: 'batch4@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerId = init.user.id;
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
      // ignore
    }
  });

  async function createAsset(filename: string): Promise<string> {
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

  async function saveDoc(
    docId: string,
    body: string,
    opts: { visibility: 'public' | 'private' | 'unlisted'; status: 'draft' | 'published' | 'archived' } = {
      visibility: 'public',
      status: 'published',
    }
  ) {
    return documentService.saveDocument(
      {
        id: docId,
        title: `Doc ${docId}`,
        slug: docId,
        rawMarkdown: body,
        category: '安全与数据主权',
        tags: [],
        visibility: opts.visibility,
        status: opts.status,
      },
      ownerId
    );
  }

  function linkedAssetIds(docId: string): string[] {
    return (db.prepare('SELECT asset_id FROM document_assets WHERE document_id = ? ORDER BY asset_id').all(docId) as any[])
      .map(r => r.asset_id);
  }

  // -------------------------------------------------------------------------
  // Extraction unit behaviour
  // -------------------------------------------------------------------------
  describe('extractAssetReferences()', () => {
    it('extracts IDs from real image nodes', () => {
      expect(extractAssetReferences('![diagram](/api/v1/assets/file/ast_image1)')).toEqual(['ast_image1']);
    });

    it('extracts IDs from real link nodes', () => {
      expect(extractAssetReferences('[下载](/api/v1/assets/file/ast_link1)')).toEqual(['ast_link1']);
    });

    it('keeps the legacy attachment: and asset: schemes working', () => {
      expect(extractAssetReferences('![a](attachment:ast_att1)')).toEqual(['ast_att1']);
      expect(extractAssetReferences('![a](asset:ast_asset1)')).toEqual(['ast_asset1']);
    });

    it('ignores fenced code blocks', () => {
      expect(extractAssetReferences('```\n![x](/api/v1/assets/file/ast_fenced)\n```')).toEqual([]);
      expect(extractAssetReferences('~~~md\n![x](attachment:ast_fenced2)\n~~~')).toEqual([]);
    });

    it('ignores inline code spans', () => {
      expect(extractAssetReferences('`/api/v1/assets/file/ast_inline`')).toEqual([]);
      expect(extractAssetReferences('use `attachment:ast_inline2` here')).toEqual([]);
    });

    it('ignores IDs that only appear as plain text', () => {
      expect(extractAssetReferences('see /api/v1/assets/file/ast_plain in the text')).toEqual([]);
      expect(extractAssetReferences('the id is ast_plain2 and nothing more')).toEqual([]);
    });

    it('ignores raw HTML img tags (not Markdown nodes)', () => {
      expect(extractAssetReferences('<img src="/api/v1/assets/file/ast_html">')).toEqual([]);
    });

    it('ignores filenames and look-alike IDs', () => {
      expect(extractAssetReferences('the file secret.png is mentioned')).toEqual([]);
      expect(extractAssetReferences('ast_filename only')).toEqual([]);
      expect(extractAssetReferences('![a](https://example.com/ast_1.png)')).toEqual([]);
    });

    it('ignores foreign origins and non-supported schemes', () => {
      const hostile = [
        '![a](https://evil.example/api/v1/assets/file/ast_foreign)',
        '![a](//evil.example/api/v1/assets/file/ast_foreign2)',
        '![a](javascript:/api/v1/assets/file/ast_foreign3)',
        '![a](data:/api/v1/assets/file/ast_foreign4)',
      ];
      for (const md of hostile) {
        expect(extractAssetReferences(md)).toEqual([]);
      }
    });

    it('finds references nested in blockquotes, tables and links', () => {
      expect(extractAssetReferences('> ![q](/api/v1/assets/file/ast_quote)')).toEqual(['ast_quote']);
      expect(
        extractAssetReferences('| h |\n| - |\n| ![t](/api/v1/assets/file/ast_table) |')
      ).toEqual(['ast_table']);
      expect(
        extractAssetReferences('[![c](/api/v1/assets/file/ast_inner)](/api/v1/assets/file/ast_outer)')
      ).toEqual(expect.arrayContaining(['ast_inner', 'ast_outer']));
    });

    it('supports reference-style links', () => {
      const md = '[r][ref]\n\n[ref]: /api/v1/assets/file/ast_ref';
      expect(extractAssetReferences(md)).toEqual(['ast_ref']);
    });

    it('normalizes query strings and fragments', () => {
      expect(extractAssetReferences('![a](/api/v1/assets/file/ast_q?x=1#frag)')).toEqual(['ast_q']);
    });

    it('rejects traversal and over-long IDs', () => {
      expect(extractAssetIdFromHref('/api/v1/assets/file/../../etc/passwd')).toBeNull();
      expect(extractAssetIdFromHref('/api/v1/assets/file/ast_x/extra')).toBeNull();
      expect(extractAssetIdFromHref(`/api/v1/assets/file/${'a'.repeat(201)}`)).toBeNull();
    });

    it('fails closed on unparseable input', () => {
      expect(extractAssetReferences('')).toEqual([]);
      expect(extractAssetReferences(undefined as any)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // document_assets association
  // -------------------------------------------------------------------------
  describe('document_assets associations', () => {
    it('creates a link for a real image reference', async () => {
      const assetId = await createAsset('real-image.png');
      await saveDoc('doc-b4-image', `# 图片\n\n![图](/api/v1/assets/file/${assetId})`);
      expect(linkedAssetIds('doc-b4-image')).toEqual([assetId]);
    });

    it('creates a link for a real link reference', async () => {
      const assetId = await createAsset('real-link.png');
      await saveDoc('doc-b4-link', `# 链接\n\n[下载附件](/api/v1/assets/file/${assetId})`);
      expect(linkedAssetIds('doc-b4-link')).toEqual([assetId]);
    });

    it('does not create a link for fenced code blocks', async () => {
      const assetId = await createAsset('fenced.png');
      await saveDoc('doc-b4-fenced', `# 代码\n\n\`\`\`md\n![x](/api/v1/assets/file/${assetId})\n\`\`\``);
      expect(linkedAssetIds('doc-b4-fenced')).toEqual([]);
    });

    it('does not create a link for inline code', async () => {
      const assetId = await createAsset('inline.png');
      await saveDoc('doc-b4-inline', `# 行内代码\n\n引用写法：\`/api/v1/assets/file/${assetId}\``);
      expect(linkedAssetIds('doc-b4-inline')).toEqual([]);
    });

    it('does not create a link for plain text mentions', async () => {
      const assetId = await createAsset('plain-text.png');
      await saveDoc('doc-b4-plain', `# 纯文本\n\n这里提到了 /api/v1/assets/file/${assetId} 但没有引用。`);
      expect(linkedAssetIds('doc-b4-plain')).toEqual([]);
    });

    it('does not create a link from a filename or look-alike id', async () => {
      const assetId = await createAsset('secret-plans.png');
      await saveDoc('doc-b4-filename', `# 文件名\n\n文件 secret-plans.png 与 ${assetId}x 出现在正文中。`);
      expect(linkedAssetIds('doc-b4-filename')).toEqual([]);
    });

    it('removes stale links when the reference is deleted from the document', async () => {
      const assetId = await createAsset('removed.png');
      await saveDoc('doc-b4-remove', `# 有引用\n\n![a](/api/v1/assets/file/${assetId})`);
      expect(linkedAssetIds('doc-b4-remove')).toEqual([assetId]);

      await saveDoc('doc-b4-remove', '# 无引用\n\n正文已移除引用');
      expect(linkedAssetIds('doc-b4-remove')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Anonymous access via HTTP
  // -------------------------------------------------------------------------
  describe('anonymous asset access follows the AST-derived association', () => {
    it('serves an asset referenced by a public+published document', async () => {
      const assetId = await createAsset('public-http.png');
      await saveDoc('doc-b4-public', `# 公开\n\n![a](/api/v1/assets/file/${assetId})`);

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(200);
    });

    it('denies an asset referenced only by a private document', async () => {
      const assetId = await createAsset('private-http.png');
      await saveDoc(
        'doc-b4-private',
        `# 私有\n\n![a](/api/v1/assets/file/${assetId})`,
        { visibility: 'private', status: 'published' }
      );

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(403);
    });

    it('denies an asset whose ID only appears in a code block', async () => {
      const assetId = await createAsset('codeblock-http.png');
      await saveDoc(
        'doc-b4-codeblock',
        `# 代码块\n\n\`\`\`md\n![a](/api/v1/assets/file/${assetId})\n\`\`\``
      );

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(403);
    });

    it('denies an asset whose ID only appears in inline code', async () => {
      const assetId = await createAsset('inline-http.png');
      await saveDoc('doc-b4-inline-http', `# 行内\n\n\`/api/v1/assets/file/${assetId}\``);

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(403);
    });

    it('denies an asset whose ID only appears as plain text', async () => {
      const assetId = await createAsset('plain-http.png');
      await saveDoc('doc-b4-plain-http', `# 纯文本\n\n/api/v1/assets/file/${assetId} 只是一段文字`);

      const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
      expect(res.status).toBe(403);
    });

    it('revokes anonymous access immediately after unpublishing', async () => {
      const assetId = await createAsset('unpublish-http.png');
      const docId = 'doc-b4-unpublish';
      const body = `# 状态变化\n\n![a](/api/v1/assets/file/${assetId})`;

      await saveDoc(docId, body, { visibility: 'public', status: 'published' });
      expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(200);

      await saveDoc(docId, body, { visibility: 'public', status: 'draft' });
      expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(403);

      await saveDoc(docId, body, { visibility: 'public', status: 'published' });
      expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(200);

      await saveDoc(docId, body, { visibility: 'private', status: 'published' });
      expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(403);
    });

    it('revokes access when the reference itself is removed', async () => {
      const assetId = await createAsset('ref-removed-http.png');
      const docId = 'doc-b4-ref-removed';

      await saveDoc(docId, `# 有引用\n\n![a](/api/v1/assets/file/${assetId})`);
      expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(200);

      await saveDoc(docId, '# 无引用\n\n正文已移除');
      expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(403);
    });

    it('still lets the owner fetch a privately referenced asset', async () => {
      const assetId = await createAsset('owner-private-http.png');
      await saveDoc(
        'doc-b4-owner-private',
        `# 私有\n\n![a](/api/v1/assets/file/${assetId})`,
        { visibility: 'private', status: 'draft' }
      );

      const res = await request(app)
        .get(`/api/v1/assets/file/${assetId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Startup rebuild uses the same AST parser
  // -------------------------------------------------------------------------
  describe('startup reference rebuild', () => {
    it('derives associations from the Markdown SSOT, not from code blocks', async () => {
      const assetId = await createAsset('rebuild-http.png');
      await saveDoc('doc-b4-rebuild', `# 重建\n\n![a](/api/v1/assets/file/${assetId})`);

      // Simulate a fresh index: drop all associations, then rebuild from disk
      db.prepare('DELETE FROM document_assets').run();
      expect(db.prepare('SELECT COUNT(*) as c FROM document_assets').get().c).toBe(0);

      await documentService.rebuildAssetReferences();

      const rebuilt = db
        .prepare('SELECT asset_id FROM document_assets WHERE document_id = ?')
        .all('doc-b4-rebuild') as any[];
      expect(rebuilt.map(r => r.asset_id)).toEqual([assetId]);

      // Code-block-only documents must stay unlinked after the rebuild
      const codeDoc = db
        .prepare('SELECT COUNT(*) as c FROM document_assets WHERE document_id = ?')
        .get('doc-b4-codeblock') as any;
      expect(codeDoc.c).toBe(0);
    });
  });
});
