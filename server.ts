import express from 'express';
import path from 'path';
import cluster from 'node:cluster';
import { fileURLToPath } from 'url';
import { apiRouter } from './server/routes/api';
import { ensureInitialPhysicalDocs, ensureAssetReferences } from './server/services/seedData';
import { documentService } from './server/services/documentService';
import { assetService } from './server/services/assetService';
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

  // Non-fatal storage maintenance. Save/delete operations still run their own
  // recovery guard if a document could not be reconciled here.
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

    // Finish attachment deletions whose DB rows committed but whose file unlink
    // failed. This must run before reconciliation/seed/asset-reference rebuild so
    // a tombstoned file can never be re-registered.
    const assetDeletions = await assetService.recoverPendingAssetDeletions();
    if (assetDeletions.recovered > 0) {
      console.log(
        `[InkFlow Asset Recovery] Completed ${assetDeletions.recovered} pending attachment deletion(s).`
      );
    }

    await ensureInitialPhysicalDocs();

    // Reconcile the asset ↔ document association table with the Markdown SSOT
    // BEFORE accepting requests. This is a multi-document DB write guarded by the
    // exclusive consistency lease; running it after listen() let online saves race
    // with the rebuild and made a backup snapshot non-deterministic.
    await ensureAssetReferences();
  } catch (err) {
    console.error('[Storage Init Error]:', err);
  }

  // Mount API Router under /api/v1
  app.use('/api/v1', apiRouter);

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'InkFlow Knowledge Hub Full-Stack API',
      timestamp: new Date().toISOString(),
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
