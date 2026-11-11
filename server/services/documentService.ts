import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { marked } from 'marked';
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
  /** Version the client based its edit on. Required by the HTTP API for updates. */
  expectedVersionCount?: number;
}

/** Thrown when a save is rejected because the document changed since the client read it. */
export class DocumentConflictError extends Error {
  public readonly code = 'VERSION_CONFLICT';
  constructor(
    public readonly details: {
      currentVersionCount: number;
      currentUpdatedAt: string;
      currentContentHash: string;
    }
  ) {
    super('文档已被其他客户端修改，请刷新后重试');
  }
}

/** Thrown for malformed save payloads (HTTP 400). */
export class DocumentValidationError extends Error {
  public readonly code = 'VALIDATION_ERROR';
}

/**
 * Thrown when an interrupted save could not be recovered. Continuing would
 * overwrite the only remaining `.bak`, so creation/update/delete must stop until
 * an administrator resolves the pending artifacts.
 */
export class DocumentRecoveryRequiredError extends Error {
  public readonly code = 'SAVE_RECOVERY_REQUIRED';
  constructor(public readonly docId: string) {
    super('文档存在未完成的保存恢复任务，已暂停写入以避免覆盖恢复备份');
  }
}

const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const MAX_TITLE_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 120;
const MAX_TAGS = 100;
const MAX_TAG_LENGTH = 80;

/** Validates a document save payload before any file or DB mutation. */
export function assertValidDocumentInput(input: DocumentInput): void {
  if (!input || typeof input !== 'object') {
    throw new DocumentValidationError('无效的文档数据');
  }
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(input.id)) {
      throw new DocumentValidationError('非法的文档 ID');
    }
  }
  if (typeof input.title !== 'string' || input.title.length > MAX_TITLE_LENGTH) {
    throw new DocumentValidationError(`文档标题必须为不超过 ${MAX_TITLE_LENGTH} 字符的字符串`);
  }
  if (typeof input.rawMarkdown !== 'string') {
    throw new DocumentValidationError('文档正文必须为字符串');
  }
  if (Buffer.byteLength(input.rawMarkdown, 'utf-8') > MAX_MARKDOWN_BYTES) {
    throw new DocumentValidationError('文档正文超过 5MB 限制');
  }
  if (input.category !== undefined && (typeof input.category !== 'string' || input.category.length > MAX_CATEGORY_LENGTH)) {
    throw new DocumentValidationError(`分类必须为不超过 ${MAX_CATEGORY_LENGTH} 字符的字符串`);
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > MAX_TAGS) {
      throw new DocumentValidationError(`标签必须为不超过 ${MAX_TAGS} 项的数组`);
    }
    for (const tag of input.tags) {
      if (typeof tag !== 'string' || tag.length > MAX_TAG_LENGTH) {
        throw new DocumentValidationError(`单个标签必须为不超过 ${MAX_TAG_LENGTH} 字符的字符串`);
      }
    }
  }
  if (input.visibility !== undefined && !['public', 'private', 'unlisted'].includes(input.visibility)) {
    throw new DocumentValidationError('visibility 仅允许 public / private / unlisted');
  }
  if (input.status !== undefined && !['draft', 'published', 'archived'].includes(input.status)) {
    throw new DocumentValidationError('status 仅允许 draft / published / archived');
  }
  if (input.expectedVersionCount !== undefined) {
    if (!Number.isInteger(input.expectedVersionCount) || input.expectedVersionCount < 1) {
      throw new DocumentValidationError('expectedVersionCount 必须为大于 0 的整数');
    }
  }
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
  status: string;
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
    `status: "${meta.status}"`,
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

/**
 * Hash of the complete Markdown file, including YAML frontmatter.
 *
 * content_hash intentionally remains body-only for search/UI compatibility.
 * Crash recovery needs to distinguish saves that only changed metadata (title,
 * visibility, status, tags…), where the body hash is identical; this full hash
 * is the commit marker stored alongside the SQLite row.
 */
