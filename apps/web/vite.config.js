import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// True multi-page build: every page is its own HTML entry with its own
// module graph. Vite dedupes the shared @watcher/ui chunk automatically.
const pages = ['index', 'login', 'devices', 'device', 'alerts', 'topology', 'reports', 'settings', 'ack'];

export default defineConfig({
  build: {
    target: 'es2022', // pages use top-level await
    rollupOptions: {
      input: Object.fromEntries(
        pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)]),
      ),
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
