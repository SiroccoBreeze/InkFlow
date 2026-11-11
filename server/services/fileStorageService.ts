import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';

export function getStorageRootDir(): string {
  return process.env.INKFLOW_DATA_DIR
    ? path.resolve(process.env.INKFLOW_DATA_DIR)
    : path.resolve(process.cwd(), 'storage');
}

export class FileStorageService {
  constructor() {
    this.ensureDirectories();
  }

  private get rootDir(): string {
    return getStorageRootDir();
  }

  private get documentsDir(): string {
    return path.join(this.rootDir, 'documents');
  }

  private get revisionsDir(): string {
    return path.join(this.rootDir, 'revisions');
  }

  private get assetsDir(): string {
    return path.join(this.rootDir, 'assets');
  }

  private get backupsDir(): string {
    return path.join(this.rootDir, 'backups');
  }

  private ensureDirectories(): void {
    const dirs = [this.rootDir, this.documentsDir, this.revisionsDir, this.assetsDir, this.backupsDir];
    for (const d of dirs) {
      if (!fsSync.existsSync(d)) {
        fsSync.mkdirSync(d, { recursive: true });
      }
    }
  }

  public getDocumentsDir(): string {
    return this.documentsDir;
  }

  public getStorageRoot(): string {
    return this.rootDir;
  }

  public getAssetsDir(): string {
    return this.assetsDir;
  }

  /**
   * Resolves a stored relative path inside the storage root and guarantees the
   * result cannot escape it (defense against traversal / absolute path injection).
   */
  public resolveWithinStorage(relativePath: string): string | null {
    if (!relativePath || typeof relativePath !== 'string') return null;
    const root = this.rootDir;
    const resolved = path.resolve(root, relativePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return null;
    }
    return resolved;
  }

  /**
   * Validates a document/revision identifier used as a filesystem path segment.
   * Rejects traversal, separators, and hidden markers so IDs can never escape their folder.
   */
  private assertSafeId(id: string): string {
    const value = String(id ?? '');
    if (
      !value ||
      value.length > 200 ||
      value === '.' ||
      value === '..' ||
      value.startsWith('.') ||
      value.includes('/') ||
      value.includes('\\') ||
      value.includes('\0') ||
      !/^[A-Za-z0-9._-]+$/.test(value)
    ) {
      throw new Error('非法的存储标识符');
    }
    return value;
  }

