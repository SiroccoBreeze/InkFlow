import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { getDatabase, generateId } from '../db/sqlite';
import { fileStorage } from './fileStorageService';

const STORAGE_ROOT = fileStorage.getStorageRoot();
const ASSETS_DIR = path.join(STORAGE_ROOT, 'assets');

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

export class AssetService {
  constructor() {
    if (!fsSync.existsSync(ASSETS_DIR)) {
      fsSync.mkdirSync(ASSETS_DIR, { recursive: true });
    }
  }

  // Upload and persist asset to physical storage/assets/ & SQLite
  public async uploadAsset(params: {
    originalName: string;
    mimeType: string;
    buffer: Buffer;
    ownerId: string;
  }): Promise<AssetRecord> {
    const db = getDatabase();
    const assetId = generateId('ast');
    const ext = path.extname(params.originalName) || this.getExtensionFromMime(params.mimeType);
    const diskFileName = `${assetId}${ext}`;
    const targetFilePath = path.join(ASSETS_DIR, diskFileName);

    // Calculate sha256 checksum
    const checksum = crypto.createHash('sha256').update(params.buffer).digest('hex');

    // Physical disk write
    await fs.writeFile(targetFilePath, params.buffer);
    const relativeStoragePath = path.relative(STORAGE_ROOT, targetFilePath);

    const now = new Date().toISOString();
    const size = params.buffer.length;

    // Persist metadata to SQLite assets table
    db.prepare(`
      INSERT INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assetId,
      params.ownerId,
      params.originalName,
      relativeStoragePath,
      params.mimeType || 'application/octet-stream',
      size,
      checksum,
      now
    );

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
  }

  // Get single asset by ID (with buffer for file serving)
  public async getAsset(id: string): Promise<{ record: any; buffer: Buffer } | null> {
    const db = getDatabase();
    const record = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
    if (!record) return null;

    const fullPath = path.join(STORAGE_ROOT, record.storage_path);
    try {
      const buffer = await fs.readFile(fullPath);
      return { record, buffer };
    } catch {
      return null;
    }
  }

  // List all uploaded assets, reconciling physical files in storage/assets/
  public listAssets(ownerId?: string): AssetRecord[] {
    const db = getDatabase();

    // Auto-reconcile physical files in storage/assets/ with SQLite assets table
    try {
      if (fsSync.existsSync(ASSETS_DIR)) {
        const diskFiles = fsSync.readdirSync(ASSETS_DIR);
        const existingRows = db.prepare('SELECT id, storage_path FROM assets').all() as any[];
        const existingFilenames = new Set(existingRows.map(r => path.basename(r.storage_path)));

        for (const file of diskFiles) {
          if (!existingFilenames.has(file)) {
            const filePath = path.join(ASSETS_DIR, file);
            const stat = fsSync.statSync(filePath);
            const ext = path.extname(file).toLowerCase();
            const id = path.parse(file).name;
            const mimeType = this.getMimeFromExtension(ext);
            const relativeStoragePath = path.relative(STORAGE_ROOT, filePath);
            const now = new Date(stat.mtimeMs).toISOString();

            db.prepare(`
              INSERT OR REPLACE INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              id,
              'usr_owner_default',
              file,
              relativeStoragePath,
              mimeType,
              stat.size,
              '',
              now
            );
          }
        }
      }
    } catch (e) {
      console.error('Error reconciling physical assets:', e);
    }

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
  }

  // Delete asset physically from disk and SQLite
  public async deleteAsset(id: string): Promise<boolean> {
    const db = getDatabase();
    let deleted = false;

    // 1. Check SQLite record
    const record = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
    if (record) {
      const fullPath = path.join(STORAGE_ROOT, record.storage_path);
      try {
        await fs.unlink(fullPath);
        deleted = true;
      } catch {}
      db.prepare('DELETE FROM assets WHERE id = ?').run(id);
      deleted = true;
    }

    // 2. Also search physical ASSETS_DIR for any file starting with or matching id
    try {
      if (fsSync.existsSync(ASSETS_DIR)) {
        const files = await fs.readdir(ASSETS_DIR);
        for (const file of files) {
          if (file.includes(id) || path.parse(file).name === id) {
            try {
              await fs.unlink(path.join(ASSETS_DIR, file));
              deleted = true;
            } catch {}
            db.prepare('DELETE FROM assets WHERE id = ? OR storage_path LIKE ?').run(id, `%${file}%`);
          }
        }
      }
    } catch {}

    return deleted;
  }

  // Cleanup any assets that are not referenced by any document Markdown
  public async cleanupUnreferencedAssets(): Promise<{ cleanedCount: number; freedBytes: number; deletedIds: string[] }> {
    const db = getDatabase();
    const diskDocIds = await fileStorage.listAllDiskDocumentIds();

    // Read all markdown content across all existing disk docs
    const allMarkdownTexts: string[] = [];
    for (const docId of diskDocIds) {
      const md = await fileStorage.readDocumentMarkdown(docId);
      if (md) allMarkdownTexts.push(md);
    }

    // Also include markdown content stored in SQLite database
    try {
      const dbDocs = db.prepare('SELECT raw_markdown FROM documents').all() as any[];
      for (const d of dbDocs) {
        if (d.raw_markdown) allMarkdownTexts.push(d.raw_markdown);
      }
    } catch {}

    const mergedAllMarkdown = allMarkdownTexts.join('\n');

    // Get all assets in database
    const allAssets = db.prepare('SELECT * FROM assets').all() as any[];
    let cleanedCount = 0;
    let freedBytes = 0;
    const deletedIds: string[] = [];

    for (const asset of allAssets) {
      // Check if asset ID or URL or filename appears in any markdown
      const isReferenced =
        mergedAllMarkdown.includes(asset.id) ||
        mergedAllMarkdown.includes(`/api/v1/assets/file/${asset.id}`) ||
        mergedAllMarkdown.includes(asset.filename) ||
        mergedAllMarkdown.includes(path.basename(asset.storage_path));

      if (!isReferenced) {
        // Physical delete
        const fullPath = path.join(STORAGE_ROOT, asset.storage_path);
        try {
          const stat = await fs.stat(fullPath);
          freedBytes += stat.size;
          await fs.unlink(fullPath);
        } catch {}

        db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
        cleanedCount++;
        deletedIds.push(asset.id);
      }
    }

    // Also clean any unindexed orphan files inside storage/assets/
    try {
      const files = await fs.readdir(ASSETS_DIR);
      const remainingAssets = db.prepare('SELECT storage_path FROM assets').all() as any[];
      const indexedPaths = new Set(remainingAssets.map(a => path.basename(a.storage_path)));
      for (const file of files) {
        if (!indexedPaths.has(file)) {
          const filePath = path.join(ASSETS_DIR, file);
          try {
            const stat = await fs.stat(filePath);
            freedBytes += stat.size;
            await fs.unlink(filePath);
            cleanedCount++;
          } catch {}
        }
      }
    } catch {}

    return { cleanedCount, freedBytes, deletedIds };
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
