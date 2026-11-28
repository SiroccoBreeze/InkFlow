import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  getDatabase,
  closeDatabase,
  seedDefaultCategoriesIfEmpty,
  SYSTEM_MARKERS,
} from '../db/sqlite';
import { authService } from '../services/authService';
import { ensureInitialPhysicalDocs } from '../services/seedData';

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_seed_once_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_seed_once_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const TEST_INIT_KEY = 'seed-once-init-key-0123456789abcdef';

process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = TEST_INIT_KEY;

let db: any;
let ownerId: string;

describe('One-way starter content seeding', () => {
  beforeAll(() => {
    closeDatabase();
    // fileStorage is constructed at module import time (before this test file
    // assigns INKFLOW_DATA_DIR), so its startup mkdir may have targeted the
    // default cwd. The service reads the env live, so create the isolated
    // runtime directories explicitly here.
    for (const dir of ['', 'documents', 'revisions', 'assets', 'backups']) {
      fs.mkdirSync(path.join(testDataDir, dir), { recursive: true });
    }
    db = getDatabase();

    const init = authService.initializeOwner({
      initKey: TEST_INIT_KEY,
      username: 'seed_once_owner',
      password: 'SeedOncePassword123!',
      email: 'seed-once@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerId = init.user!.id;
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

  it('seeds default categories once during owner initialization', () => {
    const count = (db.prepare('SELECT COUNT(*) AS c FROM categories').get() as any).c;
    expect(count).toBeGreaterThan(0);

    const marker = db
      .prepare('SELECT value FROM system_settings WHERE key = ?')
      .get(SYSTEM_MARKERS.defaultCategoriesSeeded) as any;
    expect(marker?.value).toBe('1');
  });

  it('does not recreate default categories after they are all deleted', () => {
    db.prepare('DELETE FROM categories').run();

    seedDefaultCategoriesIfEmpty(db, ownerId);

    const count = (db.prepare('SELECT COUNT(*) AS c FROM categories').get() as any).c;
    expect(count).toBe(0);
  });

  it('seeds starter documents once and records the marker', async () => {
    await ensureInitialPhysicalDocs();

    const count = (db.prepare('SELECT COUNT(*) AS c FROM documents').get() as any).c;
    expect(count).toBe(2);

    const marker = db
      .prepare('SELECT value FROM system_settings WHERE key = ?')
      .get(SYSTEM_MARKERS.starterDocsSeeded) as any;
    expect(marker?.value).toBe('1');
  });

  it('does not recreate starter documents after they are all deleted', async () => {
    // Simulate the owner intentionally deleting every document: no DB rows, no
    // folders, and no pending-deletion marker left behind.
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('DELETE FROM documents;');
    db.exec('PRAGMA foreign_keys = ON;');

    const documentsDir = path.join(testDataDir, 'documents');
    fs.rmSync(documentsDir, { recursive: true, force: true });
    fs.mkdirSync(documentsDir, { recursive: true });

    await ensureInitialPhysicalDocs();

    const count = (db.prepare('SELECT COUNT(*) AS c FROM documents').get() as any).c;
    expect(count).toBe(0);
  });
});
