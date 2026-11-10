/**
 * Release content guard (SEC-009).
 *
 * Shared by the release builder and its tests. The guard defines what is allowed
 * to exist inside a production package and refuses everything else.
 *
 * A valid release may contain only:
 *   - dist/                  compiled frontend
 *   - server/{db,routes,services}/**  backend source (no tests)
 *   - server.ts, tsconfig.json, .env.example, package.json, README.md
 *   - storage/{documents,database,assets,revisions,backups}/.gitkeep
 *
 * Runtime data (SQLite/WAL/SHM, user Markdown, revisions, attachments, backups,
 * dotenv files, key material, logs) is always a violation.
 */
import fs from 'node:fs';
import path from 'node:path';

export const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)storage\/(database|documents|revisions|assets|backups)\/(?!\.gitkeep$).+/,
  /(^|\/)\.env(?!\.example$)/,
  /\.sqlite($|-wal$|-shm$)/,
  /\.sqlite3$/,
  /\.(db|db-wal|db-shm)$/,
  /(^|\/)(secret|secrets)(\/|$)/,
  /(^|\/)(\.key|\.pem|id_rsa)(\/|$|\.)/,
  /\.(key|pem|p12|pfx)$/i,
  /\.log$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)__tests__(\/|$)/,
  /\.(test|spec)\.(ts|js)$/,
];

export function normalizeRelative(p) {
  return p.split(path.sep).join('/');
}

export function isForbiddenPath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  return FORBIDDEN_PATH_PATTERNS.some(pattern => pattern.test(normalized));
}

export function assertSafeReleasePath(relativePath) {
  if (isForbiddenPath(relativePath)) {
    throw new Error(`拒绝将敏感路径打包进 release: ${normalizeRelative(relativePath)}`);
  }
}

/**
 * Scans a built release directory and returns every violation found.
 * An empty array means the package is clean.
 */
export function scanRelease(releaseDir) {
  const violations = [];

  if (!fs.existsSync(releaseDir)) {
    return [`release directory does not exist: ${releaseDir}`];
  }

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(releaseDir, full);

      // storage/ is verified separately: it must contain only .gitkeep placeholders.
      const isStorageSkeleton = normalizeRelative(relative) === 'storage' || relative.startsWith(`storage${path.sep}`);
      if (!isStorageSkeleton && isForbiddenPath(relative)) {
        violations.push(normalizeRelative(relative));
      }

      if (entry.isDirectory()) walk(full);
    }
  }

  walk(releaseDir);

  // storage/ must be nothing but empty directory placeholders
  const storageDir = path.join(releaseDir, 'storage');
  if (fs.existsSync(storageDir)) {
    for (const entry of fs.readdirSync(storageDir, { withFileTypes: true })) {
      const full = path.join(storageDir, entry.name);
      if (entry.isFile() && entry.name !== '.gitkeep') {
        violations.push(normalizeRelative(path.relative(releaseDir, full)));
        continue;
      }
      if (entry.isDirectory()) {
        for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
          if (sub.name !== '.gitkeep') {
            violations.push(normalizeRelative(path.relative(releaseDir, path.join(full, sub.name))));
          }
        }
      }
    }
  }

  return [...new Set(violations)];
}
