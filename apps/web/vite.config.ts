import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const basePath = (process.env.VITE_BASE_PATH ?? '/').replace(/\/?$/, '/');

export default defineConfig({
  base: basePath,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
});
