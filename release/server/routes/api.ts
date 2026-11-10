import { Router, Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService';
import { documentService, parseFrontmatter, buildFrontmatterBlock } from '../services/documentService';
import { searchService } from '../services/searchService';
import { shareService } from '../services/shareService';
import { assetService } from '../services/assetService';
import { fileStorage } from '../services/fileStorageService';
import { getDatabase, generateId } from '../db/sqlite';

export const apiRouter = Router();

// Rate limiter for sensitive authentication endpoints (IP-based sliding window)
interface AttemptRecord {
  count: number;
  resetAt: number;
}
const authAttempts = new Map<string, AttemptRecord>();
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILED_ATTEMPTS = 5;

export function checkAuthRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = authAttempts.get(ip);

  if (record && record.resetAt > now && record.count >= MAX_FAILED_ATTEMPTS) {
    const waitMinutes = Math.ceil((record.resetAt - now) / 60000);
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `安全防护：连续尝试失败次数过多，请在 ${waitMinutes} 分钟后再试`,
      },
    });
    return;
  }
  next();
}

export function recordFailedAuthAttempt(req: Request) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = authAttempts.get(ip);
  if (!record || record.resetAt <= now) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  } else {
    record.count += 1;
  }
}

export function clearAuthRateLimit(req: Request) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  authAttempts.delete(ip);
}

// Middleware: Extract & strictly validate Bearer token or session
export function authenticateOptional(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const result = authService.validateSession(token);
      if (result.isValid && result.user) {
        (req as any).user = result.user;
      }
    }
  }
  next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '缺少主理人认证凭证' } });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '认证凭证不能为空' } });
    return;
  }

  const result = authService.validateSession(token);
  if (!result.isValid || !result.user || result.user.role !== 'owner') {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '无效或已过期的主理人凭证，请重新登录' } });
    return;
  }

  (req as any).user = result.user;
  next();
}

// ---------------- AUTH ROUTES ----------------
apiRouter.get('/auth/status', (req, res) => {
  res.json({
    data: {
      isInitialized: authService.isInitialized(),
    },
  });
});

apiRouter.post('/auth/init', checkAuthRateLimit, (req, res) => {
  if (authService.isInitialized()) {
    recordFailedAuthAttempt(req);
    res.status(403).json({ error: { code: 'ALREADY_INITIALIZED', message: '系统主理人账号已初始化，禁止重复执行' } });
    return;
  }

  const { username, password, email } = req.body || {};
  if (!password || typeof password !== 'string' || password.length < 6) {
    recordFailedAuthAttempt(req);
    res.status(400).json({ error: { code: 'INVALID_PASSWORD', message: '主理人访问密钥最低要求 6 位' } });
    return;
  }

  const result = authService.initializeOwner({ username, password, email });
  if (!result.success) {
    recordFailedAuthAttempt(req);
    res.status(400).json({ error: { code: 'INIT_FAILED', message: result.message || '初始化失败' } });
    return;
  }

  clearAuthRateLimit(req);
  res.status(201).json({
    data: {
      user: result.user,
      token: result.token,
      recoveryCode: result.recoveryCode,
      message: '主理人账号初始化成功，请妥善保存应急恢复密钥！',
    },
  });
});

apiRouter.post('/auth/login', checkAuthRateLimit, (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    recordFailedAuthAttempt(req);
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '请输入主理人访问密钥' } });
    return;
  }

  const result = authService.verifyOwner(password);
  if (!result.success) {
    recordFailedAuthAttempt(req);
    res.status(401).json({ error: { code: 'AUTH_FAILED', message: result.message || '密码错误，认证失败' } });
    return;
  }

  clearAuthRateLimit(req);
  res.json({
    data: {
      user: result.user,
      token: result.token,
    },
    meta: { timestamp: new Date().toISOString() },
  });
});

