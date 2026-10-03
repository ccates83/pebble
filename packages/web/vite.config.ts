import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In dev, Vite serves the UI on 5173 and proxies /api to a `pebble serve`
 * running on 7777. In production the API server serves these built files
 * itself, so there is no proxy and no second origin.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.PEBBLE_API ?? 'http://127.0.0.1:7777',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 700,
  },
});
