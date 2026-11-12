import express from 'express';
import path from 'path';
import cluster from 'node:cluster';
import { fileURLToPath } from 'url';
import { apiRouter } from './server/routes/api';
import { ensureInitialPhysicalDocs, ensureAssetReferences } from './server/services/seedData';
import { documentService } from './server/services/documentService';
import { assetService } from './server/services/assetService';
import { fileStorage } from './server/services/fileStorageService';
import { maintenanceState } from './server/services/maintenanceState';
import { getDatabase } from './server/db/sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadLocalEnv(): Promise<void> {
  // Load an optional .env from the working directory (release deployments).
  // The module is optional so the app also runs from plain environment variables.
  try {
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
  } catch {
    // dotenv unavailable — environment variables are used directly
  }
}

async function startServer() {
  await loadLocalEnv();

  // Document writing is single-instance by design (process-local per-document
  // lock + fixed-name backup/staging files). Refuse to silently operate when
  // started as a cluster worker against the same storage directory.
  if (cluster.isWorker) {
    console.error(
      '[InkFlow] 检测到 cluster worker。InkFlow 仅支持单进程写入同一 storage/ 目录，' +
        '多进程会破坏 Markdown 备份/恢复的互斥性，请以单实例方式部署。'
    );
    process.exit(1);
  }

  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.argv.includes('--production') ||
    process.argv.includes('--prod');

  // Only trust proxies we explicitly opt into; otherwise req.ip can be spoofed via X-Forwarded-For.
  const trustProxy = process.env.INKFLOW_TRUST_PROXY;
  if (trustProxy) {
    app.set('trust proxy', /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy);
  }

  // Body parsers
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // Basic hardening headers for the SPA
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Database schema migration is a hard prerequisite. Do not swallow failures:
  // starting without document_hash would make crash recovery unsafe. Throwing
  // here aborts startServer() before listen() (see the top-level catch).
  getDatabase();

  // Startup recovery is split into two classes:
  //
  //  CRITICAL — unfinished V1.1 document save/delete recovery. If this cannot be
  //  completed, the DB and Markdown may disagree; the server must NOT accept
  //  writes. We still listen so operators can read /api/health and inspect data.
  //
  //  NON-CRITICAL — attachment tombstone retry and derived-index maintenance.
  //  These are safe to degrade: they are retried later, and tombstoned assets
  //  cannot be resurrected by reconciliation.
  let criticalRecoveryError: unknown = null;
  try {
    // Finish committed deletions whose folder removal failed before any disk
    // rebuild/seed, so deleted documents cannot be re-imported.
    const deletedRecovered = await documentService.recoverPendingDeletions();
    if (deletedRecovered > 0) {
      console.log(`[InkFlow Delete Recovery] Completed ${deletedRecovered} pending deletion(s).`);
    }

    // Reconcile any save that was interrupted between the Markdown rename and the
    // SQLite commit before seeding/rebuilding anything from disk.
    const recovered = await documentService.recoverPendingSaves();
    if (recovered > 0) {
      console.log(`[InkFlow Save Recovery] Recovered ${recovered} interrupted document save(s).`);
    }

    // The recovery helpers log per-document failures instead of throwing. Scan
    // strictly for leftovers so a partial recovery is still treated as critical.
    const [pendingDeletions, pendingSaves] = await Promise.all([
      fileStorage.listPendingDeletionDocumentIds(),
      fileStorage.listPendingSaveDocumentIdsStrict(),
    ]);
    if (pendingDeletions.length > 0 || pendingSaves.length > 0) {
      throw new Error(
        `仍有未完成的文档恢复任务：待删除目录 [${pendingDeletions.join(', ')}]，` +
          `待恢复保存 [${pendingSaves.join(', ')}]`
      );
    }
  } catch (err) {
    criticalRecoveryError = err;
  }

  if (criticalRecoveryError) {
    maintenanceState.enterMaintenance('startup_recovery_failed');
    console.error(
      '[InkFlow Startup] 关键恢复失败，服务将以只读维护模式启动；所有写入请求将返回 503。' +
        '请在修复文件系统/数据后重启，期间不要执行写入操作。',
      criticalRecoveryError
    );
  } else {
    // Non-critical maintenance: failures degrade the service but do not block
    // writes, because the core data-recovery invariants still hold.
    try {
      // Finish attachment deletions whose DB rows committed but whose file unlink
      // failed. Must run before reconciliation/seed/asset-reference rebuild so a
      // tombstoned file can never be re-registered.
      const assetDeletions = await assetService.recoverPendingAssetDeletions();
      if (assetDeletions.recovered > 0) {
        console.log(
          `[InkFlow Asset Recovery] Completed ${assetDeletions.recovered} pending attachment deletion(s).`
        );
      }
      if (assetDeletions.failed > 0) {
        maintenanceState.addDegradedWarning(
          `附件删除恢复仍有 ${assetDeletions.failed} 项待重试（服务继续可用）`
        );
      }
    } catch (err) {
      console.error('[InkFlow Asset Recovery] 非关键恢复失败，服务继续运行（降级）:', err);
      maintenanceState.addDegradedWarning('附件删除恢复失败，tombstone 已保留等待重试');
    }

    try {
      await ensureInitialPhysicalDocs();
    } catch (err) {
      console.error('[InkFlow Storage] 初始化/重建索引失败，服务继续运行（降级）:', err);
      maintenanceState.addDegradedWarning('物理文档初始化/索引重建失败');
    }

    try {
      // Reconcile the asset ↔ document association table with the Markdown SSOT
      // BEFORE accepting requests. This is a multi-document DB write guarded by the
      // exclusive consistency lease; running it after listen() let online saves race
      // with the rebuild and made a backup snapshot non-deterministic.
      await ensureAssetReferences();
    } catch (err) {
      console.error('[InkFlow Storage] 附件引用重建失败，服务继续运行（降级）:', err);
      maintenanceState.addDegradedWarning('文档↔附件引用重建失败');
    }
  }

  // Server-side maintenance barrier. It does not rely on the UI: every non-read
  // HTTP request is rejected while critical recovery is unresolved.
  app.use('/api', (req, res, next) => {
    if (
      !maintenanceState.isWriteAllowed() &&
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      req.method !== 'OPTIONS'
    ) {
      const state = maintenanceState.snapshot();
      res.status(503).json({
        error: {
          code: 'MAINTENANCE_MODE',
          message: '服务处于只读维护模式：启动恢复尚未完成，写入操作已被拒绝',
          details: { reason: state.reason, since: state.since },
        },
      });
      return;
    }
    next();
  });

  // Mount API Router under /api/v1
  app.use('/api/v1', apiRouter);

  // Health check endpoint: HTTP status and body both distinguish the three states.
  app.get('/api/health', (_req, res) => {
    const state = maintenanceState.snapshot();
    res.status(state.status === 'maintenance' ? 503 : 200).json({
      status: state.status,
      service: 'InkFlow Knowledge Hub Full-Stack API',
      timestamp: new Date().toISOString(),
      maintenance: state,
    });
  });

  if (!isProd) {
    // Development mode: Mount Vite middleware
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port: PORT,
        watch: {
          ignored: [
            '**/storage/**',
            '**/storage/database/**',
            '**/storage/documents/**',
            '**/storage/assets/**',
            '**/storage/revisions/**',
            '**/*.sqlite*',
            '**/*.wal*',
            '**/*.shm*',
          ],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log(`[InkFlow Full-Stack] Mounted Vite dev middleware.`);
  } else {
    // Production mode: Serve built static assets from dist/
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath, { dotfiles: 'deny' }));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Reconcile the asset ↔ document association table with the Markdown SSOT.
  // (Done before listen() above; nothing to do here.)

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🚀 InkFlow Knowledge Hub running on http://0.0.0.0:${PORT}`);
    console.log(`📁 Physical Markdown SSOT: storage/documents/`);
    console.log(`🗄️ Native SQLite WAL Database: storage/database/knowledge_hub.sqlite`);
    console.log(`🔌 API Base Endpoint: http://0.0.0.0:${PORT}/api/v1`);
    console.log(`🔒 Document write mode: single instance (no cluster workers)`);
    if (maintenanceState.isMaintenance()) {
      console.log(`🛑 MAINTENANCE MODE (read-only): startup recovery failed — writes return 503.`);
    } else if (maintenanceState.snapshot().status === 'degraded') {
      console.log(`⚠️  DEGRADED: non-critical maintenance pending — see /api/health.`);
    }
    if (!process.env.INKFLOW_INIT_KEY) {
      console.log(`⚠️  INKFLOW_INIT_KEY is not set — first-run owner initialization is DISABLED.`);
    }
    console.log(`==================================================\n`);
  });
}

startServer().catch(err => {
  console.error('Failed to start InkFlow server:', err);
  process.exit(1);
});
