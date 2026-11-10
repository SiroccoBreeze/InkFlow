import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import { getDatabase, closeDatabase, hashPassword, verifyPassword, hashRecoveryCode, generateId } from '../db/sqlite';
import { renderMarkdown } from '../../src/services/markdown';

// Create an isolated temporary SQLite database for this test run
const testDbPath = path.join(os.tmpdir(), `inkflow_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`);
const testDataDir = path.join(os.tmpdir(), `inkflow_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
// One-time initialization key required by SEC-006 (never a production value)
const TEST_INIT_KEY = 'test-only-init-key-0123456789abcdef';
process.env.INKFLOW_INIT_KEY = TEST_INIT_KEY;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1', apiRouter);

describe('InkFlow Security & Access Control Verification', () => {
  let db: any;
  let ownerUser: any;
  let ownerToken: string;

  beforeAll(() => {
    // Reset any existing connection and open isolated test database
    closeDatabase();
    db = getDatabase();

    // Initialize clean test owner
    const initRes = authService.initializeOwner({
      initKey: TEST_INIT_KEY,
      username: 'security_audit_owner',
      password: 'AuditOwnerPassword2026!',
      email: 'audit@inkflow.local',
    });

    expect(initRes.success).toBe(true);
    expect(initRes.user?.id).toBeDefined();
    ownerUser = initRes.user;
    ownerToken = initRes.token!;
  });

  afterAll(() => {
    closeDatabase();
    // Clean up temporary database files
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      const walPath = `${testDbPath}-wal`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      const shmPath = `${testDbPath}-shm`;
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore unlink errors on cleanup
    }
  });

  describe('1. Admin API Authentication Boundaries', () => {
    it('returns 401 when requesting admin APIs without Authorization header', async () => {
      const res = await request(app).post('/api/v1/documents').send({ title: 'Test' });
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when requesting admin APIs with empty Bearer token', async () => {
      const res = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', 'Bearer ')
        .send({ title: 'Test' });
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 for pseudo/dev bypass tokens (token-*, owner_dev_token)', async () => {
      const resDev = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', 'Bearer owner_dev_token')
        .send({ title: 'Test' });
      expect(resDev.status).toBe(401);

      const resSimulated = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', 'Bearer token-1731190000')
        .send({ title: 'Test' });
      expect(resSimulated.status).toBe(401);
    });

    it('returns 401 for an invalid or forged token', async () => {
      const res = await request(app)
        .delete('/api/v1/documents/doc-not-real')
        .set('Authorization', 'Bearer non_existent_token_hex_9999999999999999');
      expect(res.status).toBe(401);
    });

    it('returns 401 for an expired token', async () => {
      const expiredToken = `expired_test_token_${crypto.randomBytes(8).toString('hex')}`;
      const tokenHash = crypto.createHash('sha256').update(expiredToken).digest('hex');
      const now = new Date(Date.now() - 100000).toISOString();
      const past = new Date(Date.now() - 50000).toISOString();

      db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(generateId('sess'), ownerUser.id, tokenHash, past, now, now);

      const res = await request(app)
        .get('/api/v1/revisions/overview')
        .set('Authorization', `Bearer ${expiredToken}`);
      expect(res.status).toBe(401);
    });
  });

  describe('2. Salted scrypt Hashing & Transparent Legacy SHA-256 Migration', () => {
    it('produces salted scrypt formatted hash', () => {
      const rawPassword = 'SecurePassword2026!';
      const hashed = hashPassword(rawPassword);
      expect(hashed.startsWith('scrypt:')).toBe(true);

      const parts = hashed.split(':');
      expect(parts.length).toBe(3);
      expect(parts[1].length).toBe(32); // 16 bytes hex salt
      expect(parts[2].length).toBe(128); // 64 bytes hex derivedKey

      const { isValid, needsRehash } = verifyPassword(rawPassword, hashed);
      expect(isValid).toBe(true);
      expect(needsRehash).toBe(false);

      const wrong = verifyPassword('WrongPassword', hashed);
      expect(wrong.isValid).toBe(false);
    });

    it('verifies legacy SHA-256 hash and flags needsRehash for automatic migration', () => {
      const plain = 'LegacySecret123';
      const legacySha256 = crypto.createHash('sha256').update(plain).digest('hex');

      const { isValid, needsRehash } = verifyPassword(plain, legacySha256);
      expect(isValid).toBe(true);
      expect(needsRehash).toBe(true);
    });
  });

  describe('3. Password Recovery Security & ACID Transaction Concurrency', () => {
    it('strictly rejects the hardcoded MASTER_RECOVERY_CODE', async () => {
      const res = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          recoveryCode: 'RESET-INKFLOW-2026',
          newPassword: 'BrandNewSecurePass123',
        });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('RESET_FAILED');
    });

    it('strictly rejects resetting password with only email address', async () => {
      const res = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          recoveryCode: 'audit@inkflow.local',
          newPassword: 'BrandNewSecurePass123',
        });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('RESET_FAILED');
    });

    it('allows resetting password with valid one-time recovery code, invalidates old sessions, and prevents code reuse', async () => {
      const testCode = 'INK-TEST-1234-RECV-KEY9';
      const codeHash = hashRecoveryCode(testCode);

      // Insert valid un-used recovery code for current owner
      db.prepare(`
        INSERT INTO recovery_codes (id, user_id, code_hash, used_at, created_at)
        VALUES (?, ?, ?, NULL, ?)
      `).run(generateId('rec'), ownerUser.id, codeHash, new Date().toISOString());

      // Create an active session before reset
      const preResetToken = `pre_reset_token_${crypto.randomBytes(8).toString('hex')}`;
      const preResetHash = crypto.createHash('sha256').update(preResetToken).digest('hex');
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 1000000).toISOString();
      db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(generateId('sess'), ownerUser.id, preResetHash, future, now, now);

      // Verify session is active before reset
      const checkBefore = authService.validateSession(preResetToken);
      expect(checkBefore.isValid).toBe(true);

      // Perform reset with the one-time recovery code
      const resetRes = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          recoveryCode: testCode,
          newPassword: 'ResetPasswordSuccess2026!',
        });
      expect(resetRes.status).toBe(200);
      expect(resetRes.body.data?.success).toBe(true);
      expect(resetRes.body.data?.newRecoveryCode).toBeDefined();

      // 1. Old session MUST be invalidated
      const checkAfter = authService.validateSession(preResetToken);
      expect(checkAfter.isValid).toBe(false);

      // 2. Re-using the SAME recovery code must now FAIL
      const reuseRes = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          recoveryCode: testCode,
          newPassword: 'AnotherPassword2026!',
        });
      expect(reuseRes.status).toBe(400);
      expect(reuseRes.body.error?.code).toBe('RESET_FAILED');
    });

    it('handles concurrent recovery attempts: strictly single-use atomic consumption', async () => {
      const raceCode = 'INK-RACE-5678-SAFE-LOCK';
      const codeHash = hashRecoveryCode(raceCode);

      db.prepare(`
        INSERT INTO recovery_codes (id, user_id, code_hash, used_at, created_at)
        VALUES (?, ?, ?, NULL, ?)
      `).run(generateId('rec'), ownerUser.id, codeHash, new Date().toISOString());

      // Execute two concurrent password resets with the exact same recovery code
      const [res1, res2] = await Promise.all([
        request(app).post('/api/v1/auth/reset-password').send({
          recoveryCode: raceCode,
          newPassword: 'ConcurrentPassword1!',
        }),
        request(app).post('/api/v1/auth/reset-password').send({
          recoveryCode: raceCode,
          newPassword: 'ConcurrentPassword2!',
        }),
      ]);

      const statuses = [res1.status, res2.status];
      // Exactly one request must succeed (200), and the other must be rejected (400)
      expect(statuses).toContain(200);
      expect(statuses).toContain(400);
    });
  });

  describe('4. First Owner Initialization Safety & Idempotence', () => {
    it('prevents repeated owner initialization via API and service', async () => {
      // 1. Service direct call (even with the correct key, initialization is closed)
      const repeatRes = authService.initializeOwner({
        initKey: TEST_INIT_KEY,
        username: 'intruder',
        password: 'IntruderPass123!',
      });
      expect(repeatRes.success).toBe(false);
      expect(repeatRes.message).toMatch(/已初始化|无法重复|永久关闭/);

      // 2. HTTP endpoint check
      const httpRes = await request(app).post('/api/v1/auth/init').send({
        username: 'intruder',
        password: 'IntruderPass123!',
      });
      expect(httpRes.status).toBe(403);
    });

    it('enforces database-level uniqueness constraint on owner role', () => {
      // Direct raw DB insert with role='owner' should throw UNIQUE constraint failure
      const now = new Date().toISOString();
      expect(() => {
        db.prepare(`
          INSERT INTO users (id, username, email, password_hash, role, is_active, created_at, updated_at)
          VALUES (?, 'second_owner', 'second@inkflow.local', 'fakehash', 'owner', 1, ?, ?)
        `).run(generateId('usr'), now, now);
      }).toThrow(/UNIQUE constraint failed/i);
    });
  });

  describe('5. Owner Profile & Public Author Permissions', () => {
    it('requires owner authentication for GET /users/profile', async () => {
      // 1. Anonymous request -> 401
      const anonRes = await request(app).get('/api/v1/users/profile');
      expect(anonRes.status).toBe(401);
      expect(anonRes.body.error?.code).toBe('UNAUTHORIZED');

      // 2. Invalid token -> 401
      const invalidRes = await request(app)
        .get('/api/v1/users/profile')
        .set('Authorization', 'Bearer invalid_forged_token');
      expect(invalidRes.status).toBe(401);

      // 3. Valid owner session -> 200 with full profile
      // Create a fresh valid session for testing
      const freshToken = `valid_test_token_${crypto.randomBytes(8).toString('hex')}`;
      const tokenHash = crypto.createHash('sha256').update(freshToken).digest('hex');
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 86400000).toISOString();
      db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(generateId('sess'), ownerUser.id, tokenHash, expires, now, now);

      const validRes = await request(app)
        .get('/api/v1/users/profile')
        .set('Authorization', `Bearer ${freshToken}`);
      expect(validRes.status).toBe(200);
      expect(validRes.body.data?.username).toBe('security_audit_owner');
    });

    it('provides safe public author information without leaking private credentials', async () => {
      const res = await request(app).get('/api/v1/users/public-author');
      expect(res.status).toBe(200);
      expect(res.body.data?.author).toBeDefined();
      expect(res.body.data?.author?.username).toBe('security_audit_owner');
      // Must NOT leak password_hash, recovery codes, or sensitive tokens
      expect(res.body.data?.author?.password_hash).toBeUndefined();
      expect(res.body.data?.author?.recovery_codes).toBeUndefined();
    });
  });

  describe('6. Document & Revision Public vs Private/Draft/Archived Boundaries', () => {
    const docNow = new Date().toISOString();

    it('forbids anonymous access to private documents and their revisions', async () => {
      const privateDocId = 'doc-private-test-1';
      db.prepare(`
        INSERT OR REPLACE INTO documents (
          id, owner_id, slug, title, description, category_name, file_path,
          visibility, status, content_hash, created_at, updated_at
        ) VALUES (
          ?, ?, 'private-doc', '私有绝密文档', '', '安全与数据主权', 'test-priv.md',
          'private', 'published', 'hash-priv', ?, ?
        )
      `).run(privateDocId, ownerUser.id, docNow, docNow);

      const res = await request(app).get(`/api/v1/documents/${privateDocId}`);
      expect(res.status).toBe(404);

      const revRes = await request(app).get(`/api/v1/documents/${privateDocId}/revisions`);
      expect(revRes.status).toBe(404);
    });

    it('forbids anonymous access to public drafts', async () => {
      const draftDocId = 'doc-public-draft-test';
      db.prepare(`
        INSERT OR REPLACE INTO documents (
          id, owner_id, slug, title, description, category_name, file_path,
          visibility, status, content_hash, created_at, updated_at
        ) VALUES (
          ?, ?, 'public-draft', '未发布的公开草稿', '', '认知与方法论', 'test-draft.md',
          'public', 'draft', 'hash-draft', ?, ?
        )
      `).run(draftDocId, ownerUser.id, docNow, docNow);

      const res = await request(app).get(`/api/v1/documents/${draftDocId}`);
      expect(res.status).toBe(404);

      const revRes = await request(app).get(`/api/v1/documents/${draftDocId}/revisions`);
      expect(revRes.status).toBe(404);
    });

    it('forbids anonymous access to public archived documents', async () => {
      const archivedDocId = 'doc-public-archived-test';
      db.prepare(`
        INSERT OR REPLACE INTO documents (
          id, owner_id, slug, title, description, category_name, file_path,
          visibility, status, content_hash, created_at, updated_at
        ) VALUES (
          ?, ?, 'public-archived', '已归档的文档', '', '认知与方法论', 'test-arch.md',
          'public', 'archived', 'hash-arch', ?, ?
        )
      `).run(archivedDocId, ownerUser.id, docNow, docNow);

      const res = await request(app).get(`/api/v1/documents/${archivedDocId}`);
      expect(res.status).toBe(404);

      const revRes = await request(app).get(`/api/v1/documents/${archivedDocId}/revisions`);
      expect(revRes.status).toBe(404);
    });

    it('allows anonymous access to public published documents', async () => {
      const publicDocId = 'doc-public-published-test';
      db.prepare(`
        INSERT OR REPLACE INTO documents (
          id, owner_id, slug, title, description, category_name, file_path,
          visibility, status, content_hash, created_at, updated_at
        ) VALUES (
          ?, ?, 'public-pub', '正式公开文档', '摘要说明', '认知与方法论', 'test-pub.md',
          'public', 'published', 'hash-pub', ?, ?
        )
      `).run(publicDocId, ownerUser.id, docNow, docNow);

      const res = await request(app).get(`/api/v1/documents/${publicDocId}`);
      expect(res.status).toBe(200);
      expect(res.body.data?.title).toBe('正式公开文档');
    });
  });

  describe('7. Markdown Sanitizer Hardening & XSS Prevention', () => {
    it('strips script tags and inline malicious event handlers', () => {
      const malicious = `
# 正常标题

<script>alert('XSS-SCRIPT')</script>

<img src="x" onerror="alert('XSS-ONERROR')" />

<a href="javascript:alert('XSS-LINK')">恶意脚本链接</a>

[安全链接](https://inkflow.org)
`;
      const html = renderMarkdown(malicious);
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert(');
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('javascript:');
      expect(html).toContain('正常标题');
      expect(html).toContain('href="https://inkflow.org"');
    });

    it('disallows data URIs in standard anchor hrefs', () => {
      const markdown = `[HTML Data URI 攻击](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`;
      const html = renderMarkdown(markdown);
      expect(html).not.toContain('data:text/html');
      expect(html).not.toContain('href="data:');
    });

    it('disallows SVG tags and script execution within SVG', () => {
      const markdown = `<svg><script>alert("SVG-XSS")</script><circle cx="50" cy="50" r="40" /></svg>`;
      const html = renderMarkdown(markdown);
      expect(html).not.toContain('<svg>');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('SVG-XSS');
    });

    it('restricts image data URIs to safe raster/webp base64 whitelist and blocks SVG/HTML data URIs', () => {
      // 1. Malicious SVG or HTML data URIs should be blocked
      const svgDataImg = `<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">`;
      const htmlDataImg = `<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">`;
      expect(renderMarkdown(svgDataImg)).not.toContain('src="data:image/svg+xml');
      expect(renderMarkdown(htmlDataImg)).not.toContain('src="data:text/html');

      // 2. Safe 1x1 PNG base64 should be permitted
      const validPngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const safeImg = `![Pixel](${validPngBase64})`;
      const renderedSafe = renderMarkdown(safeImg);
      expect(renderedSafe).toContain('src="data:image/png;base64,');
    });

    it('strips data: and javascript: within img srcset attributes', () => {
      const badSrcset = `<img src="https://example.com/pic.png" srcset="data:text/html;base64,xyz 2x" />`;
      const html = renderMarkdown(badSrcset);
      expect(html).not.toContain('srcset');
    });

    it('safely handles abnormal URLs, vbscript:, and nested HTML', () => {
      const abnormal = `<div><div><a href="vbscript:msgbox(1)">VBScript</a><a href="unknown-proto://test">Custom</a></div></div>`;
      const html = renderMarkdown(abnormal);
      expect(html).not.toContain('vbscript:');
      expect(html).not.toContain('unknown-proto:');
    });
  });

  describe('8. Private Assets Boundary', () => {
    it('prevents anonymous access to private unreferenced assets', async () => {
      const fsPromises = await import('node:fs/promises');
      const assetsDir = path.join(testDataDir, 'assets');
      await fsPromises.mkdir(assetsDir, { recursive: true });
      const assetFileName = `test_priv_${Date.now()}.png`;
      const fullAssetPath = path.join(assetsDir, assetFileName);
      await fsPromises.writeFile(fullAssetPath, Buffer.from('dummy-private-asset'));

      try {
        const assetId = generateId('ast_priv');
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO assets (
            id, owner_id, filename, storage_path, mime_type, size, checksum, created_at
          ) VALUES (
            ?, ?, 'priv.png', ?, 'image/png', 19, 'sum123', ?
          )
        `).run(assetId, ownerUser.id, `assets/${assetFileName}`, now);

        const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
        // Anonymous access must be denied (403) — never served just because the file exists
        expect([403, 404]).toContain(res.status);
        expect(res.status).toBe(403);
      } finally {
        try {
          await fsPromises.unlink(fullAssetPath);
        } catch {
          // ignore
        }
      }
    });
  });
});
