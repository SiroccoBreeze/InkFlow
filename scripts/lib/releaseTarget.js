/**
 * Release output directory guard (SEC-012).
 *
 * `INKFLOW_RELEASE_OUT` is user-controlled, and the release builder deletes the
 * target directory before rebuilding it. A bad value could therefore wipe the
 * project, the user's data, or an arbitrary directory. This module makes the
 * target selection fail-closed:
 *
 *   Allowed:
 *     - the canonical `<project>/release` directory
 *     - a direct child of the OS temp dir whose name starts with an
 *       `inkflow_release_` / `inkflow-release-` prefix (test builds)
 *
 *   Rejected (before anything is deleted):
 *     - relative, empty-ish or control-character paths
 *     - the project root, its parent, filesystem roots, the home dir
 *     - the temp dir itself
 *     - protected project subdirectories (storage, .git, src, server, …)
 *     - the configured runtime data directory (INKFLOW_DATA_DIR)
 *     - anything that escapes its allowed base through `..` or symlinks
 *
 * All checks use realpath-based canonicalization so symlinked components
 * cannot redirect the delete target.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Temp-dir output names must use one of these prefixes (test builds only). */
export const TMP_OUTPUT_PREFIXES = ['inkflow_release_', 'inkflow-release-'];

/** Project subdirectories that must never become a release target. */
export const PROTECTED_PROJECT_DIRS = [
  'storage',
  '.git',
  'node_modules',
  'src',
  'server',
  'scripts',
  'docs',
  'dist',
  '.aistudio',
];

export class ReleaseTargetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseTargetError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseTargetError(code, message);
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** True when `candidate` is `parent` itself or lives inside it. */
export function isSameOrInside(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolves `target` to a canonical absolute path, following every symlink that
 * already exists while refusing broken links and unresolvable paths.
 */
function canonicalize(target) {
  let existing = target;
  while (true) {
    if (lstatOrNull(existing)) break;
    const parent = path.dirname(existing);
    if (parent === existing) fail('UNRESOLVABLE_PATH', `无法解析输出目录: ${target}`);
    existing = parent;
  }

  // A dangling symlink reports lstat success but realpath failure.
  const existingReal = realpathOrNull(existing);
  if (!existingReal) {
    fail('UNRESOLVABLE_PATH', `输出目录包含无法解析的符号链接: ${existing}`);
  }

  const tail = path.relative(existing, target);
  if (tail === '..' || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail)) {
    fail('PATH_ESCAPE', `输出目录逃逸出可解析的父目录: ${target}`);
  }

  return path.resolve(existingReal, tail);
}

/**
 * Validates (and canonicalizes) the requested release output directory.
 *
 * @param {string | undefined | null} requestedRaw
 * @param {object} [options]
 * @param {string} [options.rootDir] project root
 * @param {string} [options.tmpDir] OS temp dir (override for tests)
 * @param {string} [options.dataDir] runtime data dir (INKFLOW_DATA_DIR or <root>/storage)
 * @param {string} [options.homeDir] home dir (override for tests)
 * @returns {{ releaseDir: string, mode: 'project' | 'temp' }}
 * @throws {ReleaseTargetError}
 */
