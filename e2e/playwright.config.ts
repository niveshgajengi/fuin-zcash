import { defineConfig } from '@playwright/test';

// Real Google Chrome (channel: 'chrome'; install Google Chrome first) against the stack from
// ./stack.sh: the site as hosted, the static landing at / and the built saleroom at /saleroom/. Both
// read the published testnet records in ../deployments; nothing is mocked. The fault-injection tests
// (verification key unavailable / altered) say so in their names.
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    channel: 'chrome',
    headless: true,
    video: 'on',
    trace: 'on',
    screenshot: 'on',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
});
