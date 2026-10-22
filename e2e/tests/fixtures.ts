import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';

import { LANDING, SALEROOM } from './urls';

export { LANDING, SALEROOM, VK_PATH } from './urls';
export const root = resolve(import.meta.dirname, '../..');
export const sale1 = JSON.parse(readFileSync(resolve(root, 'deployments/testnet.json'), 'utf8'));
export const sale2 = JSON.parse(readFileSync(resolve(root, 'deployments/testnet-reveal.json'), 'utf8'));
export const sale3 = JSON.parse(readFileSync(resolve(root, 'deployments/testnet-sale003.json'), 'utf8'));
export const EXPLORER = 'https://testnet.zcashexplorer.app/transactions/';
export const REPO = 'https://github.com/nickthelegend/zec-sealed-bid-auction';
export const fmt = (n: number | string) => Number(n).toLocaleString('en-US');

type Health = { problems: string[]; allowSameOrigin404: (path: string) => void };

/** Every test fails on a console error, an uncaught exception, or a failed same-origin request. */
export const test = base.extend<{ health: Health }>({
  health: [
    async ({ page }, use) => {
      const problems: string[] = [];
      const allowed = new Set<string>();
      const origins = new Set([new URL(LANDING).origin, new URL(SALEROOM).origin]);
      const same = (u: string) => origins.has(new URL(u).origin);
      page.on('console', (m) => {
        if (m.type() === 'error' && !(allowed.size && m.text().includes('Failed to load resource'))) problems.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('requestfailed', (r) => {
        if (same(r.url()) && !allowed.has(new URL(r.url()).pathname)) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
      });
      page.on('response', (r) => {
        if (same(r.url()) && r.status() >= 400 && !allowed.has(new URL(r.url()).pathname)) problems.push(`HTTP ${r.status()}: ${r.url()}`);
      });
      await use({ problems, allowSameOrigin404: (p) => allowed.add(p) });
      expect(problems, 'console errors / failed same-origin requests').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `page is ${sw}px wide in a ${cw}px viewport`).toBeLessThanOrEqual(cw);
}

/** The element's top edge is inside the viewport (an anchor jump landed on it). */
export async function inView(page: Page, selector: string) {
  await expect
    .poll(async () => page.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= -2 && r.top < window.innerHeight - 40;
    }))
    .toBe(true);
}

export const isMobile = (name: string) => name === 'mobile';
