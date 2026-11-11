import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_SQL = `
-- 1. Users Table (Multi-tenant ready, single-owner for V1)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_owner ON users (role) WHERE role = 'owner';

-- 2. Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Categories Table
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_owner_name ON categories (owner_id, name);

-- 4. Tags Table
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_owner_name ON tags (owner_id, name);

-- 5. Documents Metadata Table (Physical markdown is SSOT in storage/documents/{id}/index.md)
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category_id TEXT,
  category_name TEXT NOT NULL DEFAULT '未分类',
  file_path TEXT NOT NULL,
  -- Secure defaults: a new document is a private draft until the owner explicitly publishes it.
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('public', 'private', 'unlisted')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'archived')),
  content_hash TEXT NOT NULL,
  -- Full-document hash (frontmatter + body) used as the cross-filesystem commit
  -- marker for crash recovery. content_hash keeps its body-only semantics.
  document_hash TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  reading_time INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  version_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_owner_slug ON documents (owner_id, slug);
CREATE INDEX IF NOT EXISTS idx_docs_visibility ON documents (visibility);
CREATE INDEX IF NOT EXISTS idx_docs_category ON documents (category_name);

-- 6. Document Tags Association
CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (document_id, tag_id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- 7. Document Revisions History Table
CREATE TABLE IF NOT EXISTS document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 8. Shares Table (Unlisted / Secure Share links)
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  expires_at TEXT,
  max_views INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 9. Assets Table
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

-- 10. Document ↔ Asset Reference Association
-- Authoritative index of which asset is referenced by which document. Populated from
-- the parsed Markdown of each document only (never from filename substring guessing).
CREATE TABLE IF NOT EXISTS document_assets (
  document_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, asset_id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_document_assets_asset ON document_assets (asset_id);

-- 11. SQLite FTS5 Full-Text Search Virtual Table
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  document_id UNINDEXED,
  title,
  body,
  category,
  tags,
  tokenize = 'unicode61'
);

-- 12. Security One-Time Recovery Codes Table
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes (user_id, used_at);

-- 13. System Settings / One-Way Security State Markers
-- e.g. owner_initialized=1 permanently closes the first-run initialization entry.
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function initDatabaseSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA_SQL);

  // Incremental migration for installations created before document_hash existed.
  // content_hash stays body-only; document_hash covers frontmatter + body.
  try {
    const columns = db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'document_hash')) {
      db.exec('ALTER TABLE documents ADD COLUMN document_hash TEXT');
    }
  } catch (err) {
    console.error('[InkFlow Schema Migration] Failed ensuring documents.document_hash:', err);
  }
}
