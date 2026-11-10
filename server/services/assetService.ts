import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { getDatabase, generateId } from '../db/sqlite';
import { fileStorage } from './fileStorageService';
import { extractAssetReferences } from './documentService';

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

export class AssetService {
  private ensureAssetsDir(): string {
    const assetsDir = getAssetsDir();
    if (!fsSync.existsSync(assetsDir)) {
      fsSync.mkdirSync(assetsDir, { recursive: true });
    }
    return assetsDir;
  }

  // Upload and persist asset to physical storage/assets/ & SQLite
  public async uploadAsset(params: {
    originalName: string;
    mimeType: string;
    buffer: Buffer;
    ownerId: string;
  }): Promise<AssetRecord> {
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
    const relativeStoragePath = path.relative(getStorageRoot(), targetFilePath);

    const now = new Date().toISOString();
    const size = params.buffer.length;

    // Persist metadata to SQLite assets table
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

  // List all uploaded assets, reconciling physical files in storage/assets/
  public listAssets(ownerId?: string): AssetRecord[] {
    const db = getDatabase();
    const assetsDir = getAssetsDir();

    // Auto-reconcile physical files in storage/assets/ with SQLite assets table
    try {
      if (fsSync.existsSync(assetsDir)) {
        const diskFiles = fsSync.readdirSync(assetsDir);
        const existingRows = db.prepare('SELECT id, storage_path FROM assets').all() as any[];
        const existingFilenames = new Set(existingRows.map(r => path.basename(r.storage_path)));

        // Only reconcile against a real owner so FOREIGN KEY constraints stay satisfiable
        const ownerRow = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('owner') as any;
        const reconcileOwnerId = ownerRow?.id;

        if (reconcileOwnerId) {
          for (const file of diskFiles) {
            if (!existingFilenames.has(file)) {
              const filePath = path.join(assetsDir, file);
              const stat = fsSync.statSync(filePath);
              if (!stat.isFile()) continue;
              const ext = path.extname(file).toLowerCase();
              const id = path.parse(file).name;
              const mimeType = this.getMimeFromExtension(ext);
              const relativeStoragePath = path.relative(getStorageRoot(), filePath);
              const now = new Date(stat.mtimeMs).toISOString();

              db.prepare(`
                INSERT OR REPLACE INTO assets (id, owner_id, filename, storage_path, mime_type, size, checksum, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                id,
                reconcileOwnerId,
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
      const fullPath = resolveAssetPath(record.storage_path);
      if (fullPath) {
        try {
          await fs.unlink(fullPath);
          deleted = true;
        } catch {}
      }
      db.prepare('DELETE FROM document_assets WHERE asset_id = ?').run(id);
      db.prepare('DELETE FROM assets WHERE id = ?').run(id);
      deleted = true;
    }

    // 2. Also remove any physical file whose exact basename matches the asset ID
    //    (never substring matching, which could delete unrelated assets).
    try {
      const assetsDir = getAssetsDir();
      if (fsSync.existsSync(assetsDir)) {
        const files = await fs.readdir(assetsDir);
        for (const file of files) {
          if (path.parse(file).name === id) {
            try {
              await fs.unlink(path.join(assetsDir, file));
              deleted = true;
            } catch {}
          }
        }
      }
    } catch {}

    return deleted;
  }

  // Cleanup any assets that are not referenced by any document Markdown
  public async cleanupUnreferencedAssets(): Promise<{ cleanedCount: number; freedBytes: number; deletedIds: string[] }> {
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

    const allAssets = db.prepare('SELECT * FROM assets').all() as any[];
    let cleanedCount = 0;
    let freedBytes = 0;
    const deletedIds: string[] = [];

    for (const asset of allAssets) {
      if (referencedIds.has(asset.id)) continue;

      const fullPath = resolveAssetPath(asset.storage_path);
      if (fullPath) {
        try {
          const stat = await fs.stat(fullPath);
          freedBytes += stat.size;
          await fs.unlink(fullPath);
        } catch {}
      }

      db.prepare('DELETE FROM document_assets WHERE asset_id = ?').run(asset.id);
      db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
      cleanedCount++;
      deletedIds.push(asset.id);
    }

    // Also clean any unindexed orphan files inside storage/assets/
    try {
      const assetsDir = getAssetsDir();
      const files = await fs.readdir(assetsDir);
      const remainingAssets = db.prepare('SELECT storage_path FROM assets').all() as any[];
      const indexedPaths = new Set(remainingAssets.map(a => path.basename(a.storage_path)));
      for (const file of files) {
        if (!indexedPaths.has(file)) {
          const filePath = path.join(assetsDir, file);
          try {
            const stat = await fs.stat(filePath);
            if (!stat.isFile()) continue;
            // Preserve files that are still explicitly referenced by Markdown
            if (referencedIds.has(path.parse(file).name)) continue;
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
