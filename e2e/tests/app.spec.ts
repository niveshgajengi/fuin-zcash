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

test('floor: headline, featured gallery, totals from the records, read-only chip', async ({ page }, info) => {
  await page.goto(APP);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('only the winner is opened.');
  await expect(page.locator('.block-chip')).toContainText('read-only');
  await expect(page.locator('.gallery .g-item')).toHaveCount(Math.min(4, records.length));
  await expect(page.locator('.stats3 div').first().locator('b')).toHaveText(String(records.length));
  await expect(page.locator('.grid .lot-card')).toHaveCount(records.length);
  await page.locator('.filters button', { hasText: 'live' }).click();
  await expect(page.getByText('no live lots on this page')).toBeVisible();
  if (isMobile(info.project.name)) await expect(page.locator('.tabbar')).toBeVisible();
  await noHorizontalScroll(page);
});

test('lot 005: the opened winning bid, sealed losers, and the proof checked in this tab', async ({ page }) => {
  await page.goto(`${APP}#/lot/005`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sale5.lot.title.toLowerCase());
  await expect(page.locator('.auction-card .ac-result b')).toHaveText(`${taz(sale5.outcome.winningBidZat)} TAZ`);
  const checks = page.locator('.proof li');
  await expect(checks).toHaveCount(4);
  await expect(page.locator('.proof li.ps-ok')).toHaveCount(4, { timeout: 30_000 });
  await page.getByRole('button', { name: 'try to claim 1 zat more' }).click();
  await expect(page.locator('.proof li.ps-bad')).toContainText('Groth16 proof verifies');
  await page.getByRole('button', { name: 'restore the published result' }).click();
  await expect(page.locator('.proof li.ps-ok')).toHaveCount(4, { timeout: 30_000 });
  await page.getByRole('tab', { name: /sealed bids/ }).click();
  await expect(page.locator('.tr.won')).toHaveCount(1);
  await expect(page.locator('.tr .sealed-bar')).toHaveCount(sale5.deposits.filter((d: { status: string }) => d.status === 'valid').length - 1);
  await noHorizontalScroll(page);
});

test('lot 004: no sale, unrevealed deposits forfeited, nothing to prove', async ({ page }) => {
  await page.goto(`${APP}#/lot/004`);
  await expect(page.locator('.auction-card .ac-result b')).toHaveText('no sale');
  await expect(page.locator('.hammer')).toContainText('forfeited to the seller');
  await expect(page.locator('.proof li')).toHaveText(/nothing to prove/);
});

test('every wallet action says Setup required without a node', async ({ page }) => {
  await page.goto(APP);
  await page.getByRole('button', { name: /list a lot/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Setup required');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.goto(`${APP}#/seals`);
  await expect(page.getByRole('alert')).toContainText('Setup required');
  await noHorizontalScroll(page);
});
