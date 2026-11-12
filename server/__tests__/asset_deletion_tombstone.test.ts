import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import { assetService } from '../services/assetService';
import { consistencyGate } from '../services/consistencyGate';
import { getDatabase, closeDatabase } from '../db/sqlite';

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_asset_tombstone_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_asset_tombstone_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'asset-tombstone-init-key-abcdef0123456789';
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

function assetsDir(): string {
  return path.join(testDataDir, 'assets');
}

function absoluteAssetPath(storagePath: string): string {
  return path.join(testDataDir, storagePath.split('/').join(path.sep));
}

function assetRow(id: string): any {
  return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
}

function tombstones(): any[] {
  return db.prepare('SELECT * FROM asset_deletions ORDER BY asset_id, storage_path').all() as any[];
}

function insertTombstone(params: {
  assetId: string;
  storagePath: string;
  filename?: string | null;
  reason?: string;
}): void {
  db.prepare(`
    INSERT INTO asset_deletions (asset_id, storage_path, filename, reason, requested_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    params.assetId,
    params.storagePath,
    params.filename ?? path.posix.basename(params.storagePath),
    params.reason ?? 'manual-delete',
    new Date().toISOString()
  );
}

async function uploadAsset(filename: string, content: string) {
  const res = await request(app)
    .post('/api/v1/assets/upload')
    .set(auth())
    .send({
      filename,
      mimeType: 'image/png',
      base64: Buffer.from(content).toString('base64'),
    });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; storagePath: string };
}

async function deleteAsset(id: string) {
  return request(app).delete(`/api/v1/assets/${id}`).set(auth());
}

async function listAssets() {
  const res = await request(app).get('/api/v1/assets').set(auth());
  expect(res.status).toBe(200);
  return res.body.data as any[];
}

/** Makes unlink() fail with EISDIR while leaving a visible path behind. */
function makeUnlinkFail(asset: { storagePath: string }): string {
  const filePath = absoluteAssetPath(asset.storagePath);
  fs.rmSync(filePath, { force: true });
  fs.mkdirSync(filePath);
  return filePath;
}

function restoreRegularFile(asset: { storagePath: string }, content: string): string {
  const filePath = absoluteAssetPath(asset.storagePath);
  fs.rmSync(filePath, { recursive: true, force: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function createDocWithAsset(assetId: string) {
  const unique = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const res = await request(app)
    .post('/api/v1/documents')
    .set(auth())
    .send({
      title: `附件删除并发测试 ${unique}`,
      slug: `asset-tombstone-${unique}`,
      rawMarkdown: `# 附件引用\n\n![图](/api/v1/assets/file/${assetId})`,
      category: '安全与数据主权',
      tags: [],
      visibility: 'private',
      status: 'draft',
    });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; versionCount: number };
}