apiRouter.get('/auth/me', authenticateOptional, (req, res) => {
  const user = (req as any).user;
  if (!user) {
    res.json({ data: { user: null, isOwner: false } });
    return;
  }
  res.json({ data: { user, isOwner: user.role === 'owner' } });
});

apiRouter.post('/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    authService.logout(authHeader.slice(7).trim());
  }
  res.json({ data: { success: true } });
});

apiRouter.post('/auth/change-password', requireOwner, (req, res) => {
  const user = (req as any).user;
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: { code: 'INVALID_PASSWORD', message: '新密码最低长度要求 6 位' } });
    return;
  }
  const ok = authService.updateOwnerPassword(user.id, newPassword);
  res.json({ data: { success: ok } });
});

// Reset Password API (supports verified old password or one-time recovery key)
apiRouter.post('/auth/reset-password', checkAuthRateLimit, (req, res) => {
  const { username, oldPassword, recoveryCode, newPassword } = req.body || {};

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    recordFailedAuthAttempt(req);
    res.status(400).json({ error: { code: 'INVALID_PASSWORD', message: '新密码最低长度要求 6 位' } });
    return;
  }

  const result = authService.resetPassword({
    username,
    oldPassword,
    recoveryCode,
    newPassword,
  });

  if (!result.success) {
    recordFailedAuthAttempt(req);
    res.status(400).json({ error: { code: 'RESET_FAILED', message: result.message } });
    return;
  }

  clearAuthRateLimit(req);
  res.json({
    data: {
      success: true,
      message: result.message,
      newRecoveryCode: result.newRecoveryCode,
    },
  });
});

// Profile management routes (Owner Only)
apiRouter.get('/users/profile', requireOwner, (req, res) => {
  const profile = authService.getOwnerProfile();
  res.json({ data: profile });
});

// Safe public author endpoint for visitors (no private email or account IDs)
apiRouter.get('/users/public-author', (req, res) => {
  const profile = authService.getOwnerProfile();
  res.json({
    data: {
      author: {
        username: profile?.username || 'Hecker',
        role: 'owner',
      },
    },
  });
});


apiRouter.put('/users/profile', requireOwner, (req, res) => {
  const { username, email } = req.body || {};
  const ok = authService.updateOwnerProfile({ username, email });
  if (!ok) {
    res.status(400).json({ error: { code: 'UPDATE_FAILED', message: '更新用户信息失败' } });
    return;
  }
  res.json({ data: { success: true, profile: authService.getOwnerProfile() } });
});




// ---------------- DOCUMENTS ROUTES ----------------
apiRouter.get('/documents', authenticateOptional, async (req, res) => {
  const user = (req as any).user;
  const isOwner = user?.role === 'owner';
  const { visibility, category, tag, search, page, pageSize } = req.query as any;

  const result = await documentService.listDocuments({
    isOwner,
    visibility,
    category,
    tag,
    search,
    page: page ? parseInt(page) : 1,
    pageSize: pageSize ? parseInt(pageSize) : 50,
  });

  res.json({ data: result.docs, meta: result.meta });
});

apiRouter.get('/documents/:id', authenticateOptional, async (req, res) => {
  const user = (req as any).user;
  const isOwner = user?.role === 'owner';
  const doc = await documentService.getDocumentById(req.params.id, isOwner);

  if (!doc) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '文章不存在或您无权查看' } });
    return;
  }

  res.json({ data: doc });
});

apiRouter.post('/documents', requireOwner, async (req, res) => {
  const user = (req as any).user;
  const saved = await documentService.saveDocument(req.body, user.id, req.body.note);
  res.status(201).json({ data: saved });
});

apiRouter.put('/documents/:id', requireOwner, async (req, res) => {
  const user = (req as any).user;
  const input = { ...req.body, id: req.params.id };
  const saved = await documentService.saveDocument(input, user.id, req.body.note);
  res.json({ data: saved });
});

apiRouter.delete('/documents/:id', requireOwner, async (req, res) => {
  await documentService.deleteDocument(req.params.id);
  res.json({ data: { success: true } });
});

