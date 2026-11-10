import { getDatabase } from '../db/sqlite';

export class SearchService {
  private getDb() {
    return getDatabase();
  }

  public search(query: string, options: { isOwner: boolean; category?: string; limit?: number }) {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const db = this.getDb();
    const limit = Math.min(50, Math.max(1, options.limit || 20));

    // Permission enforcement: visitors only search public documents
    const visibilityCondition = options.isOwner ? '' : "AND d.visibility = 'public' AND d.status = 'published'";
    let categoryCondition = '';
    const categoryParams: any[] = [];

    if (options.category && options.category !== 'all') {
      categoryCondition = 'AND d.category_name = ?';
      categoryParams.push(options.category);
    }

    // 1. Try FTS5 Match
    try {
      const escapedQuery = `"${cleanQuery.replace(/"/g, '""')}"*`;
      const sql = `
        SELECT 
          d.id, d.title, d.slug, d.category_name as category, d.visibility,
          d.word_count, d.reading_time, d.pinned, d.updated_at,
          snippet(documents_fts, 2, '<mark>', '</mark>', '...', 20) as snippet
        FROM documents_fts fts
        JOIN documents d ON d.id = fts.document_id
        WHERE documents_fts MATCH ?
        ${visibilityCondition}
        ${categoryCondition}
        ORDER BY rank
        LIMIT ?
      `;

      const ftsRows = db.prepare(sql).all(escapedQuery, ...categoryParams, limit) as any[];
      if (ftsRows.length > 0) {
        return ftsRows;
      }
    } catch {
      // FTS syntax failed, proceed to fallback
    }

    // 2. Fallback to LIKE matching across title, description, and tags
    const likePattern = `%${cleanQuery}%`;
    const likeSql = `
      SELECT 
        d.id, d.title, d.slug, d.category_name as category, d.visibility,
        d.word_count, d.reading_time, d.pinned, d.updated_at,
        substr(d.description, 1, 120) as snippet
      FROM documents d
      WHERE (d.title LIKE ? OR d.description LIKE ? OR d.category_name LIKE ?)
      ${visibilityCondition}
      ${categoryCondition}
      ORDER BY d.pinned DESC, d.updated_at DESC
      LIMIT ?
    `;

    return db.prepare(likeSql).all(likePattern, likePattern, likePattern, ...categoryParams, limit) as any[];
  }
}

export const searchService = new SearchService();
