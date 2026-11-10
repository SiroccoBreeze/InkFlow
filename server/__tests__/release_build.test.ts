import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanRelease, isForbiddenPath } from '../../scripts/lib/releaseGuard.js';

const ROOT_DIR = path.resolve(process.cwd());
const releaseOut = path.join(os.tmpdir(), `inkflow_release_out_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
const fakeRuntimeData = path.join(os.tmpdir(), `inkflow_release_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
const MARKER = `SECRET_TEST_USER_DATA_${crypto.randomBytes(4).toString('hex')}`;

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

describe('SEC-009 Release build excludes all runtime data', () => {
  beforeAll(() => {
    // Build a realistic runtime storage directory containing "user data"
    const dirs = ['database', 'documents/doc-secret', 'revisions/doc-secret', 'assets', 'backups'];
    for (const d of dirs) fs.mkdirSync(path.join(fakeRuntimeData, d), { recursive: true });

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(fakeRuntimeData, 'database', 'knowledge_hub.sqlite'));
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT)');
    db.prepare('INSERT INTO users VALUES (?,?,?)').run('usr_x', MARKER, 'scrypt:dead:beef');
    db.close();
    fs.writeFileSync(path.join(fakeRuntimeData, 'database', 'knowledge_hub.sqlite-wal'), MARKER);
    fs.writeFileSync(path.join(fakeRuntimeData, 'database', 'knowledge_hub.sqlite-shm'), MARKER);
    fs.writeFileSync(path.join(fakeRuntimeData, 'documents', 'doc-secret', 'index.md'), `# ${MARKER}\n`);
    fs.writeFileSync(path.join(fakeRuntimeData, 'revisions', 'doc-secret', 'rev_1.md'), `${MARKER}\n`);
    fs.writeFileSync(path.join(fakeRuntimeData, 'assets', 'ast_secret.png'), MARKER);
    fs.writeFileSync(path.join(fakeRuntimeData, 'backups', 'db.bak'), MARKER);

    // Build the frontend if dist/ is missing (release builder copies it)
    if (!fs.existsSync(path.join(ROOT_DIR, 'dist', 'index.html'))) {
      execFileSync('npm', ['run', 'build'], { cwd: ROOT_DIR, stdio: 'ignore' });
    }

    // Run the real release builder against a temp output directory while a fake
    // runtime data directory exists. It must never read/copy that data.
    execFileSync('node', ['scripts/build_release.js'], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
      env: {
        ...process.env,
        INKFLOW_RELEASE_OUT: releaseOut,
        INKFLOW_RELEASE_SKIP_BUILD: '1',
        INKFLOW_DATA_DIR: fakeRuntimeData,
      },
    });
  }, 180000);

  afterAll(() => {
    for (const dir of [releaseOut, fakeRuntimeData]) {
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('creates a release package without any database, documents, assets or revisions', () => {
    const files = walkFiles(releaseOut);
    expect(files.length).toBeGreaterThan(0);

    const relative = files.map(f => path.relative(releaseOut, f).split(path.sep).join('/'));

    expect(relative.some(f => /\.sqlite/.test(f))).toBe(false);
    expect(relative.some(f => /\.db$/.test(f))).toBe(false);
    expect(relative.some(f => f.startsWith('storage/documents/') && !f.endsWith('.gitkeep'))).toBe(false);
    expect(relative.some(f => f.startsWith('storage/revisions/') && !f.endsWith('.gitkeep'))).toBe(false);
    expect(relative.some(f => f.startsWith('storage/assets/') && !f.endsWith('.gitkeep'))).toBe(false);
    expect(relative.some(f => f.startsWith('storage/backups/') && !f.endsWith('.gitkeep'))).toBe(false);
    expect(relative.some(f => f === '.env' || (f.startsWith('.env.') && f !== '.env.example'))).toBe(false);
  });

  it('never contains the test user marker anywhere in the package', () => {
    const files = walkFiles(releaseOut);
    const leaked = files.filter(f => {
      const buf = fs.readFileSync(f);
      return buf.includes(MARKER);
    });
    expect(leaked).toEqual([]);
  });

  it('keeps only empty .gitkeep placeholders inside release/storage/', () => {
    const storageDir = path.join(releaseOut, 'storage');
    expect(fs.existsSync(storageDir)).toBe(true);

    for (const entry of fs.readdirSync(storageDir, { withFileTypes: true })) {
      expect(entry.isDirectory()).toBe(true);
      const inner = fs.readdirSync(path.join(storageDir, entry.name));
      expect(inner).toEqual(['.gitkeep']);
    }
  });

  it('includes the program files required to start in a clean environment', () => {
    for (const file of ['server.ts', 'package.json', 'tsconfig.json', 'README.md', '.env.example']) {
      expect(fs.existsSync(path.join(releaseOut, file))).toBe(true);
    }
    expect(fs.existsSync(path.join(releaseOut, 'dist', 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(releaseOut, 'server', 'routes', 'api.ts'))).toBe(true);
    expect(fs.existsSync(path.join(releaseOut, 'server', '__tests__'))).toBe(false);
  });

  it('post-build guard fails when sensitive files are injected into a package', () => {
    const probeDir = path.join(os.tmpdir(), `inkflow_release_probe_${Date.now()}`);
    try {
      fs.mkdirSync(path.join(probeDir, 'storage', 'database'), { recursive: true });
      fs.mkdirSync(path.join(probeDir, 'storage', 'assets'), { recursive: true });
      fs.writeFileSync(path.join(probeDir, 'storage', 'database', 'knowledge_hub.sqlite'), '');
      fs.writeFileSync(path.join(probeDir, 'storage', 'assets', 'ast_1.png'), '');
      fs.writeFileSync(path.join(probeDir, '.env'), 'SECRET=1');
      fs.writeFileSync(path.join(probeDir, 'debug.log'), '');
      fs.writeFileSync(path.join(probeDir, 'server.key'), '');

      const violations = scanRelease(probeDir);
      expect(violations).toContain('storage/database/knowledge_hub.sqlite');
      expect(violations).toContain('storage/assets/ast_1.png');
      expect(violations).toContain('.env');
      expect(violations).toContain('debug.log');
      expect(violations).toContain('server.key');

      expect(isForbiddenPath('storage/documents/doc-1/index.md')).toBe(true);
      expect(isForbiddenPath('storage/documents/.gitkeep')).toBe(false);
      expect(isForbiddenPath('dist/index.html')).toBe(false);
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });

  it('the release package boots and initializes a fresh database on first start', async () => {
    const runtimeDir = path.join(os.tmpdir(), `inkflow_release_run_${Date.now()}`);
    // Ask the OS for a free port to avoid collisions with parallel test workers
    const net = await import('node:net');
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address();
        const p = typeof address === 'object' && address ? address.port : 0;
        srv.close(() => resolve(p));
      });
    });

    // Simulate `npm install` in the released package: link the runtime dependencies
    // instead of performing a real network install.
    const releaseNodeModules = path.join(releaseOut, 'node_modules');
    if (!fs.existsSync(releaseNodeModules)) {
      fs.mkdirSync(releaseNodeModules, { recursive: true });
      const runtimeDeps = Object.keys(
        JSON.parse(fs.readFileSync(path.join(releaseOut, 'package.json'), 'utf-8')).dependencies || {}
      ).filter(dep => dep !== 'tsx');
      for (const dep of runtimeDeps) {
        const sourceDir = path.join(ROOT_DIR, 'node_modules', dep);
        if (fs.existsSync(sourceDir)) {
          fs.symlinkSync(sourceDir, path.join(releaseNodeModules, dep), 'dir');
        }
      }
    }

    const child = spawn(path.join(ROOT_DIR, 'node_modules', '.bin', 'tsx'), ['server.ts', '--prod'], {
      cwd: releaseOut,
      env: {
        ...process.env,
        PORT: String(port),
        INKFLOW_DATA_DIR: runtimeDir,
        INKFLOW_INIT_KEY: 'release-test-init-key-0123456789',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverOutput = '';
    child.stdout.on('data', d => (serverOutput += d.toString()));
    child.stderr.on('data', d => (serverOutput += d.toString()));

    try {
      let healthy = false;
      for (let i = 0; i < 300; i++) {
        if (child.exitCode !== null) break;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (res.ok) {
            healthy = true;
            break;
          }
        } catch {
          // server not ready yet
        }
        await new Promise(r => setTimeout(r, 150));
      }
      expect(healthy, `release server did not become healthy:\n${serverOutput}`).toBe(true);

      // Fresh database created on first start (never shipped with the package)
      const dbPath = path.join(runtimeDir, 'database', 'knowledge_hub.sqlite');
      expect(fs.existsSync(dbPath)).toBe(true);

      const status = await fetch(`http://127.0.0.1:${port}/api/v1/auth/status`).then(r => r.json());
      expect(status.data.isInitialized).toBe(false);
      expect(status.data.canInitialize).toBe(true);

      const anonInit = await fetch(`http://127.0.0.1:${port}/api/v1/auth/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'attacker', password: 'AttackerPass123!' }),
      });
      expect(anonInit.status).toBe(401);
    } finally {
      child.kill('SIGKILL');
      await new Promise(r => setTimeout(r, 300));
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  }, 120000);
});
