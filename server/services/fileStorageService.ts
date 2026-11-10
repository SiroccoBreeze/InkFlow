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
  public async listAllDiskDocumentIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.documentsDir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
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

