import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { EVIDENCE, EXPLORER, LANDING, REPO, SALEROOM, expect, fmt, inView, isMobile, noHorizontalScroll, root, sale1, sale2, sale3, test } from './fixtures';

type Dep = { txid: string; output?: string; height: number; valueZat: string; status: string };
const ref = (d: { txid: string; output?: string }) => (d.output === undefined ? d.txid : `${d.txid}:${d.output}`);
const tazOf = (z: string | number) => `${Number(z) / 1e8} TAZ`;
function derive(rec: typeof sale1) {
  const unrevealed: string[] = rec.outcome.unrevealed ?? [];
  const proven = (rec.deposits as Dep[]).filter((d) => d.status === 'valid' && !unrevealed.includes(ref(d)));
  const winner = proven[rec.outcome.winnerSlot];
  const tag = (d: Dep) => (ref(d) === ref(winner) ? 'Opened' : d.status !== 'valid' ? 'Refused' : unrevealed.includes(ref(d)) ? 'Unrevealed' : 'Sealed');
  return { proven, winner, tag };
}
const s3 = derive(sale3);
const s2 = derive(sale2);
const s1 = derive(sale1);
const winTaz = tazOf(sale3.outcome.winningBidZat);

/** Each lot card in `list` is the record's deposit at that position: link, block, amount and tag. */
async function lotsMatch(page: Page, list: string, rec: typeof sale1, d: ReturnType<typeof derive>) {
  const lots = page.locator(`${list} .lot:not(.lot-sum)`);
  await expect(lots).toHaveCount(rec.deposits.length);
  for (const [i, dep] of (rec.deposits as Dep[]).entries()) {
    const lot = lots.nth(i);
    await expect(lot.locator('.lot-top b')).toHaveText(`LOT ${String(i + 1).padStart(2, '0')}`);
    const link = lot.getByRole('link');
    await expect(link).toHaveAttribute('href', EXPLORER + dep.txid);
    await expect(link).toHaveText(`${dep.txid.slice(0, 8)}…${dep.output === undefined ? '' : `:${dep.output}`} ↗`);
    await expect(lot).toContainText(fmt(dep.height));
    await expect(lot).toContainText(tazOf(dep.valueZat));
    await expect(lot.locator('.tag')).toHaveText(d.tag(dep));
  }
  // Only the winner's amount is printed among the lots.
  await expect(page.locator(`${list} .plate-open`)).toHaveCount(1);
  await expect(page.locator(`${list} .plate-open strong`)).toHaveText(tazOf(rec.outcome.winningBidZat));
  const sum = page.locator(`${list} .lot-sum`);
  await expect(sum).toContainText(`${rec.settlement.outputs.length} outputs`);
  await expect(sum.getByRole('link')).toHaveAttribute('href', EXPLORER + rec.settlement.txid);
}

