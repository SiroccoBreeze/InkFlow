import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRouter } from './server/routes/api';
import { ensureInitialPhysicalDocs, ensureAssetReferences } from './server/services/seedData';
import { documentService } from './server/services/documentService';
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

  // Ensure storage directories & initial physical markdown files
  try {
    getDatabase();
    // Reconcile any save that was interrupted between the Markdown rename and the
    // SQLite commit before seeding/rebuilding anything from disk.
    const recovered = await documentService.recoverPendingSaves();
    if (recovered > 0) {
      console.log(`[InkFlow Save Recovery] Recovered ${recovered} interrupted document save(s).`);
    }
    await ensureInitialPhysicalDocs();
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

  // Reconcile the asset ↔ document association table with the Markdown SSOT (non-blocking).
  ensureAssetReferences().catch(err => console.error('[Asset Ref Sync Error]:', err));

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🚀 InkFlow Knowledge Hub running on http://0.0.0.0:${PORT}`);
    console.log(`📁 Physical Markdown SSOT: storage/documents/`);
    console.log(`🗄️ Native SQLite WAL Database: storage/database/knowledge_hub.sqlite`);
    console.log(`🔌 API Base Endpoint: http://0.0.0.0:${PORT}/api/v1`);
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