  // Atomic file write to avoid corrupted writes if interrupted
  private async atomicWriteFile(targetPath: string, content: string | Buffer): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${targetPath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, targetPath);
  }

  // Save document Markdown file: storage/documents/{documentId}/index.md
  public async saveDocumentMarkdown(documentId: string, markdownContent: string): Promise<string> {
    const safeId = this.assertSafeId(documentId);
    const docFolder = path.join(this.documentsDir, safeId);
    const filePath = path.join(docFolder, 'index.md');
    await this.atomicWriteFile(filePath, markdownContent);
    return path.relative(this.rootDir, filePath);
  }

  // --- Crash-safe document save helpers ---------------------------------
  // The Markdown file and SQLite row cannot be committed atomically. A save
  // therefore stages the new Markdown, keeps a `.bak` of the previous file and
  // writes a `.save.pending` marker. On any failure the backup is restored; on
  // a crash the marker lets `recoverPendingDocumentSaves()` decide from the DB
  // content hash whether the file or the DB represents the committed state.

  private getDocFolderSafe(documentId: string): string | null {
    try {
      return path.join(this.documentsDir, this.assertSafeId(documentId));
    } catch {
      return null;
    }
  }

  public getDocumentIndexPath(documentId: string): string | null {
    const folder = this.getDocFolderSafe(documentId);
    return folder ? path.join(folder, 'index.md') : null;
  }

  /** Path relative to the storage root, as persisted in the documents table. */
  public toStorageRelativePath(absolutePath: string): string {
    return path.relative(this.rootDir, absolutePath);
  }

  /** True when a previous save for this document left a marker or backup behind. */
  public async hasPendingDocumentSave(documentId: string): Promise<boolean> {
    const artifacts = this.getSaveArtifacts(documentId);
    if (!artifacts) return false;
    return fsSync.existsSync(artifacts.markerPath) || fsSync.existsSync(artifacts.backupPath);
  }

  private getSaveArtifacts(documentId: string): {
    folder: string;
    finalPath: string;
    backupPath: string;
    markerPath: string;
  } | null {
    const folder = this.getDocFolderSafe(documentId);
    if (!folder) return null;
    const finalPath = path.join(folder, 'index.md');
    return {
      folder,
      finalPath,
      backupPath: `${finalPath}.bak`,
      markerPath: path.join(folder, '.save.pending'),
    };
  }

  /**
   * Prepares a save without touching index.md:
   * 1. writes the pending marker, 2. backs up the previous content (if any),
   * 3. writes the new content to a temp file that is committed by rename.
   */
  public async prepareDocumentSave(
    documentId: string,
    previousContent: string | null,
    newContent: string
  ): Promise<{ stagedPath: string; finalPath: string; backupPath: string; markerPath: string } | null> {
    const artifacts = this.getSaveArtifacts(documentId);
    if (!artifacts) return null;

    // Defense in depth: never overwrite an existing backup/marker. documentService
    // blocks saves after a failed recovery, but this guard catches any future
    // caller that forgets to run recovery first.
    if (await this.hasPendingDocumentSave(documentId)) {
      throw new Error('存在待恢复的保存产物，拒绝覆盖 .bak / .save.pending');
    }

    await fs.mkdir(artifacts.folder, { recursive: true });
    // Remove stale temp files from a crashed previous attempt (backup/marker are
    // handled by recovery, never blindly deleted here).
    const entries = await fs.readdir(artifacts.folder).catch(() => [] as string[]);
    for (const name of entries) {
      if (name.startsWith('index.md.') && name.endsWith('.tmp')) {
        await fs.rm(path.join(artifacts.folder, name), { force: true }).catch(() => {});
      }
    }

    await fs.writeFile(artifacts.markerPath, new Date().toISOString(), 'utf-8');
    if (previousContent !== null) {
      await fs.writeFile(artifacts.backupPath, previousContent, 'utf-8');
    } else {
      await fs.rm(artifacts.backupPath, { force: true }).catch(() => {});
    }

    const stagedPath = `${artifacts.finalPath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(stagedPath, newContent, 'utf-8');

    return { stagedPath, ...artifacts };
  }

  /** Atomically makes the staged Markdown the live index.md. */
  public async commitStagedDocumentSave(stagedPath: string, finalPath: string): Promise<void> {
    await fs.rename(stagedPath, finalPath);
  }

  /** Removes the pending marker/backup after the DB transaction committed. */
  public async finalizeDocumentSave(artifacts: {
    backupPath: string;
    markerPath: string;
    stagedPath: string;
  }): Promise<void> {
    await fs.rm(artifacts.markerPath, { force: true }).catch(() => {});
    await fs.rm(artifacts.backupPath, { force: true }).catch(() => {});
    await fs.rm(artifacts.stagedPath, { force: true }).catch(() => {});
  }

  /**
   * Restores the pre-save state after a failed save: previous index.md comes back
   * from `.bak`, or a brand-new document's file is removed. Always clears artifacts.
   */
  public async rollbackDocumentSave(
    documentId: string,
    artifacts: { backupPath: string; markerPath: string; stagedPath: string; finalPath: string }
  ): Promise<void> {
    const artifactsInfo = this.getSaveArtifacts(documentId);
    if (!artifactsInfo) return;

    const hasBackup = fsSync.existsSync(artifactsInfo.backupPath);
    if (hasBackup) {
      try {
        await fs.rename(artifactsInfo.backupPath, artifactsInfo.finalPath);
      } catch {
        // Keep backup + marker so startup/next-save recovery can retry; deleting
        // them here would lose the only copy of the previous committed content.
        await fs.rm(artifacts.stagedPath, { force: true }).catch(() => {});
        return;
      }
    } else {
      await fs.rm(artifactsInfo.finalPath, { force: true }).catch(() => {});
    }
    await fs.rm(artifacts.markerPath, { force: true }).catch(() => {});
    await fs.rm(artifacts.stagedPath, { force: true }).catch(() => {});
    await fs.rm(artifactsInfo.backupPath, { force: true }).catch(() => {});
  }

  /** Document ids with a pending marker or backup left by an interrupted save. */
  public async listPendingSaveDocumentIds(): Promise<string[]> {
    const ids: string[] = [];
    try {
      const entries = await fs.readdir(this.documentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folder = path.join(this.documentsDir, entry.name);
        try {
          const names = await fs.readdir(folder);
          // Pending deletion wins: a folder awaiting deletion must not be
          // recovered as a live document.
          if (names.includes('.delete.pending')) continue;
          if (names.includes('.save.pending') || names.includes('index.md.bak')) {
            ids.push(entry.name);
          }
        } catch {
          // unreadable folder: skip
        }
      }
    } catch {
      return [];
    }
    return ids;
  }

  public async readDocumentSaveBackup(documentId: string): Promise<string | null> {
    const artifacts = this.getSaveArtifacts(documentId);
    if (!artifacts) return null;
    try {
      return await fs.readFile(artifacts.backupPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Whether a restore source exists, independent of whether it can be read. */
  public documentSaveBackupExists(documentId: string): boolean {
    const artifacts = this.getSaveArtifacts(documentId);
    return artifacts ? fsSync.existsSync(artifacts.backupPath) : false;
  }

  public async restoreDocumentSaveBackup(documentId: string): Promise<boolean> {
    const artifacts = this.getSaveArtifacts(documentId);
    if (!artifacts || !fsSync.existsSync(artifacts.backupPath)) return false;
    try {
      await fs.rename(artifacts.backupPath, artifacts.finalPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the document folder still exists on disk. */
  public documentFolderExists(documentId: string): boolean {
    const folder = this.getDocFolderSafe(documentId);
    return folder ? fsSync.existsSync(folder) : false;
  }

  public async clearDocumentSaveArtifacts(documentId: string): Promise<void> {
    const artifacts = this.getSaveArtifacts(documentId);
    if (!artifacts) return;
    await fs.rm(artifacts.markerPath, { force: true }).catch(() => {});
    await fs.rm(artifacts.backupPath, { force: true }).catch(() => {});
    try {
      const names = await fs.readdir(artifacts.folder);
      for (const name of names) {
        if (name.startsWith('index.md.') && name.endsWith('.tmp')) {
          await fs.rm(path.join(artifacts.folder, name), { force: true }).catch(() => {});
        }
      }
    } catch {
      // folder missing: nothing to clean
    }
  }

  // Read document Markdown file
  public async readDocumentMarkdown(documentId: string): Promise<string | null> {
    let safeId: string;
    try {
      safeId = this.assertSafeId(documentId);
    } catch {
      return null;
    }
    const filePath = path.join(this.documentsDir, safeId, 'index.md');
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Strict read for consistency-critical scans (e.g. tag cleanup):
   * - missing index.md → null (a document may legitimately have no file)
   * - unreadable directory/file, EISDIR, EACCES, etc. → throw
   *   The caller must treat any throw as "references unknown" and fail safe.
   */
  public async readDocumentMarkdownStrict(documentId: string): Promise<string | null> {
    const safeId = this.assertSafeId(documentId);
    const filePath = path.join(this.documentsDir, safeId, 'index.md');
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  // Delete document folder
  public async deleteDocumentFolder(documentId: string): Promise<void> {
    let safeId: string;
    try {
      safeId = this.assertSafeId(documentId);
    } catch {
      return;
    }
    const docFolder = path.join(this.documentsDir, safeId);
    try {
      await fs.rm(docFolder, { recursive: true, force: true });
    } catch (err) {
      console.error(`Failed deleting document folder ${documentId}:`, err);
    }
  }

  // Delete revisions folder for a document
  public async deleteRevisionFolder(documentId: string): Promise<void> {
    let safeId: string;
    try {
      safeId = this.assertSafeId(documentId);
    } catch {
      return;
    }
    const revFolder = path.join(this.revisionsDir, safeId);
    try {
      await fs.rm(revFolder, { recursive: true, force: true });
    } catch (err) {
      console.error(`Failed deleting revision folder ${documentId}:`, err);
    }
  }

  /** Deletes the document folder and reports failure to the caller. */
  public async deleteDocumentFolderStrict(documentId: string): Promise<void> {
    const safeId = this.assertSafeId(documentId);
    await fs.rm(path.join(this.documentsDir, safeId), { recursive: true, force: true });
  }

  /** Deletes the revisions folder and reports failure to the caller. */
  public async deleteRevisionFolderStrict(documentId: string): Promise<void> {
    const safeId = this.assertSafeId(documentId);
    await fs.rm(path.join(this.revisionsDir, safeId), { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Pending-deletion markers
  // A marker lives inside the document folder, so deleting the folder removes
  // it atomically. It is written BEFORE the SQLite row is deleted; recovery
  // uses the DB row presence to decide whether the deletion actually committed.
  // -------------------------------------------------------------------------

  private getDeleteMarkerPath(documentId: string): string | null {
    const folder = this.getDocFolderSafe(documentId);
    return folder ? path.join(folder, '.delete.pending') : null;
  }

  public isDocumentDeletePending(documentId: string): boolean {
    const marker = this.getDeleteMarkerPath(documentId);
    return marker ? fsSync.existsSync(marker) : false;
  }

  /** Creates the pending-deletion marker (returns false if the folder is already gone). */
  public async markDocumentDeletePending(documentId: string): Promise<boolean> {
    const folder = this.getDocFolderSafe(documentId);
    const marker = this.getDeleteMarkerPath(documentId);
    if (!folder || !marker) throw new Error('非法的存储标识符');
    if (!fsSync.existsSync(folder)) return false;
    await this.atomicWriteFile(
      marker,
      JSON.stringify({ docId: documentId, reason: 'document-deleted', requestedAt: new Date().toISOString() })
    );
    return true;
  }

  public async clearDocumentDeletePending(documentId: string): Promise<void> {
    const marker = this.getDeleteMarkerPath(documentId);
    if (marker) await fs.rm(marker, { force: true }).catch(() => {});
  }

  /** Reads and parses the marker; null when missing. Throws on unreadable/corrupt file. */
  public async readDocumentDeleteMarker(
    documentId: string
  ): Promise<{ docId: string; reason?: string; requestedAt?: string } | null> {
    const marker = this.getDeleteMarkerPath(documentId);
    if (!marker) throw new Error('非法的存储标识符');
    let raw: string;
    try {
      raw = await fs.readFile(marker, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('删除标记格式无效');
    return parsed;
  }

  /** Document ids that still have a pending-deletion marker. Strict: readdir errors throw. */
  public async listPendingDeletionDocumentIds(): Promise<string[]> {
    const ids: string[] = [];
    const entries = await fs.readdir(this.documentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (fsSync.existsSync(path.join(this.documentsDir, entry.name, '.delete.pending'))) {
        ids.push(entry.name);
      }
    }
    return ids;
  }

  // Clean up any revision folders whose document folder no longer exists
  public async cleanupOrphanRevisions(): Promise<number> {
    try {
      const docIds = new Set(await this.listAllDiskDocumentIds());
      const revEntries = await fs.readdir(this.revisionsDir, { withFileTypes: true });
      let cleaned = 0;
      for (const entry of revEntries) {
        if (entry.isDirectory() && !docIds.has(entry.name)) {
          await fs.rm(path.join(this.revisionsDir, entry.name), { recursive: true, force: true });
          cleaned++;
        }
      }
      return cleaned;
    } catch {
      return 0;
    }
  }

  // Save revision snapshot: storage/revisions/{documentId}/{revisionId}.md
  public async saveRevisionSnapshot(
    documentId: string,
    revisionId: string,
    markdownContent: string
  ): Promise<string> {
    const safeDocId = this.assertSafeId(documentId);
    const safeRevId = this.assertSafeId(revisionId);
    const revFolder = path.join(this.revisionsDir, safeDocId);
    const filePath = path.join(revFolder, `${safeRevId}.md`);
    await this.atomicWriteFile(filePath, markdownContent);
    return path.relative(this.rootDir, filePath);
  }

  // Read revision snapshot
  public async readRevisionSnapshot(documentId: string, revisionId: string): Promise<string | null> {
    let safeDocId: string;
    let safeRevId: string;
    try {
      safeDocId = this.assertSafeId(documentId);
      safeRevId = this.assertSafeId(revisionId);
    } catch {
      return null;
    }
    const filePath = path.join(this.revisionsDir, safeDocId, `${safeRevId}.md`);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  // List all document folder IDs on physical disk
  /**
   * Lists document folders, excluding folders that are pending deletion: they
   * are logically deleted and must never be re-imported/rebuild-indexed even if
   * their physical removal failed.
   */
  public async listAllDiskDocumentIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.documentsDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .filter(e => !fsSync.existsSync(path.join(this.documentsDir, e.name, '.delete.pending')))
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Strict variant for consistency-critical scans. Directory read failures throw
   * instead of being interpreted as "no documents".
   */
  public async listAllDiskDocumentIdsStrict(): Promise<string[]> {
    const entries = await fs.readdir(this.documentsDir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .filter(e => !fsSync.existsSync(path.join(this.documentsDir, e.name, '.delete.pending')))
      .map(e => e.name);
  }

  // Get full disk stats of revisions/ folder
  public async getRevisionsDiskStats(): Promise<{
    totalRevisionsCount: number;
    totalDiskBytes: number;
    docs: Array<{
      documentId: string;
      totalBytes: number;
      files: Array<{
        revisionId: string;
        fileName: string;
        size: number;
        mtime: string;
        relativePath: string;
      }>;
    }>;
  }> {
    try {
      const docEntries = await fs.readdir(this.revisionsDir, { withFileTypes: true });
      let totalCount = 0;
      let totalBytesAll = 0;
      const docsList: Array<{
        documentId: string;
        totalBytes: number;
        files: Array<{
          revisionId: string;
          fileName: string;
          size: number;
          mtime: string;
          relativePath: string;
        }>;
      }> = [];

      for (const entry of docEntries) {
        if (!entry.isDirectory()) continue;
        const docId = entry.name;
        const docRevDir = path.join(this.revisionsDir, docId);
        const fileEntries = await fs.readdir(docRevDir, { withFileTypes: true });

        let docBytes = 0;
        const files: Array<{
          revisionId: string;
          fileName: string;
          size: number;
          mtime: string;
          relativePath: string;
        }> = [];

        for (const fe of fileEntries) {
          if (fe.isFile() && fe.name.endsWith('.md')) {
            const filePath = path.join(docRevDir, fe.name);
            const stat = await fs.stat(filePath);
            const revisionId = fe.name.replace(/\.md$/, '');
            docBytes += stat.size;
            totalBytesAll += stat.size;
            totalCount++;
            files.push({
              revisionId,
              fileName: fe.name,
              size: stat.size,
              mtime: stat.mtime.toISOString(),
              relativePath: path.relative(this.rootDir, filePath),
            });
          }
        }

        // Sort files by mtime descending (newest first)
        files.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());

        if (files.length > 0) {
          docsList.push({
            documentId: docId,
            totalBytes: docBytes,
            files,
          });
        }
      }

      // Sort docs by totalBytes descending
      docsList.sort((a, b) => b.totalBytes - a.totalBytes);

      return {
        totalRevisionsCount: totalCount,
        totalDiskBytes: totalBytesAll,
        docs: docsList,
      };
    } catch (err) {
      console.error('Failed getting revisions disk stats:', err);
      return { totalRevisionsCount: 0, totalDiskBytes: 0, docs: [] };
    }
  }

  // Delete a single revision file from disk
  public async deleteSingleRevisionFile(documentId: string, revisionId: string): Promise<boolean> {
    let safeDocId: string;
    let safeRevId: string;
    try {
      safeDocId = this.assertSafeId(documentId);
      safeRevId = this.assertSafeId(revisionId);
    } catch {
      return false;
    }
    const filePath = path.join(this.revisionsDir, safeDocId, `${safeRevId}.md`);
    try {
      await fs.rm(filePath, { force: true });
      // If folder is now empty, clean up empty directory
      const revFolder = path.join(this.revisionsDir, safeDocId);
      const remaining = await fs.readdir(revFolder).catch(() => []);
      if (remaining.length === 0) {
        await fs.rm(revFolder, { recursive: true, force: true }).catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  // Prune revisions for a specific document (keep newest keepLatest)
  public async pruneDocumentRevisions(
    documentId: string,
    keepLatest: number = 1
  ): Promise<{ deletedCount: number; freedBytes: number; deletedRevisionIds: string[] }> {
    let safeDocId: string;
    try {
      safeDocId = this.assertSafeId(documentId);
    } catch {
      return { deletedCount: 0, freedBytes: 0, deletedRevisionIds: [] };
    }
    const docRevDir = path.join(this.revisionsDir, safeDocId);
    let deletedCount = 0;
    let freedBytes = 0;
    const deletedRevisionIds: string[] = [];

    try {
      const fileEntries = await fs.readdir(docRevDir, { withFileTypes: true });
      const filesWithStats = await Promise.all(
        fileEntries
          .filter(fe => fe.isFile() && fe.name.endsWith('.md'))
          .map(async fe => {
            const filePath = path.join(docRevDir, fe.name);
            const stat = await fs.stat(filePath);
            return {
              revisionId: fe.name.replace(/\.md$/, ''),
              filePath,
              size: stat.size,
              mtime: stat.mtime.getTime(),
            };
          })
      );

      // Sort newest first
      filesWithStats.sort((a, b) => b.mtime - a.mtime);

      // Files beyond keepLatest should be pruned
      const toDelete = filesWithStats.slice(Math.max(0, keepLatest));
      for (const item of toDelete) {
        await fs.rm(item.filePath, { force: true });
        deletedCount++;
        freedBytes += item.size;
        deletedRevisionIds.push(item.revisionId);
      }

      // If keepLatest === 0 and folder is empty, remove the folder
      if (keepLatest === 0) {
        await fs.rm(docRevDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      console.error(`Failed pruning revisions for ${documentId}:`, err);
    }

    return { deletedCount, freedBytes, deletedRevisionIds };
  }

  // Prune revisions across all documents (keep newest keepLatest for each doc)
  public async pruneAllRevisions(
    keepLatest: number = 1
  ): Promise<{ deletedCount: number; freedBytes: number; deletedRevisionIds: string[] }> {
    let totalDeleted = 0;
    let totalFreed = 0;
    const allDeletedIds: string[] = [];

    try {
      const docEntries = await fs.readdir(this.revisionsDir, { withFileTypes: true });
      for (const entry of docEntries) {
        if (!entry.isDirectory()) continue;
        const res = await this.pruneDocumentRevisions(entry.name, keepLatest);
        totalDeleted += res.deletedCount;
        totalFreed += res.freedBytes;
        allDeletedIds.push(...res.deletedRevisionIds);
      }
      // Also clean up any orphan folders for documents that no longer exist
      await this.cleanupOrphanRevisions();
    } catch (err) {
      console.error('Failed pruning all revisions:', err);
    }

    return { deletedCount: totalDeleted, freedBytes: totalFreed, deletedRevisionIds: allDeletedIds };
  }
}

export const fileStorage = new FileStorageService();

