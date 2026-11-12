import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { getDatabase, generateId, runInTransaction } from '../db/sqlite';
import { fileStorage } from './fileStorageService';
import { extractAssetReferences } from './documentService';
import { assetMutationLock, consistencyGate } from './consistencyGate';
import { maintenanceState } from './maintenanceState';
import { normalizeStorageRelativePath } from '../utils/storagePaths';

// Resolved lazily so INKFLOW_DATA_DIR is always honoured (tests / multi-instance deployments)
function getStorageRoot(): string {
  return fileStorage.getStorageRoot();
}

function getAssetsDir(): string {
  return path.join(getStorageRoot(), 'assets');
}

/** Resolves a DB `storage_path` and guarantees it stays inside the storage root. */
function resolveAssetPath(relativeStoragePath: string): string | null {
  return fileStorage.resolveWithinStorage(relativeStoragePath);
}

/**
 * Resolves symlinks and re-checks containment, so a symlink planted inside
 * storage/assets/ can never be used to read files outside the storage root.
 */
async function resolveAssetRealPath(relativeStoragePath: string): Promise<string | null> {
  const resolved = resolveAssetPath(relativeStoragePath);
  if (!resolved) return null;
  try {
    const rootReal = await fs.realpath(getStorageRoot());
    const fileReal = await fs.realpath(resolved);
    if (fileReal !== rootReal && !fileReal.startsWith(rootReal + path.sep)) {
      return null;
    }
    return fileReal;
  } catch {
    return null;
  }
}

export interface AssetRecord {
  id: string;
  ownerId: string;
  filename: string;
  storagePath: string;
  mimeType: string;
  size: number;
  checksum: string;
  url: string;
  createdAt: string;
}

/**
 * Thrown when a live asset row cannot be deleted safely because its stored
 * `storage_path` cannot produce an exact, validated tombstone. The DB row and
 * file are left untouched; callers must surface this as an explicit error.
 */
export class AssetPathInvalidError extends Error {
  public readonly code = 'ASSET_PATH_INVALID';
  constructor(
    public readonly assetId: string,
    message: string
  ) {
    super(message);
  }
}

type AssetDeletionReason = 'manual-delete' | 'cleanup-unreferenced' | 'cleanup-orphan';

interface AssetDeletionIntent {
  assetId: string;
  storagePath: string;
  filename: string | null;
  reason: AssetDeletionReason;
}

interface AssetDeletionRow {
  asset_id: string;
  storage_path: string;
  filename: string | null;
  reason: string;
  requested_at: string;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
}

/** Only flat files directly inside storage/assets/ with a conservative name. */
const ASSET_FILE_NAME_RE = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Normalizes a managed asset path (`assets/<file>`). Rejects traversal,
 * subdirectories, dotfiles and names that could not have been produced by the
 * upload path. Used for reconciliation, tombstones and retry validation.
 */
function normalizeManagedAssetPath(value: unknown): string | null {
  // normalizeStorageRelativePath() trims; reject a value that would map to a
  // different file name than the one actually on disk.
  if (typeof value !== 'string' || value !== value.trim()) return null;

  const normalized = normalizeStorageRelativePath(value);
  if (!normalized) return null;

  const segments = normalized.split('/');
  if (segments.length !== 2 || segments[0] !== 'assets') return null;

  const fileName = segments[1];
  if (fileName.startsWith('.') || !ASSET_FILE_NAME_RE.test(fileName)) return null;
  if (path.posix.parse(fileName).name.startsWith('.')) return null;

  return normalized;
}

/** The asset ID implied by a managed file name (same rule used by reconcile). */
function assetIdFromFileName(fileName: string): string | null {
  if (fileName.startsWith('.') || !ASSET_FILE_NAME_RE.test(fileName)) return null;
  const id = path.posix.parse(fileName).name;
  return ASSET_FILE_NAME_RE.test(id) && !id.startsWith('.') ? id : null;
}

