import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRouter } from './server/routes/api';
import { ensureInitialPhysicalDocs } from './server/services/seedData';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.argv.includes('--production') ||
    process.argv.includes('--prod');

  // Body parsers
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // Ensure storage directories & initial physical markdown files
  try {
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
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🚀 InkFlow Knowledge Hub running on http://0.0.0.0:${PORT}`);
    console.log(`📁 Physical Markdown SSOT: storage/documents/`);
    console.log(`🗄️ Native SQLite WAL Database: storage/database/knowledge_hub.sqlite`);
    console.log(`🔌 API Base Endpoint: http://0.0.0.0:${PORT}/api/v1`);
    console.log(`==================================================\n`);
  });
}

startServer().catch(err => {
  console.error('Failed to start InkFlow server:', err);
  process.exit(1);
});