// ---------------- REVISIONS & SNAPSHOTS ROUTES ----------------
apiRouter.get('/documents/:id/revisions', authenticateOptional, async (req, res) => {
  const user = (req as any).user;
  const isOwner = user?.role === 'owner';
  const doc = await documentService.getDocumentById(req.params.id, isOwner);
  if (!doc) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '文档不存在或您无权查看其历史版本' } });
    return;
  }
  const revisions = documentService.listRevisions(req.params.id);
  res.json({ data: revisions });
});


apiRouter.get('/documents/:id/revisions/:revId', requireOwner, async (req, res) => {
  const snapshot = await documentService.getRevisionSnapshot(req.params.id, req.params.revId);
  if (!snapshot) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '版本快照不存在' } });
    return;
  }
  res.json({ data: snapshot });
});

apiRouter.post('/documents/:id/revisions/:revId/rollback', requireOwner, async (req, res) => {
  const user = (req as any).user;
  try {
    const rolledBack = await documentService.rollbackRevision(req.params.id, req.params.revId, user.id);
    res.json({ data: rolledBack });
  } catch (err: any) {
    res.status(400).json({ error: { code: 'ROLLBACK_FAILED', message: err?.message || '回滚版本失败' } });
  }
});

// Full revision disk overview
apiRouter.get('/revisions/overview', requireOwner, async (req, res) => {
  try {
    const overview = await documentService.getRevisionsOverview();
    res.json({ data: overview });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'REVISIONS_OVERVIEW_ERROR', message: err?.message || '读取版本快照概览失败' } });
  }
});

// Clean revisions: global or per-document
apiRouter.post('/revisions/cleanup', requireOwner, async (req, res) => {
  const { documentId, keepLatest, all } = req.body || {};
  try {
    const result = await documentService.cleanRevisions({
      documentId,
      keepLatest: typeof keepLatest === 'number' ? keepLatest : undefined,
      all: Boolean(all),
    });
    res.json({ data: result });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'REVISIONS_CLEANUP_ERROR', message: err?.message || '清理历史快照失败' } });
  }
});

// Delete all revisions for a single document
apiRouter.delete('/revisions/:docId', requireOwner, async (req, res) => {
  try {
    const result = await documentService.cleanRevisions({
      documentId: req.params.docId,
      all: true,
    });
    res.json({ data: result });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'REVISION_DELETE_ERROR', message: err?.message || '删除文档快照失败' } });
  }
});

// Delete a single revision snapshot file
apiRouter.delete('/revisions/:docId/:revId', requireOwner, async (req, res) => {
  try {
    const deleted = await documentService.deleteSingleRevision(req.params.docId, req.params.revId);
    res.json({ data: { success: deleted } });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'REVISION_DELETE_ERROR', message: err?.message || '删除单个快照失败' } });
  }
});

// ---------------- ASSETS & MEDIA STORAGE ROUTES ----------------
apiRouter.post('/assets/upload', requireOwner, async (req, res) => {
  const user = (req as any).user;
  const { filename, mimeType, base64 } = req.body || {};

  if (!filename || !base64) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '缺少文件名或文件内容' } });
    return;
  }

  try {
    // Strip possible data URL prefix: e.g. "data:image/png;base64,..."
    const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    const asset = await assetService.uploadAsset({
      originalName: filename,
      mimeType: mimeType || 'application/octet-stream',
      buffer,
      ownerId: user.id,
    });

    res.status(201).json({ data: asset });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'UPLOAD_FAILED', message: err?.message || '附件存储失败' } });
  }
});

apiRouter.get('/assets', requireOwner, (req, res) => {
  const assets = assetService.listAssets();
  res.json({ data: assets });
});

