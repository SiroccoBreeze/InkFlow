import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
  `inkflow_asset_invalid_path_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_asset_invalid_path_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'asset-invalid-path-init-key-abcdef0123456789';
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

function localPathFromStorage(storagePath: string): string {
  return path.join(testDataDir, storagePath.replace(/\\/g, '/'));
}

function insertAsset(params: { id: string; storagePath: string; filename?: string }): void {
  db.prepare(`
    INSERT INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    ownerId,
    params.filename || path.basename(params.storagePath.replace(/\\/g, '/')),
    params.storagePath,
    'image/png',
    3,
    'abc',
    new Date().toISOString()
  );
}

function assetRow(id: string): any {
  return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
}

function tombstones(): any[] {
  return db.prepare('SELECT * FROM asset_deletions').all() as any[];
}

describe('Asset deletion refuses invalid storage paths safely', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'asset_invalid_path_owner',
      password: 'AssetInvalidPathPassword!',
      email: 'asset-invalid-path@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerToken = init.token!;
    ownerId = init.user.id;
  });

  beforeEach(() => {
    db.exec('DELETE FROM document_assets; DELETE FROM asset_deletions; DELETE FROM assets;');
    fs.rmSync(assetsDir(), { recursive: true, force: true });
    fs.mkdirSync(assetsDir(), { recursive: true });
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

  it('refuses to delete a live row whose storage_path escapes the storage root', async () => {
    const outsideName = `inkflow_outside_${crypto.randomBytes(4).toString('hex')}.png`;
    const outsidePath = path.resolve(testDataDir, '..', outsideName);
    fs.writeFileSync(outsidePath, 'outside-must-survive');

    insertAsset({
      id: 'ast_invalid_delete',
      storagePath: `../${outsideName}`,
      filename: outsideName,
    });

    try {
      const res = await request(app).delete('/api/v1/assets/ast_invalid_delete').set(auth());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ASSET_PATH_INVALID');

      // DB row, outside file and absence of a tombstone all prove nothing was deleted.
      expect(assetRow('ast_invalid_delete')).toBeTruthy();
      expect(fs.readFileSync(outsidePath, 'utf-8')).toBe('outside-must-survive');
      expect(tombstones()).toHaveLength(0);
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it('refuses to delete when the file name does not match the asset id', async () => {
    const storagePath = 'assets/ast_other.png';
    fs.writeFileSync(localPathFromStorage(storagePath), 'other-must-survive');
    insertAsset({ id: 'ast_mismatch', storagePath, filename: 'ast_other.png' });

    const res = await request(app).delete('/api/v1/assets/ast_mismatch').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSET_PATH_INVALID');

    expect(assetRow('ast_mismatch')).toBeTruthy();
    expect(fs.existsSync(localPathFromStorage(storagePath))).toBe(true);
    expect(tombstones()).toHaveLength(0);
  });

  it('still accepts a legacy Windows path after Schema v2 normalization rules', async () => {
    const storagePath = 'assets\\ast_win.png';
    const absolutePath = localPathFromStorage(storagePath);
    fs.writeFileSync(absolutePath, 'win-content');
    insertAsset({ id: 'ast_win', storagePath, filename: 'ast_win.png' });

    const res = await request(app).delete('/api/v1/assets/ast_win').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);

    expect(assetRow('ast_win')).toBeUndefined();
    expect(fs.existsSync(absolutePath)).toBe(false);
    expect(tombstones()).toHaveLength(0);
  });

  it('cleanup skips an unreferenced row with an invalid storage_path and keeps the row', async () => {
    insertAsset({ id: 'ast_cleanup_invalid', storagePath: '../escape.png', filename: 'escape.png' });

    const res = await request(app).post('/api/v1/assets/cleanup-orphans').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.skippedInvalidPathCount).toBeGreaterThanOrEqual(1);

    expect(assetRow('ast_cleanup_invalid')).toBeTruthy();
    expect(tombstones()).toHaveLength(0);
  });

  it('cleanup skips an orphan file with an unmanaged name and keeps the file', async () => {
    const orphanPath = path.join(assetsDir(), 'bad name!.png');
    fs.writeFileSync(orphanPath, 'unmanaged-file');

    const res = await request(app).post('/api/v1/assets/cleanup-orphans').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.skippedInvalidPathCount).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(orphanPath)).toBe(true);
    expect(tombstones()).toHaveLength(0);
  });

  it('cleanup still handles a legacy Windows storage_path correctly', async () => {
    const storagePath = 'assets\\ast_cleanup_win.png';
    const absolutePath = localPathFromStorage(storagePath);
    fs.writeFileSync(absolutePath, 'win-cleanup');
    insertAsset({ id: 'ast_cleanup_win', storagePath, filename: 'ast_cleanup_win.png' });

    const res = await request(app).post('/api/v1/assets/cleanup-orphans').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.skippedInvalidPathCount).toBe(0);

    expect(assetRow('ast_cleanup_win')).toBeUndefined();
    expect(fs.existsSync(absolutePath)).toBe(false);
    expect(tombstones()).toHaveLength(0);
  });
});
