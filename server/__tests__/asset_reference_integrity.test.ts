import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import { apiRouter } from '../routes/api';
import { authService } from '../services/authService';
import { documentService } from '../services/documentService';
import { maintenanceState } from '../services/maintenanceState';
import { getDatabase, closeDatabase, generateId, hashPassword } from '../db/sqlite';
import { initDatabaseSchema } from '../db/schema';

// Isolated database + storage for the in-process suite (real SQLite, real files).
const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_ref_integrity_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_ref_integrity_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'asset-ref-integrity-init-key-0123456789';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1', apiRouter);

// ---------------------------------------------------------------------------
// In-process route behaviour (real SQLite + real storage files)
// ---------------------------------------------------------------------------
describe('Anonymous asset access honours asset-reference integrity', () => {
  let db: any;
  let ownerId: string;
  let ownerToken: string;

  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'asset_ref_owner',
      password: 'AssetRefOwnerPassword!',
      email: 'asset-ref@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerId = init.user.id;
    ownerToken = init.token!;
  });

  afterAll(() => {
    maintenanceState.resetForTests();
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

  beforeEach(() => {
    maintenanceState.resetForTests();
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

  it('serves an asset referenced by a public+published document when integrity is ready', async () => {
    const assetId = await createAsset('ready-public.png');
    await saveDoc('doc-ref-ready-public', `# 公开\n\n![a](/api/v1/assets/file/${assetId})`);

    expect(maintenanceState.snapshot().assetReferenceIntegrity).toBe('ready');

    const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
    expect(res.status).toBe(200);
  });

  it('denies an asset referenced only by a private document', async () => {
    const assetId = await createAsset('ready-private.png');
    await saveDoc('doc-ref-ready-private', `# 私有\n\n![a](/api/v1/assets/file/${assetId})`, {
      visibility: 'private',
      status: 'published',
    });

    const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
    expect(res.status).toBe(403);
  });

  it('denies an asset referenced only by an unpublished document', async () => {
    const assetId = await createAsset('ready-draft.png');
    await saveDoc('doc-ref-ready-draft', `# 草稿\n\n![a](/api/v1/assets/file/${assetId})`, {
      visibility: 'public',
      status: 'draft',
    });

    const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
    expect(res.status).toBe(403);
  });

  it('fails closed with 503 when asset references could not be calibrated', async () => {
    // This asset WOULD be publicly readable: the document is public+published and
    // the association row exists. Only the integrity flag may deny access.
    const assetId = await createAsset('unavailable-public.png');
    await saveDoc('doc-ref-unavailable', `# 公开\n\n![a](/api/v1/assets/file/${assetId})`);

    maintenanceState.markAssetReferencesUnavailable('simulated rebuild failure');

    const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ASSET_REFERENCES_UNAVAILABLE');
    expect(res.body.error.details.integrity).toBe('unavailable');

    // It must not be masked as a missing (404) or forbidden (403) asset.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it('still serves assets to the authenticated owner while references are unavailable', async () => {
    const assetId = await createAsset('unavailable-owner.png');
    await saveDoc('doc-ref-unavailable-owner', `# 私有\n\n![a](/api/v1/assets/file/${assetId})`, {
      visibility: 'private',
      status: 'draft',
    });

    maintenanceState.markAssetReferencesUnavailable('simulated rebuild failure');

    const res = await request(app)
      .get(`/api/v1/assets/file/${assetId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
  });

  it('does not block anonymous access when only a tombstone retry degrades the service', async () => {
    const assetId = await createAsset('degraded-tombstone.png');
    await saveDoc('doc-ref-degraded-tombstone', `# 公开\n\n![a](/api/v1/assets/file/${assetId})`);

    // A failed attachment deletion is a degraded warning, but it says nothing
    // about the document ↔ asset association table.
    maintenanceState.addDegradedWarning('附件删除恢复失败，tombstone 已保留等待重试');

    const snapshot = maintenanceState.snapshot();
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.assetReferenceIntegrity).toBe('ready');

    const res = await request(app).get(`/api/v1/assets/file/${assetId}`);
    expect(res.status).toBe(200);
  });

  it('revokes anonymous access after the reference is removed from the Markdown', async () => {
    const assetId = await createAsset('ref-removed-integrity.png');
    const docId = 'doc-ref-removed-integrity';

    await saveDoc(docId, `# 有引用\n\n![a](/api/v1/assets/file/${assetId})`);
    expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(200);

    await saveDoc(docId, '# 无引用\n\n正文已移除引用');
    expect((await request(app).get(`/api/v1/assets/file/${assetId}`)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Startup integration (real child process, real SQLite, real filesystem)
// ---------------------------------------------------------------------------
const ROOT_DIR = path.resolve(process.cwd());
const TSX_CLI = path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const STARTUP_STALE_DOC_ID = 'doc_stale_ref_startup';
const STARTUP_STALE_ASSET_ID = 'ast_stale_ref_startup';
const STARTUP_OWNER_PASSWORD = 'StartupOwnerPassword!';

function makeDataDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `inkflow_${prefix}_${crypto.randomBytes(4).toString('hex')}_`));
}

async function getFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface StartedServer {
  child: ChildProcess;
  port: number;
  output: () => string;
  stop: () => Promise<void>;
}

async function startServer(dataDir: string): Promise<StartedServer> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [TSX_CLI, 'server.ts', '--prod'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      INKFLOW_DATA_DIR: dataDir,
      INKFLOW_DB_PATH: '',
      INKFLOW_INIT_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', chunk => (output += chunk.toString()));
  child.stderr?.on('data', chunk => (output += chunk.toString()));

  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) break;
    try {
      // Any HTTP response (including 503) means the server is listening.
      await fetch(`http://127.0.0.1:${port}/api/health`);
      return {
        child,
        port,
        output: () => output,
        stop: async () => {
          child.kill('SIGKILL');
          await new Promise(resolve => setTimeout(resolve, 300));
        },
      };
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  child.kill('SIGKILL');
  throw new Error(`server did not start:\n${output}`);
}

/**
 * Builds a data directory with one public+published document that references one
 * existing asset (and its stale `document_assets` row).
 *
 *  - `failRebuild`: a trigger aborts every INSERT into document_assets, so the
 *    startup Markdown → association rebuild fails deterministically. Without the
 *    fail-closed check, the seeded stale association would grant anonymous access.
 *  - `invalidTombstone`: seeds a corrupt tombstone, which makes asset deletion
 *    recovery degrade — without invalidating the association table.
 */
function prepareStartupDataDir(options: { failRebuild?: boolean; invalidTombstone?: boolean } = {}): string {
  const dataDir = makeDataDir('asset_refs_startup');
  const dbDir = path.join(dataDir, 'database');
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new DatabaseSync(path.join(dbDir, 'knowledge_hub.sqlite'));
  try {
    initDatabaseSchema(db);
    const now = new Date().toISOString();
    const ownerId = 'usr_startup_owner';

    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'owner', 1, ?, ?)
    `).run(ownerId, 'startup_owner', 'startup@inkflow.local', hashPassword(STARTUP_OWNER_PASSWORD), now, now);

    db.prepare(`
      INSERT INTO documents
        (id, owner_id, slug, title, category_name, file_path, visibility, status, content_hash, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, 'public', 'published', ?, ?, ?, ?)
    `).run(
      STARTUP_STALE_DOC_ID,
      ownerId,
      'stale-ref-startup',
      'Stale reference startup',
      '安全与数据主权',
      `documents/${STARTUP_STALE_DOC_ID}/index.md`,
      'content-hash',
      now,
      now,
      now
    );

    db.prepare(`
      INSERT INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
      VALUES (?, ?, ?, ?, 'image/png', 8, 'x', ?)
    `).run(
      STARTUP_STALE_ASSET_ID,
      ownerId,
      'stale-ref.png',
      `assets/${STARTUP_STALE_ASSET_ID}.png`,
      now
    );

    // The association that must NOT grant anonymous access once the startup
    // rebuild fails.
    db.prepare(`
      INSERT INTO document_assets (document_id, asset_id, created_at)
      VALUES (?, ?, ?)
    `).run(STARTUP_STALE_DOC_ID, STARTUP_STALE_ASSET_ID, now);

    if (options.invalidTombstone) {
      db.prepare(`
        INSERT INTO asset_deletions (asset_id, storage_path, filename, reason, requested_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('ast_invalid_tombstone', '../escape.png', 'escape.png', 'manual-delete', now);
    }

    if (options.failRebuild) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS block_document_assets_insert
        BEFORE INSERT ON document_assets
        BEGIN
          SELECT RAISE(ABORT, 'simulated document_assets rebuild failure');
        END;
      `);
    }
  } finally {
    db.close();
  }

  fs.mkdirSync(path.join(dataDir, 'documents', STARTUP_STALE_DOC_ID), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'documents', STARTUP_STALE_DOC_ID, 'index.md'),
    `# Stale reference\n\n![a](/api/v1/assets/file/${STARTUP_STALE_ASSET_ID})\n`,
    'utf-8'
  );

  fs.mkdirSync(path.join(dataDir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'assets', `${STARTUP_STALE_ASSET_ID}.png`),
    Buffer.from('89504e470d0a1a0a', 'hex')
  );

  return dataDir;
}

describe('Startup asset-reference calibration failure', () => {
  it('reports unusable references and fails closed for anonymous asset access', async () => {
    const dataDir = prepareStartupDataDir({ failRebuild: true });
    const server = await startServer(dataDir);
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(health.status).toBe(200);
      const body = await health.json();
      expect(body.status).toBe('degraded');
      expect(body.maintenance.writeAllowed).toBe(true);
      expect(body.maintenance.assetReferenceIntegrity).toBe('unavailable');
      expect(body.maintenance.assetReferenceIntegrityReason).toBeTruthy();
      expect(
        body.maintenance.warnings.some((warning: string) => warning.includes('附件引用'))
      ).toBe(true);

      // The asset is public+published and has a stale association row, but the
      // route must fail closed until a successful restart recalibrates.
      const anonymous = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/assets/file/${STARTUP_STALE_ASSET_ID}`
      );
      expect(anonymous.status).toBe(503);
      const anonymousBody = await anonymous.json();
      expect(anonymousBody.error.code).toBe('ASSET_REFERENCES_UNAVAILABLE');

      // Owner access and unrelated reads must keep working.
      const login = await fetch(`http://127.0.0.1:${server.port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: STARTUP_OWNER_PASSWORD }),
      });
      expect(login.status).toBe(200);
      const token = (await login.json()).data.token as string;
      expect(typeof token).toBe('string');

      const ownerAsset = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/assets/file/${STARTUP_STALE_ASSET_ID}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(ownerAsset.status).toBe(200);

      const documents = await fetch(`http://127.0.0.1:${server.port}/api/v1/documents`);
      expect(documents.status).toBe(200);
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30000);

  it('keeps anonymous asset access when only tombstone recovery degrades the service', async () => {
    const dataDir = prepareStartupDataDir({ invalidTombstone: true });
    const server = await startServer(dataDir);
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(health.status).toBe(200);
      const body = await health.json();
      expect(body.status).toBe('degraded');
      // A failed tombstone retry must not invalidate the association table: the
      // startup rebuild still succeeded and anonymous access must keep working.
      expect(body.maintenance.assetReferenceIntegrity).toBe('ready');

      const anonymous = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/assets/file/${STARTUP_STALE_ASSET_ID}`
      );
      expect(anonymous.status).toBe(200);
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});
