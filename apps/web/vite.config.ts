import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const devApiPort = process.env.API_PORT ?? '4000';
const previewApiPort = process.env.PLAYWRIGHT_API_PORT ?? devApiPort;
const webPort = Number(process.env.WEB_PORT ?? 5173);
const previewPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 4173);
const apiProxy = (port: string) => ({
  '/api': {
    target: `http://127.0.0.1:${port}`,
    changeOrigin: false
  }
});

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    proxy: apiProxy(devApiPort)
  },
  preview: {
    port: previewPort,
    proxy: apiProxy(previewApiPort)
  },
  build: {
    sourcemap: true
  }
});
