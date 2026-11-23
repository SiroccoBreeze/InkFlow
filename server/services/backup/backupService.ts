import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import * as nodeSqlite from 'node:sqlite';
import { consistencyGate } from '../consistencyGate';
import { fileStorage } from '../fileStorageService';
import { documentService } from '../documentService';
import { assetService } from '../assetService';
import { maintenanceState } from '../maintenanceState';
import { getDatabase, getDbPath } from '../../db/sqlite';
import {
  assertAssetAssociationsMatchMarkdown,
  assertDatabaseMatchesInventory,
  assertRevisionSnapshotsMatchDatabase,
  assertSnapshotHashesMatchDatabase,
  loadDatabaseBackupState,
  stripSessionsFromDatabaseCopy,
  validateDatabaseSnapshot,
  type DatabaseBackupState,
} from './backupValidation';
import {
  collectManagedFiles,
  createFileSnapshot,
  sha256File,
} from './backupSnapshot';
import {
  buildBackupManifest,
  getApplicationVersion,
  writeBackupManifest,
} from './backupManifest';
import { assertStagingSnapshotValid } from './backupVerifier';
import {
  BACKUP_DATABASE_RELATIVE_PATH,
  BackupError,
  isBackupSnapshotId,
  type BackupSnapshotResult,
  type CreateBackupOptions,
} from './types';

// Staging lives under backups/.staging. collectManagedFiles() only scans
// documents/, revisions/ and assets/, so a staging snapshot can never include
// itself (backups/ is outside every snapshot source root).
const STAGING_DIR_NAME = '.staging';

