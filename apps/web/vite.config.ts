import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The dashboard is private: dev + preview servers bind to loopback only (never 0.0.0.0).
// In dev, /api and /apks are proxied to the Fastify dashboard listener on 127.0.0.1:3000. The proxy keeps the
// browser's Host/Origin (127.0.0.1:5173), which the server's allowlist accepts in non-production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000', '/apks': 'http://127.0.0.1:3000' },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: 'dist' },
});
