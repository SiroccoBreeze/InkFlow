import { documentService } from './documentService';
import { fileStorage } from './fileStorageService';
import { getDatabase } from '../db/sqlite';
import { INITIAL_SEED_DOCS } from './defaultSeedDocs';

export async function ensureInitialPhysicalDocs(): Promise<void> {
  const db = getDatabase();
  const owner = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('owner') as any;
  const ownerId = owner?.id || 'usr_owner_default';

  const docCount = (db.prepare('SELECT COUNT(*) as c FROM documents').get() as any)?.c || 0;
  const diskIds = await fileStorage.listAllDiskDocumentIds();

  // If disk has markdown files but SQLite index is empty, restore index from physical disk!
  if (diskIds.length > 0 && docCount === 0) {
    if (!owner?.id) {
      // Never index documents against a non-existent owner (FOREIGN KEY would fail and
      // leave a half-initialized index). The owner must initialize first.
      console.log('[InkFlow Storage] Skipping index rebuild: owner account not initialized yet.');
      return;
    }
    console.log('[InkFlow Storage] Restoring SQLite FTS5 index from physical disk Markdown files...');
    const result = await documentService.rebuildIndexFromDisk(ownerId);
    console.log(`[InkFlow Storage] Restored ${result.restoredCount} documents into SQLite from disk.`);
    return;
  }

  // If both disk and database are empty, seed the public starter docs onto disk and SQLite.
  // Seed documents are always PUBLIC because they are meant to be a public showcase.
  if (diskIds.length === 0 && owner?.id) {
    console.log('[InkFlow Storage] Initializing physical Markdown storage in storage/documents/ ...');

    for (const doc of INITIAL_SEED_DOCS) {
      try {
        await documentService.saveDocument(
          {
            id: doc.id,
            title: doc.title,
            slug: doc.slug,
            rawMarkdown: doc.rawMarkdown,
            category: doc.category,
            tags: doc.tags,
            visibility: doc.visibility,
            status: 'published',
            pinned: doc.pinned,
            author: doc.author,
          },
          ownerId,
          '系统初始化物理文档与索引'
        );
      } catch (err) {
        console.error(`Failed to seed doc ${doc.id}:`, err);
      }
    }

    console.log(`[InkFlow Storage] Successfully seeded ${INITIAL_SEED_DOCS.length} documents onto physical disk.`);
  }
}

/**
 * Reconciles the derived `document_assets` table with the Markdown SSOT on boot.
 */
export async function ensureAssetReferences(): Promise<void> {
  try {
    const count = await documentService.rebuildAssetReferences();
    if (count > 0) {
      console.log(`[InkFlow Storage] Synced asset references for ${count} documents.`);
    }
  } catch (err) {
    console.error('[InkFlow Storage] Failed syncing asset references:', err);
  }
}
