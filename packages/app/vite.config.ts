import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  // Relative paths: the built app works at any path.
  base: './',
  plugins: [react(), nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'util', 'events', 'process'] })],
  resolve: {
    alias: {
      '@deployments': resolve(__dirname, '../../deployments'),
      '@sba/circuits/result': resolve(__dirname, '../circuits/src/result.ts'),
      '@sba/circuits/poseidon': resolve(__dirname, '../circuits/src/poseidon.ts'),
    },
  },
  // The Fuin node (pnpm fuin) serves the live API; the hosted build has none and says so.
  server: { port: 5180, strictPort: true, fs: { allow: [resolve(__dirname, '../..')] }, proxy: { '/api': 'http://127.0.0.1:5179' } },
  preview: { port: 5180, strictPort: true, proxy: { '/api': 'http://127.0.0.1:5179' } },
});
