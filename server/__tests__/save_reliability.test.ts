import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import {
  documentService,
  calculateContentHash,
  calculateDocumentHash,
  parseFrontmatter,
  buildFrontmatterBlock,
} from '../services/documentService';
import { getDatabase, closeDatabase } from '../db/sqlite';
import { fileStorage } from '../services/fileStorageService';

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

function docTags(docId: string): string[] {
  return (db
    .prepare(
      `SELECT t.name FROM tags t
       JOIN document_tags dt ON dt.tag_id = t.id
       WHERE dt.document_id = ?
       ORDER BY t.name`
    )
    .all(docId) as any[]).map(row => row.name);
}

/**
 * Builds the full Markdown that a save with only metadata changes would write:
 * same body, new frontmatter (including a new updated_at), like the real save path.
 */
function fullMarkdownWithMetadata(
  docId: string,
  overrides: { title?: string; visibility?: string; status?: string; tags?: string[] }
): string {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
  const raw = fs.readFileSync(filePath(docId), 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return [
    buildFrontmatterBlock({
      id: docId,
      title: overrides.title ?? row.title,
      slug: row.slug,
      category: row.category_name,
      tags: overrides.tags ?? (Array.isArray(frontmatter.tags) ? frontmatter.tags : []),
      visibility: overrides.visibility ?? row.visibility,
      status: overrides.status ?? row.status,
      author: frontmatter.author || 'Hecker',
      pinned: Boolean(row.pinned),
      content_hash: calculateContentHash(body.trim()),
      created_at: row.created_at,
      updated_at: new Date().toISOString(),
    }),
    '',
    body.trim(),
  ].join('\n');
}

/** Simulates: new file renamed into place, crash before the SQLite commit. */
function simulateCrashBeforeCommit(docId: string, newMarkdown: string): string {
  const folder = path.join(testDataDir, 'documents', docId);
  const oldRaw = fs.readFileSync(filePath(docId), 'utf-8');
  fs.writeFileSync(path.join(folder, 'index.md.bak'), oldRaw, 'utf-8');
  fs.writeFileSync(path.join(folder, '.save.pending'), new Date().toISOString(), 'utf-8');
  fs.writeFileSync(filePath(docId), newMarkdown, 'utf-8');
  return oldRaw;
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

    const row = db.prepare('SELECT version_count, content_hash, document_hash FROM documents WHERE id = ?').get(
      created.id
    ) as any;
    expect(row.version_count).toBe(created.versionCount + 1);
    expect(row.content_hash).toBe(calculateContentHash('# 正常保存\n\nv2'));
    expect(row.document_hash).toBe(calculateDocumentHash(fs.readFileSync(filePath(created.id), 'utf-8')));
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

  // -------------------------------------------------------------------------
  // Metadata-only saves have an identical body hash. These scenarios prove that
  // recovery uses the full-document commit marker, not content_hash alone.
  const metadataOnlyScenarios: Array<{
    label: string;
    overrides: { title?: string; visibility?: string; status?: string; tags?: string[] };
  }> = [
    { label: 'title', overrides: { title: '仅修改标题后的版本' } },
    { label: 'visibility', overrides: { visibility: 'public' } },
    { label: 'status', overrides: { status: 'published' } },
    { label: 'tags', overrides: { tags: ['new-tag'] } },
  ];

  for (const scenario of metadataOnlyScenarios) {
    it(`restores the previous version when only ${scenario.label} changed before a crash`, async () => {
      const created = await createDoc('# 元数据恢复\n\n正文保持不变', {
        tags: ['old-tag'],
        visibility: 'private',
        status: 'draft',
      });
      const oldRaw = fs.readFileSync(filePath(created.id), 'utf-8');
      const oldRow = db.prepare('SELECT * FROM documents WHERE id = ?').get(created.id) as any;
      const oldTags = docTags(created.id);
      const oldDocumentHash = calculateDocumentHash(oldRaw);

      const newMarkdown = fullMarkdownWithMetadata(created.id, scenario.overrides);
      // Guard against a false-positive test: body hash must be unchanged.
      expect(parseFrontmatter(newMarkdown).body.trim()).toBe(parseFrontmatter(oldRaw).body.trim());
      expect(calculateContentHash(parseFrontmatter(newMarkdown).body.trim())).toBe(oldRow.content_hash);

      simulateCrashBeforeCommit(created.id, newMarkdown);
      await documentService.recoverPendingSaves();

      // Markdown restored byte-for-byte, so frontmatter metadata is the old one.
      expect(fs.readFileSync(filePath(created.id), 'utf-8')).toBe(oldRaw);

      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(created.id) as any;
      expect(row.title).toBe(oldRow.title);
      expect(row.visibility).toBe(oldRow.visibility);
      expect(row.status).toBe(oldRow.status);
      expect(row.version_count).toBe(oldRow.version_count);
      expect(row.content_hash).toBe(oldRow.content_hash);
      expect(row.document_hash).toBe(oldDocumentHash);
      expect(revisionCount(created.id)).toBe(1);
      expect(docTags(created.id)).toEqual(oldTags);
      expect(artifacts(created.id)).toEqual([]);

      const fm = parseFrontmatter(fs.readFileSync(filePath(created.id), 'utf-8')).frontmatter;
      expect(fm.title).toBe(row.title);
      expect(fm.visibility).toBe(row.visibility);
      expect(fm.status).toBe(row.status);
      const fmTags = Array.isArray(fm.tags) ? [...fm.tags].sort() : [];
      expect(fmTags).toEqual([...oldTags].sort());
    });
  }

  // -------------------------------------------------------------------------
  it('recovers metadata-only changes for legacy rows that have no document_hash', async () => {
    const created = await createDoc('# 旧行恢复\n\nbody', { visibility: 'private', status: 'draft' });
    db.prepare('UPDATE documents SET document_hash = NULL WHERE id = ?').run(created.id);
    const oldRaw = fs.readFileSync(filePath(created.id), 'utf-8');
    const oldRow = db.prepare('SELECT * FROM documents WHERE id = ?').get(created.id) as any;

    const newMarkdown = fullMarkdownWithMetadata(created.id, {
      title: '旧行上未提交的标题',
      visibility: 'public',
      status: 'published',
    });
    simulateCrashBeforeCommit(created.id, newMarkdown);

    await documentService.recoverPendingSaves();

    expect(fs.readFileSync(filePath(created.id), 'utf-8')).toBe(oldRaw);
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(created.id) as any;
    expect(row.title).toBe(oldRow.title);
    expect(row.visibility).toBe('private');
    expect(row.status).toBe('draft');
    expect(row.version_count).toBe(oldRow.version_count);
    // Backfill runs after recovery and records the restored file's full hash.
    expect(row.document_hash).toBe(calculateDocumentHash(oldRaw));
    expect(artifacts(created.id)).toEqual([]);
  });

  it('keeps a committed legacy metadata save instead of reverting it', async () => {
    const created = await createDoc('# 旧行已提交\n\nbody', { visibility: 'private' });
    const oldRaw = fs.readFileSync(filePath(created.id), 'utf-8');
    const slug = (db.prepare('SELECT slug FROM documents WHERE id = ?').get(created.id) as any).slug;

    const updated = await request(app)
      .put(`/api/v1/documents/${created.id}`)
      .set(auth())
      .send({
        title: '旧行已提交的新标题',
        slug,
        rawMarkdown: '# 旧行已提交\n\nbody',
        category: '安全与数据主权',
        tags: [],
        visibility: 'public',
        expectedVersionCount: created.versionCount,
      });
    expect(updated.status).toBe(200);
    const newRaw = fs.readFileSync(filePath(created.id), 'utf-8');

    // Simulate a legacy row (no document_hash) plus a leftover backup.
    db.prepare('UPDATE documents SET document_hash = NULL WHERE id = ?').run(created.id);
    const folder = path.join(testDataDir, 'documents', created.id);
    fs.writeFileSync(path.join(folder, 'index.md.bak'), oldRaw, 'utf-8');
    fs.writeFileSync(path.join(folder, '.save.pending'), new Date().toISOString(), 'utf-8');

    await documentService.recoverPendingSaves();

    expect(fs.readFileSync(filePath(created.id), 'utf-8')).toBe(newRaw);
    expect(artifacts(created.id)).toEqual([]);
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(created.id) as any;
    expect(row.title).toBe('旧行已提交的新标题');
    expect(row.visibility).toBe('public');
    expect(row.document_hash).toBe(calculateDocumentHash(newRaw));
  });

  // -------------------------------------------------------------------------
  it('completes recovery before allowing the new save', async () => {
    const created = await createDoc('# 恢复后保存\n\nold', { visibility: 'private' });
    const oldRaw = fs.readFileSync(filePath(created.id), 'utf-8');
    const uncommitted = fullMarkdownWithMetadata(created.id, { title: '未提交的标题' });
    simulateCrashBeforeCommit(created.id, uncommitted);

    const res = await updateDoc(created.id, '# 恢复后保存\n\nnew', created.versionCount);

    expect(res.status).toBe(200);
    // The uncommitted file was rolled back first, then the new save was applied.
    expect(readBody(created.id)).toBe('# 恢复后保存\n\nnew');
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(created.id) as any;
    expect(row.title).not.toBe('未提交的标题');
    expect(row.version_count).toBe(created.versionCount + 1);
    expect(artifacts(created.id)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it('blocks saves when backup restore fails and preserves the only recovery files', async () => {
    const created = await createDoc('# 恢复失败\n\nold', { visibility: 'private' });
    const oldRaw = fs.readFileSync(filePath(created.id), 'utf-8');
    const uncommitted = fullMarkdownWithMetadata(created.id, { title: '未提交且恢复失败' });
    simulateCrashBeforeCommit(created.id, uncommitted);

    const folder = path.join(testDataDir, 'documents', created.id);
    const backupPath = path.join(folder, 'index.md.bak');
    const markerPath = path.join(folder, '.save.pending');

    // Deterministic, cross-platform fault injection: force the restore primitive
    // to report failure while the real backup file still exists.
    const restoreSpy = vi.spyOn(fileStorage, 'restoreDocumentSaveBackup').mockResolvedValue(false);
    try {
      const blocked = await updateDoc(created.id, '# 恢复失败\n\nnew', created.versionCount);
      expect(blocked.status).toBe(503);
      expect(blocked.body.error.code).toBe('SAVE_RECOVERY_REQUIRED');

      // Original backup untouched, marker still present, uncommitted file untouched.
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(oldRaw);
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.readFileSync(filePath(created.id), 'utf-8')).toBe(uncommitted);

      // A second attempt must not overwrite the backup either.
      const blockedAgain = await updateDoc(created.id, '# 恢复失败\n\nsecond-attempt', created.versionCount);
      expect(blockedAgain.status).toBe(503);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(oldRaw);
      expect(fs.existsSync(markerPath)).toBe(true);

      const row = db.prepare('SELECT version_count, title FROM documents WHERE id = ?').get(created.id) as any;
      expect(row.version_count).toBe(created.versionCount);
      expect(row.title).not.toBe('未提交且恢复失败');
    } finally {
      restoreSpy.mockRestore();
    }

    // Once restoration works again, recovery succeeds and the save runs.
    const retried = await updateDoc(created.id, '# 恢复失败\n\nnew', created.versionCount);
    expect(retried.status).toBe(200);
    expect(readBody(created.id)).toBe('# 恢复失败\n\nnew');
    expect(artifacts(created.id)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it('handles a real rename failure without relying on OS permission bits', async () => {
    const created = await createDoc('# 重命名失败\n\nold');
    const oldRaw = fs.readFileSync(filePath(created.id), 'utf-8');
    const uncommitted = fullMarkdownWithMetadata(created.id, { title: '重命名失败的未提交标题' });
    simulateCrashBeforeCommit(created.id, uncommitted);

    const folder = path.join(testDataDir, 'documents', created.id);
    const backupPath = path.join(folder, 'index.md.bak');
    const markerPath = path.join(folder, '.save.pending');

    // Replace the backup file with a directory: renaming it over index.md fails
    // identically on Windows and Linux, without chmod.
    fs.rmSync(backupPath, { recursive: true, force: true });
    fs.mkdirSync(backupPath);

    try {
      const blocked = await updateDoc(created.id, '# 重命名失败\n\nnew', created.versionCount);
      expect(blocked.status).toBe(503);
      expect(blocked.body.error.code).toBe('SAVE_RECOVERY_REQUIRED');
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.statSync(backupPath).isDirectory()).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.readFileSync(filePath(created.id), 'utf-8')).toBe(uncommitted);
    } finally {
      // Restore a valid backup so the retry can complete.
      fs.rmSync(backupPath, { recursive: true, force: true });
      fs.writeFileSync(backupPath, oldRaw, 'utf-8');
    }

    const retried = await updateDoc(created.id, '# 重命名失败\n\nnew', created.versionCount);
    expect(retried.status).toBe(200);
    expect(readBody(created.id)).toBe('# 重命名失败\n\nnew');
    expect(artifacts(created.id)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it('blocks deletion while recovery cannot complete', async () => {
    const created = await createDoc('# 恢复后删除\n\nold');
    const oldRaw = fs.readFileSync(filePath(created.id), 'utf-8');
    simulateCrashBeforeCommit(created.id, fullMarkdownWithMetadata(created.id, { title: '删除前的未提交标题' }));

    const folder = path.join(testDataDir, 'documents', created.id);
    const restoreSpy = vi.spyOn(fileStorage, 'restoreDocumentSaveBackup').mockResolvedValue(false);
    try {
      const blocked = await request(app).delete(`/api/v1/documents/${created.id}`).set(auth());
      expect(blocked.status).toBe(503);
      expect(blocked.body.error.code).toBe('SAVE_RECOVERY_REQUIRED');
      expect(fs.existsSync(folder)).toBe(true);
      expect(fs.readFileSync(path.join(folder, 'index.md.bak'), 'utf-8')).toBe(oldRaw);
      expect(fs.existsSync(path.join(folder, '.save.pending'))).toBe(true);
    } finally {
      restoreSpy.mockRestore();
    }

    const deleted = await request(app).delete(`/api/v1/documents/${created.id}`).set(auth());
    expect(deleted.status).toBe(200);
    expect(fs.existsSync(folder)).toBe(false);
  });

  // -------------------------------------------------------------------------
  it('serialises a save and a delete on the same document (save first)', async () => {
    const created = await createDoc('# 保存删除竞争\n\nold');
    const folder = path.join(testDataDir, 'documents', created.id);
    const events: string[] = [];

    const originalPrepare = fileStorage.prepareDocumentSave.bind(fileStorage);
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>(resolve => (releasePrepare = resolve));
    let markPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>(resolve => (markPrepareStarted = resolve));
    const prepareSpy = vi.spyOn(fileStorage, 'prepareDocumentSave').mockImplementation(async (...args: any[]) => {
      events.push('prepare:start');
      markPrepareStarted();
      await prepareGate;
      events.push('prepare:continue');
      return originalPrepare(...(args as [string, string | null, string]));
    });

    const originalDeleteFolder = fileStorage.deleteDocumentFolder.bind(fileStorage);
    let pendingAtDelete = true;
    const deleteFolderSpy = vi.spyOn(fileStorage, 'deleteDocumentFolder').mockImplementation(async (docId: string) => {
      events.push('delete-folder');
      // The save finished (and its artifacts were finalized) before the lock
      // was released, so nothing in-use can be deleted here.
      pendingAtDelete = await fileStorage.hasPendingDocumentSave(docId);
      return originalDeleteFolder(docId);
    });

    try {
      const savePromise = updateDoc(created.id, '# 保存删除竞争\n\nsaved', created.versionCount);
      await prepareStarted;

      const deletePromise = request(app).delete(`/api/v1/documents/${created.id}`).set(auth());
      void deletePromise.then(() => {}, () => {});
      // Give the delete request a chance to (incorrectly) proceed.
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(events).not.toContain('delete-folder');

      releasePrepare();
      const [saved, deleted] = await Promise.all([savePromise, deletePromise]);

      expect(saved.status).toBe(200);
      expect(deleted.status).toBe(200);
      expect(events.indexOf('delete-folder')).toBeGreaterThan(events.indexOf('prepare:continue'));
      expect(pendingAtDelete).toBe(false);

      // Save completed first, so delete removed both DB row and folder.
      expect(db.prepare('SELECT id FROM documents WHERE id = ?').get(created.id)).toBeUndefined();
      expect(fs.existsSync(folder)).toBe(false);
    } finally {
      releasePrepare();
      prepareSpy.mockRestore();
      deleteFolderSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  it('serialises a delete and a save on the same document (delete first)', async () => {
    const created = await createDoc('# 删除保存竞争\n\nold');
    const folder = path.join(testDataDir, 'documents', created.id);
    const events: string[] = [];

    const originalDeleteFolder = fileStorage.deleteDocumentFolder.bind(fileStorage);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>(resolve => (releaseDelete = resolve));
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>(resolve => (markDeleteStarted = resolve));
    const deleteFolderSpy = vi.spyOn(fileStorage, 'deleteDocumentFolder').mockImplementation(async (docId: string) => {
      events.push('delete-folder:start');
      markDeleteStarted();
      await deleteGate;
      events.push('delete-folder:end');
      return originalDeleteFolder(docId);
    });

    const originalPrepare = fileStorage.prepareDocumentSave.bind(fileStorage);
    const prepareSpy = vi.spyOn(fileStorage, 'prepareDocumentSave').mockImplementation(async (...args: any[]) => {
      events.push('prepare');
      return originalPrepare(...(args as [string, string | null, string]));
    });

    try {
      const deletePromise = request(app).delete(`/api/v1/documents/${created.id}`).set(auth());
      // Supertest only issues the request when it is awaited/then-ed; start it now.
      void deletePromise.then(() => {}, () => {});
      await deleteStarted;

      const savePromise = updateDoc(created.id, '# 删除保存竞争\n\nrecreated', created.versionCount);
      await new Promise(resolve => setTimeout(resolve, 25));
      // Save must wait for delete to release the per-document lock.
      expect(events).toEqual(['delete-folder:start']);

      releaseDelete();
      const [deleted, saved] = await Promise.all([deletePromise, savePromise]);
      expect(deleted.status).toBe(200);
      expect(saved.status).toBe(200);

      // Delete ran first; the save re-created the document. Either way, DB row and
      // folder must agree (never a live row with a missing folder).
      const row = db.prepare('SELECT id, version_count FROM documents WHERE id = ?').get(created.id) as any;
      const folderExists = fs.existsSync(folder);
      expect(Boolean(row)).toBe(folderExists);
      expect(folderExists).toBe(true);
      expect(row.version_count).toBe(1);
      expect(readBody(created.id)).toBe('# 删除保存竞争\n\nrecreated');
    } finally {
      releaseDelete();
      deleteFolderSpy.mockRestore();
      prepareSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  it('refuses to stage a new save while recovery artifacts exist', async () => {
    const created = await createDoc('# 直接调用保护\n\nold');
    const folder = path.join(testDataDir, 'documents', created.id);
    fs.writeFileSync(path.join(folder, '.save.pending'), new Date().toISOString(), 'utf-8');

    await expect(
      fileStorage.prepareDocumentSave(created.id, 'old', 'new')
    ).rejects.toThrow(/待恢复/);

    // A later recovery clears the marker and allows staging again.
    await documentService.recoverPendingSaves();
    await expect(
      fileStorage.prepareDocumentSave(created.id, 'old', 'new')
    ).resolves.toBeTruthy();
  });

  // -------------------------------------------------------------------------
  it('keeps the committed version and clears the backup when the crash happened after commit', async () => {
    const created = await createDoc('# 已提交元数据\n\nbody', { tags: ['old'] });
    const oldRaw = fs.readFileSync(filePath(created.id), 'utf-8');

    const rowBefore = db.prepare('SELECT slug FROM documents WHERE id = ?').get(created.id) as any;
    const updated = await request(app)
      .put(`/api/v1/documents/${created.id}`)
      .set(auth())
      .send({
        title: '提交后的新标题',
        slug: rowBefore.slug,
        rawMarkdown: '# 已提交元数据\n\nbody',
        category: '安全与数据主权',
        tags: ['new'],
        visibility: 'public',
        expectedVersionCount: created.versionCount,
      });
    expect(updated.status).toBe(200);

    const newRaw = fs.readFileSync(filePath(created.id), 'utf-8');
    const folder = path.join(testDataDir, 'documents', created.id);
    fs.writeFileSync(path.join(folder, 'index.md.bak'), oldRaw, 'utf-8');
    fs.writeFileSync(path.join(folder, '.save.pending'), new Date().toISOString(), 'utf-8');

    await documentService.recoverPendingSaves();

    expect(fs.readFileSync(filePath(created.id), 'utf-8')).toBe(newRaw);
    expect(artifacts(created.id)).toEqual([]);

    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(created.id) as any;
    expect(row.title).toBe('提交后的新标题');
    expect(row.visibility).toBe('public');
    expect(row.version_count).toBe(created.versionCount + 1);
    expect(row.content_hash).toBe(calculateContentHash('# 已提交元数据\n\nbody'));
    expect(row.document_hash).toBe(calculateDocumentHash(newRaw));
    expect(revisionCount(created.id)).toBe(2);

    const fm = parseFrontmatter(newRaw).frontmatter;
    expect(fm.title).toBe(row.title);
    expect(fm.visibility).toBe(row.visibility);
    expect(fm.status).toBe(row.status);
    expect(Array.isArray(fm.tags) ? fm.tags : []).toEqual(['new']);
    expect(docTags(created.id)).toEqual(['new']);
  });

  // -------------------------------------------------------------------------
  it('backfills document_hash for rows created before the column existed', async () => {
    const created = await createDoc('# 旧数据\n\nbody');
    db.prepare('UPDATE documents SET document_hash = NULL WHERE id = ?').run(created.id);

    await documentService.backfillDocumentHashes();

    const row = db.prepare('SELECT document_hash FROM documents WHERE id = ?').get(created.id) as any;
    expect(row.document_hash).toBe(calculateDocumentHash(fs.readFileSync(filePath(created.id), 'utf-8')));
  });
});
