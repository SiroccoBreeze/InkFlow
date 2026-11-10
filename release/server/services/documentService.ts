import crypto from 'node:crypto';
import { getDatabase, generateId } from '../db/sqlite';
import { fileStorage } from './fileStorageService';
import { assetService } from './assetService';

export interface DocumentInput {
  id?: string;
  title: string;
  slug?: string;
  rawMarkdown: string;
  category?: string;
  tags?: string[];
  visibility?: 'public' | 'private' | 'unlisted';
  status?: 'draft' | 'published' | 'archived';
  pinned?: boolean;
  author?: string;
}

export function parseFrontmatter(markdown: string): {
  frontmatter: Record<string, any>;
  body: string;
} {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: markdown };
  }

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: markdown };
  }

  const yamlContent = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).replace(/^\r?\n/, '');

  const frontmatter: Record<string, any> = {};
  yamlContent.split('\n').forEach(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();

      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      } else if (val.startsWith("'") && val.endsWith("'")) {
        val = val.slice(1, -1);
      } else if (val.startsWith('[') && val.endsWith(']')) {
        try {
          frontmatter[key] = JSON.parse(val);
          return;
        } catch {}
      }
      frontmatter[key] = val;
    }
  });

  return { frontmatter, body };
}

export function buildFrontmatterBlock(meta: {
  id: string;
  title: string;
  slug: string;
  category: string;
  tags: string[];
  visibility: string;
  author: string;
  pinned: boolean;
  content_hash: string;
  created_at: string;
  updated_at: string;
}): string {
  const tagsStr = `[${meta.tags.map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ')}]`;
  return [
    '---',
    `id: "${meta.id}"`,
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    `slug: "${meta.slug}"`,
    `category: "${meta.category}"`,
    `tags: ${tagsStr}`,
    `visibility: "${meta.visibility}"`,
    `author: "${meta.author || 'Hecker'}"`,
    `pinned: ${meta.pinned ? 'true' : 'false'}`,
    `content_hash: "${meta.content_hash}"`,
    `created_at: "${meta.created_at}"`,
    `updated_at: "${meta.updated_at}"`,
    '---',
  ].join('\n');
}

export function calculateContentHash(body: string): string {
  return crypto.createHash('sha256').update(body.trim()).digest('hex').slice(0, 16);
}

export function calculateReadingStats(content: string): { wordCount: number; readingTime: number } {
  const clean = content.replace(/```[\s\S]*?```/g, '').replace(/#|\*|`|>|\[.*?\]\(.*?\)/g, '');
  const cjkChars = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latinWords = (clean.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[a-zA-Z0-9_-]+/g) || []).length;
  const wordCount = cjkChars + latinWords;
  const readingTime = Math.max(1, Math.ceil(wordCount / 300));
  return { wordCount, readingTime };
}

export class DocumentService {
  private getDb() {
    return getDatabase();
  }