function nowId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `backup-${timestamp}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Creates complete, self-contained backup snapshots (V1.2 Batch 2A).
 *
 * A snapshot is a directory containing:
 *   manifest.json
 *   database/knowledge_hub.sqlite
 *   documents/... revisions/... assets/...
 *
 * The whole snapshot is produced while holding the EXISTING exclusive
 * ConsistencyGate lease. No second lock system is introduced: document/asset
 * writers already hold a shared lease (or acquire it through their public
 * methods), so they wait for the snapshot to finish and vice versa.
 *
 * ZIP compression, restore and scheduling are intentionally out of scope.
 */
export class BackupService {
  private getBackupsRoot(): string {
    return path.join(fileStorage.getStorageRoot(), 'backups');
  }

  /**
   * Creates (if needed) and validates a directory used by the snapshot lifecycle.
   * A symlink/reparse point here could redirect staging cleanup or a published
   * snapshot outside the storage tree, so it is refused explicitly.
   */
  private async ensureSafeDirectory(target: string, label: string): Promise<void> {
    try {
      await fs.mkdir(target, { recursive: true });
    } catch (err) {
      throw new BackupError(
        'BACKUP_STAGING_FAILED',
        `无法创建${label}：${(err as any)?.message || err}`,
        { path: target },
        { cause: err }
      );
    }
    let stat: fsSync.Stats;
    try {
      stat = await fs.lstat(target);
    } catch (err) {
      throw new BackupError(
        'BACKUP_STAGING_FAILED',
        `无法检查${label}：${(err as any)?.message || err}`,
        { path: target },
        { cause: err }
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new BackupError(
        'BACKUP_STAGING_FAILED',
        `${label}不是普通目录（拒绝跟随符号链接/junction）：${target}`,
        { path: target }
      );
    }
  }

  /**
   * Removes abandoned staging directories from a previous crashed run. Only
   * entries matching this service's own snapshot ID shape are touched; unrelated
   * files/directories under `.staging/` are preserved. Completed snapshots are
   * never deleted.
   */
  public async cleanupStaleStaging(): Promise<number> {
    return consistencyGate.withExclusive(async () => {
      const backupsRoot = this.getBackupsRoot();
      await this.ensureSafeDirectory(backupsRoot, '备份根目录');
      const stagingRoot = path.join(backupsRoot, STAGING_DIR_NAME);
      await this.ensureSafeDirectory(stagingRoot, '备份 staging 目录');
      return this.cleanupStaleStagingLocked(stagingRoot);
    });
  }

  private async cleanupStaleStagingLocked(stagingRoot: string): Promise<number> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(stagingRoot, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === 'ENOENT') return 0;
      throw new BackupError(
        'BACKUP_STAGING_FAILED',
        `无法读取 staging 目录：${err?.message || err}`,
        { stagingRoot },
        { cause: err }
      );
    }

    let removed = 0;
    for (const entry of entries) {
      if (!isBackupSnapshotId(entry.name)) {
        console.warn(
          `[InkFlow Backup] Ignoring unexpected entry in staging directory (not a backup snapshot ID): ${entry.name}`
        );
        continue;
      }
      const target = path.join(stagingRoot, entry.name);
      try {
        // lstat first: a symlink must be unlinked itself, never traversed.
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) {
          await fs.rm(target, { force: true });
        } else if (stat.isDirectory()) {
          await fs.rm(target, { recursive: true, force: true });
        } else {
          await fs.rm(target, { force: true });
        }
        removed++;
      } catch (err) {
        console.error(`[InkFlow Backup] Failed cleaning stale staging entry ${target}:`, err);
      }
    }
    return removed;
  }

  /**
   * Runs every applicable pending recovery while the exclusive lease is held.
   * A recovery that cannot be completed aborts the backup: an incomplete state
   * must never be packaged as a successful snapshot.
   */
  private async recoverBeforeSnapshotLocked(): Promise<void> {
    try {
      await documentService.recoverPendingDeletions();
      await documentService.recoverPendingSaves();
    } catch (err) {
      throw new BackupError(
        'BACKUP_RECOVERY_FAILED',
        `文档恢复失败，拒绝创建备份：${(err as any)?.message || err}`,
        undefined,
        { cause: err }
      );
    }

    const [pendingDeletions, pendingSaves] = await Promise.all([
      fileStorage.listPendingDeletionDocumentIds(),
      fileStorage.listPendingSaveDocumentIdsStrict(),
    ]);
    if (pendingDeletions.length > 0 || pendingSaves.length > 0) {
      throw new BackupError(
        'BACKUP_RECOVERY_FAILED',
        `仍有未完成的文档恢复任务，拒绝创建备份：待删除 [${pendingDeletions.join(', ')}]，` +
          `待恢复保存 [${pendingSaves.join(', ')}]`,
        { pendingDeletions, pendingSaves }
      );
    }

    let assetResult: { recovered: number; failed: number; freedBytes: number };
    try {
      assetResult = await assetService.recoverPendingAssetDeletionsUnderLease();
    } catch (err) {
      throw new BackupError(
        'BACKUP_RECOVERY_FAILED',
        `附件删除恢复失败，拒绝创建备份：${(err as any)?.message || err}`,
        undefined,
        { cause: err }
      );
    }
    if (assetResult.failed > 0) {
      throw new BackupError(
        'BACKUP_RECOVERY_FAILED',
        `仍有 ${assetResult.failed} 个附件删除任务未完成，拒绝创建备份`,
        { failed: assetResult.failed }
      );
    }

    const tombstones = Number(
      (getDatabase().prepare('SELECT COUNT(*) AS c FROM asset_deletions').get() as any)?.c || 0
    );
    if (tombstones > 0) {
      throw new BackupError(
        'BACKUP_RECOVERY_FAILED',
        `仍有 ${tombstones} 个附件删除标记未解决，拒绝创建备份`,
        { tombstones }
      );
    }
  }

  private async assertSourceDatabaseOnDisk(): Promise<{ databasePath: string; size: number }> {
    const databasePath = getDbPath();
    let stat: fsSync.Stats;
    try {
      stat = await fs.lstat(databasePath);
    } catch (err) {
      throw new BackupError(
        'BACKUP_DATABASE_SNAPSHOT_FAILED',
        `生产数据库文件不可访问：${databasePath}`,
        { databasePath },
        { cause: err }
      );
    }
    if (!stat.isFile()) {
      throw new BackupError(
        'BACKUP_DATABASE_SNAPSHOT_FAILED',
        `生产数据库路径不是普通文件（可能是 :memory: 或特殊文件）：${databasePath}`,
        { databasePath }
      );
    }
    return { databasePath, size: stat.size };
  }

  /**
   * Creates and validates the database snapshot, then removes sessions from the
   * copy and returns its manifest entry. The production DB is never written.
   */
  private async createDatabaseSnapshot(
    stagingDir: string,
    state: Pick<DatabaseBackupState, 'schemaVersion' | 'criticalCounts'>,
    options: CreateBackupOptions
  ): Promise<{ path: string; size: number; sha256: string }> {
    await this.assertSourceDatabaseOnDisk();

    const destination = path.join(
      stagingDir,
      ...BACKUP_DATABASE_RELATIVE_PATH.split('/')
    );
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (fsSync.existsSync(destination)) {
      throw new BackupError(
        'BACKUP_DATABASE_SNAPSHOT_FAILED',
        `数据库快照目标已存在，拒绝覆盖：${destination}`,
        { destination }
      );
    }

    const sourceDb = getDatabase();
    if (!sourceDb.isOpen) {
      throw new BackupError('BACKUP_DATABASE_SNAPSHOT_FAILED', '生产数据库连接已关闭，无法创建快照');
    }

    // `backup()` exists in Node >= 22.16. Access it through the namespace so an
    // older Node fails with a clear error instead of an import-time crash.
    const defaultBackup = (nodeSqlite as typeof nodeSqlite).backup;
    const backupFn = options.backupDatabase ?? defaultBackup;
    if (typeof backupFn !== 'function') {
      throw new BackupError(
        'BACKUP_UNSUPPORTED',
        '当前 Node.js 不支持 node:sqlite backup()，请升级到 Node.js 22.16+ 或 24+'
      );
    }
    try {
      await backupFn(getDatabase(), destination);
    } catch (err) {
      throw new BackupError(
        'BACKUP_DATABASE_SNAPSHOT_FAILED',
        `SQLite 在线备份失败：${(err as any)?.message || err}`,
        undefined,
        { cause: err }
      );
    }

    let stat: fsSync.Stats;
    try {
      stat = await fs.lstat(destination);
    } catch (err) {
      throw new BackupError(
        'BACKUP_DATABASE_SNAPSHOT_FAILED',
        'SQLite 快照文件未生成',
        { destination },
        { cause: err }
      );
    }
    if (!stat.isFile() || stat.size <= 0) {
      throw new BackupError('BACKUP_DATABASE_SNAPSHOT_FAILED', 'SQLite 快照文件为空或不是普通文件', {
        destination,
        size: stat.size,
      });
    }

    // Sessions are removed from the COPY; VACUUM also removes their free pages.
    await stripSessionsFromDatabaseCopy(destination);
    await validateDatabaseSnapshot({
      databasePath: destination,
      expectedSchemaVersion: state.schemaVersion,
      expectedCounts: state.criticalCounts,
    });

    const finalStat = await fs.lstat(destination);
    const sha256 = await sha256File(destination);
    return { path: BACKUP_DATABASE_RELATIVE_PATH, size: finalStat.size, sha256 };
  }

  /**
   * Creates a complete snapshot directory under storage/backups/.
   *
   * Lifecycle: exclusive lease → pending recovery → DB/file preflight → SQLite
   * online backup (sessions stripped) → file snapshot (independent copy by
   * default) → manifest → independent staging verification (manifest re-read,
   * all SHA-256 recomputed) → atomic rename out of `.staging`. Any failure
   * removes only this run's staging directory; production data is never deleted
   * or repaired. Batch 2B keeps the exclusive lease for the whole operation.
   */
  public async createBackupSnapshot(options: CreateBackupOptions = {}): Promise<BackupSnapshotResult> {
    return consistencyGate.withExclusive(async () => {
      if (maintenanceState.isMaintenance()) {
        throw new BackupError(
          'BACKUP_MAINTENANCE_MODE',
          '服务处于只读维护模式（启动恢复未完成），拒绝创建备份'
        );
      }

      const backupsRoot = this.getBackupsRoot();
      await this.ensureSafeDirectory(backupsRoot, '备份根目录');
      const stagingRoot = path.join(backupsRoot, STAGING_DIR_NAME);
      await this.ensureSafeDirectory(stagingRoot, '备份 staging 目录');

      // A previous crash may have left staging data behind. Nothing else can be
      // using it: this method holds the exclusive lease.
      await this.cleanupStaleStagingLocked(stagingRoot);

      const id = nowId();
      if (!isBackupSnapshotId(id)) {
        throw new BackupError('BACKUP_STAGING_FAILED', `生成的备份 ID 不合法：${id}`, { id });
      }
      const stagingDir = path.join(stagingRoot, id);
      try {
        await fs.mkdir(stagingDir, { recursive: false });
      } catch (err) {
        throw new BackupError(
          'BACKUP_STAGING_FAILED',
          `无法创建 staging 快照目录：${(err as any)?.message || err}`,
          { stagingDir },
          { cause: err }
        );
      }

      let finalized = false;
      try {
        await this.recoverBeforeSnapshotLocked();

        const db = getDatabase();
        const state = loadDatabaseBackupState(db);
        const storageRoot = fileStorage.getStorageRoot();
        // Attachments are content exactly as named by the DB, even if their
        // extension looks like a temp/backup artifact (e.g. an upload named
        // `figure.tmp`). Unreferenced `.bak`/`.tmp` files are still excluded.
        const inventory = await collectManagedFiles(
          storageRoot,
          new Set(state.assets.map(asset => asset.canonicalPath))
        );
        assertDatabaseMatchesInventory(state, inventory);
        await assertAssetAssociationsMatchMarkdown(state, docId =>
          fileStorage.readDocumentMarkdownStrict(docId)
        );

        const database = await this.createDatabaseSnapshot(stagingDir, state, options);

        const { entries, mode, warnings: materializationWarnings } = await createFileSnapshot({
          stagingDir,
          storageRoot,
          files: inventory,
          useHardlinks: options.useHardlinks,
          forceCopy: options.forceCopy,
          linkFile: options.linkFile,
          copyFile: options.copyFile,
          beforeSourceOpen: options.beforeSourceOpen,
          afterSourceCopyChunk: options.afterSourceCopyChunk,
        });
        // The snapshot bytes must match the DB's commit markers, not just exist.
        assertSnapshotHashesMatchDatabase(state, entries);
        // Revision files have no full-file hash in SQLite; re-derive their body
        // hash from the packaged copy so a mismatched/corrupted snapshot cannot
        // be published as a successful backup.
        await assertRevisionSnapshotsMatchDatabase(state, relativePath =>
          fs.readFile(path.join(stagingDir, ...relativePath.split('/')), 'utf-8')
        );

        const manifest = buildBackupManifest({
          applicationVersion: getApplicationVersion(),
          createdAt: new Date().toISOString(),
          schemaVersion: state.schemaVersion,
          database,
          files: entries,
          snapshotMode: mode,
        });
        await writeBackupManifest(stagingDir, manifest);

        // Publication gate: the staged directory is re-read from disk and every
        // database/file SHA-256 is recomputed. A snapshot is never published
        // based on creation-time memory state. This is the same verification
        // path used later for already published backups.
        await options.beforePublishVerification?.(stagingDir, manifest);
        const verification = await assertStagingSnapshotValid(stagingDir, id);
        if (JSON.stringify(verification.manifest) !== JSON.stringify(manifest)) {
          throw new BackupError(
            'BACKUP_VERIFICATION_FAILED',
            '重新读取的 manifest 与写入前内容不一致，拒绝发布',
            { stagingDir }
          );
        }
        for (const message of materializationWarnings) {
          verification.warnings.push({
            code: 'SNAPSHOT_SOURCE_RACE_WINDOW',
            message,
          });
        }
        for (const warning of verification.warnings) {
          console.warn(`[InkFlow Backup] ${warning.message}`);
        }

        const finalDir = path.join(backupsRoot, id);
        if (fsSync.existsSync(finalDir)) {
          throw new BackupError('BACKUP_STAGING_FAILED', `备份目录已存在：${finalDir}`, {
            finalDir,
          });
        }
        try {
          await fs.rename(stagingDir, finalDir);
        } catch (err) {
          throw new BackupError(
            'BACKUP_STAGING_FAILED',
            `无法发布备份快照：${(err as any)?.message || err}`,
            { stagingDir, finalDir },
            { cause: err }
          );
        }
        finalized = true;

        return {
          id,
          directory: finalDir,
          manifestPath: path.join(finalDir, 'manifest.json'),
          manifest,
          verification,
        };
      } catch (err) {
        if (err instanceof BackupError) throw err;
        throw new BackupError(
          'BACKUP_STAGING_FAILED',
          `备份失败：${(err as any)?.message || err}`,
          undefined,
          { cause: err }
        );
      } finally {
        if (!finalized) {
          // Only this run's staging directory is removed. Production sources and
          // previously completed snapshots are never touched.
          await fs.rm(stagingDir, { recursive: true, force: true }).catch(cleanupErr => {
            console.error(`[InkFlow Backup] Failed removing staging directory ${stagingDir}:`, cleanupErr);
          });
        }
      }
    });
  }
}

export const backupService = new BackupService();
