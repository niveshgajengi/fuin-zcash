// The Fuin app at the site root, as hosted: no Fuin node, so it is read-only over the published
// records in ../deployments. Every number checked here is read from those records.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, isMobile, noHorizontalScroll, root, test } from './fixtures';
import { APP } from './urls';

const records = readdirSync(resolve(root, 'deployments'))
  .filter((f) => /^testnet(-reveal|-sale\d{3})?\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(resolve(root, 'deployments', f), 'utf8')))
  .filter((r) => r.settlement);
const sale5 = JSON.parse(readFileSync(resolve(root, 'deployments/testnet-sale005.json'), 'utf8'));
const taz = (z: string) => (Number(z) / 1e8).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 6 });

test.beforeEach(async ({ health }) => {
  // Without a node, the app's one probe of /api/health is answered 404 by the static host.
  health.allowSameOrigin404('/api/health');
});

test('home: the latest lot on its stage, the phases, every auction in the table, read-only', async ({ page }, info) => {
  await page.goto(APP);
  const latest = records.reduce((a, r) => (Number(a.auction.openHeight) > Number(r.auction.openHeight) ? a : r));
  await expect(page.locator('.stage h1')).toHaveText((latest.lot?.title ?? '').toLowerCase());
  await expect(page.locator('.block-chip')).toContainText('read-only');
  await expect(page.locator('.phases li')).toHaveCount(3);
  await expect(page.locator('.atable .at-row:not(.at-head)')).toHaveCount(records.length);
  await expect(page.locator('.why-card')).toHaveCount(3);
  if (isMobile(info.project.name)) await expect(page.locator('.tabbar')).toBeVisible();
  await noHorizontalScroll(page);
});

test('lot 005: the opened winning bid, sealed losers, and the proof checked in this tab', async ({ page }) => {
  await page.goto(`${APP}#/lot/005`);
  await expect(page.locator('.stage h1')).toHaveText(sale5.lot.title.toLowerCase());
  await expect(page.locator('.stage .duo b.gold')).toHaveText(`${taz(sale5.outcome.winningBidZat)} TAZ`);
  await expect(page.locator('.proof li.ps-ok')).toHaveCount(4, { timeout: 30_000 });
  await page.getByRole('button', { name: 'try to claim 1 zat more' }).click();
  await expect(page.locator('.proof li.ps-bad')).toContainText('Groth16 proof verifies');
  await page.getByRole('button', { name: 'restore the published result' }).click();
  await expect(page.locator('.proof li.ps-ok')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.locator('.hist4 li.won')).toHaveCount(1);
  await expect(page.locator('.hist4 .sealed-bar')).toHaveCount(sale5.deposits.filter((d: { status: string }) => d.status === 'valid').length - 1);
  await noHorizontalScroll(page);
});

test('lot 004: no sale, unrevealed deposits forfeited, nothing to prove', async ({ page }) => {
  await page.goto(`${APP}#/lot/004`);
  await expect(page.locator('.stage .duo b').first()).toHaveText('no sale');
  await expect(page.locator('.hammer')).toContainText('forfeited to the seller');
  await expect(page.locator('.proof li')).toHaveText(/nothing to prove/);
});

test('every wallet action says Setup required without a node', async ({ page }) => {
  await page.goto(APP);
  await page.getByRole('button', { name: /list a lot/ }).last().click();
  await expect(page.getByRole('dialog')).toContainText('Setup required');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.goto(`${APP}#/seals`);
  await expect(page.getByRole('alert')).toContainText('Setup required');
  await noHorizontalScroll(page);
});
