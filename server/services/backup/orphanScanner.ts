import path from 'node:path';
import fs from 'node:fs/promises';
import { getDatabase, getStorageDir } from '../../db/sqlite';
import { normalizeStorageRelativePath } from '../../utils/storagePaths';
import { assetMutationLock, consistencyGate } from '../consistencyGate';
import { collectManagedFiles } from './backupSnapshot';
import {
  expectedManagedFilePaths,
  loadDatabaseBackupState,
} from './backupValidation';
import { parseManagedSnapshotPath } from './backupVerifier';

export type OrphanManagedFileKind =
  | 'revision'
  | 'asset'
  | 'document'
  | 'unknown';

export interface OrphanManagedFile {
  relativePath: string;
  absolutePath: string;
  kind: OrphanManagedFileKind;
  size: number;
  /** Only revision/asset orphans can be removed by the explicit cleanup entry. */
  cleanable: boolean;
  reason: string;
}

export interface OrphanScanReport {
  scannedAt: string;
  inventoryCount: number;
  expectedCount: number;
  orphans: OrphanManagedFile[];
  cleanableCount: number;
  manualReviewCount: number;
}

export interface OrphanCleanupResult {
  dryRun: boolean;
  requested: string[];
  /** Populated for dry runs: files that would be removed. */
  wouldRemove: string[];
  removed: string[];
  alreadyMissing: string[];
  skipped: Array<{ relativePath: string; reason: string }>;
  errors: Array<{ relativePath: string; message: string }>;
}

interface TombstoneSets {
  ids: Set<string>;
  paths: Set<string>;
}

function readTombstones(): TombstoneSets {
  const rows = getDatabase()
    .prepare('SELECT asset_id, storage_path FROM asset_deletions')
    .all() as Array<{ asset_id: string; storage_path: string }>;

  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const row of rows) {
    ids.add(String(row.asset_id));
    const normalized = normalizeStorageRelativePath(row.storage_path);
    paths.add(normalized ?? String(row.storage_path));
  }
  return { ids, paths };
}

/**
 * Read-only scan of files under documents/, revisions/ and assets/ that have no
 * database row. It does not delete or repair anything.
 *
 * The scan holds the exclusive consistency lease so the DB snapshot and the
 * filesystem inventory describe the same generation. The backup flow never
 * calls this function or its cleanup counterpart.
 */
async function scanLocked(): Promise<OrphanScanReport> {
  const db = getDatabase();
  const state = loadDatabaseBackupState(db);
  const storageRoot = getStorageDir();
  const inventory = await collectManagedFiles(
    storageRoot,
    new Set(state.assets.map(asset => asset.canonicalPath))
  );
  const expected = expectedManagedFilePaths(state);
  const tombstones = readTombstones();

  const orphans: OrphanManagedFile[] = [];
  for (const file of inventory) {
    if (expected.has(file.relativePath)) continue;

    const base = {
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      size: file.size,
    };
    const parsed = parseManagedSnapshotPath(file.relativePath);

    if (parsed?.kind === 'revision') {
      orphans.push({
        ...base,
        kind: 'revision',
        cleanable: true,
        reason: '数据库未登记的历史版本文件（可能是崩溃保存或删除文件失败留下的孤儿）',
      });
      continue;
    }

    if (parsed?.kind === 'asset') {
      const assetId = path.posix.parse(parsed.fileName).name;
      if (tombstones.ids.has(assetId) || tombstones.paths.has(file.relativePath)) {
        orphans.push({
          ...base,
          kind: 'asset',
          cleanable: false,
          reason: '附件删除标记仍未解决；请先完成 tombstone 重试，不能由孤儿清理直接删除',
        });
      } else {
        orphans.push({
          ...base,
          kind: 'asset',
          cleanable: true,
          reason: '数据库未登记的附件文件（可能是上传崩溃或对账前留下的孤儿）',
        });
      }
      continue;
    }

    if (parsed?.kind === 'document') {
      orphans.push({
        ...base,
        kind: 'document',
        cleanable: false,
        reason: '文档 index.md 没有对应数据库行；可能是未提交创建或待恢复删除，必须人工确认',
      });
      continue;
    }

    orphans.push({
      ...base,
      kind: 'unknown',
      cleanable: false,
      reason: '文件不符合受管快照路径布局，必须人工确认',
    });
  }

  orphans.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  return {
    scannedAt: new Date().toISOString(),
    inventoryCount: inventory.length,
    expectedCount: expected.size,
    orphans,
    cleanableCount: orphans.filter(orphan => orphan.cleanable).length,
    manualReviewCount: orphans.filter(orphan => !orphan.cleanable).length,
  };
}

/** Read-only preview. Never deletes or modifies anything. */
export async function scanManagedOrphans(): Promise<OrphanScanReport> {
  return consistencyGate.withExclusive(() => scanLocked());
}

async function cleanupLocked(
  relativePaths: string[],
  dryRun: boolean
): Promise<OrphanCleanupResult> {
  const scan = await scanLocked();
  const byPath = new Map(scan.orphans.map(orphan => [orphan.relativePath, orphan]));
  const requested = Array.from(new Set(relativePaths));

  const result: OrphanCleanupResult = {
    dryRun,
    requested,
    wouldRemove: [],
    removed: [],
    alreadyMissing: [],
    skipped: [],
    errors: [],
  };

  for (const rawPath of requested) {
    const normalized = normalizeStorageRelativePath(rawPath);
    if (!normalized || normalized !== rawPath) {
      result.skipped.push({ relativePath: rawPath, reason: '不是安全的存储相对路径' });
      continue;
    }

    const orphan = byPath.get(normalized);
    if (!orphan) {
      result.skipped.push({
        relativePath: normalized,
        reason: '该路径当前不是数据库未登记的孤儿，拒绝删除',
      });
      continue;
    }
    if (!orphan.cleanable) {
      result.skipped.push({ relativePath: normalized, reason: orphan.reason });
      continue;
    }

    if (dryRun) {
      result.wouldRemove.push(normalized);
      continue;
    }

    try {
      const stat = await fs.lstat(orphan.absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        result.skipped.push({
          relativePath: normalized,
          reason: '目标不是普通文件（拒绝跟随符号链接/删除目录）',
        });
        continue;
      }
      await fs.unlink(orphan.absolutePath);
      result.removed.push(normalized);

      if (orphan.kind === 'revision') {
        // Remove a now-empty per-document directory. Non-empty directories are
        // left untouched (ENOTEMPTY is expected).
        await fs.rmdir(path.dirname(orphan.absolutePath)).catch(() => {});
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        result.alreadyMissing.push(normalized);
        continue;
      }
      result.errors.push({
        relativePath: normalized,
        message: err?.message || String(err),
      });
    }
  }

  return result;
}

/**
 * Explicit cleanup entry for orphan revision/asset FILES. It requires the exact
 * paths returned by `scanManagedOrphans()` and supports a read-only dry run.
 *
 * - Only regular files at the scanned paths are unlinked.
 * - Unregistered document files, tombstoned assets and unknown layouts are never
 *   removed automatically.
 * - The backup flow never calls this function; it only fails closed.
 */
export async function cleanupManagedOrphanFiles(options: {
  relativePaths: string[];
  dryRun?: boolean;
}): Promise<OrphanCleanupResult> {
  const dryRun = options.dryRun === true;
  return consistencyGate.withExclusive(() =>
    assetMutationLock.withLock(() => cleanupLocked(options.relativePaths, dryRun))
  );
}