export class AssetService {
  private ensureAssetsDir(): string {
    const assetsDir = getAssetsDir();
    if (!fsSync.existsSync(assetsDir)) {
      fsSync.mkdirSync(assetsDir, { recursive: true });
    }
    return assetsDir;
  }

  // -------------------------------------------------------------------------
  // Asset deletion tombstones
  //
  // Deleting an asset is a two-sided operation: the DB rows and the physical
  // file cannot be removed atomically. The tombstone is inserted in the SAME
  // transaction that removes the rows, so the intent survives a crash. The file
  // is unlinked afterwards, and only a confirmed deletion (or ENOENT) removes
  // the tombstone. Reconcile skips every tombstoned ID/path, so a failed unlink
  // can never resurrect the asset as a fresh DB row.
  // -------------------------------------------------------------------------

  /** Persist deletion intent. Caller must already be inside a transaction. */
  private recordDeletionIntentsLocked(intents: AssetDeletionIntent[]): void {
    if (intents.length === 0) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    const statement = db.prepare(`
      INSERT INTO asset_deletions (asset_id, storage_path, filename, reason, requested_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(asset_id, storage_path) DO UPDATE SET
        filename = excluded.filename,
        reason = excluded.reason,
        requested_at = excluded.requested_at,
        attempts = 0,
        last_attempt_at = NULL,
        last_error = NULL
    `);

    for (const intent of intents) {
      // Defense in depth: never persist a tombstone that could later resolve to
      // an unrelated file. Callers must already have validated the path, but a
      // future caller must not be able to bypass that by constructing an intent.
      const normalized = normalizeManagedAssetPath(intent.storagePath);
      const impliedId = normalized ? assetIdFromFileName(path.posix.basename(normalized)) : null;
      if (!normalized || normalized !== intent.storagePath || !impliedId || impliedId !== intent.assetId) {
        throw new Error(
          `拒绝写入非法的附件删除标记：asset_id=${intent.assetId}, storage_path=${JSON.stringify(intent.storagePath)}`
        );
      }
      statement.run(intent.assetId, intent.storagePath, intent.filename, intent.reason, now);
    }
  }

  /** Removes exactly the tombstone that was just satisfied (no broader match). */
  private clearTombstoneLocked(assetId: string, storagePath: string): void {
    getDatabase()
      .prepare('DELETE FROM asset_deletions WHERE asset_id = ? AND storage_path = ?')
      .run(assetId, storagePath);
  }

  private markTombstoneFailureLocked(row: AssetDeletionRow, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    getDatabase()
      .prepare(`
        UPDATE asset_deletions
        SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
        WHERE asset_id = ? AND storage_path = ?
      `)
      .run(new Date().toISOString(), message, row.asset_id, row.storage_path);
  }

  /**
   * Validates a tombstone before touching the filesystem:
   *  - path must be a flat `assets/<file>` with a conservative name;
   *  - the file name must imply the same asset ID stored in the tombstone.
   * A forged/corrupt tombstone is refused (kept for diagnosis), never used to
   * delete an unrelated file or a document.
   */
  private resolveTombstoneTarget(row: AssetDeletionRow): { absolutePath: string; storagePath: string } | null {
    const storagePath = normalizeManagedAssetPath(row.storage_path);
    if (!storagePath) return null;

    const fileName = path.posix.basename(storagePath);
    const impliedId = assetIdFromFileName(fileName);
    if (!impliedId || impliedId !== row.asset_id) return null;

    const absolutePath = resolveAssetPath(storagePath);
    if (!absolutePath) return null;

    return { absolutePath, storagePath };
  }

