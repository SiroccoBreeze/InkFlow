import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { normalizeStorageRelativePath } from '../../utils/storagePaths';
import { BackupError, BACKUP_MANIFEST_FILE_NAME, type BackupFileEntry, type SnapshotMode } from './types';

const MANAGED_DIRECTORIES = ['documents', 'revisions', 'assets'] as const;

export interface SnapshotInventoryEntry {
  /** Canonical POSIX path relative to the storage root (and backup root). */
  relativePath: string;
  absolutePath: string;
  size: number;
}

/** Temp/backup/marker files are never part of the content snapshot. */
function isExcludedFileName(name: string): boolean {
  if (name.startsWith('.')) return true; // .gitkeep, .save.pending, .delete.pending, .env
  const lower = name.toLowerCase();
  if (lower.endsWith('.bak')) return true;
  if (lower.endsWith('.tmp')) return true;
  return false;
}

async function walkManagedDirectory(
  rootDir: string,
  directoryRelativePath: string,
  output: SnapshotInventoryEntry[],
  seen: Map<string, string>,
  preservedPaths: ReadonlySet<string>,
  preservedDirectories: ReadonlySet<string>
): Promise<void> {
  const absoluteDir = path.join(rootDir, ...directoryRelativePath.split('/'));
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (err: any) {
    // The managed roots are checked before walking. A nested directory that
    // disappears mid-scan means the source changed while we were snapshotting;
    // silently returning would turn an incomplete snapshot into a "successful"
    // one, so fail closed. Callers that need "absent directory == empty" handle
    // the managed root themselves in collectManagedFiles().
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `快照目录在扫描过程中不可访问 ${directoryRelativePath}：${err?.message || err}`,
      { path: directoryRelativePath },
      { cause: err }
    );
  }

  for (const entry of entries) {
    const childRelativePath = `${directoryRelativePath}/${entry.name}`;
    // A DB-referenced attachment may legitimately end in `.tmp`/`.bak`; those
    // exact paths are content, not recovery artifacts. Directories containing a
    // preserved path must also be traversed. Unreferenced files with those
    // suffixes remain excluded.
    const preserved =
      preservedPaths.has(childRelativePath) || preservedDirectories.has(childRelativePath);
    if (isExcludedFileName(entry.name) && !preserved) continue;

    // Never follow symlinks/junctions: an attacker could otherwise pull files
    // from outside the storage root into the backup.
    if (entry.isSymbolicLink()) {
      console.warn(`[InkFlow Backup] Skipping symbolic link in snapshot tree: ${childRelativePath}`);
      continue;
    }
    if (entry.isDirectory()) {
      // Defense in depth: on Windows a junction/reparse point may not always be
      // reported by Dirent as a symlink. lstat it before descending.
      const childAbsolutePath = path.join(rootDir, ...childRelativePath.split('/'));
      const childStat = await fs.lstat(childAbsolutePath);
      if (childStat.isSymbolicLink()) {
        console.warn(`[InkFlow Backup] Skipping symbolic link in snapshot tree: ${childRelativePath}`);
        continue;
      }
      await walkManagedDirectory(
        rootDir,
        childRelativePath,
        output,
        seen,
        preservedPaths,
        preservedDirectories
      );
      continue;
    }
    if (!entry.isFile()) continue;

    const normalized = normalizeStorageRelativePath(childRelativePath);
    if (!normalized || normalized !== childRelativePath) {
      throw new BackupError('BACKUP_INCONSISTENT_STATE', `快照路径不是安全的 POSIX 相对路径：${childRelativePath}`);
    }

    const absolutePath = path.join(rootDir, ...normalized.split('/'));
    let stat: fsSync.Stats;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (err: any) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `快照源文件不可访问：${normalized}：${err?.message || err}`,
        { path: normalized },
        { cause: err }
      );
    }
    if (!stat.isFile()) continue;

    const lower = normalized.toLowerCase();
    const previous = seen.get(lower);
    if (previous) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `快照路径冲突（大小写不敏感）：${previous} 与 ${normalized}`,
        { first: previous, second: normalized }
      );
    }
    seen.set(lower, normalized);

    output.push({ relativePath: normalized, absolutePath, size: stat.size });
  }
}

/**
 * Builds the authoritative file inventory for documents/, revisions/ and assets/.
 *
 * Only regular files are considered. Dotfiles, `.bak`, `.tmp`, `.save.pending`,
 * `.delete.pending`, `.env` and symlinks are excluded, unless the exact path is
 * listed in `preservedPaths` (DB-referenced attachments are content even when
 * their extension happens to be `.tmp`/`.bak`). Directory read failures abort
 * the backup rather than producing a silently incomplete snapshot.
 */