describe('Asset deletion tombstones', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'asset_tombstone_owner',
      password: 'AssetTombstonePassword!',
      email: 'asset-tombstone@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerToken = init.token!;
    ownerId = init.user.id;
  });

  beforeEach(() => {
    db.exec('DELETE FROM document_assets; DELETE FROM asset_deletions; DELETE FROM assets;');
    const dir = assetsDir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
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

  it('deletes DB row and file together, leaving no tombstone', async () => {
    const asset = await uploadAsset('success.png', 'success-content');
    const filePath = absoluteAssetPath(asset.storagePath);
    expect(fs.existsSync(filePath)).toBe(true);

    const res = await deleteAsset(asset.id);
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);

    expect(assetRow(asset.id)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(tombstones()).toHaveLength(0);
  });

  it('keeps the tombstone when the physical unlink fails', async () => {
    const asset = await uploadAsset('unlink-fails.png', 'unlink-fails-content');
    const filePath = makeUnlinkFail(asset);

    const res = await deleteAsset(asset.id);
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);

    expect(assetRow(asset.id)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(true);

    const rows = tombstones();
    expect(rows).toHaveLength(1);
    expect(rows[0].asset_id).toBe(asset.id);
    expect(rows[0].storage_path).toBe(asset.storagePath);
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
    expect(String(rows[0].last_error || '')).toMatch(/目录|directory/i);

    fs.rmSync(filePath, { recursive: true, force: true });
  });

  it('never resurrects a tombstoned asset through listAssets()', async () => {
    // A plausible crash state: the file is still a regular file, the DB row is
    // gone, and only the tombstone remembers the pending deletion.
    const storagePath = 'assets/ast_tombstone_regular.png';
    fs.writeFileSync(absoluteAssetPath(storagePath), 'still-on-disk');
    insertTombstone({ assetId: 'ast_tombstone_regular', storagePath });

    expect(await listAssets()).toHaveLength(0);
    expect(assetRow('ast_tombstone_regular')).toBeUndefined();
    expect(fs.existsSync(absoluteAssetPath(storagePath))).toBe(true);

    // A second reconcile must behave identically.
    expect(await listAssets()).toHaveLength(0);
    expect(tombstones()).toHaveLength(1);
  });

  it('finishes a pending deletion after a simulated process restart', async () => {
    const storagePath = 'assets/ast_restart_pending.png';
    fs.writeFileSync(absoluteAssetPath(storagePath), 'restart-content');
    insertTombstone({ assetId: 'ast_restart_pending', storagePath });

    // Simulate a process restart: close and reopen the SQLite connection, then
    // run the same startup recovery hook that server.ts invokes before listen().
    closeDatabase();
    db = getDatabase();

    const result = await assetService.recoverPendingAssetDeletions();
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    expect(fs.existsSync(absoluteAssetPath(storagePath))).toBe(false);
    expect(tombstones()).toHaveLength(0);
    expect(consistencyGate.isIdle()).toBe(true);
  });

  it('clears a tombstone when the file is already missing', async () => {
    insertTombstone({
      assetId: 'ast_already_missing',
      storagePath: 'assets/ast_already_missing.png',
    });

    const result = await assetService.recoverPendingAssetDeletions();
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(tombstones()).toHaveLength(0);
  });

  it('refuses corrupt or mismatched tombstones without deleting unrelated files', async () => {
    const outsidePath = path.resolve(testDataDir, '..', `inkflow_outside_${crypto.randomBytes(4).toString('hex')}.png`);
    fs.writeFileSync(outsidePath, 'outside-must-survive');

    const otherPath = 'assets/ast_other.png';
    fs.writeFileSync(absoluteAssetPath(otherPath), 'other-must-survive');

    insertTombstone({ assetId: 'ast_escape', storagePath: `../${path.basename(outsidePath)}` });
    insertTombstone({ assetId: 'ast_mismatch', storagePath: otherPath });

    try {
      const result = await assetService.recoverPendingAssetDeletions();
      expect(result.failed).toBe(2);

      expect(fs.existsSync(outsidePath)).toBe(true);
      expect(fs.existsSync(absoluteAssetPath(otherPath))).toBe(true);

      const rows = tombstones();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.last_error).toBeTruthy();
        expect(row.attempts).toBeGreaterThanOrEqual(1);
      }
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it('serialises concurrent upload with a pending asset deletion', async () => {
    const oldAsset = await uploadAsset('concurrent-old.png', 'old-content');
    makeUnlinkFail(oldAsset);

    const [deleted, uploaded] = await Promise.all([
      deleteAsset(oldAsset.id),
      uploadAsset('concurrent-new.png', 'new-content'),
    ]);

    expect(deleted.status).toBe(200);
    expect(uploaded.id).not.toBe(oldAsset.id);

    // Old asset stays deleted (tombstone retained because unlink failed).
    expect(assetRow(oldAsset.id)).toBeUndefined();
    expect(tombstones().some(row => row.asset_id === oldAsset.id)).toBe(true);

    // New upload is a live asset: row + file both exist, and reconciliation keeps it.
    expect(assetRow(uploaded.id)).toBeTruthy();
    expect(fs.existsSync(absoluteAssetPath(uploaded.storagePath))).toBe(true);

    const listed = await listAssets();
    expect(listed.some(row => row.id === uploaded.id)).toBe(true);
    expect(listed.some(row => row.id === oldAsset.id)).toBe(false);

    fs.rmSync(absoluteAssetPath(oldAsset.storagePath), { recursive: true, force: true });
  });

  it('serialises concurrent reconciliation with a failed asset deletion', async () => {
    const asset = await uploadAsset('concurrent-reconcile.png', 'reconcile-content');
    makeUnlinkFail(asset);

    const [deleted] = await Promise.all([deleteAsset(asset.id), listAssets()]);
    expect(deleted.status).toBe(200);

    // Final state must not contain a resurrected row.
    expect(assetRow(asset.id)).toBeUndefined();
    expect(tombstones().some(row => row.asset_id === asset.id)).toBe(true);

    // A subsequent reconcile still must not revive it.
    const listed = await listAssets();
    expect(listed.some(row => row.id === asset.id)).toBe(false);

    fs.rmSync(absoluteAssetPath(asset.storagePath), { recursive: true, force: true });
  });

  it('stays consistent when a document save races an asset deletion', async () => {
    const asset = await uploadAsset('doc-race.png', 'doc-race-content');
    const doc = await createDocWithAsset(asset.id);

    const [deleted, saved] = await Promise.all([
      deleteAsset(asset.id),
      request(app)
        .put(`/api/v1/documents/${doc.id}`)
        .set(auth())
        .send({
          title: '附件删除并发测试',
          rawMarkdown: `# 附件引用更新\n\n![图](/api/v1/assets/file/${asset.id})`,
          category: '安全与数据主权',
          tags: [],
          visibility: 'private',
          status: 'draft',
          expectedVersionCount: doc.versionCount,
        }),
    ]);

    expect(deleted.status).toBe(200);
    expect(saved.status).toBe(200);
    expect(assetRow(asset.id)).toBeUndefined();
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM document_assets WHERE asset_id = ?').get(asset.id) as any).c
    ).toBe(0);
    expect(fs.existsSync(absoluteAssetPath(asset.storagePath))).toBe(false);
  });

  it('keeps retrying cleanup failures and converges once the file becomes deletable', async () => {
    const asset = await uploadAsset('cleanup-retry.png', 'cleanup-retry-content');
    const filePath = makeUnlinkFail(asset);

    const first = await request(app).post('/api/v1/assets/cleanup-orphans').set(auth());
    expect(first.status).toBe(200);
    expect(assetRow(asset.id)).toBeUndefined();
    expect(tombstones().some(row => row.asset_id === asset.id)).toBe(true);

    // Repeating the operation must be idempotent (still no row, same tombstone).
    const second = await request(app).post('/api/v1/assets/cleanup-orphans').set(auth());
    expect(second.status).toBe(200);
    expect(assetRow(asset.id)).toBeUndefined();
    expect(tombstones().some(row => row.asset_id === asset.id)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);

    // Filesystem recovers: the next cleanup or startup retry completes the delete.
    restoreRegularFile(asset, 'cleanup-retry-content');
    const third = await request(app).post('/api/v1/assets/cleanup-orphans').set(auth());
    expect(third.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(tombstones()).toHaveLength(0);
  });

  it('ignores dotfiles, directories and symlinks during reconciliation', async () => {
    fs.writeFileSync(path.join(assetsDir(), '.gitkeep'), '');
    fs.mkdirSync(path.join(assetsDir(), 'ast_directory.png'));

    let symlinkCreated = false;
    try {
      fs.symlinkSync(
        path.join(assetsDir(), '.gitkeep'),
        path.join(assetsDir(), 'ast_symlink.png')
      );
      symlinkCreated = true;
    } catch {
      // Windows without symlink privileges: the directory/dotfile checks still run.
    }

    const listed = await listAssets();
    expect(listed).toHaveLength(0);
    expect(assetRow('ast_directory')).toBeUndefined();
    expect(assetRow('ast_symlink')).toBeUndefined();
    expect(assetRow('.gitkeep')).toBeUndefined();

    if (symlinkCreated) {
      expect(
        (db.prepare('SELECT COUNT(*) AS c FROM assets WHERE id = ?').get('ast_symlink') as any).c
      ).toBe(0);
    }
  });

  it('does not recreate tombstones for an asset that still has a live DB row', async () => {
    // Defensive case: a tombstone that predates a committed/rolled-back delete
    // must be cancelled rather than deleting a live asset's file.
    const asset = await uploadAsset('live-row.png', 'live-content');
    insertTombstone({ assetId: asset.id, storagePath: asset.storagePath });

    const result = await assetService.recoverPendingAssetDeletions();
    expect(result.failed).toBe(0);

    expect(assetRow(asset.id)).toBeTruthy();
    expect(fs.existsSync(absoluteAssetPath(asset.storagePath))).toBe(true);
    expect(tombstones()).toHaveLength(0);
  });
});