  private async attemptTombstoneDeletionLocked(
    row: AssetDeletionRow
  ): Promise<{ status: 'deleted' | 'missing' | 'cancelled' | 'failed'; freedBytes: number }> {
    const db = getDatabase();

    // If the assets row still exists, the delete transaction that created this
    // tombstone never committed (or the id was reused). Never delete a live
    // asset's file: cancel the intent instead.
    const live = db.prepare('SELECT id FROM assets WHERE id = ?').get(row.asset_id) as any;
    if (live) {
      this.clearTombstoneLocked(row.asset_id, row.storage_path);
      return { status: 'cancelled', freedBytes: 0 };
    }

    const target = this.resolveTombstoneTarget(row);
    if (!target) {
      this.markTombstoneFailureLocked(row, '删除标记路径无效或与 asset_id 不匹配');
      return { status: 'failed', freedBytes: 0 };
    }

    try {
      // lstat: never follow a symlink. Directories are refused (no recursive rm).
      const stat = await fs.lstat(target.absolutePath);
      if (stat.isDirectory()) {
        this.markTombstoneFailureLocked(row, '目标是目录，拒绝递归删除');
        return { status: 'failed', freedBytes: 0 };
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        this.markTombstoneFailureLocked(row, '目标不是普通文件或符号链接');
        return { status: 'failed', freedBytes: 0 };
      }

      await fs.unlink(target.absolutePath);
      this.clearTombstoneLocked(row.asset_id, row.storage_path);
      return { status: 'deleted', freedBytes: stat.isFile() ? stat.size : 0 };
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // The file is already gone: the deletion goal is satisfied.
        this.clearTombstoneLocked(row.asset_id, row.storage_path);
        return { status: 'missing', freedBytes: 0 };
      }
      this.markTombstoneFailureLocked(row, err);
      return { status: 'failed', freedBytes: 0 };
    }
  }

  /**
   * Retries every pending tombstone. Idempotent; safe to call repeatedly.
   * Caller must hold either the exclusive consistency lease (startup/cleanup)
   * or the asset mutex plus a shared lease (delete/list paths).
   */
  private async retryPendingDeletionsLocked(): Promise<{
    recovered: number;
    failed: number;
    freedBytes: number;
  }> {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT * FROM asset_deletions ORDER BY requested_at ASC, asset_id ASC, storage_path ASC')
      .all() as unknown as AssetDeletionRow[];

    let recovered = 0;
    let failed = 0;
    let freedBytes = 0;

    for (const row of rows) {
      const result = await this.attemptTombstoneDeletionLocked(row);
      if (result.status === 'failed') failed++;
      else recovered++;
      freedBytes += result.freedBytes;
    }

    if (failed > 0) {
      console.error(
        `[InkFlow Assets] ${failed} asset deletion(s) still pending; tombstones were retained for retry.`
      );
    }

    return { recovered, failed, freedBytes };
  }

  /**
   * Startup recovery for attachments whose physical deletion failed after the
   * DB rows were removed. Runs under the exclusive lease before the server
   * accepts requests, so it cannot race an upload/reconcile/save.
   */
  public async recoverPendingAssetDeletions(): Promise<{
    recovered: number;
    failed: number;
    freedBytes: number;
  }> {
    return consistencyGate.withExclusive(() =>
      assetMutationLock.withLock(() => this.retryPendingDeletionsLocked())
    );
  }

  // Upload and persist asset to physical storage/assets/ & SQLite
  public async uploadAsset(params: {
    originalName: string;
    mimeType: string;
    buffer: Buffer;
    ownerId: string;
  }): Promise<AssetRecord> {
    // Shared lease excludes backup/restore; the asset mutex serialises uploads
    // against delete/cleanup/reconcile so a file can never be observed between
    // "written to disk" and "inserted into assets".
    const releaseGate = await consistencyGate.acquireShared();
    const releaseMutex = await assetMutationLock.acquire();
    try {
      const db = getDatabase();
      const assetsDir = this.ensureAssetsDir();
      const assetId = generateId('ast');
      const ext = path.extname(params.originalName) || this.getExtensionFromMime(params.mimeType);
      // Only keep a conservative extension; never let the original name influence the path beyond that.
      const safeExt = /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : '';
      const diskFileName = `${assetId}${safeExt}`;
      const targetFilePath = path.join(assetsDir, diskFileName);

      // Calculate sha256 checksum
      const checksum = crypto.createHash('sha256').update(params.buffer).digest('hex');

      // Physical disk write
      await fs.writeFile(targetFilePath, params.buffer, { flag: 'wx' });
      const relativeStoragePath = fileStorage.toStorageRelativePath(targetFilePath);

      const now = new Date().toISOString();
      const size = params.buffer.length;

      // Persist metadata to SQLite assets table. If the insert fails, remove the
      // just-written file so a failed upload cannot leave a permanent orphan.
      try {
        db.prepare(`
          INSERT INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          assetId,
          params.ownerId,
          path.basename(params.originalName),
          relativeStoragePath,
          params.mimeType || 'application/octet-stream',
          size,
          checksum,
          now
        );
      } catch (err) {
        await fs.rm(targetFilePath, { force: true }).catch(() => {});
        throw err;
      }

      return {
        id: assetId,
        ownerId: params.ownerId,
        filename: params.originalName,
        storagePath: relativeStoragePath,
        mimeType: params.mimeType,
        size,
        checksum,
        url: `/api/v1/assets/file/${assetId}`,
        createdAt: now,
      };
    } finally {
      releaseMutex();
      releaseGate();
    }
  }

  // Get single asset by ID (with buffer for file serving)
  public async getAsset(id: string): Promise<{ record: any; buffer: Buffer } | null> {
    const db = getDatabase();
    const record = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
    if (!record) return null;

    const fullPath = await resolveAssetRealPath(record.storage_path);
    if (!fullPath) return null;

    try {
      const stat = await fs.lstat(fullPath);
      if (!stat.isFile()) return null;
      const buffer = await fs.readFile(fullPath);
      return { record, buffer };
    } catch {
      return null;
    }
  }

  // List all uploaded assets, reconciling physical files in storage/assets/.
  // Async because reconciliation is a write and must hold the consistency lease.
  public async listAssets(ownerId?: string): Promise<AssetRecord[]> {
    const releaseGate = await consistencyGate.acquireShared();
    const releaseMutex = await assetMutationLock.acquire();
    try {
      // In read-only maintenance mode, listing assets must not perform the
      // reconciliation write (GET /assets is otherwise a disguised write).
      if (maintenanceState.isWriteAllowed()) {
        this.reconcilePhysicalAssetsLocked();
      }
      const db = getDatabase();
      const rows = db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all() as any[];

      return rows.map(r => ({
        id: r.id,
        ownerId: r.owner_id,
        filename: r.filename,
        storagePath: r.storage_path,
        mimeType: r.mime_type,
        size: r.size,
        checksum: r.checksum,
        url: `/api/v1/assets/file/${r.id}`,
        createdAt: r.created_at,
      }));
    } finally {
      releaseMutex();
      releaseGate();
    }
  }

  /**
   * Adds DB rows for physical files that are missing from `assets`. Caller must
   * hold the asset mutex (and a shared lease). It never deletes anything.
   *
   * Tombstoned IDs/paths are skipped: a failed physical deletion must never be
   * turned back into a live asset row by reconciliation. Only regular files with
   * a conservative, flat name inside storage/assets/ are considered; dotfiles,
   * directories and symlinks are ignored.
   */
  private reconcilePhysicalAssetsLocked(): void {
    const db = getDatabase();
    const assetsDir = getAssetsDir();

    try {
      if (!fsSync.existsSync(assetsDir)) return;

      const tombstones = db.prepare('SELECT asset_id, storage_path FROM asset_deletions').all() as any[];
      const tombstoneIds = new Set(tombstones.map(row => String(row.asset_id)));
      const tombstonePaths = new Set(
        tombstones
          .map(row => normalizeManagedAssetPath(row.storage_path) ?? String(row.storage_path))
          .filter(Boolean)
      );

      const existingRows = db.prepare('SELECT id, storage_path FROM assets').all() as any[];
      const existingIds = new Set(existingRows.map(row => String(row.id)));
      const existingFilenames = new Set(
        existingRows.map(row => path.basename(String(row.storage_path).replace(/\\/g, '/')))
      );

      // Only reconcile against a real owner so FOREIGN KEY constraints stay satisfiable
      const ownerRow = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('owner') as any;
      const reconcileOwnerId = ownerRow?.id;
      if (!reconcileOwnerId) return;

      for (const entry of fsSync.readdirSync(assetsDir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;

        const storagePath = normalizeManagedAssetPath(`assets/${entry.name}`);
        const assetId = assetIdFromFileName(entry.name);
        if (!storagePath || !assetId) continue;

        if (tombstoneIds.has(assetId) || tombstonePaths.has(storagePath)) continue;
        if (existingIds.has(assetId) || existingFilenames.has(entry.name)) continue;

        const filePath = path.join(assetsDir, entry.name);
        let stat: fsSync.Stats;
        try {
          // lstat: a symlink is not an attachment, even if it points at a file.
          stat = fsSync.lstatSync(filePath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        const mimeType = this.getMimeFromExtension(ext);
        const now = new Date(stat.mtimeMs).toISOString();

        db.prepare(`
          INSERT OR IGNORE INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          assetId,
          reconcileOwnerId,
          entry.name,
          storagePath,
          mimeType,
          stat.size,
          '',
          now
        );
      }
    } catch (e) {
      console.error('Error reconciling physical assets:', e);
    }
  }

  // Delete asset: persist the deletion intent and remove the SQLite rows in one
  // transaction, then unlink the file. A failed unlink keeps the tombstone, so
  // reconcile cannot resurrect the attachment and startup can retry.
  public async deleteAsset(id: string): Promise<boolean> {
    const releaseGate = await consistencyGate.acquireShared();
    const releaseMutex = await assetMutationLock.acquire();
    try {
      const db = getDatabase();
      const record = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;

      const intents: AssetDeletionIntent[] = [];
      const seenPaths = new Set<string>();
      const addIntent = (rawStoragePath: unknown, filename: string | null): boolean => {
        const storagePath = normalizeManagedAssetPath(rawStoragePath);
        if (!storagePath) return false;
        const impliedId = assetIdFromFileName(path.posix.basename(storagePath));
        if (!impliedId || impliedId !== id) return false;
        if (seenPaths.has(storagePath)) return false;
        seenPaths.add(storagePath);
        intents.push({ assetId: id, storagePath, filename, reason: 'manual-delete' });
        return true;
      };

      if (record) {
        const recordPathValid = addIntent(
          record.storage_path,
          record.filename ? String(record.filename) : null
        );
        if (!recordPathValid) {
          // A live row whose storage_path cannot produce an exact tombstone must
          // not be deleted: doing so would leave an unprotected file that the
          // reconciler could later re-register (or could never be cleaned up).
          throw new AssetPathInvalidError(
            id,
            `附件 ${id} 的 storage_path 无法生成合法删除标记，已拒绝删除并保留数据库记录与物理文件`
          );
        }
      }

      // Also remove any physical file whose exact basename matches the asset ID
      // (never substring matching). Only regular files are considered; directories
      // and symlinks are never treated as attachments.
      try {
        const assetsDir = this.ensureAssetsDir();
        for (const entry of fsSync.readdirSync(assetsDir, { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          if (path.parse(entry.name).name !== id) continue;
          addIntent(`assets/${entry.name}`, entry.name);
        }
      } catch (err) {
        console.error('[InkFlow Assets] Failed scanning assets directory:', err);
      }

      let dbRowDeleted = false;
      if (record) {
        runInTransaction(db, () => {
          // Intent and row removal commit together, or not at all.
          this.recordDeletionIntentsLocked(intents);
          db.prepare('DELETE FROM document_assets WHERE asset_id = ?').run(id);
          db.prepare('DELETE FROM assets WHERE id = ?').run(id);
        });
        dbRowDeleted = true;
      } else if (intents.length > 0) {
        runInTransaction(db, () => this.recordDeletionIntentsLocked(intents));
      }

      // Retry this deletion and any previously failed attachments. A failure
      // leaves the tombstone in place for the next startup/cleanup attempt.
      await this.retryPendingDeletionsLocked();

      if (dbRowDeleted) return true;
      if (intents.length === 0) return false;

      // No DB row: report success only if at least one exact target was removed
      // (or was already missing).
      const remaining = new Set(
        (db.prepare('SELECT storage_path FROM asset_deletions WHERE asset_id = ?').all(id) as any[]).map(
          row => String(row.storage_path)
        )
      );
      return intents.some(intent => !remaining.has(intent.storagePath));
    } finally {
      releaseMutex();
      releaseGate();
    }
  }

  // Cleanup any assets that are not referenced by any document Markdown.
  //
  // Exclusive lease: this scan reads every Markdown file and removes DB rows that
  // describe files. It must not interleave with a save (which may add a reference
  // and a document_assets row) or with a backup (which needs a stable generation).
  public async cleanupUnreferencedAssets(): Promise<{
    cleanedCount: number;
    freedBytes: number;
    deletedIds: string[];
    skippedInvalidPaths: string[];
  }> {
    return consistencyGate.withExclusive(() =>
      assetMutationLock.withLock(() => this.cleanupUnreferencedAssetsUnderLease())
    );
  }

  /** Body of cleanup; caller must hold the exclusive lease AND the asset mutex. */
  public async cleanupUnreferencedAssetsUnderLease(): Promise<{
    cleanedCount: number;
    freedBytes: number;
    deletedIds: string[];
    skippedInvalidPaths: string[];
  }> {
    const db = getDatabase();

    // Build the set of asset IDs explicitly referenced by every document on disk.
    const referencedIds = new Set<string>();
    const diskDocIds = await fileStorage.listAllDiskDocumentIds();
    for (const docId of diskDocIds) {
      const md = await fileStorage.readDocumentMarkdown(docId);
      if (!md) continue;
      for (const id of extractAssetReferences(md)) referencedIds.add(id);
    }

    // Include the authoritative association table as a second source of truth.
    try {
      const rows = db.prepare('SELECT DISTINCT asset_id FROM document_assets').all() as any[];
      for (const r of rows) if (r.asset_id) referencedIds.add(r.asset_id);
    } catch {}

    // 0. Retry deletions that failed in a previous run before choosing new work.
    await this.retryPendingDeletionsLocked();

    const allAssets = db.prepare('SELECT * FROM assets').all() as any[];
    const candidates: Array<{ id: string; storagePath: string }> = [];
    const intentByPath = new Map<string, AssetDeletionIntent>();
    const sizeByPath = new Map<string, number>();
    const skippedInvalidPaths: string[] = [];

    for (const asset of allAssets) {
      const id = String(asset.id);
      if (referencedIds.has(id)) continue;

      const storagePath = normalizeManagedAssetPath(asset.storage_path);
      const impliedId = storagePath ? assetIdFromFileName(path.posix.basename(storagePath)) : null;
      if (!storagePath || !impliedId || impliedId !== id) {
        // Never delete the index row when the physical target cannot be named
        // exactly. Keep the row + file and leave a diagnostic for the operator.
        const label = `${id}:${JSON.stringify(asset.storage_path ?? null)}`;
        skippedInvalidPaths.push(label);
        console.error(
          `[InkFlow Assets] Skipping unreferenced asset ${label}: storage_path 无法解析为合法附件路径`
        );
        continue;
      }

      candidates.push({ id, storagePath });

      try {
        const absolutePath = resolveAssetPath(storagePath);
        if (absolutePath) {
          const stat = await fs.lstat(absolutePath);
          sizeByPath.set(storagePath, stat.isFile() ? stat.size : 0);
        }
      } catch {
        // missing file: the DB row is still removable
      }

      intentByPath.set(storagePath, {
        assetId: id,
        storagePath,
        filename: asset.filename ? String(asset.filename) : path.posix.basename(storagePath),
        reason: 'cleanup-unreferenced',
      });
    }

    // Unindexed orphan files (no assets row) that are also not referenced by any
    // Markdown. Only regular, conservatively named flat files are considered.
    const indexedFilenames = new Set(
      allAssets.map(asset => path.basename(String(asset.storage_path).replace(/\\/g, '/')))
    );
    const orphanIntents: AssetDeletionIntent[] = [];
    try {
      const assetsDir = this.ensureAssetsDir();
      for (const entry of fsSync.readdirSync(assetsDir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;

        const storagePath = normalizeManagedAssetPath(`assets/${entry.name}`);
        const assetId = assetIdFromFileName(entry.name);
        if (!storagePath || !assetId) {
          // Dotfiles (.gitkeep) are not attachments and are skipped silently.
          if (!entry.name.startsWith('.')) {
            const label = `assets/${entry.name}`;
            skippedInvalidPaths.push(label);
            console.error(
              `[InkFlow Assets] Skipping orphan file ${label}: 名称不是受管理的附件文件名`
            );
          }
          continue;
        }
        if (indexedFilenames.has(entry.name)) continue;
        if (referencedIds.has(assetId)) continue;
        if (intentByPath.has(storagePath)) continue;

        const filePath = path.join(assetsDir, entry.name);
        try {
          const stat = fsSync.lstatSync(filePath);
          if (!stat.isFile()) continue;
          sizeByPath.set(storagePath, stat.size);
        } catch {
          continue;
        }

        orphanIntents.push({
          assetId,
          storagePath,
          filename: entry.name,
          reason: 'cleanup-orphan',
        });
        intentByPath.set(storagePath, orphanIntents[orphanIntents.length - 1]);
      }
    } catch (err) {
      console.error('[InkFlow Assets] Failed scanning assets directory:', err);
    }

    const intents = Array.from(intentByPath.values());

    // 1. Persist every deletion intent and remove the candidate DB rows in one
    //    transaction. Reconcile will skip these tombstones even if the unlink
    //    below fails, so the asset cannot come back.
    if (candidates.length > 0 || intents.length > 0) {
      runInTransaction(db, () => {
        this.recordDeletionIntentsLocked(intents);
        const deleteAssociation = db.prepare('DELETE FROM document_assets WHERE asset_id = ?');
        const deleteAsset = db.prepare('DELETE FROM assets WHERE id = ?');
        for (const candidate of candidates) {
          deleteAssociation.run(candidate.id);
          deleteAsset.run(candidate.id);
        }
      });
    }

    // 2. Attempt every pending deletion (including ones from earlier runs).
    await this.retryPendingDeletionsLocked();

    // 3. Report only this operation's outcome.
    const remainingPaths = new Set(
      (db.prepare('SELECT storage_path FROM asset_deletions').all() as any[]).map(row =>
        String(row.storage_path)
      )
    );
    let freedBytes = 0;
    let cleanedOrphanFiles = 0;
    for (const intent of intents) {
      if (remainingPaths.has(intent.storagePath)) continue;
      freedBytes += sizeByPath.get(intent.storagePath) ?? 0;
      if (intent.reason === 'cleanup-orphan') cleanedOrphanFiles++;
    }

    const deletedIds = candidates.map(candidate => candidate.id);
    return {
      cleanedCount: candidates.length + cleanedOrphanFiles,
      freedBytes,
      deletedIds,
      skippedInvalidPaths,
    };
  }

  private getExtensionFromMime(mime: string): string {
    const map: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/svg+xml': '.svg',
      'application/pdf': '.pdf',
      'text/markdown': '.md',
      'text/plain': '.txt',
      'application/zip': '.zip',
    };
    return map[mime] || '.bin';
  }

  private getMimeFromExtension(ext: string): string {
    const map: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.zip': 'application/zip',
    };
    return map[ext.toLowerCase()] || 'application/octet-stream';
  }
}

export const assetService = new AssetService();