export async function collectManagedFiles(
  rootDir: string,
  preservedPaths: ReadonlySet<string> = new Set()
): Promise<SnapshotInventoryEntry[]> {
  const output: SnapshotInventoryEntry[] = [];
  const seen = new Map<string, string>();
  const preservedDirectories = new Set<string>();
  for (const preservedPath of preservedPaths) {
    const segments = preservedPath.split('/');
    for (let index = 1; index < segments.length; index++) {
      preservedDirectories.add(segments.slice(0, index).join('/'));
    }
  }

  for (const directory of MANAGED_DIRECTORIES) {
    const absoluteRoot = path.join(rootDir, directory);
    let rootStat: fsSync.Stats;
    try {
      rootStat = await fs.lstat(absoluteRoot);
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue; // absent directory === empty
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `快照源目录不存在或不可访问：${directory}：${err?.message || err}`,
        { path: directory },
        { cause: err }
      );
    }
    // The managed root itself must be a real directory. A symlinked
    // storage/documents (or junction) could otherwise pull outside files in.
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `快照源目录不是普通目录（拒绝跟随符号链接）：${directory}`,
        { path: directory }
      );
    }
    await walkManagedDirectory(
      rootDir,
      directory,
      output,
      seen,
      preservedPaths,
      preservedDirectories
    );
  }

  output.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return output;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function defaultCopyFile(source: string, destination: string): Promise<void> {
  // COPYFILE_EXCL: a snapshot must never silently overwrite an existing file.
  await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL);
}

function resolveSnapshotDestination(stagingDir: string, relativePath: string): string {
  const destination = path.join(stagingDir, ...relativePath.split('/'));
  const root = path.resolve(stagingDir);
  const resolved = path.resolve(destination);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new BackupError('BACKUP_FILE_SNAPSHOT_FAILED', `快照目标路径越界：${relativePath}`);
  }
  return resolved;
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Re-checks a source entry immediately before it is linked/copied.
 *
 * collectManagedFiles() already skips symlinks, but the filesystem can change
 * while the snapshot is being materialised. Following a newly introduced symlink
 * here would pull an out-of-tree file into the backup package (or violate the DB
 * commit markers), so every source must still be a regular file, stay under the
 * real storage root, and keep the size captured by the inventory.
 */
async function assertSnapshotSourceUnchanged(
  file: SnapshotInventoryEntry,
  storageRootReal: string
): Promise<void> {
  let stat: fsSync.Stats;
  try {
    stat = await fs.lstat(file.absolutePath);
  } catch (err: any) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `快照源文件在扫描后不可访问：${file.relativePath}：${err?.message || err}`,
      { path: file.relativePath },
      { cause: err }
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `快照源文件在扫描后不再是普通文件（拒绝跟随符号链接）：${file.relativePath}`,
      { path: file.relativePath }
    );
  }
  if (stat.size !== file.size) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `快照源文件在扫描后发生变化：${file.relativePath}（期望 ${file.size} 字节，实际 ${stat.size}）`,
      { path: file.relativePath, expectedSize: file.size, actualSize: stat.size }
    );
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(file.absolutePath);
  } catch (err: any) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `无法解析快照源文件真实路径：${file.relativePath}：${err?.message || err}`,
      { path: file.relativePath },
      { cause: err }
    );
  }
  if (!isStrictlyInside(storageRootReal, realPath)) {
    throw new BackupError(
      'BACKUP_INCONSISTENT_STATE',
      `快照源文件解析到存储目录之外（符号链接逃逸）：${file.relativePath}`,
      { path: file.relativePath }
    );
  }
}

/**
 * Materialises the file inventory inside `stagingDir`.
 *
 * HARD-LINK SAFETY AUDIT (V1.2 Batch 2A):
 *  - documents/<id>/index.md is written by `atomicWriteFile` (temp + rename) and the
 *    crash-recovery path restores it with `rename`; it is never truncated/appended
 *    in place.
 *  - revisions/<docId>/<revisionId>.md is written by the same `atomicWriteFile`
 *    helper and removed with `unlink`; no in-place mutation exists.
 *  - assets/<file> is created with an exclusive `writeFile({ flag: 'wx' })`, never
 *    overwritten, and deleted with `unlink`. Reconciliation only inserts DB rows.
 * Because every future change replaces the directory entry instead of mutating the
 * inode, an existing hardlink keeps the snapshot's bytes immutable. Any future
 * in-place writer must switch this code to copy mode first.
 *
 * Link failures (EXDEV, EPERM, unsupported filesystems, Windows restrictions) fall
 * back to a real copy file-by-file. The manifest records hardlink/copy/mixed.
 *
 * Defence in depth: every inventory entry is lstat'ed and realpath-checked again
 * immediately before materialisation (regular file, still inside the real storage
 * root, unchanged size). This closes the scan→link/copy window against a file that
 * is swapped for a symlink after collectManagedFiles() ran.
 */
