import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { EXPLORER, LANDING, REPO, expect, fmt, inView, isMobile, noHorizontalScroll, sale1, test } from './fixtures';

const valid = sale1.deposits.filter((d: { status: string }) => d.status === 'valid');
const winner = valid[sale1.outcome.winnerSlot];
const winTaz = `${Number(sale1.outcome.winningBidZat) / 1e8} TAZ`;

test.describe('landing', () => {
  test('loads the catalogue cover with the record’s numbers, no horizontal scroll', async ({ page }, info) => {
    await page.goto(LANDING);
    await expect(page).toHaveTitle(/Fuin/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Three sealed bids. One envelope opens.');
    const facts = page.locator('.cover .facts');
    await expect(facts).toContainText(`${Number(sale1.auction.depositZat) / 1e8} TAZ`);
    await expect(facts).toContainText(`${Number(sale1.auction.reserveZat) / 1e8} TAZ`);
    await expect(facts).toContainText(`blocks ${fmt(sale1.auction.openHeight)}–${fmt(sale1.auction.closeHeight)}`);
    await expect(facts).toContainText(`block ${fmt(sale1.settlement.height)}`);
    const len = sale1.blockTimes.close.time - sale1.blockTimes.open.time;
    await expect(facts).toContainText(`${Math.floor(len / 60)} min ${len % 60} s`);
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`landing-cover-${info.project.name}.png`) });
  });

  test('the live clock counts from the settlement block header time', async ({ page }) => {
    await page.goto(LANDING);
    const read = () => page.locator('#digits b').allTextContents();
    await expect.poll(async () => (await read()).join('')).not.toContain('--');
    const [d, h, m, s] = (await read()).map(Number);
    const shown = d * 86400 + h * 3600 + m * 60 + s;
    const expected = Math.floor(Date.now() / 1000) - sale1.blockTimes.settlement.time;
    expect(Math.abs(shown - expected)).toBeLessThanOrEqual(3);
    await expect.poll(async () => (await read()).join(':'), { timeout: 3000 }).not.toBe([d, h, m, s].map((v) => String(v).padStart(2, '0')).join(':'));
  });

  test('the envelopes: only the winner’s seal breaks; the button seals and re-breaks it', async ({ page }, info) => {
    await page.goto(LANDING);
    const stage = page.locator('#stage');
    const btn = page.getByRole('button', { name: /Break the seal|Seal it again/ });
    await stage.scrollIntoViewIfNeeded();
    // Opens on its own once in view (after 900 ms).
    await expect(stage).toHaveClass(/is-open/);
    await expect(btn).toHaveText('Seal it again');
    await expect(page.locator('#stage-status')).toHaveText(`The proof opened one envelope: ${winTaz}, the highest bid. The other two are never published.`);
    await expect(page.locator('.env-note')).toHaveText(['sealed for good', 'sealed for good', 'opened by the proof']);
    await expect(page.locator('.env.win .letter strong')).toHaveText(winTaz);
    await expect(page.locator('.env-label').nth(2)).toContainText(winner.txid.slice(0, 8));
    await page.screenshot({ path: info.outputPath(`landing-opened-${info.project.name}.png`) });
    await btn.click();
    await expect(stage).not.toHaveClass(/is-open/);
    await expect(btn).toHaveText('Break the seal');
    await expect(page.locator('.env-note')).toHaveText(['sealed', 'sealed', 'sealed']);
    await expect(page.locator('#stage-status')).toHaveText('Three equal deposits. Nothing on chain says which bid is highest.');
    await btn.click();
    await expect(stage).toHaveClass(/is-open/);
    await expect(btn).toHaveText('Seal it again');
  });

  test('reduced motion: the result is open on load with no transition', async ({ browser }, info) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: info.project.use.viewport!, recordVideo: { dir: info.outputPath('video') } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(LANDING);
    await expect(page.locator('#stage')).toHaveClass(/is-open/, { timeout: 500 });
    await expect(page.getByRole('button', { name: 'Seal it again' })).toBeVisible();
    expect(await page.locator('.env.win .letter').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test('nav anchors, cover CTAs, the wordmark and the skip link land on their sections', async ({ page }, info) => {
    await page.goto(LANDING);
    const nav = page.getByRole('navigation', { name: 'Sections' });
    if (!isMobile(info.project.name)) {
      for (const [name, id] of [['The lots', 'lots'], ['Conditions', 'conditions'], ['Provenance', 'provenance'], ['Condition report', 'report']]) {
        await nav.getByRole('link', { name, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`#${id}$`));
        await inView(page, `#${id} h2`);
      }
    } else {
      // On a phone the masthead keeps only "Code"; the section links are hidden by design.
      await expect(nav.getByRole('link', { name: 'The lots' })).toBeHidden();
      await expect(nav.getByRole('link', { name: 'Code' })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Code' })).toHaveAttribute('href', REPO);
    await page.getByRole('link', { name: 'Fuin, home' }).click();
    await expect(page).toHaveURL(/#cover$/);
    await inView(page, '#cover');
    await page.getByRole('link', { name: 'See every lot' }).click();
    await expect(page).toHaveURL(/#lots$/);
    await inView(page, '#lots h2');
    await page.getByRole('link', { name: 'Audit it yourself' }).click();
    await expect(page).toHaveURL(/#provenance$/);
    await inView(page, '#provenance h2');
    // Keyboard: the first Tab shows the skip link, Enter jumps to the cover.
    await page.goto(LANDING);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the sale' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#cover$/);
  });

  test('every deposit is a lot card whose tx link is the recorded deposit, in chain order', async ({ page }, info) => {
    await page.goto(LANDING + '#lots');
    const lots = page.locator('#lots .lot:not(.lot-sum)');
    await expect(lots).toHaveCount(sale1.deposits.length);
    for (const [i, d] of sale1.deposits.entries()) {
      const lot = lots.nth(i);
      await expect(lot.locator('.lot-top b')).toHaveText(`LOT ${String(i + 1).padStart(2, '0')}`);
      const link = lot.getByRole('link');
      await expect(link).toHaveAttribute('href', EXPLORER + d.txid);
      await expect(link).toHaveText(`${d.txid.slice(0, 8)}… ↗`);
      await expect(lot).toContainText(fmt(d.height));
      await expect(lot).toContainText(`${Number(d.valueZat) / 1e8} TAZ`);
      const tag = d.txid === winner.txid ? 'Opened' : d.status === 'valid' ? 'Sealed' : 'Refused';
      await expect(lot.locator('.tag')).toHaveText(tag);
    }
    // Only the winner's amount is printed in the lots.
    await expect(page.locator('#lots')).toContainText(winTaz);
    const sum = page.locator('#lots .lot-sum');
    await expect(sum).toContainText(`${sale1.settlement.outputs.length} outputs`);
    await expect(sum.getByRole('link')).toHaveAttribute('href', EXPLORER + sale1.settlement.txid);
    await expect(page.getByRole('link', { name: 'Full record' })).toHaveAttribute('href', `${REPO}/blob/main/deployments/testnet.json`);
    await noHorizontalScroll(page);
    await page.locator('#lots').screenshot({ path: info.outputPath(`landing-lots-${info.project.name}.png`) });
  });

  test('provenance ledger: every recipient line matches what its key decrypted', async ({ page }, info) => {
    await page.goto(LANDING + '#provenance');
    const ledger = page.locator('#provenance .ledger');
    await expect(ledger.locator('.ledger-head')).toContainText(`block ${fmt(sale1.settlement.height)}`);
    await expect(ledger.locator('.ledger-head').getByRole('link')).toHaveAttribute('href', EXPLORER + sale1.settlement.txid);
    const rows = ledger.locator('.row');
    await expect(rows).toHaveCount(sale1.settlement.viewingKeyChecks.length);
    const want: Record<string, string> = {};
    for (const c of sale1.settlement.viewingKeyChecks) {
      expect(c.ok).toBe(true);
      const parts: string[] = c.expected.split('+');
      const same = parts.every((p) => p === parts[0]);
      want[c.recipient.replace(/(\d)$/, ' $1').replace(/^./, (s: string) => s.toUpperCase())] = same && parts.length > 1 ? `${fmt(parts[0])} × ${parts.length}` : parts.map(fmt).join(' + ');
    }
    for (const [who, amt] of Object.entries(want)) {
      const row = rows.filter({ has: page.locator('.who', { hasText: new RegExp(`^${who}$`) }) });
      await expect(row).toHaveCount(1);
      await expect(row.locator('.amt')).toContainText(amt);
      await expect(row.locator('.ok')).toHaveText('match');
    }
    const term = page.getByLabel(/Audit output/);
    await expect(term).toContainText('all checks pass');
    await expect(term).toContainText(`winning bid ${sale1.outcome.winningBidZat} zat`);
    await expect(page.getByRole('link', { name: 'Protocol and threat model' })).toHaveAttribute('href', `${REPO}/tree/main/packages/docs`);
    await noHorizontalScroll(page);
    await page.locator('#provenance').screenshot({ path: info.outputPath(`landing-provenance-${info.project.name}.png`) });
  });

  test('conditions of sale and condition report describe the reveal channel and dispute window', async ({ page }) => {
    await page.goto(LANDING + '#conditions');
    await expect(page.locator('#conditions .conds li')).toHaveCount(8);
    await expect(page.locator('#conditions')).toContainText('sealed to the auction\'s reveal key');
    await expect(page.locator('#conditions')).toContainText('signed complaint anchored on chain');
    await expect(page.locator('#report h3')).toHaveText(['The auctioneer learns every bid', 'Reveals cost a transaction', 'Single-party trusted setup', 'Testnet only, and not the first']);
  });

  test('every control whose label contains "log" (and the ledger/provenance links) works', async ({ page }, info) => {
    await page.goto(LANDING);
    // There is no button labelled "log" on the landing; assert it so a new one cannot ship untested.
    await expect(page.getByRole('button', { name: /log/i })).toHaveCount(0);
    const logLinks = page.getByRole('link', { name: /\blog\b|ledger|provenance|record/i });
    const names = (await logLinks.allInnerTexts()).map((s) => s.trim());
    expect(names).toEqual(expect.arrayContaining(['Full record', 'Live record']));
    for (const name of names) {
      const link = page.getByRole('link', { name, exact: true }).first();
      if (!(await link.isVisible())) continue; // "Provenance" is hidden in the phone masthead
      const href = (await link.getAttribute('href'))!;
      if (href.startsWith('#')) {
        await link.click();
        await expect(page).toHaveURL(new RegExp(`${href}$`));
        await inView(page, `${href} h2`);
      } else {
        expect(href).toBe(`${REPO}/blob/main/deployments/testnet.json`);
      }
    }
    if (!isMobile(info.project.name)) expect(names).toContain('Provenance');
  });

  test('footer links point at the repository, record, docs and tests', async ({ page }) => {
    await page.goto(LANDING);
    const foot = page.getByRole('contentinfo').getByRole('navigation', { name: 'Links' });
    await expect(foot.getByRole('link', { name: 'Repository' })).toHaveAttribute('href', REPO);
    await expect(foot.getByRole('link', { name: 'Live record' })).toHaveAttribute('href', `${REPO}/blob/main/deployments/testnet.json`);
    await expect(foot.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', `${REPO}/tree/main/packages/docs`);
    await expect(foot.getByRole('link', { name: 'Tests' })).toHaveAttribute('href', `${REPO}/blob/main/TESTING.md`);
    await expect(page.getByRole('contentinfo')).toContainText('Copyright (c) 2026 Nivesh Gajengi');
  });

  test('provenance log: every line shown is in a fresh live audit of the chain, and the command works', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(LANDING + '#provenance');
    const term = page.getByLabel(/Audit output/);
    await expect(term.locator('.c')).toHaveText('$ pnpm --filter @sba/service run audit');
    const shown = (await term.innerText()).split('\n').slice(1).filter((l) => l.trim() && !/^\[ .* \]$/.test(l.trim()));
    // The exact command from the page, against live testnet (lightwalletd), with only the published viewing key.
    const { stdout } = await promisify(execFile)('pnpm', ['--filter', '@sba/service', 'run', 'audit'], { cwd: resolve(import.meta.dirname, '../..'), timeout: 280_000, maxBuffer: 8 << 20 });
    const live = stdout.split('\n');
    for (const l of shown) expect(live, `landing line not in the live audit: ${l}`).toContain(l);
    expect(live).toContain('all checks pass');
  });

  test('audit without the verifier binary says "Setup required" and fails (no fake pass)', async () => {
    const err = await promisify(execFile)('pnpm', ['--filter', '@sba/service', 'run', 'audit'], {
      cwd: resolve(import.meta.dirname, '../..'),
      env: { ...process.env, SBA_VERIFY_BIN: '/nonexistent/sba-verify' },
      timeout: 60_000,
    }).then(() => null, (e: { code: number; stdout: string; stderr: string }) => e);
    expect(err, 'audit exited 0 without a verifier').not.toBeNull();
    expect(err!.stdout + err!.stderr).toContain('Setup required: SBA_VERIFY_BIN');
    expect(err!.stdout).not.toContain('all checks pass');
  });
});