apiRouter.get('/assets/file/:id', authenticateOptional, async (req, res) => {
  const asset = await assetService.getAsset(req.params.id);
  if (!asset) {
    res.status(404).send('Asset not found');
    return;
  }

  const user = (req as any).user;
  const isOwner = user?.role === 'owner';

  // Permission check: if anonymous or non-owner, check if asset is referenced in any public published document
  if (!isOwner) {
    const db = getDatabase();
    const publicDocs = db.prepare(`
      SELECT id, file_path FROM documents
      WHERE visibility = 'public' AND status = 'published'
    `).all() as any[];

    let isPublic = false;
    const assetId = asset.record.id;
    const assetFilename = asset.record.filename;

    for (const doc of publicDocs) {
      const md = await fileStorage.readDocumentMarkdown(doc.id);
      if (
        md &&
        (md.includes(assetId) ||
          md.includes(`/assets/file/${assetId}`) ||
          md.includes(assetFilename))
      ) {
        isPublic = true;
        break;
      }
    }

    if (!isPublic) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '私有附件或尚未公开的媒体资源，禁止匿名访问' } });
      return;
    }
  }

  // Security Headers: prevent MIME sniffing & execute risks for SVG / HTML
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const mime = (asset.record.mime_type || '').toLowerCase();
  const isSvg = mime.includes('svg');
  const isExecutableOrHtml =
    mime.includes('html') ||
    mime.includes('javascript') ||
    mime.includes('ecmascript') ||
    mime.includes('x-sh');

  if (isExecutableOrHtml) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(asset.record.filename || 'asset')}"`
    );
  } else if (isSvg) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  } else {
    res.setHeader('Content-Type', asset.record.mime_type || 'application/octet-stream');
  }

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(asset.buffer);
});


apiRouter.delete('/assets/:id', requireOwner, async (req, res) => {
  const ok = await assetService.deleteAsset(req.params.id);
  res.json({ data: { success: ok } });
});

apiRouter.post('/assets/cleanup-orphans', requireOwner, async (req, res) => {
  try {
    const result = await assetService.cleanupUnreferencedAssets();
    res.json({
      data: {
        success: true,
        cleanedCount: result.cleanedCount,
        freedBytes: result.freedBytes,
        message: `成功清理 ${result.cleanedCount} 个未引用的孤立附件，释放 ${(result.freedBytes / 1024).toFixed(1)} KB 空间`,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'CLEANUP_FAILED', message: err?.message || '清理未引用附件失败' } });
  }
});

// ---------------- CATEGORIES & TAGS ROUTES ----------------
apiRouter.get('/categories', (req, res) => {
  const db = getDatabase();
  const rows = db.prepare('SELECT id, name, slug, description, sort_order FROM categories ORDER BY sort_order ASC, name ASC').all();
  res.json({ data: rows });
});

apiRouter.post('/categories', requireOwner, (req, res) => {
  const user = (req as any).user;
  const { name, description, slug } = req.body;
  if (!name?.trim()) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '分类名称不能为空' } });
    return;
  }
  const db = getDatabase();
  const id = generateId('cat');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO categories (id, owner_id, name, slug, description, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, user.id, name.trim(), slug || name.trim().toLowerCase(), description || '', now, now);

  res.status(201).json({ data: { id, name: name.trim() } });
});

apiRouter.delete('/categories/:id', requireOwner, (req, res) => {
  const db = getDatabase();
  const idOrName = req.params.id;
  const cat = db.prepare('SELECT id, name FROM categories WHERE id = ? OR name = ?').get(idOrName, idOrName) as any;
  if (cat) {
    db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
    db.prepare("UPDATE documents SET category_name = '未分类' WHERE category_name = ?").run(cat.name);
  } else {
    db.prepare('DELETE FROM categories WHERE id = ?').run(idOrName);
  }
  res.json({ data: { success: true } });
});

