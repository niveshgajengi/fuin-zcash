import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'util', 'events', 'process'] })],
  resolve: { alias: { '@deployments': resolve(__dirname, '../../deployments') } },
  server: { port: 5178, strictPort: true, fs: { allow: [resolve(__dirname, '../..')] } },
});