export function resolveReleaseTarget(requestedRaw, options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const tmpDir = path.resolve(options.tmpDir || os.tmpdir());
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const dataDir = path.resolve(options.dataDir || path.join(rootDir, 'storage'));

  const defaultTarget = path.join(rootDir, 'release');
  // Inspect the RAW value first: trimming would hide trailing newlines/NUL bytes.
  if (requestedRaw !== undefined && requestedRaw !== null && typeof requestedRaw !== 'string') {
    fail('INVALID_PATH', '输出目录必须是字符串');
  }
  const rawValue = typeof requestedRaw === 'string' ? requestedRaw : '';
  if (/[\u0000-\u001f\u007f]/.test(rawValue)) {
    fail('INVALID_PATH', '输出目录包含非法控制字符');
  }
  if (rawValue !== rawValue.trim()) {
    fail('INVALID_PATH', '输出目录首尾不能包含空白字符');
  }

  const hasExplicitTarget = rawValue !== '';
  const requested = hasExplicitTarget ? rawValue : defaultTarget;

  if (!requested) {
    fail('INVALID_PATH', '输出目录不能为空');
  }
  if (hasExplicitTarget && !path.isAbsolute(requested)) {
    fail('RELATIVE_PATH', `输出目录必须是绝对路径: ${requested}`);
  }

  const rootReal = realpathOrNull(rootDir);
  if (!rootReal) {
    fail('UNRESOLVABLE_PATH', `无法解析项目根目录: ${rootDir}`);
  }
  const tmpReal = realpathOrNull(tmpDir) || tmpDir;
  const homeReal = realpathOrNull(homeDir) || homeDir;

  // Reject the delete target itself being a symlink before canonicalizing it.
  const requestedLstat = lstatOrNull(requested);
  if (requestedLstat?.isSymbolicLink()) {
    fail('SYMLINK_TARGET', `输出目录本身是符号链接，拒绝执行: ${requested}`);
  }
  // An existing non-directory path can never be a valid release output.
  if (requestedLstat && !requestedLstat.isDirectory()) {
    fail('NOT_A_DIRECTORY', `输出目录已存在但不是目录: ${requested}`);
  }

  const canonical = canonicalize(requested);

  if (requestedLstat && realpathOrNull(requested) !== canonical) {
    fail('SYMLINK_TARGET', `输出目录经符号链接解析后不一致，拒绝执行: ${requested}`);
  }

  // 1. Absolutely forbidden locations
  const fsRoot = path.parse(canonical).root;
  const forbiddenExact = new Set(
    [rootReal, path.dirname(rootReal), fsRoot, tmpReal, homeReal, dataDir].map(p => path.resolve(p))
  );

  if (forbiddenExact.has(canonical)) {
    fail('FORBIDDEN_TARGET', `拒绝将输出目录设置为危险路径: ${canonical}`);
  }

  // The target must not be an ancestor of the project (deleting it would wipe the repo).
  if (isSameOrInside(canonical, rootReal)) {
    fail('FORBIDDEN_TARGET', `输出目录是项目根目录或其父目录，拒绝执行: ${canonical}`);
  }

  // 2. Runtime data directory (users' Markdown, database, assets, revisions).
  //    Checked before the generic protected-directory loop so the error names the
  //    actual risk, and in both directions so neither an ancestor nor a descendant passes.
  const dataReal = realpathOrNull(dataDir) || dataDir;
  if (isSameOrInside(dataReal, canonical) || isSameOrInside(canonical, dataReal)) {
    fail('DATA_DIR_CONFLICT', `输出目录与运行时数据目录重叠，拒绝执行: ${canonical}`);
  }

  // 3. Protected project directories
  for (const dir of PROTECTED_PROJECT_DIRS) {
    const protectedDir = path.join(rootReal, dir);
    if (isSameOrInside(protectedDir, canonical)) {
      fail('PROTECTED_PATH', `输出目录位于受保护的项目目录内 (${dir}/)，拒绝执行: ${canonical}`);
    }
  }

  // 4. Canonical project release directory
  const canonicalProjectRelease = path.join(rootReal, 'release');
  if (canonical === canonicalProjectRelease) {
    return { releaseDir: canonical, mode: 'project' };
  }

  // 5. Test builds: a direct, prefixed child of the OS temp directory
  const parentDir = path.dirname(canonical);
  const baseName = path.basename(canonical);
  if (parentDir === tmpReal && TMP_OUTPUT_PREFIXES.some(prefix => baseName.startsWith(prefix))) {
    return { releaseDir: canonical, mode: 'temp' };
  }

  fail(
    'OUTSIDE_ALLOWED_BASE',
    `输出目录必须位于 ${canonicalProjectRelease} 或临时目录下的 ${TMP_OUTPUT_PREFIXES.join(' / ')}* 子目录: ${canonical}`
  );
}

/**
 * Re-checks a previously validated target immediately before deleting it
 * (guards against the target being swapped for a symlink in between).
 */
export function assertReleaseTargetStillSafe(releaseDir, options = {}) {
  const { releaseDir: revalidated } = resolveReleaseTarget(releaseDir, options);
  if (path.resolve(revalidated) !== path.resolve(releaseDir)) {
    fail('TARGET_CHANGED', `输出目录在校验后发生变化，拒绝删除: ${releaseDir} → ${revalidated}`);
  }
  return revalidated;
}

/**
 * Deletes a validated release directory. The target is re-validated first and
 * the deletion is skipped when the directory does not exist.
 */
export function removeReleaseDirSafely(releaseDir, options = {}) {
  const safeDir = assertReleaseTargetStillSafe(releaseDir, options);
  if (fs.existsSync(safeDir)) {
    fs.rmSync(safeDir, { recursive: true, force: true });
  }
  return safeDir;
}
