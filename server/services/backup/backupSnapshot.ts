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

function statChanged(before: fsSync.Stats, after: fsSync.Stats): boolean {
  return (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.ino !== after.ino
  );
}

function openFlagsNoFollow(): number {
  const noFollow =
    process.platform === 'win32' || fsSync.constants.O_NOFOLLOW === undefined
      ? 0
      : fsSync.constants.O_NOFOLLOW;
  return fsSync.constants.O_RDONLY | noFollow;
}

/**
 * Copies one source file through an already-opened file descriptor.
 *
 * The source is opened with O_NOFOLLOW (POSIX), fstat'ed, read exclusively from
 * that handle, and fstat'ed again afterwards. The destination is written through
 * a private `wx+` handle, then read back from the same handle and hashed. Any
 * size/inode/mtime change on the source, a short/long read, or a destination hash
 * mismatch aborts the backup.
 *
 * Windows cannot express O_NOFOLLOW through Node. The final lstat→open window
 * therefore remains a documented residual race; O_NOFOLLOW-free copying is still
 * fstat/realpath checked and hash-verified, but it must not be described as a
 * complete elimination of the path-swap race there.
 */
async function safeCopyFile(params: {
  sourcePath: string;
  destinationPath: string;
  expectedStat: fsSync.Stats;
  storageRootReal: string;
  relativePath: string;
  onChunk?: (bytesReadTotal: number) => Promise<void>;
}): Promise<void> {
  let sourceHandle: fs.FileHandle;
  try {
    sourceHandle = await fs.open(params.sourcePath, openFlagsNoFollow());
  } catch (err: any) {
    throw new BackupError(
      'BACKUP_FILE_SNAPSHOT_FAILED',
      `无法安全打开快照源文件：${params.relativePath}：${err?.message || err}`,
      { path: params.relativePath },
      { cause: err }
    );
  }

  try {
    const before = await sourceHandle.stat();
    if (!before.isFile()) {
      throw new BackupError(
        'BACKUP_FILE_SNAPSHOT_FAILED',
        `快照源文件句柄不是普通文件：${params.relativePath}`,
        { path: params.relativePath }
      );
    }
    if (
      before.size !== params.expectedStat.size ||
      before.ino !== params.expectedStat.ino ||
      before.dev !== params.expectedStat.dev ||
      before.mtimeMs !== params.expectedStat.mtimeMs
    ) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `快照源文件在检查与打开之间被替换或修改：${params.relativePath}`,
        {
          path: params.relativePath,
          expectedSize: params.expectedStat.size,
          actualSize: before.size,
          expectedIno: params.expectedStat.ino,
          actualIno: before.ino,
        }
      );
    }

    // Re-check provenance after opening. On POSIX O_NOFOLLOW already rejects a
    // final symlink; on Windows this narrows (but does not eliminate) the race.
    let realPath: string;
    try {
      realPath = await fs.realpath(params.sourcePath);
    } catch (err: any) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `无法解析快照源文件真实路径：${params.relativePath}：${err?.message || err}`,
        { path: params.relativePath },
        { cause: err }
      );
    }
    if (!isStrictlyInside(params.storageRootReal, realPath)) {
      throw new BackupError(
        'BACKUP_INCONSISTENT_STATE',
        `快照源文件解析到存储目录之外（符号链接逃逸）：${params.relativePath}`,
        { path: params.relativePath }
      );
    }

    let destinationHandle: fs.FileHandle;
    try {
      destinationHandle = await fs.open(params.destinationPath, 'wx+');
    } catch (err: any) {
      throw new BackupError(
        'BACKUP_FILE_SNAPSHOT_FAILED',
        `无法创建快照目标文件：${params.relativePath}：${err?.message || err}`,
        { path: params.relativePath },
        { cause: err }
      );
    }

    try {
      const chunk = Buffer.alloc(64 * 1024);
      let position = 0;
      let bytesReadTotal = 0;
      const sourceHash = crypto.createHash('sha256');

      while (position < before.size) {
        const { bytesRead } = await sourceHandle.read(
          chunk,
          0,
          Math.min(chunk.length, before.size - position),
          position
        );
        if (bytesRead <= 0) break;

        const block = chunk.subarray(0, bytesRead);
        sourceHash.update(block);
        bytesReadTotal += bytesRead;

        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await destinationHandle.write(
            block,
            written,
            bytesRead - written,
            position + written
          );
          if (bytesWritten <= 0) break;
          written += bytesWritten;
        }
        if (written !== bytesRead) {
          throw new BackupError(
            'BACKUP_FILE_SNAPSHOT_FAILED',
            `快照目标文件写入不完整：${params.relativePath}`,
            { path: params.relativePath, expectedBytes: bytesRead, writtenBytes: written }
          );
        }
        position += bytesRead;
        await params.onChunk?.(bytesReadTotal);
      }

      const after = await sourceHandle.stat();
      if (bytesReadTotal !== before.size || statChanged(before, after)) {
        throw new BackupError(
          'BACKUP_INCONSISTENT_STATE',
          `快照源文件在复制期间发生变化：${params.relativePath}`,
          {
            path: params.relativePath,
            expectedSize: before.size,
            actualSize: after.size,
            bytesRead: bytesReadTotal,
          }
        );
      }

      const destinationStat = await destinationHandle.stat();
      if (!destinationStat.isFile() || destinationStat.size !== bytesReadTotal) {
        throw new BackupError(
          'BACKUP_FILE_SNAPSHOT_FAILED',
          `快照目标文件大小不一致：${params.relativePath}（期望 ${bytesReadTotal} 字节，实际 ${destinationStat.size}）`,
          {
            path: params.relativePath,
            expectedSize: bytesReadTotal,
            actualSize: destinationStat.size,
          }
        );
      }

      // Read the destination back through the same private handle and compare
      // the actual copied bytes with the bytes hashed from the source handle.
      const destinationHash = crypto.createHash('sha256');
      let verifyPosition = 0;
      while (verifyPosition < bytesReadTotal) {
        const { bytesRead } = await destinationHandle.read(
          chunk,
          0,
          Math.min(chunk.length, bytesReadTotal - verifyPosition),
          verifyPosition
        );
        if (bytesRead <= 0) break;
        destinationHash.update(chunk.subarray(0, bytesRead));
        verifyPosition += bytesRead;
      }
      const sourceDigest = sourceHash.digest('hex');
      const destinationDigest = destinationHash.digest('hex');
      if (verifyPosition !== bytesReadTotal || sourceDigest !== destinationDigest) {
        throw new BackupError(
          'BACKUP_FILE_SNAPSHOT_FAILED',
          `快照复制内容校验失败：${params.relativePath}`,
          {
            path: params.relativePath,
            sourceSha256: sourceDigest,
            destinationSha256: destinationDigest,
          }
        );
      }
    } finally {
      await destinationHandle.close().catch(() => {});
    }
  } finally {
    await sourceHandle.close().catch(() => {});
  }
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
): Promise<fsSync.Stats> {
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
  return stat;
}