export function calculateDocumentHash(markdown: string): string {
  return crypto.createHash('sha256').update(markdown, 'utf-8').digest('hex');
}

/**
 * Minimal async read/write lock (no third-party dependency).
 * Document saves/deletes hold a shared lease; global maintenance operations
 * (tag dictionary cleanup, global revision pruning) hold an exclusive lease.
 * Writer-preferring so a maintenance request cannot starve behind new saves.
 */
class AsyncReadWriteLock {
  private readers = 0;
  private writing = false;
  private queue: Array<{ mode: 'read' | 'write'; grant: (release: () => void) => void }> = [];

  private makeRelease(mode: 'read' | 'write'): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === 'read') this.readers--;
      else this.writing = false;
      this.drain();
    };
  }

  private drain(): void {
    if (this.writing) return;

    if (this.queue[0]?.mode === 'write') {
      if (this.readers > 0) return;
      const next = this.queue.shift()!;
      this.writing = true;
      next.grant(this.makeRelease('write'));
      return;
    }

    while (this.queue[0]?.mode === 'read') {
      const next = this.queue.shift()!;
      this.readers++;
      next.grant(this.makeRelease('read'));
    }
  }

  public acquireRead(): Promise<() => void> {
    return new Promise(resolve => {
      this.queue.push({ mode: 'read', grant: resolve });
      this.drain();
    });
  }

  public acquireWrite(): Promise<() => void> {
    return new Promise(resolve => {
      this.queue.push({ mode: 'write', grant: resolve });
      this.drain();
    });
  }
}

/**
 * Normalizes one link/image target and returns the asset ID it refers to.
 * Only the three supported, explicit reference forms are accepted:
 *   - /api/v1/assets/file/{assetId}      (the canonical URL inserted by the editor)
 *   - attachment:{assetId}               (legacy inline attachment syntax)
 *   - asset:{assetId}                    (explicit asset scheme)
 * Anything else (external URLs, filenames, arbitrary text) yields null.
 */
