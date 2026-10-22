import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  // Relative asset and fetch paths, so the built saleroom works at any path (GitHub Pages serves it at /<repo>/saleroom/).
  base: './',
  plugins: [react(), nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'util', 'events', 'process'] })],
  resolve: {
    alias: {
      '@deployments': resolve(__dirname, '../../deployments'),
      // The same result check the audit and MCP use, from source (browser-safe modules only).
      '@sba/circuits/result': resolve(__dirname, '../circuits/src/result.ts'),
      '@sba/circuits/poseidon': resolve(__dirname, '../circuits/src/poseidon.ts'),
    },
  },
  server: { port: 5178, strictPort: true, fs: { allow: [resolve(__dirname, '../..')] } },
});
