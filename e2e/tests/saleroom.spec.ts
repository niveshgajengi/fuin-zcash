import { createHash } from 'node:crypto';
import { EXPLORER, REPO, SALEROOM, expect, fmt, noHorizontalScroll, sale1, sale2, test } from './fixtures';
import type { Page } from '@playwright/test';

const valid = sale1.deposits.filter((d: { status: string }) => d.status === 'valid');
const winner = valid[sale1.outcome.winnerSlot];
const taz = (z: string | number) => `${(Number(z) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 6 })} TAZ`;
const utc = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);
const kindOf = (d: { txid: string; status: string }) => (d.txid === winner.txid ? 'opened' : d.status === 'valid' ? 'sealed' : 'refused');

const verify = (page: Page) => page.locator('section.verify');
const step = (page: Page, label: string) => verify(page).locator('.step', { hasText: label });
async function settled(page: Page, verdict: string) {
  await expect(verify(page).getByRole('heading')).toHaveText(verdict, { timeout: 30_000 });
  await expect(verify(page).getByRole('button', { name: 'Check the published result' })).toBeEnabled();
}

test.describe('saleroom', () => {
  test('sale header: hammer price, lede, timeline and live clock from the record; no horizontal scroll', async ({ page }, info) => {
    await page.goto(SALEROOM);
    await expect(page).toHaveTitle(/Fuin/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hammer price${taz(sale1.outcome.winningBidZat)}`);
    await expect(page.locator('.sale-meta code')).toHaveText(sale1.auction.name);
    await expect(page.locator('.sale-lede')).toContainText(`${valid.length} sealed bids, each an equal ${taz(sale1.auction.depositZat)}`);
    const tl = page.getByRole('list', { name: 'Auction timeline' }).locator('li');
    const bt = sale1.blockTimes;
    for (const [i, [label, b]] of ([['Open', bt.open], ['Close', bt.close], ['Hammer', bt.settlement]] as const).entries()) {
      await expect(tl.nth(i)).toContainText(label);
      await expect(tl.nth(i).locator('b')).toHaveText(fmt(b.height));
      await expect(tl.nth(i).locator('small')).toHaveText(`${utc(b.time)} UTC`);
    }
    await expect(tl.nth(3).locator('b')).toHaveText(taz(sale1.auction.reserveZat));
    const clock = page.getByRole('timer');
    const label = (await clock.getAttribute('aria-label'))!;
    expect(label).toMatch(/^\d+ days? \d+ hours? \d+ minutes? since the hammer$/);
    for (const [n, unit] of label.matchAll(/(\d+) (\w+)/g).map((x) => [Number(x[1]), x[2]] as const)) if (unit !== 'since') expect(unit.endsWith('s')).toBe(n !== 1);
    const read = async () => (await clock.locator('.digits > span').allTextContents()).map((t) => parseInt(t, 10));
    const [d, h, m, s] = await read();
    expect(Math.abs(d * 86400 + h * 3600 + m * 60 + s - (Math.floor(Date.now() / 1000) - bt.settlement.time))).toBeLessThanOrEqual(3);
    await expect.poll(async () => (await read()).join(':'), { timeout: 3000 }).not.toBe([d, h, m, s].join(':'));
    await settled(page, 'The result holds.');
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`saleroom-top-${info.project.name}.png`) });
  });

  test('verify in this tab: the record passes all four checks against the served verification key', async ({ page, request }, info) => {
    await page.goto(SALEROOM);
    await settled(page, 'The result holds.');
    const served = await (await request.get(SALEROOM + 'verification_key.json')).body();
    const sha = createHash('sha256').update(served).digest('hex');
    expect(sha).toBe(sale1.verificationKeySha256);
    await expect(verify(page).locator('.step-ok')).toHaveCount(4);
    await expect(step(page, 'Verification key is the published one')).toContainText(`sha256 ${sha.slice(0, 12)}… matches the record`);
    await expect(step(page, 'Groth16 proof verifies')).toContainText('pairing check passes in this tab (snarkjs)');
    await expect(step(page, 'Proof covers exactly the valid deposits')).toContainText(`slots 0-${valid.length - 1} are the ${valid.length} revealed valid deposits in chain order`);
    await expect(step(page, 'Winner is a real deposit')).toContainText(`slot ${sale1.outcome.winnerSlot} is deposit ${winner.txid.slice(0, 10)}`);
    await verify(page).screenshot({ path: info.outputPath(`saleroom-verify-ok-${info.project.name}.png`) });
  });

  test('tamper buttons: 1 zat more breaks the proof; a phantom bid breaks proof and slots; re-check restores', async ({ page }, info) => {
    await page.goto(SALEROOM);
    await settled(page, 'The result holds.');
    const v = verify(page);

    await v.getByRole('button', { name: 'Claim 1 zat more' }).click();
    await settled(page, 'The result does not hold.');
    await expect(v).toHaveClass(/is-bad/);
    await expect(v.locator('.verify-sub')).toHaveText('Tampered: the winning bid was raised by 1 zat.');
    await expect(step(page, 'Verification key is the published one')).toHaveClass(/step-ok/);
    await expect(step(page, 'Groth16 proof verifies')).toHaveClass(/step-bad/);
    await expect(step(page, 'Groth16 proof verifies')).toContainText('the proof does not verify for these public signals');
    await v.screenshot({ path: info.outputPath(`saleroom-tamper-bid-${info.project.name}.png`) });

    await v.getByRole('button', { name: 'Slip in a phantom bid' }).click();
    await settled(page, 'The result does not hold.');
    await expect(v.locator('.verify-sub')).toHaveText(`Tampered: slot ${valid.length}, which must be empty, now holds a commitment.`);
    await expect(step(page, 'Groth16 proof verifies')).toHaveClass(/step-bad/);
    await expect(step(page, 'Proof covers exactly the valid deposits')).toHaveClass(/step-bad/);
    await expect(step(page, 'Proof covers exactly the valid deposits')).toContainText(`slot ${valid.length}`);
    await v.screenshot({ path: info.outputPath(`saleroom-tamper-phantom-${info.project.name}.png`) });

    await v.getByRole('button', { name: 'Check the published result' }).click();
    // While the checks run, every action is disabled.
    await settled(page, 'The result holds.');
    await expect(v).toHaveClass(/is-ok/);
    await expect(v.locator('.step-ok')).toHaveCount(4);
  });

  test('lot filters: each chip shows exactly its lots and its count', async ({ page }, info) => {
    await page.goto(SALEROOM);
    const chips = page.getByRole('group', { name: 'Filter lots' });
    const lots = page.locator('ul.lots > li');
    const count = { all: sale1.deposits.length, sealed: 0, opened: 0, refused: 0 } as Record<string, number>;
    sale1.deposits.forEach((d: { txid: string; status: string }) => count[kindOf(d)]++);
    for (const [label, id] of [['Sealed', 'sealed'], ['Opened', 'opened'], ['Refused', 'refused'], ['All', 'all']]) {
      const chip = chips.getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
      await expect(chip).toHaveText(`${label} ${count[id]}`);
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      await expect(chips.locator('[aria-pressed=true]')).toHaveCount(1);
      await expect(lots).toHaveCount(count[id]);
      if (id !== 'all') await expect(page.locator(`ul.lots > li:not(.lot-${id})`)).toHaveCount(0);
      await page.locator('section[aria-labelledby=lots-title]').screenshot({ path: info.outputPath(`saleroom-filter-${id}-${info.project.name}.png`) });
    }
  });

  test('lot cards: chain order, explorer links, only the winner’s amount shown, refusal reasons', async ({ page }) => {
    await page.goto(SALEROOM);
    const lots = page.locator('ul.lots > li');
    await expect(lots).toHaveCount(sale1.deposits.length);
    for (const [i, d] of sale1.deposits.entries()) {
      const lot = lots.nth(i);
      await expect(lot.locator('.lot-top b')).toHaveText(`LOT ${String(i + 1).padStart(2, '0')}`);
      const a = lot.getByRole('link', { name: `Transaction ${d.txid} on the explorer` });
      await expect(a).toHaveAttribute('href', EXPLORER + d.txid);
      await expect(a).toHaveAttribute('target', '_blank');
      await expect(lot).toContainText(fmt(d.height));
      if (kindOf(d) === 'refused') await expect(lot.locator('.why')).toHaveText(d.reason);
    }
    await expect(page.locator('ul.lots')).toContainText(taz(sale1.outcome.winningBidZat));
    await expect(page.locator('ul.lots .plate-open')).toHaveCount(1);
  });

  test('provenance ledger: each recipient’s decrypted outputs match; settlement link', async ({ page }, info) => {
    await page.goto(SALEROOM);
    const sec = page.locator('section[aria-labelledby=prov-title]');
    await expect(sec.getByRole('link', { name: `${sale1.settlement.txid.slice(0, 8)}… ↗` })).toHaveAttribute('href', EXPLORER + sale1.settlement.txid);
    await expect(sec).toContainText(`block ${fmt(sale1.settlement.height)} (${utc(sale1.blockTimes.settlement.time)} UTC), ${sale1.settlement.outputs.length} outputs`);
    // The column header row is display:none below 640 px (each cell carries its own label there).
    const rows = sec.getByRole('table', { name: 'Settlement outputs by recipient' }).locator('.ledger-row:not(.ledger-head)');
    await expect(rows).toHaveCount(sale1.settlement.viewingKeyChecks.length);
    for (const c of sale1.settlement.viewingKeyChecks) {
      const row = rows.filter({ hasText: c.recipient });
      await expect(row.getByRole('cell').nth(1)).toHaveText(`${c.expected.split('+').map(fmt).join(' + ')} zat`);
      await expect(row.getByRole('cell').nth(2)).toHaveText(`${c.seen.map(fmt).join(' + ')} zat`);
      await expect(row.getByRole('cell').nth(3)).toHaveText(c.ok ? 'match' : 'mismatch');
    }
    await expect(sec).toContainText(`no transparent part: ${sale1.ironwoodOnly ? 'yes' : 'no'}`);
    await sec.screenshot({ path: info.outputPath(`saleroom-provenance-${info.project.name}.png`) });
  });

  test('Sale 002: every reveal note with its block, deposit and status; window, unrevealed and recipient checks', async ({ page }, info) => {
    await page.goto(SALEROOM);
    const sec = page.locator('section[aria-labelledby=sale2-title]');
    await expect(sec.getByRole('heading', { name: 'Bids opened by sealed memo' })).toBeVisible();
    await expect(sec.locator('.block-sub code')).toHaveText(sale2.auction.name);
    await expect(sec).toContainText(`Hammer price ${taz(sale2.outcome.winningBidZat)}`);
    await expect(sec.getByRole('link', { name: `${sale2.settlement.txid.slice(0, 8)}… ↗` })).toHaveAttribute('href', EXPLORER + sale2.settlement.txid);
    const rows = sec.getByRole('table', { name: 'Reveal notes on chain' }).locator('.reveal-row:not(.ledger-head)');
    await expect(rows).toHaveCount(sale2.reveals.length);
    const statusText: Record<string, string> = { accepted: 'accepted', wrong_commitment: 'wrong deposit', late: 'late' };
    for (const [i, v] of sale2.reveals.entries()) {
      const row = rows.nth(i);
      await expect(row.getByRole('cell').nth(0)).toHaveText(fmt(v.height));
      await expect(row.getByRole('link')).toHaveAttribute('href', EXPLORER + v.txid);
      if (v.label) await expect(row.getByRole('cell').nth(1)).toContainText(v.label);
      await expect(row.getByRole('cell').nth(2)).toHaveText(`${v.deposit.slice(0, 8)}…`);
      await expect(row.getByRole('cell').nth(3)).toHaveText(statusText[v.status] ?? v.status);
    }
    await expect(sec).toContainText(`Reveal window: blocks ${fmt(sale2.auction.closeHeight + 1)}–${fmt(sale2.auction.revealCloseHeight)}; complaints until ${sale2.auction.disputeBlocks} blocks`);
    await expect(sec).toContainText(`Deposits never revealed, listed in the outcome: ${sale2.outcome.unrevealed.length}`);
    const checks = sale2.settlement.viewingKeyChecks;
    await expect(sec).toContainText(`${checks.filter((c: { ok: boolean }) => c.ok).length} of ${checks.length} match`);
    await noHorizontalScroll(page);
    await sec.screenshot({ path: info.outputPath(`saleroom-sale2-${info.project.name}.png`) });
  });

  test('audit: the viewing-key disclosure opens and closes and shows the published key', async ({ page }) => {
    await page.goto(SALEROOM);
    const det = page.locator('details.key');
    await expect(det.locator('code')).toBeHidden();
    await det.getByText('Auction incoming viewing key').click();
    await expect(det).toHaveAttribute('open', '');
    await expect(det.locator('code')).toHaveText(sale1.auction.uivk);
    await expect(det.locator('code')).toBeVisible();
    await noHorizontalScroll(page);
    await det.getByText('Auction incoming viewing key').click();
    await expect(det.locator('code')).toBeHidden();
  });

  test('every control whose label contains "log" works; header links, skip link', async ({ page }) => {
    await page.goto(SALEROOM);
    // No button in the saleroom is labelled "log"; assert it so a new one cannot ship untested.
    await expect(page.getByRole('button', { name: /log/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /\blog\b/i })).toHaveCount(0);
    // The ledgers are reached by scrolling and their explorer links (checked above); the header:
    await expect(page.getByRole('link', { name: 'Code ↗' })).toHaveAttribute('href', REPO);
    // The audit command the page tells users to run is the one that works (pnpm's own `audit` would run otherwise).
    for (const code of await page.locator('code', { hasText: '@sba/service' }).allTextContents()) expect(code).toBe('pnpm --filter @sba/service run audit');
    await page.getByRole('link', { name: 'Fuin saleroom' }).click();
    await expect(page).toHaveURL(/#main$/);
    await page.goto(SALEROOM);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the saleroom' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    await settled(page, 'The result holds.');
  });

  test('reduced motion: no spinner animation while the checks run', async ({ browser }, info) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: info.project.use.viewport!, recordVideo: { dir: info.outputPath('video') } });
    const page = await ctx.newPage();
    await page.goto(SALEROOM);
    const anim = await page.evaluate(() => {
      const el = document.createElement('li');
      el.className = 'step step-run';
      el.innerHTML = '<span class="step-mark"></span>';
      document.querySelector('.steps')!.appendChild(el);
      const v = getComputedStyle(el.querySelector('.step-mark')!).animationName;
      el.remove();
      return v;
    });
    expect(anim).toBe('none');
    await settled(page, 'The result holds.');
    await ctx.close();
  });

  test('error state (fault injection on the page’s own static file): verification key unavailable or altered', async ({ page, health }, info) => {
    health.allowSameOrigin404('/verification_key.json');
    await page.route('**/verification_key.json', (r) => r.fulfill({ status: 404, body: 'not found' }));
    await page.goto(SALEROOM);
    await settled(page, 'Could not finish the checks.');
    await expect(step(page, 'Verification key is the published one')).toHaveClass(/step-error/);
    await expect(step(page, 'Verification key is the published one')).toContainText('verification_key.json: HTTP 404');
    await verify(page).screenshot({ path: info.outputPath(`saleroom-vk-missing-${info.project.name}.png`) });

    await page.unroute('**/verification_key.json');
    await page.route('**/verification_key.json', async (r) => {
      const res = await r.fetch();
      const vk = JSON.parse(await res.text());
      vk.nPublic = vk.nPublic; // same content, re-serialised: a different byte string than the published file
      await r.fulfill({ response: res, body: JSON.stringify(vk) });
    });
    await verify(page).getByRole('button', { name: 'Check the published result' }).click();
    await settled(page, 'The result does not hold.');
    await expect(step(page, 'Verification key is the published one')).toHaveClass(/step-bad/);
    await expect(step(page, 'Verification key is the published one')).toContainText('does not match the record');
  });
});