export async function createFileSnapshot(params: {
  stagingDir: string;
  /** Real storage root used to verify that no source escaped through a symlink. */
  storageRoot: string;
  files: SnapshotInventoryEntry[];
  forceCopy?: boolean;
  linkFile?: (source: string, destination: string) => Promise<void>;
  copyFile?: (source: string, destination: string) => Promise<void>;
}): Promise<{ entries: BackupFileEntry[]; mode: SnapshotMode }> {
  const linkFile = params.linkFile ?? fs.link;
  const copyFile = params.copyFile ?? defaultCopyFile;
  let storageRootReal: string;
  try {
    storageRootReal = await fs.realpath(params.storageRoot);
  } catch (err: any) {
    throw new BackupError(
      'BACKUP_FILE_SNAPSHOT_FAILED',
      `无法解析存储根目录真实路径：${params.storageRoot}：${err?.message || err}`,
      { storageRoot: params.storageRoot },
      { cause: err }
    );
  }
  let hardlinkCount = 0;
  let copyCount = 0;
  const entries: BackupFileEntry[] = [];

  for (const file of params.files) {
    await assertSnapshotSourceUnchanged(file, storageRootReal);
    const destination = resolveSnapshotDestination(params.stagingDir, file.relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });

    let usedHardlink = false;
    if (!params.forceCopy) {
      try {
        await linkFile(file.absolutePath, destination);
        usedHardlink = true;
      } catch {
        // Fall through to copy. The link may have failed before creating anything,
        // but remove any partial destination to keep the fallback deterministic.
        await fs.rm(destination, { force: true }).catch(() => {});
      }
    }

    if (!usedHardlink) {
      try {
        await copyFile(file.absolutePath, destination);
        copyCount++;
      } catch (err: any) {
        throw new BackupError(
          'BACKUP_FILE_SNAPSHOT_FAILED',
          `复制快照文件失败：${file.relativePath}：${err?.message || err}`,
          { path: file.relativePath },
          { cause: err }
        );
      }
    } else {
      hardlinkCount++;
    }

    const stat = await fs.lstat(destination).catch((err: any) => {
      throw new BackupError(
        'BACKUP_FILE_SNAPSHOT_FAILED',
        `快照文件不可访问：${file.relativePath}：${err?.message || err}`,
        { path: file.relativePath },
        { cause: err }
      );
    });
    if (!stat.isFile() || stat.size !== file.size) {
      throw new BackupError(
        'BACKUP_FILE_SNAPSHOT_FAILED',
        `快照文件大小/类型不一致：${file.relativePath}（期望 ${file.size} 字节，实际 ${stat.size}）`,
        { path: file.relativePath, expectedSize: file.size, actualSize: stat.size }
      );
    }

    const sha256 = await sha256File(destination).catch((err: any) => {
      throw new BackupError(
        'BACKUP_FILE_SNAPSHOT_FAILED',
        `计算快照文件 SHA-256 失败：${file.relativePath}：${err?.message || err}`,
        { path: file.relativePath },
        { cause: err }
      );
    });
    entries.push({ path: file.relativePath, size: file.size, sha256 });
  }

  let mode: SnapshotMode;
  if (copyCount === 0) mode = 'hardlink';
  else if (hardlinkCount === 0) mode = 'copy';
  else mode = 'mixed';
  // An empty content snapshot claims neither strategy.
  if (entries.length === 0) mode = 'copy';

  return { entries, mode };
}

async function walkSnapshotDirectory(
  directory: string,
  relativeBase: string,
  output: string[]
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new BackupError('BACKUP_INCONSISTENT_STATE', `快照目录中出现符号链接：${relativePath}`);
    }
    if (entry.isDirectory()) {
      await walkSnapshotDirectory(absolutePath, relativePath, output);
    } else if (entry.isFile()) {
      output.push(relativePath);
    }
  }
}

/**
 * Final consistency check: the staging directory must contain exactly the files
 * described by the manifest plus manifest.json itself. Sizes must match. This
 * catches stray temp files, missing copies and accidental extra data.
 */
export async function verifySnapshotLayout(
  directory: string,
  manifest: { database: { path: string; size: number }; files: BackupFileEntry[] }
): Promise<void> {
  const actual: string[] = [];
  await walkSnapshotDirectory(directory, '', actual);
  actual.sort();

  const expected = [
    BACKUP_MANIFEST_FILE_NAME,
    manifest.database.path,
    ...manifest.files.map(file => file.path),
  ].sort();

  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    const missing = expected.filter(value => !actual.includes(value));
    const extra = actual.filter(value => !expected.includes(value));
    throw new BackupError('BACKUP_INCONSISTENT_STATE', '快照目录内容与 manifest 不一致', {
      missing,
      extra,
    });
  }

  for (const file of manifest.files) {
    const stat = await fs.lstat(path.join(directory, ...file.path.split('/')));
    if (!stat.isFile() || stat.size !== file.size) {
      throw new BackupError('BACKUP_INCONSISTENT_STATE', `快照文件大小不一致：${file.path}`, {
        expectedSize: file.size,
        actualSize: stat.size,
      });
    }
  }
  const databaseStat = await fs.lstat(path.join(directory, ...manifest.database.path.split('/')));
  if (!databaseStat.isFile() || databaseStat.size !== manifest.database.size) {
    throw new BackupError('BACKUP_INCONSISTENT_STATE', '数据库快照大小与 manifest 不一致');
  }
}
