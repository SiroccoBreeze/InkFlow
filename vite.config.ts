import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(() => {
  const isHmrDisabled = process.env.DISABLE_HMR === 'true';

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: !isHmrDisabled,
      watch: isHmrDisabled
        ? null
        : {
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
  };
});