  // List documents with optional filters and permission boundaries
  public async listDocuments(options: {
    isOwner: boolean;
    visibility?: string;
    category?: string;
    tag?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    const db = this.getDb();
    const page = Math.max(1, options.page || 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize || 50));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: any[] = [];

    // Public / Permission check
    if (!options.isOwner) {
      conditions.push("visibility = 'public' AND status = 'published'");
    } else if (options.visibility && options.visibility !== 'all') {
      conditions.push('visibility = ?');
      params.push(options.visibility);
    }

    if (options.category && options.category !== 'all') {
      conditions.push('category_name = ?');
      params.push(options.category);
    }

    if (options.search) {
      conditions.push('(title LIKE ? OR category_name LIKE ?)');
      params.push(`%${options.search}%`, `%${options.search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = db.prepare(`SELECT COUNT(*) as total FROM documents ${whereClause}`);
    const total = (countStmt.get(...params) as any)?.total || 0;

    const queryStmt = db.prepare(`
      SELECT 
        id, owner_id, slug, title, description, category_name as category,
        file_path, visibility, status, content_hash, word_count, reading_time,
        pinned, version_count, created_at, updated_at, published_at
      FROM documents
      ${whereClause}
      ORDER BY pinned DESC, created_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = queryStmt.all(...params, pageSize, offset) as any[];

    // Fetch tags and physical markdown content for each document
    const docs = await Promise.all(
      rows.map(async row => {
        const tagRows = db
          .prepare(
            `
          SELECT t.name FROM tags t
          JOIN document_tags dt ON dt.tag_id = t.id
          WHERE dt.document_id = ?
        `
          )
          .all(row.id) as any[];

        const rawMarkdown = await fileStorage.readDocumentMarkdown(row.id);

        return {
          ...row,
          rawMarkdown: rawMarkdown || `# ${row.title}\n\n${row.description || ''}`,
          pinned: Boolean(row.pinned),
          tags: tagRows.map(t => t.name),
        };
      })
    );

    return {
      docs,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  // Get single document with raw markdown read from physical disk
  public async getDocumentById(id: string, isOwner: boolean) {
    const db = this.getDb();
    const docRow = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as any;
    if (!docRow) return null;

    if (!isOwner && docRow.visibility !== 'public') {
      return null;
    }

    // Read full markdown from physical disk
    let rawMarkdown = await fileStorage.readDocumentMarkdown(id);
    if (!rawMarkdown) {
      rawMarkdown = `# ${docRow.title}\n\n`;
    }

    const tagRows = db
      .prepare(
        `
      SELECT t.name FROM tags t
      JOIN document_tags dt ON dt.tag_id = t.id
      WHERE dt.document_id = ?
    `
      )
      .all(id) as any[];

    return {
      ...docRow,
      category: docRow.category_name,
      pinned: Boolean(docRow.pinned),
      tags: tagRows.map(t => t.name),
      rawMarkdown,
    };
  }

  // Create or Update Document: Dual write to physical disk and SQLite
  public async saveDocument(input: DocumentInput, ownerId: string, note?: string) {
    const db = this.getDb();
    const now = new Date().toISOString();
    const docId = input.id || generateId('doc');
    const title = input.title.trim() || '无标题文档';
    const slug = (input.slug || input.title || docId)
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || docId;
    const category = input.category?.trim() || '未分类';
    const tags = (input.tags || []).map(t => t.trim().replace(/^#/, '')).filter(Boolean);
    const visibility = input.visibility || 'public';
    const status = input.status || 'published';
    const pinned = input.pinned ? 1 : 0;

    // Check existing document
    const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;

    // Parse body for stats and hash
    const { body } = parseFrontmatter(input.rawMarkdown);
    const cleanBody = body.trim();
    const contentHash = calculateContentHash(cleanBody);
    const stats = calculateReadingStats(cleanBody);

    const createdAt = existing?.created_at || now;
    const versionCount = (existing?.version_count || 0) + 1;

    // Assemble canonical Markdown file with Frontmatter
    const fullMarkdown = [
      buildFrontmatterBlock({
        id: docId,
        title,
        slug,
        category,
        tags,
        visibility,
        author: input.author || 'Hecker',
        pinned: Boolean(pinned),
        content_hash: contentHash,
        created_at: createdAt,
        updated_at: now,
      }),
      '',
      cleanBody,
    ].join('\n');

    // 1. Physically write to disk: storage/documents/{docId}/index.md
    const relativeFilePath = await fileStorage.saveDocumentMarkdown(docId, fullMarkdown);

    // 2. Upsert Category if new
    const existingCat = db.prepare('SELECT id FROM categories WHERE name = ?').get(category) as any;
    let categoryId = existingCat?.id;
    if (!categoryId) {
      categoryId = generateId('cat');
      db.prepare(`
        INSERT OR IGNORE INTO categories (id, owner_id, name, slug, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(categoryId, ownerId, category, slug, now, now);
    }

    // 3. Update SQLite documents table first (so foreign keys in child tables succeed)
    db.prepare(`
      INSERT INTO documents (
        id, owner_id, slug, title, description, category_id, category_name,
        file_path, visibility, status, content_hash, word_count, reading_time,
        pinned, version_count, created_at, updated_at, published_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        slug = excluded.slug,
        category_id = excluded.category_id,
        category_name = excluded.category_name,
        file_path = excluded.file_path,
        visibility = excluded.visibility,
        status = excluded.status,
        content_hash = excluded.content_hash,
        word_count = excluded.word_count,
        reading_time = excluded.reading_time,
        pinned = excluded.pinned,
        version_count = excluded.version_count,
        updated_at = excluded.updated_at
    `).run(
      docId,
      ownerId,
      slug,
      title,
      cleanBody.slice(0, 160).replace(/\n/g, ' '),
      categoryId,
      category,
      relativeFilePath,
      visibility,
      status,
      contentHash,
      stats.wordCount,
      stats.readingTime,
      pinned,
      versionCount,
      createdAt,
      now,
      visibility === 'public' ? now : null
    );

    // 4. Save revision snapshot now that documents row exists
    if (existing) {
      const revId = generateId('rev');
      const snapshotPath = await fileStorage.saveRevisionSnapshot(docId, revId, fullMarkdown);
      db.prepare(`
        INSERT INTO document_revisions (id, document_id, title, content_hash, snapshot_path, version_number, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(revId, docId, title, contentHash, snapshotPath, versionCount, note || '更新文章内容', now);
    } else {
      const revId = generateId('rev');
      const snapshotPath = await fileStorage.saveRevisionSnapshot(docId, revId, fullMarkdown);
      db.prepare(`
        INSERT INTO document_revisions (id, document_id, title, content_hash, snapshot_path, version_number, note, created_at)
        VALUES (?, ?, ?, ?, ?, 1, '创建初始化版本', ?)
      `).run(revId, docId, title, contentHash, snapshotPath, now);
    }

    // 5. Update Tags & Associations
    db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(docId);
    for (const tagName of tags) {
      let tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any;
      let tagId = tagRow?.id;
      if (!tagId) {
        tagId = generateId('tag');
        db.prepare('INSERT OR IGNORE INTO tags (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').run(
          tagId,
          ownerId,
          tagName,
          tagName.toLowerCase(),
          now
        );
      }
      db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)').run(docId, tagId);
    }

    // 6. Update FTS5 Search Index
    db.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(docId);
    db.prepare(`
      INSERT INTO documents_fts (document_id, title, body, category, tags)
      VALUES (?, ?, ?, ?, ?)
    `).run(docId, title, cleanBody, category, tags.join(' '));

    return {
      id: docId,
      slug,
      title,
      category,
      tags,
      visibility,
      status,
      pinned: Boolean(pinned),
      versionCount,
      wordCount: stats.wordCount,
      readingTime: stats.readingTime,
      createdAt,
      updatedAt: now,
      rawMarkdown: fullMarkdown,
    };
  }

  // Delete document
  public async deleteDocument(id: string) {
    const db = this.getDb();
    // 1. Read document markdown to check for attached assets before deleting
    const rawMarkdown = await fileStorage.readDocumentMarkdown(id);

    // 2. Delete physical document folder and revisions folder
    await fileStorage.deleteDocumentFolder(id);
    await fileStorage.deleteRevisionFolder(id);

    // 3. Delete database records
    db.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(id);
    db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(id);
    db.prepare('DELETE FROM document_revisions WHERE document_id = ?').run(id);
    try {
      db.prepare('DELETE FROM comments WHERE document_id = ?').run(id);
    } catch {}
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);

    // 4. Clean up any assets that were only in this document
    if (rawMarkdown) {
      try {
        await assetService.cleanupUnreferencedAssets();
      } catch {}
    }

    // 5. Clean up any orphaned revisions
    await fileStorage.cleanupOrphanRevisions();

    return true;
  }

  // Disaster Recovery: Rebuild Index from Physical Disk Markdown Files
  public async rebuildIndexFromDisk(ownerId: string): Promise<{ restoredCount: number }> {
    const db = this.getDb();
    const diskDocIds = await fileStorage.listAllDiskDocumentIds();
    let restoredCount = 0;

    for (const docId of diskDocIds) {
      const rawMarkdown = await fileStorage.readDocumentMarkdown(docId);
      if (!rawMarkdown) continue;

      const { frontmatter, body } = parseFrontmatter(rawMarkdown);
      const title = frontmatter.title || '恢复文档';
      const category = frontmatter.category || '未分类';
      const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
      const visibility = frontmatter.visibility || 'public';
      const pinned = frontmatter.pinned ? true : false;

      await this.saveDocument(
        {
          id: docId,
          title,
          slug: frontmatter.slug,
          rawMarkdown,
          category,
          tags,
          visibility: visibility as any,
          pinned,
          author: frontmatter.author || 'Owner',
        },
        ownerId,
        '从磁盘文件自动重建索引'
      );
      restoredCount++;
    }

    return { restoredCount };
  }

  // List all revisions for a document
  public listRevisions(docId: string) {
    const db = this.getDb();
    const rows = db
      .prepare(`
        SELECT id, document_id, title, version_number, note, content_hash, snapshot_path, created_at
        FROM document_revisions
        WHERE document_id = ?
        ORDER BY version_number DESC
      `)
      .all(docId) as any[];

    return rows.map(r => ({
      id: r.id,
      docId: r.document_id,
      title: r.title,
      versionNumber: r.version_number,
      note: r.note,
      contentHash: r.content_hash,
      createdAt: r.created_at,
    }));
  }

  // Get single revision snapshot with markdown content
  public async getRevisionSnapshot(docId: string, revisionId: string) {
    const db = this.getDb();
    const row = db
      .prepare('SELECT * FROM document_revisions WHERE id = ? AND document_id = ?')
      .get(revisionId, docId) as any;
    if (!row) return null;

    const rawMarkdown = await fileStorage.readRevisionSnapshot(docId, revisionId);
    return {
      id: row.id,
      docId: row.document_id,
      title: row.title,
      versionNumber: row.version_number,
      note: row.note,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      rawMarkdown,
    };
  }

  // Rollback document to a historical revision
  public async rollbackRevision(docId: string, revisionId: string, ownerId: string) {
    const snapshot = await this.getRevisionSnapshot(docId, revisionId);
    if (!snapshot || !snapshot.rawMarkdown) {
      throw new Error('未找到该历史版本的快照文件');
    }

    const { frontmatter } = parseFrontmatter(snapshot.rawMarkdown);
    const db = this.getDb();
    const docRow = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
    if (!docRow) throw new Error('目标文档不存在');

    return await this.saveDocument(
      {
        id: docId,
        title: frontmatter.title || docRow.title,
        slug: frontmatter.slug || docRow.slug,
        rawMarkdown: snapshot.rawMarkdown,
        category: frontmatter.category || docRow.category_name,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
        visibility: (frontmatter.visibility || docRow.visibility) as any,
        pinned: Boolean(frontmatter.pinned !== undefined ? frontmatter.pinned : docRow.pinned),
        author: frontmatter.author || 'Hecker',
      },
      ownerId,
      `回滚至历史版本 v${snapshot.versionNumber}`
    );
  }

  // Get full revisions overview across physical disk and SQLite
  public async getRevisionsOverview() {
    const db = this.getDb();
    const diskStats = await fileStorage.getRevisionsDiskStats();

    // Map doc details from SQLite
    const docRows = db.prepare('SELECT id, title, category_name, slug, updated_at FROM documents').all() as any[];
    const docMap = new Map<string, any>();
    for (const d of docRows) {
      docMap.set(d.id, d);
    }

    // Map all revision records from SQLite
    const revRows = db.prepare('SELECT id, document_id, version_number, note, created_at FROM document_revisions').all() as any[];
    const revMap = new Map<string, any>();
    for (const r of revRows) {
      revMap.set(`${r.document_id}:${r.id}`, r);
    }

    const groups = diskStats.docs.map(docGroup => {
      const docMeta = docMap.get(docGroup.documentId);
      const enrichedFiles = docGroup.files.map(f => {
        const dbRev = revMap.get(`${docGroup.documentId}:${f.revisionId}`);
        return {
          id: f.revisionId,
          fileName: f.fileName,
          size: f.size,
          createdAt: dbRev?.created_at || f.mtime,
          versionNumber: dbRev?.version_number || null,
          note: dbRev?.note || '历史快照',
          relativePath: f.relativePath,
        };
      });

      return {
        documentId: docGroup.documentId,
        title: docMeta?.title || `文档 (ID: ${docGroup.documentId})`,
        category: docMeta?.category_name || '未分类',
        slug: docMeta?.slug || '',
        updatedAt: docMeta?.updated_at || (enrichedFiles[0]?.createdAt || ''),
        totalBytes: docGroup.totalBytes,
        revisionCount: enrichedFiles.length,
        latestRevisionAt: enrichedFiles[0]?.createdAt || '',
        revisions: enrichedFiles,
      };
    });

    return {
      totalDocumentsWithRevisions: groups.length,
      totalRevisionsCount: diskStats.totalRevisionsCount,
      totalDiskBytes: diskStats.totalDiskBytes,
      groups,
    };
  }

  // Clean revisions: either for a specific document, or globally across all documents
  public async cleanRevisions(options: {
    documentId?: string;
    keepLatest?: number;
    all?: boolean;
  }): Promise<{
    cleanedCount: number;
    freedBytes: number;
    remainingCount: number;
    totalDiskBytes: number;
  }> {
    const db = this.getDb();
    const keepLatest = options.all ? 0 : options.keepLatest !== undefined ? options.keepLatest : 1;

    let deletedCount = 0;
    let freedBytes = 0;
    let deletedIds: string[] = [];

    if (options.documentId) {
      const res = await fileStorage.pruneDocumentRevisions(options.documentId, keepLatest);
      deletedCount = res.deletedCount;
      freedBytes = res.freedBytes;
      deletedIds = res.deletedRevisionIds;

      if (deletedIds.length > 0) {
        const placeholders = deletedIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM document_revisions WHERE document_id = ? AND id IN (${placeholders})`).run(
          options.documentId,
          ...deletedIds
        );
      }
    } else {
      const res = await fileStorage.pruneAllRevisions(keepLatest);
      deletedCount = res.deletedCount;
      freedBytes = res.freedBytes;
      deletedIds = res.deletedRevisionIds;

      if (deletedIds.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < deletedIds.length; i += batchSize) {
          const chunk = deletedIds.slice(i, i + batchSize);
          const placeholders = chunk.map(() => '?').join(',');
          db.prepare(`DELETE FROM document_revisions WHERE id IN (${placeholders})`).run(...chunk);
        }
      }
    }

    const updatedStats = await fileStorage.getRevisionsDiskStats();

    return {
      cleanedCount: deletedCount,
      freedBytes,
      remainingCount: updatedStats.totalRevisionsCount,
      totalDiskBytes: updatedStats.totalDiskBytes,
    };
  }

  // Delete a single revision file and DB record
  public async deleteSingleRevision(documentId: string, revisionId: string): Promise<boolean> {
    const db = this.getDb();
    const diskRemoved = await fileStorage.deleteSingleRevisionFile(documentId, revisionId);
    db.prepare('DELETE FROM document_revisions WHERE document_id = ? AND id = ?').run(documentId, revisionId);
    return diskRemoved;
  }
}

export const documentService = new DocumentService();