/** Each recipient row of `ledger` equals what that recipient's key decrypted. */
async function ledgerMatches(page: Page, ledger: string, rec: typeof sale1) {
  const rows = page.locator(`${ledger} .row`);
  await expect(rows).toHaveCount(rec.settlement.viewingKeyChecks.length);
  for (const c of rec.settlement.viewingKeyChecks as { recipient: string; expected: string; ok: boolean }[]) {
    expect(c.ok).toBe(true);
    const parts = c.expected.split('+');
    const same = parts.every((p) => p === parts[0]);
    const amt = same && parts.length > 1 ? `${fmt(parts[0])} × ${parts.length}` : parts.map(fmt).join(' + ');
    const who = c.recipient.replace(/(\d)$/, ' $1').replace(/^./, (s) => s.toUpperCase());
    const row = rows.filter({ has: page.locator('.who', { hasText: new RegExp(`^${who}$`) }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.amt')).toContainText(amt);
    await expect(row.locator('.ok')).toHaveText('match');
  }
}

test.describe('evidence page (the full catalogue, moved from the landing on Oct 25)', () => {
  test('the cover is Sale 003, bid through MCP by script-driven sba-mcp processes, with the record’s numbers; no horizontal scroll', async ({ page }, info) => {
    await page.goto(EVIDENCE);
    await expect(page).toHaveTitle('Fuin · Evidence: Sale 003, sealed bids on Zcash');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Three sealed bids. One envelope opens.');
    await expect(page.locator('.cover .lotno')).toContainText(`SALE 003${sale3.auction.name}`);
    await expect(page.locator('.cover .lede')).toContainText('Each bidder was a separate sba-mcp server process with only its own wallet, driven over MCP by the reveal-run script (no language model chose a bid)');
    await expect(page.locator('.cover .lede')).toContainText('a losing bid is never published unless its bidder files a complaint, which publishes its own bid');
    await expect(page.locator('.cover .lede')).toContainText('Only the auctioneer reads them.');
    const facts = page.locator('.cover .facts');
    await expect(facts).toContainText(tazOf(sale3.auction.depositZat));
    await expect(facts).toContainText(tazOf(sale3.auction.reserveZat));
    await expect(facts).toContainText(`blocks ${fmt(sale3.auction.openHeight)}–${fmt(sale3.auction.closeHeight)}`);
    await expect(facts).toContainText(`blocks ${fmt(sale3.auction.closeHeight + 1)}–${fmt(sale3.auction.revealCloseHeight)}`);
    await expect(facts).toContainText(`block ${fmt(sale3.settlement.height)}`);
    const len = sale3.blockTimes.close.time - sale3.blockTimes.open.time;
    await expect(facts).toContainText(`${Math.floor(len / 60)} min ${len % 60} s`);
    expect((await page.locator('body').innerText()).match(/\bMCP\b/g)?.length ?? 0).toBeGreaterThan(3);
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`landing-cover-${info.project.name}.png`) });
  });

  test('the live clock counts from the Sale 003 settlement block header time', async ({ page }) => {
    await page.goto(EVIDENCE);
    const read = () => page.locator('#digits b').allTextContents();
    await expect.poll(async () => (await read()).join('')).not.toContain('--');
    const [d, h, m, s] = (await read()).map(Number);
    const shown = d * 86400 + h * 3600 + m * 60 + s;
    const expected = Math.floor(Date.now() / 1000) - sale3.blockTimes.settlement.time;
    expect(Math.abs(shown - expected)).toBeLessThanOrEqual(3);
    await expect(page.locator('.clock .eyebrow')).toContainText(`block ${fmt(sale3.settlement.height)} · ${new Date(sale3.blockTimes.settlement.time * 1000).toISOString().slice(11, 19)} UTC`);
    await expect.poll(async () => (await read()).join(':'), { timeout: 3000 }).not.toBe([d, h, m, s].map((v) => String(v).padStart(2, '0')).join(':'));
  });

  test('the envelopes are the three revealed bids: only the winner’s seal breaks; the button seals and re-breaks it', async ({ page }, info) => {
    await page.goto(EVIDENCE);
    const stage = page.locator('#stage');
    const btn = page.getByRole('button', { name: /Break the seal|Seal it again/ });
    const labels = page.locator('.env-label');
    await expect(labels).toHaveCount(s3.proven.length);
    for (const [i, d] of s3.proven.entries()) await expect(labels.nth(i)).toContainText(`Lot ${String((sale3.deposits as Dep[]).indexOf(d) + 1).padStart(2, '0')}`);
    const w = sale3.outcome.winnerSlot;
    await stage.scrollIntoViewIfNeeded();
    // Opens on its own once in view (after 900 ms).
    await expect(stage).toHaveClass(/is-open/);
    await expect(btn).toHaveText('Seal it again');
    await expect(page.locator('#stage-status')).toHaveText(`The proof opened one envelope: ${winTaz}, the highest bid. The other two are never published.`);
    await expect(page.locator('.env-note')).toHaveText(s3.proven.map((_, i) => (i === w ? 'opened by the proof' : 'sealed for good')));
    await expect(page.locator('.env.win .letter strong')).toHaveText(winTaz);
    await expect(labels.nth(w)).toContainText(s3.winner.txid.slice(0, 8));
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
    await page.goto(EVIDENCE);
    await expect(page.locator('#stage')).toHaveClass(/is-open/, { timeout: 500 });
    await expect(page.getByRole('button', { name: 'Seal it again' })).toBeVisible();
    expect(await page.locator('.env.win .letter').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test('nav anchors, cover CTAs, the wordmark and the skip link land on their sections; the saleroom links open it', async ({ page }, info) => {
    await page.goto(EVIDENCE);
    const nav = page.getByRole('navigation', { name: 'Sections' });
    if (!isMobile(info.project.name)) {
      for (const [name, id] of [['The lots', 'lots'], ['Reveals', 'reveals'], ['Provenance', 'provenance'], ['What is new', 'new']]) {
        await nav.getByRole('link', { name, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`#${id}$`));
        await inView(page, `#${id} h2`);
      }
      await expect(nav.getByRole('link', { name: 'Saleroom', exact: true })).toHaveAttribute('href', 'saleroom/');
    } else {
      // On a phone the masthead keeps only "Code"; the section links are hidden by design.
      await expect(nav.getByRole('link', { name: 'The lots' })).toBeHidden();
      await expect(nav.getByRole('link', { name: 'Code' })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Code' })).toHaveAttribute('href', REPO);
    // The wordmark goes back to the landing (the overview).
    await expect(page.getByRole('link', { name: 'Fuin, home' })).toHaveAttribute('href', './');
    await page.getByRole('link', { name: 'See every lot' }).click();
    await expect(page).toHaveURL(/#lots$/);
    await inView(page, '#lots h2');
    await page.getByRole('link', { name: 'Audit it yourself' }).click();
    await expect(page).toHaveURL(/#provenance$/);
    await inView(page, '#provenance h2');
    // "Verify it in the saleroom" opens the hosted saleroom next to this page, on Sale 003.
    await page.goto(EVIDENCE);
    await page.getByRole('link', { name: 'Verify it in the saleroom' }).click();
    await expect(page).toHaveURL(SALEROOM);
    await expect(page.locator('.sale-meta code')).toHaveText(sale3.auction.name);
    await expect(page.locator('section.verify h2')).toHaveText('The result holds.', { timeout: 30_000 });
    // Keyboard: the first Tab shows the skip link, Enter jumps to the cover.
    await page.goto(EVIDENCE);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the sale' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#cover$/);
  });

  test('the first lot section is Sale 003: every deposit a lot card whose tx link is the recorded payment, in chain order', async ({ page }, info) => {
    await page.goto(EVIDENCE + '#lots');
    expect(await page.locator('ul.lots').first().evaluate((el) => el.closest('section')?.id)).toBe('lots');
    await expect(page.locator('#lots .sec-head')).toContainText(sale3.auction.name);
    await lotsMatch(page, '#lots', sale3, s3);
    await expect(page.locator('#lots')).toContainText(winTaz);
    await expect(page.locator('#lots .lot').filter({ hasText: 'Unrevealed' })).toContainText('forfeited to the seller (memo forfeit:<deposit>), minus its 5,000 zat output fee');
    await expect(page.locator('#lots .lot').filter({ hasText: 'Duplicate' })).toContainText('refunded minus its own 5,000 zat output fee');
    await expect(page.getByRole('link', { name: 'Full record' })).toHaveAttribute('href', `${REPO}/blob/main/deployments/testnet-sale003.json`);
    await noHorizontalScroll(page);
    await page.locator('#lots').screenshot({ path: info.outputPath(`landing-lots-${info.project.name}.png`) });
  });

  test('reveals and MCP bidders: every reveal note with its block, deposit and status; MCP tools; the anchored complaint', async ({ page }, info) => {
    await page.goto(EVIDENCE + '#reveals');
    const sec = page.locator('#reveals');
    const rows = sec.getByRole('table', { name: 'Reveal notes on chain' }).locator('.rv');
    await expect(rows).toHaveCount(sale3.reveals.length);
    const statusText: { [k: string]: string } = { accepted: 'accepted', wrong_commitment: 'wrong deposit', late: 'late' };
    for (const [i, v] of sale3.reveals.entries()) {
      const row = rows.nth(i);
      await expect(row.locator('.rv-b')).toHaveText(fmt(v.height));
      await expect(row.getByRole('link')).toHaveAttribute('href', EXPLORER + v.txid);
      await expect(row.locator('.rv-n small')).toHaveText(v.label);
      await expect(row.locator('.rv-d')).toHaveText(`opens ${v.deposit.length > 64 ? `${v.deposit.slice(0, 8)}…${v.deposit.slice(64)}` : `${v.deposit.slice(0, 8)}…`}`);
      await expect(row.locator('.st')).toHaveText(statusText[v.status]);
    }
    await expect(sec.locator('.ledger-head')).toContainText(`blocks ${fmt(sale3.auction.closeHeight + 1)}–${fmt(sale3.auction.revealCloseHeight)}`);
    for (const tool of ['sba-mcp', 'bid', 'reveal', 'complain', 'verify_result']) await expect(sec.locator('code', { hasText: new RegExp(`^${tool}$`) }).first()).toBeVisible();
    const c = sale3.complaints[0];
    await expect(sec.getByRole('link', { name: `${c.anchor.txid.slice(0, 8)}… ↗` })).toHaveAttribute('href', EXPLORER + c.anchor.txid);
    await expect(sec).toContainText(`block ${fmt(c.anchor.height)}`);
    await expect(sec).toContainText('It publishes no viewing key');
    await expect(sec).toContainText('The reveal-run script drove each one over MCP');
    await noHorizontalScroll(page);
    await sec.screenshot({ path: info.outputPath(`landing-reveals-${info.project.name}.png`) });
  });

  test('provenance ledger: every Sale 003 recipient line matches what its key decrypted', async ({ page }, info) => {
    await page.goto(EVIDENCE + '#provenance');
    const head = page.locator('#provenance .ledger-head');
    await expect(head).toContainText(`block ${fmt(sale3.settlement.height)}`);
    await expect(head.getByRole('link')).toHaveAttribute('href', EXPLORER + sale3.settlement.txid);
    await ledgerMatches(page, '#provenance .ledger', sale3);
    const term = page.getByLabel(/Audit output/);
    await expect(term).toContainText("chain checks pass; payments not checked: give the seller's incoming viewing key (SBA_SELLER_UIVK)");
    await expect(term).toContainText('✓ terms: the auction id is the hash of every term');
    await expect(page.locator('#provenance')).toContainText('the seller paid 135,000 zat for the winning bid and 195,000 for the forfeit');
    await expect(term).not.toContainText('all checks pass');
    await expect(term).toContainText(`winning bid ${sale3.outcome.winningBidZat} zat`);
    await expect(term).not.toContainText('! terms: legacy');
    await expect(page.getByRole('link', { name: 'Protocol and threat model' })).toHaveAttribute('href', `${REPO}/tree/main/packages/docs`);
    await noHorizontalScroll(page);
    await page.locator('#provenance').screenshot({ path: info.outputPath(`landing-provenance-${info.project.name}.png`) });
  });

  test('Sale 002 keeps its own section: lots, settlement ledger, record link and its complaint from testnet-reveal.json', async ({ page }, info) => {
    await page.goto(EVIDENCE + '#sale002');
    await expect(page.locator('#sale002 h2')).toHaveText('The reveal-channel sale, before bound terms');
    await expect(page.locator('#sale002 .sec-head')).toContainText(sale2.auction.name);
    await expect(page.locator('#sale002 .sec-head')).toContainText(`for ${tazOf(sale2.outcome.winningBidZat)}`);
    await lotsMatch(page, '#sale002', sale2, s2);
    await expect(page.locator('#sale002 .lot').filter({ hasText: 'Unrevealed' })).toContainText('this sale predates the rule that forfeits it to the seller');
    await expect(page.locator('#sale002 .s2-ledger .ledger-head').getByRole('link')).toHaveAttribute('href', EXPLORER + sale2.settlement.txid);
    await ledgerMatches(page, '#sale002 .s2-ledger', sale2);
    const c = sale2.complaints[0];
    await expect(page.locator('#sale002 .s2-note').getByRole('link')).toHaveAttribute('href', EXPLORER + c.anchor.txid);
    await expect(page.locator('#sale002 .s2-note')).toContainText("whole demo wallet");
    await expect(page.getByRole('link', { name: 'Sale 002 record' })).toHaveAttribute('href', `${REPO}/blob/main/deployments/testnet-reveal.json`);
    await noHorizontalScroll(page);
    await page.locator('#sale002').screenshot({ path: info.outputPath(`landing-sale002-${info.project.name}.png`) });
  });

  test('Sale 001 keeps its own section: lots, settlement ledger and record link from testnet.json', async ({ page }, info) => {
    await page.goto(EVIDENCE + '#sale001');
    await expect(page.locator('#sale001 h2')).toHaveText('The first sale, before the reveal channel');
    await expect(page.locator('#sale001 .sec-head')).toContainText(sale1.auction.name);
    await expect(page.locator('#sale001 .sec-head')).toContainText(`for ${tazOf(sale1.outcome.winningBidZat)}`);
    await lotsMatch(page, '#sale001', sale1, s1);
    await expect(page.locator('#sale001 .s1-ledger .ledger-head').getByRole('link')).toHaveAttribute('href', EXPLORER + sale1.settlement.txid);
    await ledgerMatches(page, '#sale001 .s1-ledger', sale1);
    await expect(page.getByRole('link', { name: 'Sale 001 record' })).toHaveAttribute('href', `${REPO}/blob/main/deployments/testnet.json`);
    await noHorizontalScroll(page);
    await page.locator('#sale001').screenshot({ path: info.outputPath(`landing-sale001-${info.project.name}.png`) });
  });

  test('conditions of sale and condition report: bound terms, reveal channel, capacity, ties by txid, forfeits to the seller, disputes', async ({ page }) => {
    await page.goto(EVIDENCE + '#conditions');
    const conds = page.locator('#conditions');
    await expect(conds.locator('.conds li')).toHaveCount(10);
    for (const text of [
      'The auction id is a hash of every term on the card',
      "sealed to the auction's reveal key",
      'Only the first 8 revealed valid deposits compete',
      'a deposit nobody reveals takes no slot',
      'minus its own 5,000 zat output fee',
      'If nothing valid is revealed, or the highest revealed bid is below the reserve, there is no sale',
      'within one block that is the lower txid',
      'An unrevealed deposit goes to the seller, not the auctioneer',
      'signed complaint anchored on chain',
    ])
      await expect(conds).toContainText(text);
    await expect(page.locator('#report h3')).toHaveText(['The auctioneer learns every bid', 'Reveals cost a transaction', 'Complaints publish', 'Single-party trusted setup', 'The audit trusts its lightwalletd', 'Payments need a recipient key', 'Ties go to the lower txid', 'Testnet only, and not the first']);
    await expect(page.locator('#report')).toContainText('anyone can pay the auction address after the auctioneer');
    await expect(page.locator('#report')).toContainText('Sales 001 and 002 predate bound terms');
    await expect(page.locator('#report')).toContainText("Sale 003's are bound");
  });

  test('what is new: the zkSNARKs ZEC auction is named with sources, and Fuin’s three differences', async ({ page }, info) => {
    await page.goto(EVIDENCE + '#new');
    const sec = page.locator('#new');
    await expect(sec).toContainText('zkSNARKs ran a blind-bid ZEC auction in September 2026 (reported: 16,971 bids, cleared at 1.5 ZEC, settled through NEAR Intents)');
    await expect(sec).toContainText('Ethereum has many commit-reveal auctions with ZK proofs');
    await expect(sec.locator('.news b')).toHaveText(['The deposits are the public inputs.', 'Reveals are sealed inside shielded memos.', 'Complaints and audit need no trust.']);
    await expect(sec.getByRole('link', { name: 'Crypto Briefing' })).toHaveAttribute('href', 'https://cryptobriefing.com/zksnarks-auction-clears-zcash-blind-bids/');
    await expect(sec.getByRole('link', { name: 'NEAR Intents blog' })).toHaveAttribute('href', 'https://intents.aurora.dev/blog/zcash-auction-cross-chain-swaps');
    await noHorizontalScroll(page);
    await sec.screenshot({ path: info.outputPath(`landing-new-${info.project.name}.png`) });
  });

  test('every control whose label contains "log" (and the ledger/provenance/record links) works', async ({ page }, info) => {
    await page.goto(EVIDENCE);
    // There is no button labelled "log" on the landing; assert it so a new one cannot ship untested.
    await expect(page.getByRole('button', { name: /log/i })).toHaveCount(0);
    const logLinks = page.getByRole('link', { name: /\blog\b|ledger|provenance|record/i });
    const names = (await logLinks.allInnerTexts()).map((s) => s.trim());
    expect(names).toEqual(expect.arrayContaining(['Full record', 'Live record', 'Sale 002 record', 'Sale 001 record']));
    const records: { [k: string]: string } = { 'Full record': 'testnet-sale003.json', 'Live record': 'testnet-sale003.json', 'Sale 002 record': 'testnet-reveal.json', 'Sale 001 record': 'testnet.json' };
    for (const name of names) {
      const link = page.getByRole('link', { name, exact: true }).first();
      if (!(await link.isVisible())) continue; // "Provenance" is hidden in the phone masthead
      const href = (await link.getAttribute('href'))!;
      if (href.startsWith('#')) {
        await link.click();
        await expect(page).toHaveURL(new RegExp(`${href}$`));
        await inView(page, `${href} h2`);
      } else {
        expect(href).toBe(`${REPO}/blob/main/deployments/${records[name]}`);
      }
    }
    if (!isMobile(info.project.name)) expect(names).toContain('Provenance');
  });

  test('the saleroom section opens the hosted saleroom, and gives the local route as a second way', async ({ page }, info) => {
    await page.goto(EVIDENCE + '#saleroom');
    const sec = page.locator('#saleroom');
    await expect(sec.getByRole('heading', { level: 2 })).toHaveText('Check the result in your own browser');
    await expect(sec).toContainText('re-checks any of the three sales in the tab');
    await expect(sec.locator('pre.term')).toHaveText('$ pnpm install\n$ pnpm --filter @sba/dashboard dev\n  then open http://localhost:5178');
    // the local command is real: that package, a plain `vite` dev script, and the port its config pins
    const pkg = JSON.parse(readFileSync(resolve(root, 'packages/dashboard/package.json'), 'utf8'));
    expect(pkg.name).toBe('@sba/dashboard');
    expect(pkg.scripts.dev).toBe('vite');
    expect(readFileSync(resolve(root, 'packages/dashboard/vite.config.ts'), 'utf8')).toContain('port: 5178, strictPort: true');
    await sec.screenshot({ path: info.outputPath(`landing-saleroom-${info.project.name}.png`) });
    await noHorizontalScroll(page);
    // The button: the saleroom served next to this page (relative link, as on GitHub Pages).
    const open = sec.getByRole('link', { name: 'Open the saleroom' });
    await expect(open).toHaveAttribute('href', 'saleroom/');
    await open.click();
    await expect(page).toHaveURL(SALEROOM);
    await expect(page.locator('section.verify h2')).toHaveText('The result holds.', { timeout: 30_000 });
    await expect(page.locator('section.verify .step-ok')).toHaveCount(4);
  });

  test('masthead between the phone and desktop layouts: no horizontal scroll and no nav label broken across lines', async ({ page }) => {
    await page.goto(EVIDENCE);
    await page.evaluate(() => document.fonts.ready);
    for (const width of [641, 672, 700, 768, 820, 900, 901, 1040]) {
      await page.setViewportSize({ width, height: 800 });
      await noHorizontalScroll(page);
      const nav = page.getByRole('navigation', { name: 'Sections' });
      const broken = await nav.locator('a').evaluateAll((links) =>
        links.filter((a) => getComputedStyle(a).display !== 'none' && a.getClientRects().length > 1).map((a) => a.textContent?.trim()),
      );
      expect(broken, `nav labels on two lines at ${width}px`).toEqual([]);
      // Every visible label sits on one line: as tall as the shortest label.
      const heights = await nav.locator('a:not(.btn)').evaluateAll((links) => links.filter((a) => getComputedStyle(a).display !== 'none').map((a) => Math.round(a.getBoundingClientRect().height)));
      expect(Math.max(...heights), `a nav label wraps at ${width}px`).toBe(Math.min(...heights));
      // The Saleroom link is in the masthead only when there is room for it; the colophon always has it.
      await expect(nav.getByRole('link', { name: 'Saleroom', exact: true })).toBeVisible({ visible: width > 900 });
      await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Saleroom' })).toHaveAttribute('href', 'saleroom/');
    }
  });

  test('no overclaimed agents: every use of "agent" on the page names the scripted MCP driver', async ({ page }) => {
    await page.goto(EVIDENCE);
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/\bagents? bid|MCP agents?\b|independent agents?/i);
    const html = await page.content();
    expect(html).not.toContain('three MCP agents');
    expect(text).toContain('No language model chose a bid.');
  });

  test('footer links point at the repository, record, docs, tests and the saleroom', async ({ page }) => {
    await page.goto(EVIDENCE);
    const foot = page.getByRole('contentinfo').getByRole('navigation', { name: 'Links' });
    await expect(foot.getByRole('link', { name: 'Repository' })).toHaveAttribute('href', REPO);
    await expect(foot.getByRole('link', { name: 'Live record' })).toHaveAttribute('href', `${REPO}/blob/main/deployments/testnet-sale003.json`);
    await expect(foot.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', `${REPO}/tree/main/packages/docs`);
    await expect(foot.getByRole('link', { name: 'Tests' })).toHaveAttribute('href', `${REPO}/blob/main/TESTING.md`);
    await expect(foot.getByRole('link', { name: 'Saleroom' })).toHaveAttribute('href', 'saleroom/');
    await expect(foot.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', './');
    await expect(page.getByRole('contentinfo')).toContainText('Copyright (c) 2026 Nivesh Gajengi');
  });

  test('provenance log: every line shown is in a fresh live audit of the chain (Sale 003 and its complaint), and the command works', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(EVIDENCE + '#provenance');
    const term = page.getByLabel(/Audit output/);
    const cmd = (await term.locator('.c').innerText()).trim();
    expect(cmd).toBe(`$ pnpm --filter @sba/service run audit deployments/testnet-sale003.json deployments/${sale3.complaints[0].file}`);
    const shown = (await term.innerText()).split('\n').slice(1).filter((l) => l.trim() && !/^\[ .* \]$/.test(l.trim()));
    // The exact command from the page, against live testnet (lightwalletd), with only the published viewing key.
    const { stdout } = await promisify(execFile)('pnpm', cmd.split(' ').slice(2), { cwd: root, timeout: 280_000, maxBuffer: 8 << 20 });
    const live = stdout.split('\n');
    for (const l of shown) expect(live, `landing line not in the live audit: ${l}`).toContain(l);
    expect(live).toContain("chain checks pass; payments not checked: give the seller's incoming viewing key (SBA_SELLER_UIVK) to check the seller's payout, and a complaint with a refund key to check a refund");
  });

  test('audit without the verifier binary says "Setup required" and fails (no fake pass)', async () => {
    const err = await promisify(execFile)('pnpm', ['--filter', '@sba/service', 'run', 'audit'], {
      cwd: root,
      env: { ...process.env, SBA_VERIFY_BIN: '/nonexistent/sba-verify' },
      timeout: 60_000,
    }).then(() => null, (e: { code: number; stdout: string; stderr: string }) => e);
    expect(err, 'audit exited 0 without a verifier').not.toBeNull();
    expect(err!.stdout + err!.stderr).toContain('Setup required: SBA_VERIFY_BIN');
    expect(err!.stdout).not.toContain('all checks pass');
  });
});

test.describe('landing (one-screen overview)', () => {
  test('first screen: the headline, one subline, two buttons and the envelopes; no horizontal scroll', async ({ page }, info) => {
    await page.goto(LANDING);
    await expect(page).toHaveTitle('Fuin · sealed-bid auctions on Zcash');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Three sealed bids. One envelope opens.');
    await expect(page.locator('.sub')).toHaveText('Every bid is an equal shielded Zcash deposit. A zero-knowledge proof opens only the winner.');
    const ctas = page.locator('.cover .cta a');
    await expect(ctas).toHaveText(['Verify it in the saleroom', 'See the evidence']);
    await expect(ctas.nth(0)).toHaveAttribute('href', 'saleroom/');
    await expect(ctas.nth(1)).toHaveAttribute('href', 'evidence.html');
    await expect(page.locator('#stage .env')).toHaveCount(s3.proven.length);
    await expect(page.locator('#stage .env.win .letter strong')).toHaveText(winTaz);
    await expect(page.locator('#stage')).toHaveClass(/is-open/);
    await expect(page.locator('#win-note')).toHaveText('opened by the proof');
    // No txids or block ranges on the landing: they live on the evidence page.
    expect(await page.locator('body').innerText()).not.toMatch(/[0-9a-f]{8}…|blocks \d/);
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`landing-first-screen-${info.project.name}.png`) });
  });

  test('reduced motion: the winner is open on load, with no transition', async ({ browser }, info) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: info.project.use.viewport! });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(LANDING);
    await expect(page.locator('#stage')).toHaveClass(/is-open/, { timeout: 500 });
    expect(await page.locator('.env.win .letter').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test('proof numbers are real: three sale records, the TESTING.md total; the evidence link opens the catalogue', async ({ page }) => {
    await page.goto(LANDING);
    const testing = readFileSync(resolve(root, 'TESTING.md'), 'utf8');
    const total = testing.match(/\*\*total\*\* \| \| \| \*\*(\d+) passed/)![1];
    await expect(page.locator('.facts b')).toHaveText([String([sale1, sale2, sale3].length), total, '0']);
    await expect(page.locator('.strip h3')).toHaveText(['Live', 'Setup required']);
    await page.getByRole('link', { name: 'See the evidence' }).last().click();
    await expect(page).toHaveURL(EVIDENCE);
    await expect(page.locator('#lots h2')).toHaveText('Every deposit to the auction');
  });

  test('footer CTA and links: saleroom, evidence, tests, repository', async ({ page }) => {
    await page.goto(LANDING);
    await expect(page.locator('.end').getByRole('link', { name: 'Open the saleroom' })).toHaveAttribute('href', 'saleroom/');
    const foot = page.getByRole('contentinfo').getByRole('navigation', { name: 'Links' });
    await expect(foot.getByRole('link', { name: 'Evidence' })).toHaveAttribute('href', 'evidence.html');
    await expect(foot.getByRole('link', { name: 'Tests' })).toHaveAttribute('href', `${REPO}/blob/main/TESTING.md`);
    await expect(foot.getByRole('link', { name: 'Repository' })).toHaveAttribute('href', REPO);
    await expect(page.getByRole('contentinfo')).toContainText('Copyright (c) 2026 Nivesh Gajengi');
  });
});
