import crypto from 'node:crypto';
import { getDatabase, hashPassword, verifyPassword, generateId } from '../db/sqlite';
import { documentService, toPublicDocument } from './documentService';

export interface CreateShareOptions {
  documentId: string;
  password?: string;
  expiresInDays?: number;
  maxViews?: number;
}

export class ShareService {
  private getDb() {
    return getDatabase();
  }

  public createShare(options: CreateShareOptions, ownerId: string): { shareId: string; rawToken: string } {
    const db = this.getDb();
    const rawToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const shareId = generateId('share');
    const now = new Date();
    
    let expiresAt: string | null = null;
    if (options.expiresInDays && options.expiresInDays > 0) {
      expiresAt = new Date(now.getTime() + options.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const passwordHash = options.password ? hashPassword(options.password) : null;

    db.prepare(`
      INSERT INTO shares (id, owner_id, document_id, token_hash, password_hash, expires_at, max_views, view_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(shareId, ownerId, options.documentId, tokenHash, passwordHash, expiresAt, options.maxViews || null, now.toISOString());

    return { shareId, rawToken };
  }

  public async accessShare(rawToken: string, passwordAttempt?: string) {
    const db = this.getDb();
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const now = new Date().toISOString();

    const share = db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(tokenHash) as any;
    if (!share) {
      return { allowed: false, reason: 'SHARE_NOT_FOUND', message: '分享链接无效或已被删除' };
    }

    if (share.revoked_at) {
      return { allowed: false, reason: 'REVOKED', message: '此分享链接已被创建者主动撤销' };
    }

    if (share.expires_at && share.expires_at < now) {
      return { allowed: false, reason: 'EXPIRED', message: '此分享链接已过期' };
    }

    if (share.max_views && share.view_count >= share.max_views) {
      return { allowed: false, reason: 'MAX_VIEWS_EXCEEDED', message: '已达到该分享允许的最大访问次数' };
    }

    if (share.password_hash) {
      if (!passwordAttempt) {
        return { allowed: false, reason: 'PASSWORD_REQUIRED', message: '该分享链接受密码保护，请输入访问密码' };
      }
      // hashPassword() generates a fresh random salt on every call, so comparing its output
      // to a stored hash can never match. Verify against the stored salted hash instead.
      const { isValid } = verifyPassword(passwordAttempt, share.password_hash);
      if (!isValid) {
        return { allowed: false, reason: 'INCORRECT_PASSWORD', message: '访问密码错误，请重新输入' };
      }
    }

    // Increment view count
    db.prepare('UPDATE shares SET view_count = view_count + 1 WHERE id = ?').run(share.id);

    // Fetch document content
    const doc = await documentService.getDocumentById(share.document_id, true);
    if (!doc) {
      return { allowed: false, reason: 'DOC_NOT_FOUND', message: '关联文档已不存在' };
    }

    return {
      allowed: true,
      // Share recipients are external viewers: never expose internal paths/owner IDs.
      doc: toPublicDocument(doc),
      shareInfo: {
        id: share.id,
        viewCount: share.view_count + 1,
        maxViews: share.max_views,
        expiresAt: share.expires_at,
      },
    };
  }

  public revokeShare(shareId: string): boolean {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(now, shareId);
    return true;
  }
}

export const shareService = new ShareService();