/**
 * Materialises the file inventory inside `stagingDir`.
 *
 * SNAPSHOT MODES (V1.2 Batch 2B):
 *  - Default: independent COPY. Every backup file is a private inode, so a later
 *    in-place write to a production file (or any external tool rewriting it)
 *    cannot alter the backup.
 *  - Opt-in `useHardlinks`: link first, copy on failure. This is a fast mode, NOT
 *    an independent or immutable backup: the staged file and the production file
 *    share one inode, so any in-place truncate/write corrupts both. Project code
 *    currently only replaces directory entries (atomic temp+rename writes, `wx`
 *    creation, unlink), but external/manual writers are outside that guarantee.
 *    The manifest records the mode and verification reports a warning for it.
 *
 * Link failures (EXDEV, EPERM, unsupported filesystems, Windows restrictions) fall
 * back to a real copy file-by-file. The manifest records the effective mode.
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
  /** Default false: independent copy. True: hardlink-first (not independent). */
  useHardlinks?: boolean;
  /** @deprecated Use `useHardlinks`; kept for existing callers/tests. */
  forceCopy?: boolean;
  linkFile?: (source: string, destination: string) => Promise<void>;
  copyFile?: (source: string, destination: string) => Promise<void>;
  /** Test/diagnostic hook: runs after source pre-checks and before open/link. */
  beforeSourceOpen?: (relativePath: string, absolutePath: string) => Promise<void>;
  /** Test/diagnostic hook: runs after each copied 64 KiB chunk. */
  afterSourceCopyChunk?: (relativePath: string, bytesReadTotal: number) => Promise<void>;
}): Promise<{ entries: BackupFileEntry[]; mode: SnapshotMode; warnings: string[] }> {
  const linkFile = params.linkFile ?? fs.link;
  const useHardlinks = params.useHardlinks === true && params.forceCopy !== true;
  const warnings: string[] = [];
  if (!useHardlinks && (process.platform === 'win32' || fsSync.constants.O_NOFOLLOW === undefined)) {
    warnings.push(
      '当前平台无法使用 O_NOFOLLOW：源文件在 lstat 检查与 open 之间仍存在符号链接替换窗口。' +
        '复制内容仍通过句柄 fstat、前后状态比较和 SHA-256 回读校验，但该竞态未被完全消除。'
    );
  }
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
    const sourceStat = await assertSnapshotSourceUnchanged(file, storageRootReal);
    await params.beforeSourceOpen?.(file.relativePath, file.absolutePath);
    const destination = resolveSnapshotDestination(params.stagingDir, file.relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });

    let usedHardlink = false;
    if (useHardlinks) {
      try {
        await linkFile(file.absolutePath, destination);
        usedHardlink = true;
      } catch {
        // Fall through to copy. The link may have failed before creating anything,
        // but remove any partial destination to keep the fallback deterministic.
        await fs.rm(destination, { force: true }).catch(() => {});
      }
    }

    if (usedHardlink) {
      // The link itself is path-based; re-check the source immediately after it
      // to detect a change during link creation. A final-component symlink swap
      // remains a residual TOCTOU risk in hardlink mode (documented above).
      let after: fsSync.Stats;
      try {
        after = await fs.lstat(file.absolutePath);
      } catch (err: any) {
        throw new BackupError(
          'BACKUP_INCONSISTENT_STATE',
          `硬链接后源文件不可访问：${file.relativePath}：${err?.message || err}`,
          { path: file.relativePath },
          { cause: err }
        );
      }
      // Creating a hardlink updates the inode ctime/nlink, so only compare the
      // attributes that indicate a content replacement here.
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        after.size !== sourceStat.size ||
        after.mtimeMs !== sourceStat.mtimeMs ||
        after.ino !== sourceStat.ino
      ) {
        throw new BackupError(
          'BACKUP_INCONSISTENT_STATE',
          `硬链接建立期间源文件发生变化：${file.relativePath}`,
          { path: file.relativePath }
        );
      }
      hardlinkCount++;
    } else {
      try {
        if (params.copyFile) {
          await params.copyFile(file.absolutePath, destination);
        } else {
          await safeCopyFile({
            sourcePath: file.absolutePath,
            destinationPath: destination,
            expectedStat: sourceStat,
            storageRootReal,
            relativePath: file.relativePath,
            onChunk: params.afterSourceCopyChunk
              ? bytesReadTotal => params.afterSourceCopyChunk!(file.relativePath, bytesReadTotal)
              : undefined,
          });
        }
        copyCount++;
      } catch (err: any) {
        if (err instanceof BackupError) throw err;
        throw new BackupError(
          'BACKUP_FILE_SNAPSHOT_FAILED',
          `复制快照文件失败：${file.relativePath}：${err?.message || err}`,
          { path: file.relativePath },
          { cause: err }
        );
      }
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
  if (entries.length === 0 || !useHardlinks) mode = 'copy';
  else if (copyCount === 0) mode = 'hardlink';
  else if (hardlinkCount === 0) mode = 'copy';
  else mode = 'mixed';

  return { entries, mode, warnings };
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
 * Legacy size-only layout check.
 *
 * Production creation and verification now use `backupVerifier`, which re-reads
 * the manifest, rejects unknown/non-regular/symlink entries and recomputes every
 * SHA-256. This helper is kept for low-level callers/tests that only need the
 * path/size contract.
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
