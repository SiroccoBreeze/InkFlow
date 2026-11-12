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
  `inkflow_asset_consistency_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_asset_consistency_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'asset-consistency-init-key-abcdef0123456789';
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

function listDiskFiles(): string[] {
  if (!fs.existsSync(assetsDir())) return [];
  return fs.readdirSync(assetsDir()).filter(name => name !== '.gitkeep');
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
  return res.body.data as { id: string; storagePath: string; checksum: string };
}

describe('Asset write paths are coordinated with the consistency gate', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'asset_consistency_owner',
      password: 'AssetConsistencyPassword!',
      email: 'asset-consistency@inkflow.local',
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

  it('removes the physical file when the assets INSERT fails', async () => {
    const before = listDiskFiles();

    db.exec(`
      CREATE TRIGGER fail_asset_upload
      BEFORE INSERT ON assets
      WHEN NEW.filename = 'fail-upload.png'
      BEGIN
        SELECT RAISE(ABORT, 'simulated assets insert failure');
      END;
    `);

    try {
      const res = await request(app)
        .post('/api/v1/assets/upload')
        .set(auth())
        .send({
          filename: 'fail-upload.png',
          mimeType: 'image/png',
          base64: Buffer.from('should-not-survive').toString('base64'),
        });

      expect(res.status).toBe(500);
      expect(listDiskFiles()).toEqual(before);
      expect((db.prepare('SELECT COUNT(*) AS c FROM assets').get() as any).c).toBe(0);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_asset_upload');
    }
  });

  it('removes asset metadata even when the physical unlink fails (DB first)', async () => {
    const asset = await uploadAsset('undeletable.png', 'undeletable-content');
    const filePath = absoluteAssetPath(asset.storagePath);

    // Replace the file with a directory so unlink() fails with EISDIR.
    fs.rmSync(filePath, { force: true });
    fs.mkdirSync(filePath);

    try {
      const res = await request(app).delete(`/api/v1/assets/${asset.id}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);

      expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(asset.id)).toBeUndefined();
      expect(fs.existsSync(filePath)).toBe(true); // orphan directory remains
    } finally {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  });

  it('removes unreferenced asset rows before trying to unlink their files', async () => {
    const asset = await uploadAsset('cleanup-undeletable.png', 'cleanup-content');
    const filePath = absoluteAssetPath(asset.storagePath);

    fs.rmSync(filePath, { force: true });
    fs.mkdirSync(filePath);

    try {
      const res = await request(app).post('/api/v1/assets/cleanup-orphans').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.cleanedCount).toBeGreaterThanOrEqual(1);

      expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(asset.id)).toBeUndefined();
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  });

  it('reconciles physical files exactly once and tolerates legacy Windows paths', async () => {
    fs.mkdirSync(assetsDir(), { recursive: true });
    const windowsStylePath = 'assets\\ast_legacy_win.png';
    const fileName = 'ast_legacy_win.png';
    fs.writeFileSync(path.join(assetsDir(), fileName), 'legacy-windows-path');

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'ast_legacy_win',
      ownerId,
      fileName,
      windowsStylePath,
      'image/png',
      Buffer.byteLength('legacy-windows-path'),
      '',
      now
    );

    // Reading through the legacy backslash path must still resolve inside storage.
    const served = await request(app).get('/api/v1/assets/file/ast_legacy_win').set(auth());
    expect(served.status).toBe(200);
    expect(served.body.toString()).toBe('legacy-windows-path');

    // A manual, unindexed file is reconciled once; a second list must not duplicate it.
    fs.writeFileSync(path.join(assetsDir(), 'ast_reconciled.png'), 'reconciled');
    const firstList = await request(app).get('/api/v1/assets').set(auth());
    expect(firstList.status).toBe(200);
    expect(firstList.body.data.filter((row: any) => row.id === 'ast_reconciled')).toHaveLength(1);

    const secondList = await request(app).get('/api/v1/assets').set(auth());
    expect(secondList.status).toBe(200);
    expect(secondList.body.data.filter((row: any) => row.id === 'ast_reconciled')).toHaveLength(1);
  });

  it('new uploads store canonical POSIX storage paths', async () => {
    const asset = await uploadAsset('posix.png', 'posix-content');
    expect(asset.storagePath).toContain('/');
    expect(asset.storagePath).not.toContain('\\');
    expect(asset.storagePath.startsWith('assets/')).toBe(true);
  });
});
