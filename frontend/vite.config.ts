import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const apiTarget = process.env.GHOSTGRID_API ?? 'http://127.0.0.1:8787';
// The cascade engine is pure TypeScript owned by the backend; the browser imports the very same files.
const engine = fileURLToPath(new URL('../backend/engine', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@engine': engine, '@shared': fileURLToPath(new URL('../backend/shared', import.meta.url)) } },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
