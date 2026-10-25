import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
// A separate env directory prevents reading the developer's .env files.
export default {
  root: fileURLToPath(new URL('../../apps/web', import.meta.url)),
  envDir: fileURLToPath(new URL('./empty-env', import.meta.url)),
  plugins: [react(), {
    name: 'tripbeam-fixture-label',
    transformIndexHtml() {
      return [{ tag: 'div', attrs: { 'data-e2e-fixture': 'true', style: 'padding:8px 16px;background:#fff0cb;color:#704914;text-align:center;font:600 12px/1.5 system-ui,sans-serif;position:relative;z-index:1000;' }, children: '离线验收演示 · 地点与路线为测试数据，不可用于出行', injectTo: 'body-prepend' }];
    },
  }],
  define: {
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://127.0.0.1:3102'),
    'import.meta.env.VITE_MAP_TILE_URL': JSON.stringify(''),
  },
  server: { host: '127.0.0.1', port: 4174, strictPort: true },
};
