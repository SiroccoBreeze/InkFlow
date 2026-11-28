import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { initDatabaseSchema } from './schema';

export function getStorageDir(): string {
  return process.env.INKFLOW_DATA_DIR ? path.resolve(process.env.INKFLOW_DATA_DIR) : path.resolve(process.cwd(), 'storage');
}

export function getDbPath(): string {
  if (process.env.INKFLOW_DB_PATH) {
    return path.resolve(process.env.INKFLOW_DB_PATH);
  }
  return path.join(getStorageDir(), 'database', 'knowledge_hub.sqlite');
}

let dbInstance: DatabaseSync | null = null;

// Salted scrypt password hashing for owner credentials
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(plain.trim(), salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

export function verifyPassword(plain: string, storedHash: string): { isValid: boolean; needsRehash: boolean } {
  if (!storedHash || !plain) return { isValid: false, needsRehash: false };

  // 1. Modern salted scrypt: scrypt:<salt>:<derivedKeyHex>
  if (storedHash.startsWith('scrypt:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return { isValid: false, needsRehash: false };
    const salt = parts[1];
    const expectedHex = parts[2];
    const derivedKey = crypto.scryptSync(plain.trim(), salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 32 * 1024 * 1024,
    });
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const isValid = derivedKey.length === expectedBuf.length && crypto.timingSafeEqual(derivedKey, expectedBuf);
    return { isValid, needsRehash: false };
  }

  // 2. Backward compatibility: Legacy unsalted SHA-256 (64 hex characters)
  if (/^[a-f0-9]{64}$/i.test(storedHash)) {
    const sha256 = crypto.createHash('sha256').update(plain.trim()).digest('hex');
    const isValid = sha256.toLowerCase() === storedHash.toLowerCase();
    return { isValid, needsRehash: isValid };
  }

  return { isValid: false, needsRehash: false };
}

export function hashRecoveryCode(code: string): string {
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function generateId(prefix: string = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export function setDatabase(db: DatabaseSync | null): void {
  dbInstance = db;
}

/**
 * Runs a SYNCHRONOUS callback inside a single IMMEDIATE transaction.
 *
 * Why synchronous: `node:sqlite` exposes one connection per process. If a
 * transaction spans an `await`, other request handlers can run their SQL on the
 * same connection while the transaction is open — their writes become part of
 * this transaction (and are rolled back with it), or their own BEGIN fails and
 * rolls back this one. Callers must perform all file I/O before/after the
 * transaction and only run synchronous SQL here.
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') {
      throw new Error('事务回调必须是同步函数：检测到返回 Promise，已回滚以避免跨 await 事务');
    }
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite may already have rolled the transaction back.
    }
    throw err;
  }
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
  }
}

export function getDatabase(): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }

  const dbFilePath = getDbPath();
  const dbDir = path.dirname(dbFilePath);

  // Ensure storage directories exist
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new DatabaseSync(dbFilePath);
  try {
    initDatabaseSchema(db);
    seedDefaultDataIfEmpty(db);
  } catch (err) {
    // Do not leave a half-initialized connection open, and never delete the
    // database to "fix" a migration failure.
    try {
      db.close();
    } catch {
      // ignore close failure
    }
    console.error(`[InkFlow Database] Initialization failed for ${dbFilePath}:`, err);
    throw err;
  }

  dbInstance = db;
  return dbInstance;
}

export const SYSTEM_MARKERS = {
  defaultCategoriesSeeded: 'default_categories_seeded',
  starterDocsSeeded: 'starter_docs_seeded',
} as const;

export function hasSystemMarker(db: DatabaseSync, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as any;
    return row?.value === '1';
  } catch {
    // pre-migration database without the system_settings table
    return false;
  }
}

export function setSystemMarker(db: DatabaseSync, key: string): void {
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, '1', ?)
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
  `).run(key, new Date().toISOString());
}

export function seedDefaultCategoriesIfEmpty(db: DatabaseSync, ownerId: string): void {
  // One-way marker: default categories are a first-run convenience. Once the
  // owner has received them (or already curated a taxonomy), deleting every
  // category must not bring the built-in five back on the next startup.
  if (hasSystemMarker(db, SYSTEM_MARKERS.defaultCategoriesSeeded)) return;

  const checkCats = db.prepare('SELECT COUNT(*) as count FROM categories');
  const catCount = (checkCats.get() as any)?.count || 0;

  if (catCount === 0) {
    const now = new Date().toISOString();
    const defaultCategories = [
      { id: 'cat_arch', name: '架构与系统', slug: 'architecture', desc: '全栈架构演进、高可用设计与分布式基础设施', color: '#0284c7', order: 1 },
      { id: 'cat_cog', name: '认知与方法论', slug: 'cognitive', desc: '心智模型、卡片盒笔记法、个人知识管理与第二大脑体系', color: '#d97706', order: 2 },
      { id: 'cat_ai', name: 'AI与前沿工程', slug: 'ai-engineering', desc: '大语言模型应用、Prompt工程、智能体Agent与知识库检索增强', color: '#7c3aed', order: 3 },
      { id: 'cat_web', name: '前端与跨端', slug: 'frontend', desc: '现代前端工程化、组件库架构与性能优化实践', color: '#16a34a', order: 4 },
      { id: 'cat_sec', name: '安全与数据主权', slug: 'security', desc: '本地优先架构、数据主权、加密分享与防数据丢失防护机制', color: '#e11d48', order: 5 },
    ];

    const insertCat = db.prepare(`
      INSERT INTO categories (id, owner_id, name, slug, description, color, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of defaultCategories) {
      insertCat.run(c.id, ownerId, c.name, c.slug, c.desc, c.color, c.order, now, now);
    }
  }

  // Set the marker whether we seeded now or the installation already had
  // categories. From this point on, the owner's taxonomy is authoritative.
  setSystemMarker(db, SYSTEM_MARKERS.defaultCategoriesSeeded);
}

function seedDefaultDataIfEmpty(db: DatabaseSync): void {
  // Only seed default categories if an active owner is present in users table
  const existing = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('owner') as any;
  if (existing?.id) {
    seedDefaultCategoriesIfEmpty(db, existing.id);
  }
}

