import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT_DIR = path.resolve(process.cwd());
const BUILD_SCRIPT = path.join(ROOT_DIR, 'scripts', 'build_release.js');
const STAGING_DIR = path.join(ROOT_DIR, '.release-staging');

const releaseOut = path.join(
  os.tmpdir(),
  `inkflow_release_staging_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const MARKER = `STAGING_SENTINEL_${crypto.randomBytes(6).toString('hex')}`;

/** Files placed inside .release-staging that must survive the build. */
const FIXTURE_FILES: Record<string, string> = {
  'sentinel.txt': `${MARKER}\n`,
  'nested/deep/note.md': `# ${MARKER}\n\nshould not be deleted\n`,
  '.hidden-state.json': JSON.stringify({ marker: MARKER }),
};

let weCreatedStagingDir = false;

function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function listScriptJsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listScriptJsFiles(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

describe('SEC-014 Release build performs no unvalidated recursive deletion', () => {
  beforeAll(() => {
    // Only create the fixture when the directory does not already exist;
    // a pre-existing .release-staging belongs to the developer, not to this test.
    if (!fs.existsSync(STAGING_DIR)) {
      fs.mkdirSync(STAGING_DIR, { recursive: true });
      weCreatedStagingDir = true;
    }
    for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
      const target = path.join(STAGING_DIR, relative);
      if (fs.existsSync(target)) continue; // never overwrite existing developer data
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf-8');
    }

    if (!fs.existsSync(path.join(ROOT_DIR, 'dist', 'index.html'))) {
      execFileSync('npm', ['run', 'build'], { cwd: ROOT_DIR, stdio: 'ignore' });
    }

    execFileSync('node', [BUILD_SCRIPT], {
      cwd: ROOT_DIR,
      stdio: 'pipe',
      env: {
        ...process.env,
        INKFLOW_RELEASE_OUT: releaseOut,
        INKFLOW_RELEASE_SKIP_BUILD: '1',
      },
    });
  }, 180000);

  afterAll(() => {
    try {
      if (fs.existsSync(releaseOut)) fs.rmSync(releaseOut, { recursive: true, force: true });
    } catch {
      // ignore
    }
    // Only remove the fixture files this test created, and only if we created the dir.
    if (weCreatedStagingDir) {
      try {
        fs.rmSync(STAGING_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('keeps .release-staging and every file inside it after a build', () => {
    expect(fs.existsSync(STAGING_DIR)).toBe(true);

    const after = snapshotDir(STAGING_DIR);
    for (const [relative, expectedContent] of Object.entries(FIXTURE_FILES)) {
      expect(after[relative], `${relative} was deleted by the release build`).toBe(expectedContent);
    }
  });

  it('does not leave the staging sentinel anywhere in the release package', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full).includes(MARKER)) found.push(path.relative(releaseOut, full));
      }
    };
    walk(releaseOut);
    expect(found).toEqual([]);
  });

  it('no longer declares or deletes STAGING_DIR in the release builder', () => {
    const source = fs.readFileSync(BUILD_SCRIPT, 'utf-8');

    expect(source).not.toContain('STAGING_DIR');
    expect(source).not.toContain('.release-staging');
    // The builder must not call fs.rmSync directly at all.
    expect(source).not.toMatch(/fs\.rmSync\s*\(/);
    expect(source).not.toMatch(/fs\.rm\s*\(/);
    expect(source).not.toMatch(/fs\.rmdir\s*\(/);
  });

  it('only the path-checked helper performs recursive deletion under scripts/', () => {
    const offenders: Array<{ file: string; match: string }> = [];

    for (const file of listScriptJsFiles(path.join(ROOT_DIR, 'scripts'))) {
      const source = fs.readFileSync(file, 'utf-8');
      const relative = path.relative(ROOT_DIR, file).split(path.sep).join('/');
      const recursiveDeletes = source.match(/(?:fs\.)?(?:rmSync|rm|rmdir)\s*\([^)]*recursive\s*:\s*true/g) || [];

      for (const call of recursiveDeletes) {
        // The single allowed recursive delete is the validated one in releaseTarget.js
        if (relative === 'scripts/lib/releaseTarget.js' && call.includes('safeDir')) continue;
        offenders.push({ file: relative, match: call.replace(/\s+/g, ' ') });
      }
    }

    expect(offenders).toEqual([]);
  });
});