export function extractAssetIdFromHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const value = href.trim();
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return null;

  // Query strings and fragments are not part of the asset identity.
  let target = value.replace(/[?#].*$/, '');
  if (target.startsWith('./')) target = target.slice(2);

  // Supported explicit attachment schemes: attachment:{assetId} / asset:{assetId}
  const schemeMatch = /^(?:attachment|asset):(.+)$/i.exec(target);
  if (schemeMatch) {
    const id = schemeMatch[1];
    return /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : null;
  }

  // Any other scheme (http:, https:, mailto:, data:, file:, javascript:, …) is
  // never a local asset reference, even if its path looks similar.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;

  // Canonical editor URL: /api/v1/assets/file/{assetId}
  const fileMatch = /^\/api\/v1\/assets\/file\/([^/]+)$/i.exec(target);
  if (!fileMatch) return null;

  const assetId = fileMatch[1];
  return /^[A-Za-z0-9_-]{1,200}$/.test(assetId) ? assetId : null;
}

/**
 * Walks the Markdown token tree and collects asset references from real
 * image/link nodes only. Code blocks, inline code, raw HTML and plain text are
 * token types that never carry an `href`, so IDs written there cannot create an
 * association.
 */
function collectAssetIdsFromTokens(tokens: any[] | undefined, found: Set<string>): void {
  if (!Array.isArray(tokens)) return;
  for (const token of tokens) {
    if (!token || typeof token !== 'object') continue;

    if (token.type === 'image' || token.type === 'link') {
      const assetId = extractAssetIdFromHref(token.href);
      if (assetId) found.add(assetId);
    }

    // Recurse into container tokens (paragraph, heading, list, blockquote, table, emphasis, …)
    collectAssetIdsFromTokens(token.tokens, found);
    collectAssetIdsFromTokens(token.items, found);
    if (token.header) collectAssetIdsFromTokens(token.header, found);
    if (Array.isArray(token.rows)) {
      for (const row of token.rows) collectAssetIdsFromTokens(row, found);
    }
  }
}

/**
 * Extracts asset references from Markdown using the parser's token tree.
 * Filenames are deliberately NOT considered references.
 */
export function extractAssetReferences(markdown: string): string[] {
  if (!markdown || typeof markdown !== 'string') return [];

  let tokens: any[];
  try {
    tokens = marked.lexer(markdown) as any[];
  } catch {
    // Unparseable Markdown grants no access (fail-closed).
    return [];
  }

  const found = new Set<string>();
  collectAssetIdsFromTokens(tokens, found);
  return Array.from(found);
}

export function calculateReadingStats(content: string): { wordCount: number; readingTime: number } {
  const clean = content.replace(/```[\s\S]*?```/g, '').replace(/#|\*|`|>|\[.*?\]\(.*?\)/g, '');
  const cjkChars = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latinWords = (clean.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[a-zA-Z0-9_-]+/g) || []).length;
  const wordCount = cjkChars + latinWords;
  const readingTime = Math.max(1, Math.ceil(wordCount / 300));
  return { wordCount, readingTime };
}

/**
 * Removes fields that must never be exposed to anonymous visitors:
 * internal filesystem paths, owner account identifiers, and content hashes.
 */
export function toPublicDocument<T extends Record<string, any>>(row: T): T {
  const {
    file_path: _filePath,
    owner_id: _ownerId,
    content_hash: _contentHash,
    ...rest
  } = row as Record<string, any>;
  return rest as T;
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

        const doc = {
          ...row,
          rawMarkdown: rawMarkdown || `# ${row.title}\n\n${row.description || ''}`,
          pinned: Boolean(row.pinned),
          tags: tagRows.map(t => t.name),
        };

        return options.isOwner ? doc : toPublicDocument(doc);
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

    // Permission enforcement: anonymous visitors can ONLY access public and published documents
    if (!isOwner && (docRow.visibility !== 'public' || docRow.status !== 'published')) {
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

    const result = {
      ...docRow,
      category: docRow.category_name,
      pinned: Boolean(docRow.pinned),
      tags: tagRows.map(t => t.name),
      rawMarkdown,
    };

    // Public responses never leak internal disk paths, owner IDs, or content hashes
    return isOwner ? result : toPublicDocument(result);
  }

  // Per-document save mutex: serialises the Markdown + SQLite write sequence inside
  // this process, so two requests cannot interleave between the version check and commit.
  //
  // SINGLE-INSTANCE CONSTRAINT: this lock is process-local. InkFlow is started as a
  // single Node process (see package.json / release deployment) and does not support
  // multiple writers sharing one storage/ directory. The SQLite version CAS still
  // prevents lost updates across processes, but the `.bak` / `.save.pending` staging
  // files use fixed names and are only safe with one writer. If multi-process support
  // is ever required, replace this with a cross-process lock before enabling it.
  private saveLocks = new Map<string, Promise<void>>();

  // Shared by all document writes; exclusive for tag dictionary cleanup and global
  // revision pruning, so their multi-document scan/delete cannot interleave with a
  // save that adds a tag association.
  private maintenanceLock = new AsyncReadWriteLock();

  private async withSaveGate<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.maintenanceLock.acquireRead();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Runs a multi-document maintenance operation while no document save/delete is
   * in flight (and blocks new ones until the operation completes).
   */
  public async runExclusiveMaintenance<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.maintenanceLock.acquireWrite();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async withDocumentLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.saveLocks.get(docId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const tail = previous.catch(() => {}).then(() => gate);
    this.saveLocks.set(docId, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.saveLocks.get(docId) === tail) this.saveLocks.delete(docId);
    }
  }

  public documentExists(docId: string): boolean {
    if (!docId || typeof docId !== 'string') return false;
    const row = this.getDb().prepare('SELECT 1 AS ok FROM documents WHERE id = ?').get(docId) as any;
    return Boolean(row?.ok);
  }

  /**
   * Recovers saves interrupted between the Markdown rename and the SQLite commit.
   * The DB content hash is the commit point: if index.md matches it the save is
   * kept, otherwise the previous file is restored (or an uncommitted new file removed).
   */
  private async recoverPendingSave(docId: string): Promise<'none' | 'recovered' | 'failed'> {
    if (!(await fileStorage.hasPendingDocumentSave(docId))) return 'none';

    const db = this.getDb();
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
    const currentMarkdown = await fileStorage.readDocumentMarkdown(docId);

    if (row) {
      // Prefer the full-document commit marker. Legacy rows (created before
      // document_hash existed) fall back to comparing the file's frontmatter
      // metadata with SQLite; the body hash alone cannot distinguish a
      // metadata-only save that never committed.
      let fileMatchesCommittedState: boolean;
      if (row.document_hash) {
        fileMatchesCommittedState =
          currentMarkdown !== null && calculateDocumentHash(currentMarkdown) === row.document_hash;
      } else if (currentMarkdown === null) {
        fileMatchesCommittedState = false;
      } else {
        fileMatchesCommittedState = this.markdownMetadataMatchesRow(docId, currentMarkdown, row);
      }

      if (fileMatchesCommittedState) {
        // Committed (or the file was never replaced): the backup is stale.
        await fileStorage.clearDocumentSaveArtifacts(docId);
      } else {
        const restored = await fileStorage.restoreDocumentSaveBackup(docId);
        if (!restored) {
          const hasBackup = fileStorage.documentSaveBackupExists(docId);
          if (hasBackup) {
            // Backup exists but could not be restored (I/O error). Leave every
            // artifact in place so a later recovery attempt can retry.
            console.error(`[InkFlow Save Recovery] Could not restore backup for ${docId}; will retry later.`);
            return 'failed';
          }
          // No backup at all: index.md is ahead of the DB with nothing to restore.
          const indexPath = fileStorage.getDocumentIndexPath(docId);
          if (indexPath) {
            try {
              await fs.rm(indexPath, { force: true });
            } catch (err) {
              // Keep marker/backup: removing them now would erase the only trace
              // that this document still needs administrator recovery.
              console.error(`[InkFlow Save Recovery] Could not remove ${indexPath}:`, err);
              return 'failed';
            }
          }
        }
        await fileStorage.clearDocumentSaveArtifacts(docId);
      }
    } else {
      // Interrupted create: no DB row means this Markdown was never committed.
      // The folder only contains the uncommitted index/artifacts, so remove it.
      await fileStorage.deleteDocumentFolder(docId);
      if (fileStorage.documentFolderExists(docId)) {
        console.error(`[InkFlow Save Recovery] Could not remove uncommitted folder for ${docId}; will retry later.`);
        return 'failed';
      }
    }

    return 'recovered';
  }

  /**
   * Legacy fallback for rows without document_hash: does the file's frontmatter
   * describe the same metadata as the committed SQLite row? Used only by
   * recovery, so body-only edits (identical body hash) are classified correctly.
   */
  private markdownMetadataMatchesRow(docId: string, markdown: string, row: any): boolean {
    const { frontmatter } = parseFrontmatter(markdown);
    const dbTags = (
      this.getDb()
        .prepare(
          `SELECT t.name FROM tags t
           JOIN document_tags dt ON dt.tag_id = t.id
           WHERE dt.document_id = ?
           ORDER BY t.name`
        )
        .all(docId) as any[]
    ).map(t => String(t.name));
    const fileTags = (Array.isArray(frontmatter.tags) ? frontmatter.tags : [])
      .map((t: any) => String(t))
      .sort();
    const sameTags =
      fileTags.length === dbTags.length && fileTags.every((tag, index) => tag === dbTags[index]);
    const samePinned = String(frontmatter.pinned === true || frontmatter.pinned === 'true') === String(Boolean(row.pinned));

    // updated_at is written by the same save as every metadata field; when present
    // an exact match is the strongest signal.
    if (frontmatter.updated_at) {
      return (
        String(frontmatter.updated_at) === String(row.updated_at) &&
        String(frontmatter.title || '') === String(row.title) &&
        String(frontmatter.visibility || '') === String(row.visibility) &&
        String(frontmatter.status || '') === String(row.status) &&
        samePinned &&
        sameTags
      );
    }

    return (
      String(frontmatter.title || '') === String(row.title) &&
      String(frontmatter.visibility || '') === String(row.visibility) &&
      String(frontmatter.status || '') === String(row.status) &&
      String(frontmatter.category || '') === String(row.category_name) &&
      samePinned &&
      sameTags
    );
  }

  /** Runs crash recovery for every document that left save artifacts behind. */
  public async recoverPendingSaves(): Promise<number> {
    const ids = await fileStorage.listPendingSaveDocumentIds();
    let recovered = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const result = await this.recoverPendingSave(id);
        if (result === 'recovered') recovered++;
        else if (result === 'failed') failed++;
      } catch (err) {
        console.error(`[InkFlow Save Recovery] Failed recovering ${id}:`, err);
        failed++;
      }
    }
    if (failed > 0) {
      console.error(
        `[InkFlow Save Recovery] ${failed} document(s) still require recovery; writes for them are blocked.`
      );
    }

    // Upgrade legacy rows so future metadata-only saves can be recovered by
    // comparing the full Markdown hash instead of the body hash alone.
    await this.backfillDocumentHashes();

    return recovered;
  }

  /** Fills document_hash for rows created before the column existed. */
  public async backfillDocumentHashes(): Promise<number> {
    const db = this.getDb();
    const rows = db.prepare('SELECT id FROM documents WHERE document_hash IS NULL').all() as any[];
    let updated = 0;
    for (const row of rows) {
      // Never seal the hash of a file whose recovery is still unresolved: doing so
      // would make the uncommitted file look committed on the next attempt.
      if (await fileStorage.hasPendingDocumentSave(row.id)) continue;
      const markdown = await fileStorage.readDocumentMarkdown(row.id);
      if (markdown === null) continue;
      db.prepare('UPDATE documents SET document_hash = ? WHERE id = ? AND document_hash IS NULL').run(
        calculateDocumentHash(markdown),
        row.id
      );
      updated++;
    }
    return updated;
  }

  // Create or Update Document: dual write to physical disk and SQLite.
  // The HTTP layer requires expectedVersionCount for updates; internal callers
  // (rollback, index rebuild) may omit it and are serialised by the same lock.
  public async saveDocument(input: DocumentInput, ownerId: string, note?: string) {
    assertValidDocumentInput(input);

    const docId = input.id || generateId('doc');
    return this.withSaveGate(() => this.withDocumentLock(docId, async () => {
      // Heal a previously interrupted save for this document before touching it again.
      // If recovery cannot complete, refuse to write: continuing would overwrite
      // the only `.bak` / `.save.pending` that an administrator may need.
      const recovery = await this.recoverPendingSave(docId).catch(err => {
        console.error(`[InkFlow Save Recovery] Recovery failed for ${docId}:`, err);
        return 'failed' as const;
      });
      if (recovery === 'failed') {
        throw new DocumentRecoveryRequiredError(docId);
      }
      return this.saveDocumentLocked(input, docId, ownerId, note);
    }));
  }

  private async saveDocumentLocked(input: DocumentInput, docId: string, ownerId: string, note?: string) {
    const db = this.getDb();
    const now = new Date().toISOString();

    const title = input.title.trim() || '无标题文档';
    const slug = (input.slug || input.title || docId)
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || docId;
    const category = input.category?.trim() || '未分类';
    const tags = (input.tags || []).map(t => t.trim().replace(/^#/, '')).filter(Boolean);

    // Re-read inside the lock: this is the authoritative "version we are editing from".
    const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;

    if (
      existing &&
      input.expectedVersionCount !== undefined &&
      input.expectedVersionCount !== existing.version_count
    ) {
      throw new DocumentConflictError({
        currentVersionCount: existing.version_count,
        currentUpdatedAt: existing.updated_at,
        currentContentHash: existing.content_hash,
      });
    }

    // Secure defaults: a brand-new document is a PRIVATE DRAFT unless the owner explicitly publishes it.
    const visibility = input.visibility ?? existing?.visibility ?? 'private';
    const status = input.status ?? existing?.status ?? 'draft';
    const pinned = input.pinned ? 1 : 0;

    const { body } = parseFrontmatter(input.rawMarkdown);
    const cleanBody = body.trim();
    const contentHash = calculateContentHash(cleanBody);
    const stats = calculateReadingStats(cleanBody);

    const createdAt = existing?.created_at || now;
    const versionCount = (existing?.version_count || 0) + 1;

    const fullMarkdown = [
      buildFrontmatterBlock({
        id: docId,
        title,
        slug,
        category,
        tags,
        visibility,
        status,
        author: input.author || 'Hecker',
        pinned: Boolean(pinned),
        content_hash: contentHash,
        created_at: createdAt,
        updated_at: now,
      }),
      '',
      cleanBody,
    ].join('\n');
    // Full-file hash (frontmatter + body) is the commit marker used by recovery.
    const documentHash = calculateDocumentHash(fullMarkdown);

    // 1. Stage the new Markdown and back up the previous file. index.md is untouched
    //    until commitStagedDocumentSave() renames the temp file.
    const previousMarkdown = await fileStorage.readDocumentMarkdown(docId);
    const artifacts = await fileStorage.prepareDocumentSave(docId, previousMarkdown, fullMarkdown);
    if (!artifacts) {
      throw new Error('无法准备文档存储路径');
    }

    let dbCommitted = false;
    let revisionId: string | null = null;

    try {
      // 2. Commit the file change (atomic rename on the same filesystem).
      await fileStorage.commitStagedDocumentSave(artifacts.stagedPath, artifacts.finalPath);

      // 3. All SQLite writes happen in one transaction. If anything fails (revision
      //    snapshot I/O, FTS, tag, asset association), the DB rolls back and the
      //    Markdown file is restored from the backup below.
      db.exec('BEGIN IMMEDIATE');
      try {
        const existingCat = db.prepare('SELECT id FROM categories WHERE name = ?').get(category) as any;
        let categoryId = existingCat?.id;
        if (!categoryId) {
          categoryId = generateId('cat');
          db.prepare(`
            INSERT OR IGNORE INTO categories (id, owner_id, name, slug, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(categoryId, ownerId, category, slug, now, now);
        }

        if (existing) {
          const updated = db.prepare(`
            UPDATE documents SET
              title = ?, slug = ?, category_id = ?, category_name = ?, file_path = ?,
              visibility = ?, status = ?, content_hash = ?, document_hash = ?, word_count = ?, reading_time = ?,
              pinned = ?, version_count = ?, updated_at = ?
            WHERE id = ? AND version_count = ?
          `).run(
            title,
            slug,
            categoryId,
            category,
            fileStorage.toStorageRelativePath(artifacts.finalPath),
            visibility,
            status,
            contentHash,
            documentHash,
            stats.wordCount,
            stats.readingTime,
            pinned,
            versionCount,
            now,
            docId,
            existing.version_count
          );

          if (Number((updated as any).changes) !== 1) {
            const current = db.prepare('SELECT version_count, updated_at, content_hash FROM documents WHERE id = ?').get(docId) as any;
            throw new DocumentConflictError({
              currentVersionCount: current?.version_count ?? versionCount,
              currentUpdatedAt: current?.updated_at ?? now,
              currentContentHash: current?.content_hash ?? contentHash,
            });
          }
        } else {
          db.prepare(`
            INSERT INTO documents (
              id, owner_id, slug, title, description, category_id, category_name,
              file_path, visibility, status, content_hash, document_hash, word_count, reading_time,
              pinned, version_count, created_at, updated_at, published_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            docId,
            ownerId,
            slug,
            title,
            cleanBody.slice(0, 160).replace(/\n/g, ' '),
            categoryId,
            category,
            fileStorage.toStorageRelativePath(artifacts.finalPath),
            visibility,
            status,
            contentHash,
            documentHash,
            stats.wordCount,
            stats.readingTime,
            pinned,
            versionCount,
            createdAt,
            now,
            visibility === 'public' ? now : null
          );
        }

        revisionId = generateId('rev');
        const snapshotPath = await fileStorage.saveRevisionSnapshot(docId, revisionId, fullMarkdown);
        db.prepare(`
          INSERT INTO document_revisions (id, document_id, title, content_hash, snapshot_path, version_number, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          revisionId,
          docId,
          title,
          contentHash,
          snapshotPath,
          versionCount,
          existing ? note || '更新文章内容' : '创建初始化版本',
          now
        );

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

        db.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(docId);
        db.prepare(`
          INSERT INTO documents_fts (document_id, title, body, category, tags)
          VALUES (?, ?, ?, ?, ?)
        `).run(docId, title, cleanBody, category, tags.join(' '));

        this.syncDocumentAssets(docId, cleanBody);

        db.exec('COMMIT');
        dbCommitted = true;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // transaction may already be rolled back by SQLite
        }
        throw err;
      }

      // 4. Success: drop the backup marker files.
      await fileStorage.finalizeDocumentSave(artifacts);

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
    } catch (err) {
      if (!dbCommitted) {
        if (revisionId) {
          await fileStorage.deleteSingleRevisionFile(docId, revisionId).catch(() => {});
        }
        await fileStorage.rollbackDocumentSave(docId, artifacts).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Rebuilds `document_assets` from explicit references found in a document's Markdown.
   * Only asset IDs that actually exist in the assets table are recorded.
   */
  public syncDocumentAssets(docId: string, markdownBody: string): string[] {
    const db = this.getDb();
    const referencedIds = extractAssetReferences(markdownBody);

    db.prepare('DELETE FROM document_assets WHERE document_id = ?').run(docId);

    const validIds: string[] = [];
    const existsStmt = db.prepare('SELECT id FROM assets WHERE id = ?');
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO document_assets (document_id, asset_id, created_at)
      VALUES (?, ?, ?)
    `);
    const now = new Date().toISOString();

    for (const assetId of referencedIds) {
      if (existsStmt.get(assetId)) {
        insertStmt.run(docId, assetId, now);
        validIds.push(assetId);
      }
    }

    return validIds;
  }

  /**
   * Rebuilds every document ↔ asset reference from the physical Markdown SSOT.
   * Used at startup so legacy documents get a reliable association table.
   */
  public async rebuildAssetReferences(): Promise<number> {
    const db = this.getDb();
    const docIds = await fileStorage.listAllDiskDocumentIds();
    let synced = 0;

    for (const docId of docIds) {
      // Serialise with saves: a concurrent save rebuilds the same association
      // table inside its transaction, and a stale read must not overwrite it.
      await this.withDocumentLock(docId, async () => {
        const raw = await fileStorage.readDocumentMarkdown(docId);
        if (!raw) return;
        const { body } = parseFrontmatter(raw);
        this.syncDocumentAssets(docId, body);
        synced++;
      });
    }

    return synced;
  }

  /**
   * Whether an asset is anonymously readable: it must be explicitly referenced by at
   * least one document that is BOTH public AND published.
   */
  public isAssetPubliclyReadable(assetId: string): boolean {
    const db = this.getDb();
    if (!assetId) return false;
    const row = db.prepare(`
      SELECT 1 AS ok
      FROM document_assets da
      JOIN documents d ON d.id = da.document_id
      WHERE da.asset_id = ?
        AND d.visibility = 'public'
        AND d.status = 'published'
      LIMIT 1
    `).get(assetId) as any;
    return Boolean(row?.ok);
  }

  // Delete document
  public async deleteDocument(id: string) {
    // Same gate + per-document lock as saveDocument: a save and a delete for the
    // same document can never interleave, and global tag/revision maintenance
    // cannot observe a half-deleted document.
    return this.withSaveGate(() =>
      this.withDocumentLock(id, async () => {
        // Deletion must not run while a save is awaiting recovery: it would remove
        // the backup/marker files that contain the last committed content.
        const recovery = await this.recoverPendingSave(id).catch(err => {
          console.error(`[InkFlow Save Recovery] Recovery failed for ${id}:`, err);
          return 'failed' as const;
        });
        if (recovery === 'failed') {
          throw new DocumentRecoveryRequiredError(id);
        }

        const db = this.getDb();
        // 1. Read document markdown to check for attached assets before deleting
        const rawMarkdown = await fileStorage.readDocumentMarkdown(id);

        // 2. Remove SQLite records first, in one transaction. If this fails the
        //    Markdown folder is untouched (consistent). The reverse order could
        //    leave a DB row pointing at a folder that was already deleted.
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(id);
          db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(id);
          db.prepare('DELETE FROM document_revisions WHERE document_id = ?').run(id);
          try {
            db.prepare('DELETE FROM comments WHERE document_id = ?').run(id);
          } catch {}
          // Cascades remove document_assets.
          db.prepare('DELETE FROM documents WHERE id = ?').run(id);
          db.exec('COMMIT');
        } catch (err) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // may already be rolled back
          }
          throw err;
        }

        // 3. Delete physical document folder and revisions folder. If a filesystem
        //    deletion fails, only orphan files remain (no live DB record).
        await fileStorage.deleteDocumentFolder(id);
        await fileStorage.deleteRevisionFolder(id);

        // 4. Clean up any assets that were only in this document
        if (rawMarkdown) {
          try {
            await assetService.cleanupUnreferencedAssets();
          } catch {}
        }

        // 5. Clean up any orphaned revisions
        await fileStorage.cleanupOrphanRevisions();

        return true;
      })
    );
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
      // Disk snapshots from existing installations were published documents; keep them published
      // so disaster recovery does not silently unpublish the whole site.
      const status = frontmatter.status || 'published';
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
          status: status as any,
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
        // Rollback is an intentional overwrite, but still participates in the
        // optimistic lock so a concurrent edit cannot be silently clobbered.
        expectedVersionCount: docRow.version_count,
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
    const keepLatest = options.all ? 0 : options.keepLatest !== undefined ? options.keepLatest : 1;

    const runCleanup = async (documentId?: string) => {
      const db = this.getDb();
      let deletedCount = 0;
      let freedBytes = 0;
      let deletedIds: string[] = [];

      if (documentId) {
        const res = await fileStorage.pruneDocumentRevisions(documentId, keepLatest);
        deletedCount = res.deletedCount;
        freedBytes = res.freedBytes;
        deletedIds = res.deletedRevisionIds;

        if (deletedIds.length > 0) {
          const placeholders = deletedIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM document_revisions WHERE document_id = ? AND id IN (${placeholders})`).run(
            documentId,
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
    };

    const documentId = options.documentId;
    if (documentId) {
      // A save writes a snapshot file and inserts its row in one save transaction;
      // pruning must not run between those two steps for the same document. The
      // shared lease also excludes the global (exclusive) pruning path.
      return this.withSaveGate(() => this.withDocumentLock(documentId, () => runCleanup(documentId)));
    }

    // Global pruning touches every document's revision folder: block all saves
    // while it runs instead of trying to lock an unknown, changing document set.
    return this.runExclusiveMaintenance(() => runCleanup());
  }

  // Delete a single revision file and DB record
  public async deleteSingleRevision(documentId: string, revisionId: string): Promise<boolean> {
    return this.withSaveGate(() =>
      this.withDocumentLock(documentId, async () => {
        const db = this.getDb();
        const diskRemoved = await fileStorage.deleteSingleRevisionFile(documentId, revisionId);
        db.prepare('DELETE FROM document_revisions WHERE document_id = ? AND id = ?').run(documentId, revisionId);
        return diskRemoved;
      })
    );
  }
}

export const documentService = new DocumentService();
