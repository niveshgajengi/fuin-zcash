import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { EXPLORER, LANDING, REPO, SALEROOM, VK_PATH, expect, fmt, noHorizontalScroll, root, sale1, sale2, sale3, test } from './fixtures';
import type { Page } from '@playwright/test';

type Dep = { txid: string; output?: string; height: number; valueZat: string; memo: string; status: string; reason: string | null };
const ref = (d: { txid: string; output?: string }) => (d.output === undefined ? d.txid : `${d.txid}:${d.output}`);
const taz = (z: string | number) => `${(Number(z) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 6 })} TAZ`;
const utc = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);

/** What the page must show for a record: proven deposits (valid, revealed, chain order), the winner, each lot's kind. */
function derive(rec: typeof sale1) {
  const unrevealed: string[] = rec.outcome.unrevealed ?? [];
  const deposits = rec.deposits as Dep[];
  const proven = deposits.filter((d) => d.status === 'valid' && !unrevealed.includes(ref(d)));
  const winner = proven[rec.outcome.winnerSlot];
  const kindOf = (d: Dep) => (ref(d) === ref(winner) ? 'opened' : d.status !== 'valid' ? 'refused' : unrevealed.includes(ref(d)) ? 'unrevealed' : 'sealed');
  return { deposits, unrevealed, proven, winner, kindOf };
}

const SALES = [
  { id: '003', rec: sale3, url: SALEROOM, tab: 'Sale 003 · current rules' },
  { id: '002', rec: sale2, url: `${SALEROOM}?sale=002`, tab: 'Sale 002 · reveal channel' },
  { id: '001', rec: sale1, url: `${SALEROOM}?sale=001`, tab: 'Sale 001 · first sale' },
] as const;

const verify = (page: Page) => page.locator('section.verify');
const step = (page: Page, label: string) => verify(page).locator('.step', { hasText: label });
async function settled(page: Page, verdict: string) {
  await expect(verify(page).getByRole('heading')).toHaveText(verdict, { timeout: 30_000 });
  await expect(verify(page).getByRole('button')).toHaveCount(3);
  await expect(verify(page).locator('button:disabled')).toHaveCount(0);
}