apiRouter.get('/tags', (req, res) => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT t.name, COUNT(dt.document_id) as count
    FROM tags t
    LEFT JOIN document_tags dt ON dt.tag_id = t.id
    GROUP BY t.id, t.name
    ORDER BY count DESC, t.name ASC
  `).all();
  res.json({ data: rows });
});

apiRouter.delete('/tags/:name', requireOwner, async (req, res) => {
  const tagName = decodeURIComponent(req.params.name).trim();
  const db = getDatabase();

  const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as any;
  if (tagRow) {
    db.prepare('DELETE FROM document_tags WHERE tag_id = ?').run(tagRow.id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(tagRow.id);
  }

  // Also remove tag from physical markdown files in storage/documents/
  try {
    const docIds = await fileStorage.listAllDiskDocumentIds();
    for (const docId of docIds) {
      const raw = await fileStorage.readDocumentMarkdown(docId);
      if (raw) {
        const { frontmatter, body } = parseFrontmatter(raw);
        if (Array.isArray(frontmatter.tags) && frontmatter.tags.includes(tagName)) {
          frontmatter.tags = frontmatter.tags.filter((t: string) => t !== tagName);
          const newMarkdown = [
            buildFrontmatterBlock(frontmatter as any),
            '',
            body.trimStart(),
          ].join('\n');
          await fileStorage.saveDocumentMarkdown(docId, newMarkdown);
        }
      }
    }
  } catch (err) {
    console.error('[Delete Tag Sync Error]:', err);
  }

  res.json({ data: { success: true } });
});

// ---------------- SEARCH ROUTE ----------------
apiRouter.get('/search', authenticateOptional, (req, res) => {
  const user = (req as any).user;
  const isOwner = user?.role === 'owner';
  const { q, category, limit } = req.query as any;

  if (!q || !q.trim()) {
    res.json({ data: [] });
    return;
  }

  const results = searchService.search(q, {
    isOwner,
    category,
    limit: limit ? parseInt(limit) : 20,
  });

  res.json({ data: results });
});

// ---------------- SHARES ROUTES ----------------
apiRouter.post('/shares', requireOwner, (req, res) => {
  const user = (req as any).user;
  const { documentId, password, expiresInDays, maxViews } = req.body;
  if (!documentId) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '必须指定文档 ID' } });
    return;
  }

  const { shareId, rawToken } = shareService.createShare(
    { documentId, password, expiresInDays, maxViews },
    user.id
  );

  res.status(201).json({ data: { shareId, token: rawToken } });
});

apiRouter.post('/shares/access', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '缺少分享凭证' } });
    return;
  }

  const result = await shareService.accessShare(token, password);
  if (!result.allowed) {
    res.status(403).json({ error: { code: result.reason, message: result.message } });
    return;
  }

  res.json({ data: { doc: result.doc, share: result.shareInfo } });
});

apiRouter.delete('/shares/:id', requireOwner, (req, res) => {
  shareService.revokeShare(req.params.id);
  res.json({ data: { success: true } });
});

// ---------------- SYSTEM & DISASTER RECOVERY ROUTES ----------------
apiRouter.post('/system/rebuild-index', requireOwner, async (req, res) => {
  const user = (req as any).user;
  const result = await documentService.rebuildIndexFromDisk(user.id);
  res.json({ data: { success: true, message: `已从磁盘 Markdown 目录全量重建 ${result.restoredCount} 篇文档及搜索索引` } });
});

apiRouter.get('/system/stats', authenticateOptional, (req, res) => {
  const db = getDatabase();
  const totalDocs = (db.prepare('SELECT COUNT(*) as c FROM documents').get() as any)?.c || 0;
  const totalTags = (db.prepare('SELECT COUNT(*) as c FROM tags').get() as any)?.c || 0;
  const totalCategories = (db.prepare('SELECT COUNT(*) as c FROM categories').get() as any)?.c || 0;
  const totalRevisions = (db.prepare('SELECT COUNT(*) as c FROM document_revisions').get() as any)?.c || 0;

  res.json({
    data: {
      storageModel: 'Local-First Physical Markdown + Native SQLite WAL',
      totalDocs,
      totalTags,
      totalCategories,
      totalRevisions,
    },
  });
});
