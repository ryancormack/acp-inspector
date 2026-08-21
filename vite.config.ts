import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const uiRoot = fileURLToPath(new URL('./src/ui', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/ui', import.meta.url));

export default defineConfig({
  root: uiRoot,
  base: './',
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // `pnpm dev:ui` serves the UI with HMR and forwards the control socket
    // to a separately-running `acp-debugger` process on 6274.
    host: '127.0.0.1',
    port: 6275,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:6274', ws: true },
    },
  },
});