test.describe('saleroom', () => {
  test('Sale 003 is the headline: the tabs switch the whole page and the URL; ?sale=002 and ?sale=001 open the earlier sales', async ({ page }, info) => {
    await page.goto(SALEROOM);
    const tabs = page.getByRole('tablist', { name: 'Sales' }).getByRole('tab');
    await expect(tabs).toHaveText(['Sale 003 · current rules', 'Sale 002 · reveal channel', 'Sale 001 · first sale']);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.sale-meta code')).toHaveText(sale3.auction.name);
    await settled(page, 'The result holds.');
    await tabs.nth(2).click();
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/\?sale=001$/);
    await expect(page.locator('.sale-meta code')).toHaveText(sale1.auction.name);
    await expect(page.locator('section[aria-labelledby=sale2-title]')).toHaveCount(0);
    await expect(verify(page).locator('.eyebrow')).toHaveText('Verify in this tab · Sale 001');
    await settled(page, 'The result holds.');
    await page.reload();
    await expect(page.locator('.sale-meta code')).toHaveText(sale1.auction.name);
    await tabs.nth(1).click();
    await expect(page).toHaveURL(/\?sale=002$/);
    await expect(page.locator('.sale-meta code')).toHaveText(sale2.auction.name);
    await settled(page, 'The result holds.');
    await tabs.first().click();
    await expect(page).toHaveURL(/\?sale=003$/);
    await expect(page.locator('.sale-meta code')).toHaveText(sale3.auction.name);
    await noHorizontalScroll(page);
    await page.screenshot({ path: info.outputPath(`saleroom-tabs-${info.project.name}.png`) });
  });

  for (const s of SALES) {
    const { deposits, unrevealed, proven, winner, kindOf } = derive(s.rec);

    test(`Sale ${s.id} header: hammer price, lede, timeline and live clock from the record; no horizontal scroll`, async ({ page }, info) => {
      await page.goto(s.url);
      await expect(page).toHaveTitle(/Fuin/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hammer price${taz(s.rec.outcome.winningBidZat)}`);
      await expect(page.locator('.sale-meta')).toContainText(`SALE ${s.id}`);
      await expect(page.locator('.sale-meta code')).toHaveText(s.rec.auction.name);
      await expect(page.locator('.sale-lede')).toContainText(`${proven.length} ${s.id !== '001' ? 'revealed sealed bids' : 'sealed bids'}, each an equal ${taz(s.rec.auction.depositZat)}`);
      if (s.id !== '001') await expect(page.locator('.sale-lede')).toContainText('placed through three separate sba-mcp servers driven by the reveal-run script');
      const tl = page.getByRole('list', { name: 'Auction timeline' }).locator('li');
      const bt = s.rec.blockTimes as { open: { height: number; time: number }; close: { height: number; time: number }; revealClose?: { height: number; time: number }; settlement: { height: number; time: number } };
      const rows = [['Open', bt.open], ['Close', bt.close], ...(bt.revealClose ? [['Reveals close', bt.revealClose]] : []), ['Hammer', bt.settlement]] as [string, { height: number; time: number }][];
      await expect(tl).toHaveCount(rows.length + 1);
      for (const [i, [label, b]] of rows.entries()) {
        await expect(tl.nth(i).locator('span')).toHaveText(label);
        await expect(tl.nth(i).locator('b')).toHaveText(fmt(b.height));
        await expect(tl.nth(i).locator('small')).toHaveText(`${utc(b.time)} UTC`);
      }
      await expect(tl.last().locator('b')).toHaveText(taz(s.rec.auction.reserveZat));
      await expect(tl.last().locator('span')).toHaveText('Reserve');
      await expect(tl.last().locator('small')).toHaveText('met');
      await expect(page.locator('.sale-lede')).toContainText('the other 2 are never published.');
      if (s.id === '001') await expect(page.locator('.sale-lede')).not.toContainText(/reveal-run|sba-mcp|reveal channel/);
      const clock = page.getByRole('timer');
      const label = (await clock.getAttribute('aria-label'))!;
      expect(label).toMatch(/^\d+ days? \d+ hours? \d+ minutes? since the hammer$/);
      for (const [n, unit] of label.matchAll(/(\d+) (\w+)/g).map((x) => [Number(x[1]), x[2]] as const)) if (unit !== 'since') expect(unit.endsWith('s')).toBe(n !== 1);
      const read = async () => (await clock.locator('.digits > span').allTextContents()).map((t) => parseInt(t, 10));
      const [d, h, m, sec] = await read();
      expect(d).toBeGreaterThanOrEqual(0);
      for (const [v, max] of [[h, 23], [m, 59], [sec, 59]]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(max); }
      expect(Math.abs(d * 86400 + h * 3600 + m * 60 + sec - (Math.floor(Date.now() / 1000) - bt.settlement.time))).toBeLessThanOrEqual(3);
      await expect.poll(async () => (await read()).join(':'), { timeout: 3000 }).not.toBe([d, h, m, sec].join(':'));
      await settled(page, 'The result holds.');
      await noHorizontalScroll(page);
      await page.screenshot({ path: info.outputPath(`saleroom-${s.id}-top-${info.project.name}.png`) });
    });

    test(`Sale ${s.id} verify in this tab: the record passes all four checks against the served verification key`, async ({ page, request }, info) => {
      await page.goto(s.url);
      await settled(page, 'The result holds.');
      const served = await (await request.get(SALEROOM + 'verification_key.json')).body();
      const sha = createHash('sha256').update(served).digest('hex');
      expect(sha).toBe(s.rec.verificationKeySha256);
      await expect(verify(page).locator('.step-ok')).toHaveCount(4);
      await expect(verify(page).locator('.verify-sub')).toHaveText(`Against the published Sale ${s.id} record, with the proof and checks the audit uses.`);
      await expect(step(page, 'Verification key is the published one')).toContainText(`sha256 ${sha.slice(0, 12)}… matches the record`);
      await expect(step(page, 'Groth16 proof verifies')).toContainText('pairing check passes in this tab (snarkjs)');
      await expect(step(page, 'Proof covers exactly the valid deposits')).toContainText(`slots 0-${proven.length - 1} are the ${proven.length} revealed valid deposits in chain order; slots 3-7 are empty`);
      await expect(step(page, 'Winner is a real deposit')).toContainText(`slot ${s.rec.outcome.winnerSlot} is deposit ${ref(winner).slice(0, 10)}`);
      await verify(page).screenshot({ path: info.outputPath(`saleroom-${s.id}-verify-ok-${info.project.name}.png`) });
    });

    test(`Sale ${s.id} tamper buttons: 1 zat more breaks the proof; a phantom bid breaks proof and slots; re-check restores`, async ({ page }, info) => {
      await page.goto(s.url);
      await settled(page, 'The result holds.');
      const v = verify(page);

      await v.getByRole('button', { name: 'Claim 1 zat more' }).click();
      await settled(page, 'The result does not hold.');
      await expect(v).toHaveClass(/is-bad/);
      await expect(v.locator('.verify-sub')).toHaveText('Tampered: the winning bid was raised by 1 zat.');
      await expect(step(page, 'Verification key is the published one')).toHaveClass(/step-ok/);
      await expect(step(page, 'Groth16 proof verifies')).toHaveClass(/step-bad/);
      await expect(step(page, 'Groth16 proof verifies')).toContainText('the proof does not verify for these public signals');
      await v.screenshot({ path: info.outputPath(`saleroom-${s.id}-tamper-bid-${info.project.name}.png`) });

      await v.getByRole('button', { name: 'Slip in a phantom bid' }).click();
      await settled(page, 'The result does not hold.');
      await expect(v.locator('.verify-sub')).toHaveText(`Tampered: slot ${proven.length}, which must be empty, now holds a commitment.`);
      await expect(step(page, 'Groth16 proof verifies')).toHaveClass(/step-bad/);
      await expect(step(page, 'Proof covers exactly the valid deposits')).toHaveClass(/step-bad/);
      await expect(step(page, 'Proof covers exactly the valid deposits')).toContainText(`slot ${proven.length} should be empty`);
      await v.screenshot({ path: info.outputPath(`saleroom-${s.id}-tamper-phantom-${info.project.name}.png`) });

      await v.getByRole('button', { name: 'Check the published result' }).click();
      await settled(page, 'The result holds.');
      await expect(v).toHaveClass(/is-ok/);
      await expect(v.locator('.step-ok')).toHaveCount(4);
    });

    test(`Sale ${s.id} lot filters: each chip shows exactly its lots and its count`, async ({ page }, info) => {
      await page.goto(s.url);
      const chips = page.getByRole('group', { name: 'Filter lots' });
      const lots = page.locator('ul.lots > li');
      const count: { [k: string]: number } = { all: deposits.length, sealed: 0, opened: 0, unrevealed: 0, refused: 0 };
      deposits.forEach((d) => count[kindOf(d)]++);
      const shown = [['Sealed', 'sealed'], ['Opened', 'opened'], ...(count.unrevealed ? [['Unrevealed', 'unrevealed']] : []), ['Refused', 'refused'], ['All', 'all']];
      await expect(chips.getByRole('button')).toHaveCount(shown.length);
      for (const [label, id] of shown) {
        const chip = chips.getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
        await expect(chip).toHaveText(`${label} ${count[id]}`);
        await chip.click();
        await expect(chip).toHaveAttribute('aria-pressed', 'true');
        await expect(chips.locator('[aria-pressed=true]')).toHaveCount(1);
        await expect(lots).toHaveCount(count[id]);
        const selected = deposits.map((d, i) => ({ d, i })).filter(({ d }) => id === 'all' || kindOf(d) === id);
        await expect(lots.locator('.lot-top b')).toHaveText(selected.map(({ i }) => `LOT ${String(i + 1).padStart(2, '0')}`));
        for (const [i, { d }] of selected.entries()) await expect(lots.nth(i).getByRole('link')).toHaveAttribute('href', EXPLORER + d.txid);
        if (id !== 'all') await expect(page.locator(`ul.lots > li:not(.lot-${id})`)).toHaveCount(0);
        await page.locator('section[aria-labelledby=lots-title]').screenshot({ path: info.outputPath(`saleroom-${s.id}-filter-${id}-${info.project.name}.png`) });
      }
    });

    test(`Sale ${s.id} lot cards: chain order, explorer links, only the winner’s amount shown, refusal reasons`, async ({ page }) => {
      await page.goto(s.url);
      const lots = page.locator('ul.lots > li');
      await expect(lots).toHaveCount(deposits.length);
      for (const [i, d] of deposits.entries()) {
        const lot = lots.nth(i);
        await expect(lot.locator('.lot-top b')).toHaveText(`LOT ${String(i + 1).padStart(2, '0')}`);
        const a = lot.getByRole('link', { name: `Transaction ${d.txid}${d.output === undefined ? '' : ` output ${d.output}`} on the explorer` });
        await expect(a).toHaveAttribute('href', EXPLORER + d.txid);
        await expect(a).toHaveAttribute('target', '_blank');
        await expect(a).toHaveText(`${d.txid.slice(0, 8)}…${d.output === undefined ? '' : `:${d.output}`} ↗`);
        await expect(lot.locator('dl > div').first().locator('dd')).toHaveText(taz(d.valueZat));
        const c = d.memo.split(':')[2];
        const canonical = c !== undefined && /^(0|[1-9][0-9]*)$/.test(c) && BigInt(c) < 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        if (canonical && d.status !== 'memo_mismatch') await expect(lot.locator('dd[title]')).toHaveAttribute('title', c);
        else await expect(lot.locator('dd[title]')).toHaveCount(0);
        if (kindOf(d) === 'sealed') {
          await expect(lot.locator('.plate')).toHaveText('');
          await expect(lot.locator('.why')).toHaveText('A losing bid. Refunded in full; the amount is never published.');
        }
        if (kindOf(d) === 'unrevealed') await expect(lot.locator('.plate')).toHaveText('Never opened');
        await expect(lot).toContainText(fmt(d.height));
        await expect(lot.locator('.tag')).toHaveText({ opened: 'Opened', sealed: 'Sealed', unrevealed: 'Unrevealed', refused: 'Refused' }[kindOf(d)]);
        if (kindOf(d) === 'refused') await expect(lot.locator('.why')).toHaveText(d.reason!);
        if (kindOf(d) === 'unrevealed')
          await expect(lot.locator('.why')).toContainText(s.id === '003' ? 'Never revealed: left out of the proof, listed in the outcome and forfeited to the seller' : 'Never revealed: left out of the proof and listed in the outcome');
      }
      await expect(page.locator('ul.lots')).toContainText(taz(s.rec.outcome.winningBidZat));
      await expect(page.locator('ul.lots .plate-open')).toHaveCount(1);
      expect(unrevealed.length).toBe(s.id === '001' ? 0 : 1);
    });

    test(`Sale ${s.id} provenance ledger: each recipient’s decrypted outputs match; settlement link`, async ({ page }, info) => {
      await page.goto(s.url);
      const sec = page.locator('section[aria-labelledby=prov-title]');
      await expect(sec.getByRole('link', { name: `${s.rec.settlement.txid.slice(0, 8)}… ↗` })).toHaveAttribute('href', EXPLORER + s.rec.settlement.txid);
      await expect(sec).toContainText(`block ${fmt(s.rec.settlement.height)} (${utc(s.rec.blockTimes.settlement.time)} UTC), ${s.rec.settlement.outputs.length} outputs`);
      // The column header row is display:none below 640 px (each cell carries its own label there).
      const rows = sec.getByRole('table', { name: 'Settlement outputs by recipient' }).locator('.ledger-row:not(.ledger-head)');
      await expect(rows).toHaveCount(s.rec.settlement.viewingKeyChecks.length);
      for (const c of s.rec.settlement.viewingKeyChecks as { recipient: string; expected: string; seen: number[]; ok: boolean }[]) {
        const row = rows.filter({ hasText: c.recipient });
        await expect(row.getByRole('cell').nth(1)).toHaveText(`${c.expected.split('+').map(fmt).join(' + ')} zat`);
        await expect(row.getByRole('cell').nth(2)).toHaveText(`${c.seen.map(fmt).join(' + ')} zat`);
        await expect(row.getByRole('cell').nth(3)).toHaveText(c.ok ? 'match' : 'mismatch');
      }
      await expect(sec).toContainText(`no transparent part: ${s.rec.ironwoodOnly ? 'yes' : 'no'}`);
      await expect(sec).toContainText(`Valid deposits declared unrevealed: ${unrevealed.length}`);
      await sec.screenshot({ path: info.outputPath(`saleroom-${s.id}-provenance-${info.project.name}.png`) });
    });
  }

  for (const s of SALES.filter((x) => x.id !== '001')) {
  const sale2 = s.rec;
  test(`Sale ${s.id}: every reveal note with its block, deposit and status; window, unrevealed and recipient checks`, async ({ page }, info) => {
    await page.goto(s.url);
    const sec = page.locator('section[aria-labelledby=sale2-title]');
    await expect(sec.getByRole('heading', { name: 'Bids opened by sealed memo' })).toBeVisible();
    await expect(sec.locator('.block-sub code').first()).toHaveText(sale2.auction.name);
    await expect(sec).toContainText('Three bidders, each its own sba-mcp server process with only its own wallet, bid and revealed through the MCP tools, driven by the reveal-run script (no language model chose a bid).');
    await expect(sec).toContainText(`Hammer price ${taz(sale2.outcome.winningBidZat)}`);
    const rows = sec.getByRole('table', { name: 'Reveal notes on chain' }).locator('.reveal-row:not(.ledger-head)');
    await expect(rows).toHaveCount(sale2.reveals.length);
    const statusText: { [k: string]: string } = { accepted: 'accepted', wrong_commitment: 'wrong deposit', late: 'late' };
    for (const [i, v] of sale2.reveals.entries()) {
      const row = rows.nth(i);
      await expect(row.getByRole('cell').nth(0)).toHaveText(fmt(v.height));
      await expect(row.getByRole('link')).toHaveAttribute('href', EXPLORER + v.txid);
      if (v.label) await expect(row.getByRole('cell').nth(1)).toContainText(v.label);
      await expect(row.getByRole('cell').nth(2)).toHaveText(v.deposit.length > 64 ? `${v.deposit.slice(0, 8)}…${v.deposit.slice(64)}` : `${v.deposit.slice(0, 8)}…`);
      await expect(row.getByRole('cell').nth(3)).toHaveText(statusText[v.status] ?? v.status);
    }
    await expect(sec).toContainText(`Reveal window: blocks ${fmt(sale2.auction.closeHeight + 1)}–${fmt(sale2.auction.revealCloseHeight)}; complaints until ${sale2.auction.disputeBlocks} blocks`);
    await expect(sec).toContainText(`Deposits never revealed, listed in the outcome: ${sale2.outcome.unrevealed.length}`);
    const checks = sale2.settlement.viewingKeyChecks;
    await expect(sec).toContainText(`${checks.filter((c: { ok: boolean }) => c.ok).length} of ${checks.length} match`);
    await noHorizontalScroll(page);
    await sec.screenshot({ path: info.outputPath(`saleroom-${s.id}-reveals-${info.project.name}.png`) });
  });
  }

  for (const s of SALES.filter((x) => x.id !== '001')) {
  const sale2 = s.rec;
  test(`Sale ${s.id} complaint: the digest computed in the tab is the one anchored on chain, and the verdict shown is the live audit’s`, async ({ page }, info) => {
    test.setTimeout(300_000);
    await page.goto(s.url);
    const card = page.locator('.complaint');
    const meta = sale2.complaints[0];
    await expect(card.locator('dd[title]')).toHaveAttribute('title', /^[0-9a-f]{64}$/);
    const digest = (await card.locator('dd[title]').getAttribute('title'))!;
    await expect(card.locator('dd[title]')).toHaveAttribute('title', digest);
    await expect(card).toContainText(`${digest.slice(0, 16)}…`);
    await expect(card.getByRole('link')).toHaveAttribute('href', EXPLORER + meta.anchor.txid);
    await expect(card).toContainText(`block ${fmt(meta.anchor.height)}`);
    await expect(card).toContainText(s.id === '002' ? "carries the incoming viewing key of bidder2's whole demo wallet" : 'It was filed without a refund key, so it publishes no viewing key.');
    // The anchor, read live from testnet with the auction's public viewing key: its memo carries exactly this digest.
    const bin = process.env.SBA_VERIFY_BIN ?? resolve(root, 'packages/verifier/target/release/sba-verify');
    expect(existsSync(bin), `Setup required: SBA_VERIFY_BIN (${bin})`).toBe(true);
    const { stdout: tx } = await promisify(execFile)(bin, ['tx', meta.anchor.txid], { env: { ...process.env, SBA_UIVK: sale2.auction.uivk }, timeout: 120_000 });
    const anchor = JSON.parse(tx);
    expect(anchor.height).toBe(meta.anchor.height);
    expect(anchor.outputs.map((o: { memo: { text?: string } }) => o.memo?.text)).toEqual([`sba1d:${sale2.auction.auctionId}:${digest}`]);
    // The verdict: run the command the page shows and find the quoted lines in its output.
    const cmd = (await page.locator('section[aria-labelledby=audit-title] code.cmd').innerText()).trim();
    expect(cmd).toBe(`pnpm --filter @sba/service run audit deployments/${s.id === '002' ? 'testnet-reveal.json' : 'testnet-sale003.json'} deployments/${meta.file}`);
    const { stdout } = await promisify(execFile)('pnpm', cmd.split(' ').slice(1), { cwd: root, timeout: 280_000, maxBuffer: 8 << 20 });
    const verdict = ((await card.locator('.verdict').textContent()) ?? '').trim(); // textContent: the badge is upper-cased by CSS only
    const m = verdict.match(/^(\w+) (.+?); ((?:paid in full|payment not checked): .+)\.$/)!;
    expect(m, verdict).not.toBeNull();
    expect(stdout).toContain(`${m[1]}: ${m[2]}`);
    expect(stdout).toContain(m[3]);
    // The complaint's refund key checks its refund; the seller's payout needs the seller's key, so the run does not claim "all checks pass".
    expect(stdout).toContain(
      s.id === '002'
        ? "\nchain checks pass; payments partly checked: the complaints' refunds were checked, the seller's payout needs the seller's incoming viewing key (SBA_SELLER_UIVK)"
        : "\nchain checks pass; payments not checked: give the seller's incoming viewing key (SBA_SELLER_UIVK) to check the seller's payout, and a complaint with a refund key to check a refund",
    );
    expect(stdout).not.toContain('all checks pass');
    await card.screenshot({ path: info.outputPath(`saleroom-${s.id}-complaint-${info.project.name}.png`) });
  });
  }

  test('audit: the viewing-key disclosure opens and closes and shows the published key', async ({ page }) => {
    await page.goto(SALEROOM);
    const det = page.locator('details.key');
    await expect(det.locator('code')).toBeHidden();
    await det.getByText('Auction incoming viewing key').click();
    await expect(det).toHaveAttribute('open', '');
    expect(await det.locator('code').evaluate((e, key) => e.textContent === key, sale3.auction.uivk)).toBe(true);
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
    await expect(page.getByRole('link', { name: 'Code ↗' })).toHaveAttribute('href', REPO);
    // Every audit command on the page is `pnpm --filter @sba/service run audit` (pnpm's own `audit` would run otherwise), with only files that exist.
    for (const code of await page.locator('code', { hasText: '@sba/service' }).allTextContents()) {
      expect(code.startsWith('pnpm --filter @sba/service run audit')).toBe(true);
      for (const f of code.split(' ').slice(5)) expect(existsSync(resolve(root, f)), f).toBe(true);
    }
    await page.getByRole('link', { name: 'Fuin saleroom' }).click();
    await expect(page).toHaveURL(/#main$/);
    // Vite dev has no adjacent landing page; production builds do.
    if (process.env.FUIN_DEV === '1') await expect(page.getByRole('link', { name: 'Catalogue' })).toHaveCount(0);
    else {
      await page.getByRole('link', { name: 'Catalogue' }).click();
      await expect(page).toHaveURL(LANDING);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
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
    health.allowSameOrigin404(VK_PATH);
    await page.route('**/verification_key.json', (r) => r.fulfill({ status: 404, body: 'not found' }));
    await page.goto(SALEROOM);
    await settled(page, 'Could not finish the checks.');
    await expect(step(page, 'Verification key is the published one')).toHaveClass(/step-error/);
    await expect(step(page, 'Verification key is the published one')).toContainText('verification_key.json: HTTP 404');
    await expect(verify(page).locator('.step-ok')).toHaveCount(0);
    for (const later of ['Groth16 proof verifies', 'Proof covers exactly the valid deposits', 'Winner is a real deposit']) {
      await expect(step(page, later)).toHaveClass(/step-error/);
      await expect(step(page, later)).toContainText('not run: an earlier check could not finish');
    }
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
