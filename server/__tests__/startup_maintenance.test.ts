import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initDatabaseSchema } from '../db/schema';

const ROOT_DIR = path.resolve(process.cwd());
const TSX_CLI = path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

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

function writeInvalidTombstone(dataDir: string): void {
  const dbDir = path.join(dataDir, 'database');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'knowledge_hub.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    initDatabaseSchema(db);
    db.prepare(`
      INSERT INTO asset_deletions (asset_id, storage_path, filename, reason, requested_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('ast_bad_tombstone', '../escape.png', 'escape.png', 'manual-delete', new Date().toISOString());
  } finally {
    db.close();
  }
}

describe('Startup recovery failure handling', () => {
  it('enters read-only maintenance mode when critical document recovery fails', async () => {
    const dataDir = makeDataDir('startup_critical');
    // A file where storage/documents/ should be makes the strict recovery scan
    // fail deterministically with ENOTDIR, for every platform and user.
    fs.writeFileSync(path.join(dataDir, 'documents'), 'not-a-directory');

    const server = await startServer(dataDir);
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(health.status).toBe(503);
      const body = await health.json();
      expect(body.status).toBe('maintenance');
      expect(body.maintenance.writeAllowed).toBe(false);
      expect(body.maintenance.reason).toBe('startup_recovery_failed');

      // Every write API is blocked by the server-side barrier, not the UI.
      const write = await fetch(`http://127.0.0.1:${server.port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'whatever' }),
      });
      expect(write.status).toBe(503);
      expect((await write.json()).error.code).toBe('MAINTENANCE_MODE');

      const documentWrite = await fetch(`http://127.0.0.1:${server.port}/api/v1/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'blocked', rawMarkdown: '# blocked' }),
      });
      expect(documentWrite.status).toBe(503);

      // Read-only diagnostics remain available.
      const categories = await fetch(`http://127.0.0.1:${server.port}/api/v1/categories`);
      expect(categories.status).toBe(200);
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30000);

  it('starts degraded (writes allowed) when only non-critical asset recovery fails', async () => {
    const dataDir = makeDataDir('startup_degraded');
    writeInvalidTombstone(dataDir);

    const server = await startServer(dataDir);
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(health.status).toBe(200);
      const body = await health.json();
      expect(body.status).toBe('degraded');
      expect(body.maintenance.writeAllowed).toBe(true);
      expect(body.maintenance.warnings.length).toBeGreaterThan(0);

      // Non-read requests are still accepted (the login route itself runs).
      const login = await fetch(`http://127.0.0.1:${server.port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      expect(login.status).not.toBe(503);
      expect([400, 401]).toContain(login.status);
    } finally {
      await server.stop();
      // The invalid tombstone must survive startup (kept for diagnosis/retry).
      const db = new DatabaseSync(path.join(dataDir, 'database', 'knowledge_hub.sqlite'));
      try {
        const row = db
          .prepare('SELECT asset_id, last_error FROM asset_deletions WHERE asset_id = ?')
          .get('ast_bad_tombstone') as any;
        expect(row?.asset_id).toBe('ast_bad_tombstone');
        expect(row?.last_error).toBeTruthy();
      } finally {
        db.close();
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30000);

  it('starts normally when no recovery is pending', async () => {
    const dataDir = makeDataDir('startup_ok');

    const server = await startServer(dataDir);
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(health.status).toBe(200);
      const body = await health.json();
      expect(body.status).toBe('ok');
      expect(body.maintenance.writeAllowed).toBe(true);
      expect(body.maintenance.warnings).toEqual([]);

      const login = await fetch(`http://127.0.0.1:${server.port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      expect(login.status).not.toBe(503);
      expect([400, 401]).toContain(login.status);
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});
