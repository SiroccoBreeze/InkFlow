import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ReleaseTargetError,
  resolveReleaseTarget,
  removeReleaseDirSafely,
  isSameOrInside,
  TMP_OUTPUT_PREFIXES,
} from '../../scripts/lib/releaseTarget.js';

const ROOT_DIR = path.resolve(process.cwd());
const tmpRoot = path.join(os.tmpdir(), `inkflow_target_tests_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmpRoot, { recursive: true });

// Sandbox "project" so tests never touch the real repository or its data.
const sandboxProject = path.join(tmpRoot, 'project');
const sandboxHome = path.join(tmpRoot, 'home');
const sandboxTmp = path.join(tmpRoot, 'tmp');
const sandboxData = path.join(sandboxProject, 'storage');

function makeSandboxProject() {
  for (const dir of [
    'storage/documents/doc-1',
    'storage/database',
    'storage/assets',
    'storage/revisions/doc-1',
    'src',
    'server',
    'scripts/lib',
    '.git/objects',
    'dist',
    'docs',
    'node_modules',
  ]) {
    fs.mkdirSync(path.join(sandboxProject, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(sandboxProject, 'package.json'), '{"name":"sandbox"}\n');
  fs.writeFileSync(path.join(sandboxProject, 'server.ts'), '// sandbox\n');
  fs.writeFileSync(path.join(sandboxProject, 'storage/documents/doc-1/index.md'), '# REAL USER DATA\n');
  fs.writeFileSync(path.join(sandboxProject, 'storage/database/knowledge_hub.sqlite'), 'REAL DB');
  fs.writeFileSync(path.join(sandboxProject, 'storage/assets/ast_1.png'), 'REAL ASSET');
  fs.writeFileSync(path.join(sandboxProject, 'storage/revisions/doc-1/rev_1.md'), 'REAL REVISION');
  fs.mkdirSync(sandboxHome, { recursive: true });
  fs.mkdirSync(sandboxTmp, { recursive: true });
}

makeSandboxProject();

const baseOptions = {
  rootDir: sandboxProject,
  tmpDir: sandboxTmp,
  homeDir: sandboxHome,
  dataDir: sandboxData,
};

function expectRejected(target: string, code?: string, options: Record<string, unknown> = baseOptions) {
  let error: unknown;
  try {
    resolveReleaseTarget(target, options);
  } catch (err) {
    error = err;
  }
  expect(error, `expected ${target} to be rejected`).toBeInstanceOf(ReleaseTargetError);
  if (code) expect((error as ReleaseTargetError).code).toBe(code);
  return error as ReleaseTargetError;
}

function snapshotTree(dir: string, base: string = dir, out: Record<string, string> = {}): Record<string, string> {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      snapshotTree(full, base, out);
    } else {
      out[path.relative(base, full)] = fs.readFileSync(full, 'utf8');
    }
  }
  return out;
}

describe('SEC-012 Release output directory safety', () => {
  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('allowed targets', () => {
    it('accepts the canonical <project>/release directory by default', () => {
      const { releaseDir, mode } = resolveReleaseTarget(undefined, baseOptions);
      expect(releaseDir).toBe(fs.realpathSync(sandboxProject) + path.sep + 'release');
      expect(mode).toBe('project');
    });

    it('accepts an explicit <project>/release path', () => {
      const requested = path.join(sandboxProject, 'release');
      const { releaseDir, mode } = resolveReleaseTarget(requested, baseOptions);
      expect(mode).toBe('project');
      expect(releaseDir).toBe(path.join(fs.realpathSync(sandboxProject), 'release'));
    });

    it('accepts a correctly prefixed direct child of the temp dir (test builds)', () => {
      const requested = path.join(sandboxTmp, `${TMP_OUTPUT_PREFIXES[0]}abc123`);
      const { releaseDir, mode } = resolveReleaseTarget(requested, baseOptions);
      expect(mode).toBe('temp');
      expect(releaseDir).toBe(path.join(fs.realpathSync(sandboxTmp), `${TMP_OUTPUT_PREFIXES[0]}abc123`));
    });
  });

  describe('dangerous targets are rejected before any deletion', () => {
    it('rejects the project root', () => {
      expectRejected(sandboxProject, 'FORBIDDEN_TARGET');
    });

    it('rejects the parent of the project root', () => {
      expectRejected(path.dirname(sandboxProject), 'FORBIDDEN_TARGET');
    });

    it('rejects the filesystem root', () => {
      expectRejected(path.parse(sandboxProject).root, 'FORBIDDEN_TARGET');
    });

    it('rejects the home directory', () => {
      expectRejected(sandboxHome, 'FORBIDDEN_TARGET');
    });

    it('rejects the temp directory itself', () => {
      expectRejected(sandboxTmp, 'FORBIDDEN_TARGET');
    });

    it('rejects the runtime data directory and its contents', () => {
      // The data dir itself is also covered by the exact-match deny list
      expectRejected(sandboxData, 'FORBIDDEN_TARGET');
      expectRejected(path.join(sandboxData, 'documents'), 'DATA_DIR_CONFLICT');
      expectRejected(path.join(sandboxData, 'documents', 'doc-1', 'nested'), 'DATA_DIR_CONFLICT');
    });

    it('rejects protected project subdirectories', () => {
      // storage/ is reported as a data-directory conflict (more specific reason)
      for (const dir of ['.git', 'src', 'server', 'scripts', 'dist', 'docs', 'node_modules']) {
        expectRejected(path.join(sandboxProject, dir), 'PROTECTED_PATH');
      }
    });

    it('rejects an ancestor directory of the project', () => {
      expectRejected(path.dirname(sandboxProject), 'FORBIDDEN_TARGET');
    });

    it('rejects relative and malformed paths', () => {
      expectRejected('release', 'RELATIVE_PATH');
      expectRejected('./release', 'RELATIVE_PATH');
      expectRejected(path.join(sandboxTmp, 'inkflow_release_evil\u0000'), 'INVALID_PATH');
      expectRejected(path.join(sandboxTmp, 'inkflow_release_evil\n'), 'INVALID_PATH');
    });

    it('rejects a temp subdirectory without an allowed prefix', () => {
      expectRejected(path.join(sandboxTmp, 'random-dir'), 'OUTSIDE_ALLOWED_BASE');
    });

    it('rejects paths that escape the temp dir via ..', () => {
      expectRejected(path.join(sandboxTmp, `${TMP_OUTPUT_PREFIXES[0]}x`, '..', '..', 'etc'), 'OUTSIDE_ALLOWED_BASE');
    });

    it('rejects a symlink pointing at the project root', () => {
      const link = path.join(sandboxTmp, `${TMP_OUTPUT_PREFIXES[0]}link-to-project`);
      fs.symlinkSync(sandboxProject, link);
      try {
        expectRejected(link, 'SYMLINK_TARGET');
      } finally {
        fs.rmSync(link, { force: true });
      }
    });

    it('rejects a prefixed temp path that traverses a symlink to somewhere outside temp', () => {
      const outside = path.join(tmpRoot, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      const link = path.join(sandboxTmp, `${TMP_OUTPUT_PREFIXES[0]}link-dir`);
      fs.symlinkSync(outside, link);
      try {
        // The final component resolves outside tmp → must not be treated as a temp target
        expectRejected(path.join(link, 'nested'), 'OUTSIDE_ALLOWED_BASE');
      } finally {
        fs.rmSync(link, { force: true });
      }
    });

    it('rejects a dangling symlink target', () => {
      const link = path.join(sandboxTmp, `${TMP_OUTPUT_PREFIXES[0]}dangling`);
      fs.symlinkSync(path.join(tmpRoot, 'does-not-exist'), link);
      try {
        expectRejected(link, 'SYMLINK_TARGET');
      } finally {
        fs.rmSync(link, { force: true });
      }
    });

    it('rejects an existing path that is not a directory', () => {
      const filePath = path.join(sandboxTmp, `${TMP_OUTPUT_PREFIXES[0]}not-a-dir`);
      fs.writeFileSync(filePath, 'i am a file');
      try {
        expectRejected(filePath, 'NOT_A_DIRECTORY');
        expect(fs.readFileSync(filePath, 'utf8')).toBe('i am a file');
      } finally {
        fs.rmSync(filePath, { force: true });
      }
    });
  });

  describe('deletion is skipped for rejected targets', () => {
    it('leaves the real user data untouched when a dangerous target is rejected', () => {
      const before = snapshotTree(sandboxProject);
      expect(before['storage/documents/doc-1/index.md']).toBe('# REAL USER DATA\n');

      for (const target of [
        sandboxProject,
        path.dirname(sandboxProject),
        sandboxData,
        path.join(sandboxProject, '.git'),
        path.join(sandboxProject, 'src'),
      ]) {
        expect(() => removeReleaseDirSafely(target, baseOptions)).toThrow(ReleaseTargetError);
      }

      expect(snapshotTree(sandboxProject)).toEqual(before);
    });

    it('does not delete anything when the builder aborts on an unsafe INKFLOW_RELEASE_OUT', () => {
      const before = snapshotTree(sandboxProject);
      let failed = false;
      try {
        execFileSync('node', ['scripts/build_release.js'], {
          cwd: ROOT_DIR,
          stdio: 'pipe',
          env: {
            ...process.env,
            INKFLOW_RELEASE_OUT: sandboxProject,
            INKFLOW_RELEASE_SKIP_BUILD: '1',
            INKFLOW_DATA_DIR: sandboxData,
          },
        });
      } catch (err: any) {
        failed = true;
        expect(err.status).toBe(1);
        expect(String(err.stderr)).toContain('BUILD ABORTED');
        // The project root overlaps the runtime data dir, so either guard may fire first
        expect(String(err.stderr)).toMatch(/FORBIDDEN_TARGET|DATA_DIR_CONFLICT/);
        expect(String(err.stderr)).toContain('未删除或修改任何文件');
      }
      expect(failed).toBe(true);
      expect(snapshotTree(sandboxProject)).toEqual(before);
    });

    it('does not delete the real repository or its user data when pointed at the repo root', () => {
      const realStorageBefore = snapshotTree(path.join(ROOT_DIR, 'storage'));
      let failed = false;
      try {
        execFileSync('node', ['scripts/build_release.js'], {
          cwd: ROOT_DIR,
          stdio: 'pipe',
          env: { ...process.env, INKFLOW_RELEASE_OUT: ROOT_DIR, INKFLOW_RELEASE_SKIP_BUILD: '1' },
        });
      } catch (err: any) {
        failed = true;
        expect(err.status).toBe(1);
      }
      expect(failed).toBe(true);
      expect(fs.existsSync(path.join(ROOT_DIR, 'package.json'))).toBe(true);
      expect(fs.existsSync(path.join(ROOT_DIR, 'server.ts'))).toBe(true);
      expect(snapshotTree(path.join(ROOT_DIR, 'storage'))).toEqual(realStorageBefore);
    });

    it('removes a safe temp output directory but nothing outside it', () => {
      const safeOut = path.join(sandboxTmp, `${TMP_OUTPUT_PREFIXES[0]}safe-delete`);
      const siblingFile = path.join(sandboxTmp, 'unrelated.txt');
      const userDataFile = path.join(sandboxData, 'documents/doc-1/index.md');

      fs.mkdirSync(path.join(safeOut, 'junk'), { recursive: true });
      fs.writeFileSync(path.join(safeOut, 'junk', 'old.txt'), 'old');
      fs.writeFileSync(siblingFile, 'keep me');

      removeReleaseDirSafely(safeOut, baseOptions);

      expect(fs.existsSync(safeOut)).toBe(false);
      expect(fs.readFileSync(siblingFile, 'utf8')).toBe('keep me');
      expect(fs.readFileSync(userDataFile, 'utf8')).toBe('# REAL USER DATA\n');
    });
  });

  describe('helper semantics', () => {
    it('isSameOrInside handles equality, descendants and siblings', () => {
      expect(isSameOrInside('/a/b', '/a/b')).toBe(true);
      expect(isSameOrInside('/a/b', '/a/b/c')).toBe(true);
      expect(isSameOrInside('/a/b', '/a/bc')).toBe(false);
      expect(isSameOrInside('/a/b', '/a')).toBe(false);
      expect(isSameOrInside('/a/b', '/x/y')).toBe(false);
    });
  });
});
