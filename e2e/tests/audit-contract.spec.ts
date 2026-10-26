import { test, expect, LANDING, EVIDENCE, SALEROOM, REPO, VK_PATH, sale1, sale2, sale3, noHorizontalScroll, inView } from './fixtures';
import type { Page, Locator } from '@playwright/test';

const sales = [{ id: '003', r: sale3, file: 'testnet-sale003.json' }, { id: '002', r: sale2, file: 'testnet-reveal.json' }, { id: '001', r: sale1, file: 'testnet.json' }];
const taz = (z: string) => `${Number(z) / 1e8} TAZ`;
const fmt = (z: number) => z.toLocaleString('en-US');
const opened = 'The proof opened one envelope: 0.00135 TAZ, the highest bid. The other two are never published.';
async function holds(page: Page) {
  await expect(page.locator('.verify h2')).toHaveText('The result holds.', { timeout: 30_000 });
  await expect(page.locator('.verify .step-ok')).toHaveCount(4);
  await expect(page.locator('.verify button:disabled')).toHaveCount(0);
}
async function content(loc: Locator, phrases: string[]) {
  for (const phrase of phrases) await expect(loc).toContainText(phrase);
}
async function bounds(page: Page, selector: string) {
  const elements = page.locator(selector);
  for (let i = 0; i < await elements.count(); i++) {
    const el = elements.nth(i);
    if (!await el.isVisible()) continue;
    await el.scrollIntoViewIfNeeded();
    const fits = await el.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return r.left >= -1 && r.right <= innerWidth + 1 && r.width > 0 && r.height > 0;
    });
    expect(fits, `clipped ${selector} element ${i}`).toBe(true);
  }
  await noHorizontalScroll(page);
}
async function keyboardLink(page: Page, link: Locator) {
  // Focus with keyboard, including the browser's focus-visible modality.
  await link.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(link).toBeFocused();
  expect(await link.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
}

test('audit landing: masthead, artwork, steps, privacy, live/setup text and footer contract', async ({ page, request }) => {
  await page.goto(LANDING);
  await expect(page.locator('.word b')).toHaveText('Fuin');
  await expect(page.locator('.word span')).toHaveText('封印 · seal');
  await expect(page.locator('.word')).toHaveAttribute('href', './');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const [name, href] of [['Evidence', 'evidence.html'], ['Saleroom', 'saleroom/'], ['Code', REPO]]) await expect(nav.getByRole('link', { name, exact: true, includeHidden: true })).toHaveAttribute('href', href);
  await expect(nav.getByRole('link', { name: 'Code' })).toBeVisible();
  await expect(page.locator('.cover .lotno')).toHaveText('SALE 003Zcash testnet');
  expect(await page.locator('.cover .lotno').evaluate((e) => e.getBoundingClientRect().bottom <= document.querySelector('h1')!.getBoundingClientRect().top)).toBe(true);
  expect((await request.get(new URL('assets/hero.webp', LANDING).href)).status()).toBe(200);
  await expect(page.locator('.art img')).toHaveJSProperty('complete', true);
  expect(await page.locator('.art img').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
  expect(await page.locator('.art img').evaluate((e) => getComputedStyle(e).objectFit)).toBe('cover');
  for (const el of await page.locator('.cover h1, .cover .cta a').all()) {
    expect(await el.evaluate((e) => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  }
  await expect(page.locator('.steps h3')).toHaveText(['Seal', 'Reveal', 'Prove']);
  await expect(page.locator('.steps p')).toHaveText([
    'Each bidder sends the same deposit, a commitment to its bid in the memo.',
    'After the close, each bid travels in a shielded memo only the auctioneer reads.',
    'A Groth16 proof opens the highest bid; one transaction pays and refunds everyone.',
  ]);
  await expect(page.locator('.facts > div').last()).toHaveText('0Losing bids shown');
  expect((await page.locator('body').innerText()).match(/[\d.]+ TAZ/g)).toEqual(['0.00135 TAZ']);
  await expect(page.locator('#h-live')).toHaveText("What's live today");
  await expect(page.locator('.strip p')).toHaveText([
    'Three settled testnet sales, and a saleroom that re-checks each proof in your tab.',
    'Running a sale needs your own funded testnet wallets. No hosted auction service; no mainnet.',
  ]);
  await expect(page.locator('form, input')).toHaveCount(0);
  await expect(page.locator('.end h2')).toHaveText("Don't trust the auctioneer. Check it.");
  await expect(page.locator('.end p')).toHaveText('The saleroom verifies the proof and the rules in your browser.');
  await content(page.locator('footer'), ['MIT', 'Copyright (c) 2026 Nivesh Gajengi', 'Zcash testnet', 'not audited']);
  for (const [name, href] of [['Evidence', 'evidence.html'], ['Saleroom', 'saleroom/'], ['Tests', REPO + '/blob/main/TESTING.md'], ['Repository', REPO]]) await expect(page.locator('footer').getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  await bounds(page, 'h1, h2, h3, .steps li, .facts > div, .cta a, .strip > div, footer a');
});

for (const source of ['hero saleroom', 'hero evidence', 'footer saleroom']) {
  test(`audit landing keyboard navigation: ${source}`, async ({ page }) => {
    await page.goto(LANDING);
    const link = source === 'hero evidence' ? page.locator('.cover .cta a').nth(1) : source === 'hero saleroom' ? page.locator('.cover .cta a').first() : page.locator('.end a');
    await keyboardLink(page, link);
    if (source === 'hero evidence') {
      await expect(page).toHaveURL(EVIDENCE);
      await expect(page.locator('ul.lots').first()).toHaveClass(/lots/);
      expect(await page.locator('ul.lots').first().evaluate((e) => e.closest('section')!.id)).toBe('lots');
      await expect(page.locator('#lots h2')).toHaveText('Every deposit to the auction');
    } else {
      // Landing CTAs belong to the landing deployment even when the saleroom
      // checks separately target Vite's root through FUIN_SALEROOM.
      await expect(page).toHaveURL(new URL('saleroom/', LANDING).href);
      await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText('Sale 003 · current rules');
      await holds(page);
    }
  });
}

for (const route of [LANDING, EVIDENCE]) {
  test(`audit envelope timing and interrupted reload: ${route === LANDING ? 'landing' : 'evidence'}`, async ({ page }) => {
    // Install the real browser clock before application scripts; pause only time, never replace application logic.
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.goto(route);
    const stage = page.locator('#stage');
    await stage.scrollIntoViewIfNeeded();
    if (route === EVIDENCE) await page.waitForTimeout(100); // allow the real observer callback to queue its delay
    await expect(stage).not.toHaveClass(/is-open/);
    await page.clock.runFor(899);
    await expect(stage).not.toHaveClass(/is-open/);
    await page.clock.runFor(1);
    await expect(stage).toHaveClass(/is-open/);
    // Reload while the seal/flap/letter CSS transition is in progress.
    await page.reload();
    await stage.scrollIntoViewIfNeeded();
    if (route === EVIDENCE) await page.waitForTimeout(100);
    await page.clock.runFor(3000);
    await expect(stage).toHaveClass(/is-open/);
    await expect(stage.locator('.env')).toHaveCount(3);
    await expect(stage.locator('.env.win')).toHaveCount(1);
    await expect(stage.locator('.letter strong')).toHaveText('0.00135 TAZ');
    await expect(stage.locator('.letter small')).toHaveText('Winning bid');
    // CSS transitions use Chrome's animation clock, independently of the paused JS clock.
    await expect.poll(() => stage.locator('.env.win .wax').evaluate((e) => getComputedStyle(e).opacity), { timeout: 3000 }).toBe('0');
    for (const wax of await stage.locator('.env:not(.win) .wax').all()) expect(await wax.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    await expect(stage.locator('.env-note')).toHaveText(route === LANDING ? ['sealed', 'opened by the proof', 'sealed'] : ['sealed for good', 'opened by the proof', 'sealed for good']);
    if (route === EVIDENCE) {
      await expect(page.locator('#reveal')).toHaveText('Seal it again');
      await expect(page.locator('#stage-status')).toHaveText(opened);
      await page.locator('#reveal').click();
      await expect(page.locator('#stage-status')).toHaveText('Three equal deposits. Nothing on chain says which bid is highest.');
      await page.locator('#reveal').click();
      await expect(page.locator('#stage-status')).toHaveText(opened);
    }
  });
  test(`audit reduced envelope motion: ${route === LANDING ? 'landing' : 'evidence'}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(route);
    await expect(page.locator('#stage')).toHaveClass(/is-open/, { timeout: 500 });
    for (const el of await page.locator('.letter, .flap, .wax').all()) expect(await el.evaluate((e) => getComputedStyle(e).transitionDuration)).toBe('0s');
    if (route === LANDING) {
      expect(await page.locator('.art').evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
      expect(await page.locator('.art').evaluate((e) => getComputedStyle(e, '::before').animationName)).toBe('none');
    } else expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  });
}

test('audit evidence: observer fallback, home activation and skip target', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).IntersectionObserver; });
  await page.goto(EVIDENCE);
  await expect(page.locator('#stage')).toHaveClass(/is-open/, { timeout: 500 });
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to the sale' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await inView(page, '#cover h1');
  await keyboardLink(page, page.getByRole('link', { name: 'Fuin, home' }));
  await expect(page).toHaveURL(LANDING);
});

test('audit evidence: labels, padded clock, catalogue details, provenance and exact log disclosures', async ({ page }) => {
  await page.goto(EVIDENCE);
  for (const v of await page.locator('#digits b').allTextContents()) expect(v).toMatch(/^\d{2,}$/);
  await content(page.locator('#stage'), ['Lot 01', 'bidder1', '372e205c…', 'Lot 02', 'bidder2', 'dc95f63d…', 'Lot 03', 'bidder3', '37e5c2df…:1']);
  await content(page.locator('#lots'), ['Never opened', '1 tx', 'winning bid and the forfeit', "winner's change and every revealed losing deposit"]);
  for (const lot of await page.locator('#lots .lot').filter({ has: page.locator('.tag-sealed') }).all()) {
    await content(lot, ['refunded in full', 'amount never published']);
    await expect(lot.locator('.plate')).toHaveText('');
  }
  await content(page.locator('#reveals .prov-side'), ['unfounded: its reveal was honoured', 'payment was not checked by it']);
  await content(page.locator('#provenance'), ['Ironwood only', "[ 4 lines omitted: pnpm's header ]", '[ 1 line omitted: the dispute-window scan', '1 valid deposit(s) declared unrevealed', 'slots 0-2 are the 3 revealed valid deposits in chain order; slots 3-7 are empty', 'unfounded: reveal 6e9e9cf97c (block 4530306) was honoured; payment not checked: the complaint gives no refund viewing key']);
  const lines = (await page.getByLabel(/Audit output/).innerText()).split('\n');
  expect(lines.at(-1)).toBe("chain checks pass; payments not checked: give the seller's incoming viewing key (SBA_SELLER_UIVK) to check the seller's payout, and a complaint with a refund key to check a refund");
  for (const { id, r } of sales.filter((s) => s.id !== '003')) {
    const sec = page.locator(`#sale${id}`);
    await content(sec.locator('.sec-head'), [r.auction.name, taz(r.auction.depositZat), taz(r.auction.reserveZat), `${fmt(r.auction.openHeight)}–${fmt(r.auction.closeHeight)}`, `hammer at block ${fmt(r.settlement.height)}`]);
    await content(sec.locator('.ledger-head'), [`block ${fmt(r.settlement.height)}`, 'Ironwood only']);
    if (id === '002') {
      await content(sec, ['reveals until block 4,526,479', 'stays in the auction wallet', 'first payment of a two-payment transaction', 'second payment in the same transaction', 'unfounded: its reveal was honoured and it was paid 5,000 of 5,000 zat', 'block 4,526,500']);
      await expect(sec.locator('.plate-refused span')).toHaveText(['Memo mismatch', 'Memo mismatch', 'Memo mismatch', 'Memo mismatch', 'Duplicate']);
    } else {
      await expect(sec.locator('.plate-refused span')).toHaveText(['Wrong amount', 'Memo mismatch', 'Duplicate', 'Late']);
      await content(sec, ['Not the 0.02 TAZ deposit', 'Memo is not a bid commitment', 'Same commitment as Lot 02', 'Mined after the close at 4,522,278']);
    }
    for (const plate of await sec.locator('.plate-sealed:not(.plate-unrev)').all()) await expect(plate).toHaveText('');
  }
});

test('audit evidence: full conditions, scan limit, prior art, tamper description and intermediate navigation', async ({ page }) => {
  await page.goto(EVIDENCE);
  await content(page.locator('#conditions'), [
    'close, reveal window, reserve, deposit, keys and seller', 'Sales 001 and 002 predate this', '248-bit salt', 'Poseidon(auction, bid, salt)', 'sba1:<auction>:<commitment>',
    'Deposits mined after the close height are late', 'A copied commitment is a duplicate', 'a wrong amount or a non-bid memo is not a bid', 'Only the first 8 revealed valid deposits compete',
    'A reveal outside the window, one that does not decrypt, or one whose opening does not match the deposit it names is refused',
    'highest bid and meets the reserve', 'any unused slot must be empty', 'refunds every losing bid in full', '60,000 zat fee budget',
    'every revealed deposit is refunded minus its output fee', 'A proof with reserve 0', "Filing one makes that bidder's own bid public.",
  ]);
  await content(page.locator('#report'), ['a record says how far it scanned', 'the audit reports later notes', 'late and cannot change the outcome']);
  await expect(page.locator('#new h2')).toHaveText('Not the first sealed-bid ZK auction');
  await expect(page.getByRole('link', { name: 'Nightash', exact: true })).toHaveAttribute('href', 'https://nightash.org/en/news/near-intents-zec-auction-settlement-2026-09-14/');
  await content(page.locator('#saleroom'), ['two tamper buttons that break them']);
  for (const width of [641, 768, 900, 901, 1040]) {
    await page.setViewportSize({ width, height: 800 });
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await expect(nav.getByRole('link', { name: 'What is new' })).toBeVisible({ visible: width > 900 });
    const boxes = await nav.locator('a:visible').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right);
    // The destination remains reachable by ordinary scrolling when its masthead link is hidden.
    await page.locator('#new h2').scrollIntoViewIfNeeded();
    await expect(page.locator('#new h2')).toBeInViewport();
  }
});

for (const { id, r, file } of sales) {
  test(`audit Sale ${id}: direct/reload, tabs, exact audit setup, disclosure isolation and footer`, async ({ page }) => {
    await page.goto(`${SALEROOM}?sale=${id}`);
    for (let reload = 0; reload < 2; reload++) {
      if (reload) await page.reload();
      await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText(new RegExp(`Sale ${id}`));
      await expect(page.locator('[role=tab][aria-selected=true]')).toHaveCount(1);
      await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', `tab-${id}`);
      await expect(page.locator('.verify .eyebrow')).toHaveText(`Verify in this tab · Sale ${id}`);
      await holds(page);
    }
    const audit = page.locator('section[aria-labelledby=audit-title]');
    await expect(audit.locator('code.cmd')).toHaveText(`pnpm --filter @sba/service run audit deployments/${file}${id === '001' ? '' : ` deployments/${r.complaints[0].file}`}`);
    await content(audit, ['scans the auction', 're-applies the rules', 'SBA_SELLER_UIVK', 'payments not checked', id === '003' ? 'hash of every term' : 'windows and reserve are read from the record ("legacy")']);
    await content(page.locator('.verify'), ['This page checks the record against itself.', 're-reads the deposits from the chain']);
    const det = page.locator('details.key');
    await expect(det).not.toHaveAttribute('open', '');
    await expect(det.locator('code')).toBeHidden();
    await det.locator('summary').click();
    // Compare privately in the browser: no key values in assertion output or screenshots.
    expect(await det.locator('code').evaluate((e, key) => e.textContent === key, r.auction.uivk)).toBe(true);
    await content(det, ['It cannot spend, and it never shows a bid.']);
    await det.locator('summary').click();
    await expect(det.locator('code')).toBeHidden();
    await det.locator('summary').click();
    await page.getByRole('tab', { name: /Sale 003/ }).click();
    if (id !== '003') await expect(det.locator('code')).toBeHidden();
    await content(page.locator('footer'), ['MIT', 'Copyright (c) 2026 Nivesh Gajengi', 'the auctioneer learns every bid at the reveal', "the public learns only the winner's"]);
    if (id === '001') {
      await page.getByRole('tab', { name: /Sale 001/ }).click();
      await expect(page.getByRole('table', { name: 'Reveal notes on chain' })).toHaveCount(0);
      await expect(page.locator('.complaint')).toHaveCount(0);
      await content(page.locator('section[aria-labelledby=prov-title]'), ['An altered reveal', r.alteredReveal.reason]);
    } else {
      await page.getByRole('tab', { name: new RegExp(`Sale ${id}`) }).click();
      const card = page.locator('.complaint');
      await content(card, ['bidder2 with MCP complain', 'unfounded', id === '003' ? 'reveal 6e9e9cf97c (block 4530306) was honoured' : 'reveal 07ec9dcd08 (block 4526464) was honoured', id === '003' ? 'payment not checked: the complaint gives no refund viewing key' : 'paid in full: the refund address received 5000 zat in settlement e84de386e2, owed 5000']);
      await expect(card.locator('dd[title]')).toHaveText(/^[0-9a-f]{16}…$/);
      expect(await card.innerText()).not.toMatch(/uviewtest1\w+|utest1\w+|revealSecret|refundViewingKey/);
      await content(page.locator('section[aria-labelledby=sale2-title] .facts'), ['2 deposits (valid, duplicate)']);
    }
  });
}

for (const query of ['?sale=unknown', '?sale=']) {
  test(`audit unknown sale defaults safely: ${query}`, async ({ page }) => {
    await page.goto(SALEROOM + query);
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText('Sale 003 · current rules');
    await holds(page);
  });
}

test('audit switching sales resets filters and removes unavailable Unrevealed chip', async ({ page }) => {
  await page.goto(SALEROOM);
  for (const filter of ['Unrevealed', 'Refused']) {
    await page.getByRole('tab', { name: /Sale 003/ }).click();
    await page.getByRole('button', { name: new RegExp(`^${filter} `) }).click();
    await page.getByRole('tab', { name: /Sale 001/ }).click();
    await expect(page.getByRole('button', { name: 'All 7' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('ul.lots > li')).toHaveCount(7);
    await expect(page.getByRole('button', { name: /^Unrevealed/ })).toHaveCount(0);
  }
});

test('audit delayed verification: disabled actions, final sale owns results after old responses resolve', async ({ page }) => {
  const pending: (() => void)[] = [];
  // React StrictMode deliberately runs mount effects twice in Vite dev. Hold
  // both real requests for each mount so stale responses are released together.
  const perMount = process.env.FUIN_DEV === '1' ? 2 : 1;
  await page.route('**/verification_key.json', async (route) => {
    await new Promise<void>((resolve) => pending.push(resolve));
    await route.continue();
  });
  await page.goto(SALEROOM);
  await expect.poll(() => pending.length).toBe(perMount);
  await expect(page.locator('.verify button:disabled')).toHaveCount(3);
  await page.getByRole('tab', { name: /Sale 002/ }).click();
  await expect.poll(() => pending.length).toBe(2 * perMount);
  await expect(page.locator('.verify button:disabled')).toHaveCount(3);
  await page.getByRole('tab', { name: /Sale 001/ }).click();
  await expect.poll(() => pending.length).toBe(3 * perMount);
  pending.slice(2 * perMount).forEach((release) => release());
  await holds(page);
  pending.slice(0, 2 * perMount).forEach((release) => release());
  await expect(page.locator('.sale-meta code')).toHaveText(sale1.auction.name);
  await expect(page.locator('.verify')).toContainText('slot 2 is deposit d910ebad41');
  await expect(page.locator('ul.lots > li')).toHaveCount(7);
  await expect(page.locator('.complaint')).toHaveCount(0);
  await holds(page);
});

for (const failure of ['invalid JSON', 'HTTP 503']) {
  test(`audit verification recovery from ${failure}`, async ({ page, health }) => {
    if (failure === 'HTTP 503') health.allowSameOriginStatus(VK_PATH, 503);
    await page.route('**/verification_key.json', (r) => r.fulfill({ status: failure === 'HTTP 503' ? 503 : 200, body: 'invalid-json' }));
    await page.goto(SALEROOM);
    await expect(page.locator('.verify h2')).toHaveText('Could not finish the checks.');
    await expect(page.locator('.verify .step-error')).toHaveCount(4);
    await expect(page.locator('.verify .step-ok')).toHaveCount(0);
    await expect(page.locator('.verify button:disabled')).toHaveCount(0);
    await expect(page.locator('.verify')).toContainText(failure === 'HTTP 503' ? 'verification_key.json: HTTP 503' : /JSON|Unexpected token/);
    await expect(page.locator('.verify .step').last()).toContainText('not run: an earlier check could not finish');
    await page.unroute('**/verification_key.json');
    await page.getByRole('button', { name: 'Check the published result' }).click();
    await holds(page);
  });
}

test('audit saleroom reduced motion keeps real verification and keyboard controls working', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release!: () => void;
  await page.route('**/verification_key.json', async (route) => { await new Promise<void>((r) => { release = r; }); await route.continue(); });
  await page.goto(SALEROOM);
  await expect(page.locator('.step-run .step-mark')).toHaveCount(1);
  expect(await page.locator('.step-run .step-mark').evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  release();
  await holds(page);
  await page.unroute('**/verification_key.json');
  const check = page.getByRole('button', { name: 'Claim 1 zat more' });
  await keyboardLink(page, check);
  await expect(page.locator('.verify h2')).toHaveText('The result does not hold.');
});

for (const route of [LANDING, EVIDENCE, SALEROOM]) {
  test(`audit full layout and reachable lower sections: ${route}`, async ({ page }, info) => {
    await page.goto(route);
    await page.evaluate(() => document.fonts.ready);
    if (route === SALEROOM) await holds(page);
    await bounds(page, route === SALEROOM ? '.bar a, [role=tab], .timeline li, .clock, .lot, .chip, .verify button, .reveal-row:not(.ledger-head), .complaint' : 'h1, h2, h3, .lot, .row, .env-label, .term, footer a');
    for (const heading of await page.locator('h2').all()) { await heading.scrollIntoViewIfNeeded(); await expect(heading).toBeInViewport(); }
    if (route === SALEROOM) {
      const columns = await page.locator('ul.lots').evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
      expect(columns).toBe(info.project.name === 'mobile' ? 1 : 3);
      if (info.project.name === 'mobile') {
        for (const column of [2, 3]) expect(await page.locator('.ledger-row:not(.ledger-head)').first().locator(`span[role=cell]:nth-child(${column})`).evaluate((e) => getComputedStyle(e, '::before').content)).toMatch(/expected|decrypted/i);
      }
    }
    await page.screenshot({ path: info.outputPath('layout.jpg'), type: 'jpeg', quality: 65 });
  });
}

test('audit browser-only empty catalogue fixture restores the real published lots', async ({ page }) => {
  await page.goto(SALEROOM);
  await holds(page);
  // This fixture changes only the live component's in-memory deposits. It never
  // rewrites a record, replaces a network response or adds a product test mode.
  await page.locator('ul.lots').evaluate((el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))!;
    let fiber = (el as any)[key];
    while (fiber && !fiber.memoizedProps?.sale) fiber = fiber.return;
    const record = fiber.memoizedProps.sale.r;
    (window as any).__emptyCatalogue = { record, deposits: record.deposits };
    record.deposits = [];
    const label = document.createElement('p');
    label.id = 'empty-fixture-label';
    label.textContent = 'Browser-only empty-deposits fixture; published files unchanged.';
    document.body.prepend(label);
  });
  await page.getByRole('tab', { name: /Sale 002/ }).click();
  await page.getByRole('tab', { name: /Sale 003/ }).click();
  await expect(page.getByRole('button', { name: 'All 0' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.empty')).toHaveText('No lots in this group.');
  await expect(page.locator('ul.lots > li')).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).__emptyCatalogue; f.record.deposits = f.deposits; document.getElementById('empty-fixture-label')!.remove(); });
  await page.getByRole('tab', { name: /Sale 002/ }).click();
  await page.getByRole('tab', { name: /Sale 003/ }).click();
  await expect(page.getByRole('button', { name: 'All 5' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('ul.lots > li')).toHaveCount(5);
  await holds(page);
});

test('audit entry: wordmark, correct-origin assets, Code target and keyboard skip focus', async ({ page }) => {
  const assets: { url: string; type: string }[] = [];
  page.on('request', (r) => { if (['script', 'stylesheet'].includes(r.resourceType())) assets.push({ url: r.url(), type: r.resourceType() }); });
  await page.goto(SALEROOM);
  await expect(page.locator('.word b')).toHaveText('Fuin');
  await expect(page.locator('.word span')).toHaveText('Saleroom');
  const code = page.getByRole('link', { name: 'Code ↗' });
  await expect(code).toHaveAttribute('href', REPO);
  await expect(code).toHaveAttribute('target', '_blank');
  const localAssets = assets.filter((a) => /^https?:/.test(a.url) && new URL(a.url).origin === new URL(SALEROOM).origin);
  expect(localAssets.some((a) => a.type === 'script')).toBe(true);
  if (process.env.FUIN_DEV === '1') {
    // Vite's CSS module is requested as JavaScript, then injected into a style tag.
    expect(localAssets.some((a) => new URL(a.url).pathname === '/src/styles.css')).toBe(true);
    await expect(page.locator('style[data-vite-dev-id$="/src/styles.css"]')).toHaveCount(1);
  } else expect(localAssets.some((a) => a.type === 'stylesheet')).toBe(true);
  for (const a of localAssets) expect(new URL(a.url).pathname.startsWith(new URL(SALEROOM).pathname)).toBe(true);
  const skip = page.getByRole('link', { name: 'Skip to the saleroom' });
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await keyboardLink(page, page.getByRole('link', { name: 'Fuin saleroom' }));
  await expect(page).toHaveURL(/#main$/);
  await holds(page);
});

for (const { id, r } of sales) {
  test(`audit Sale ${id}: timer advances exactly once per second and never goes negative`, async ({ page }) => {
    const time = new Date((r.blockTimes.settlement.time + 90061) * 1000);
    await page.clock.install({ time });
    await page.clock.pauseAt(time);
    await page.goto(`${SALEROOM}?sale=${id}`);
    const read = () => page.locator('.clock .digits > span').allTextContents();
    await expect.poll(read).toEqual(['01D', '01H', '01M', '01S']);
    await page.clock.runFor(999);
    expect(await read()).toEqual(['01D', '01H', '01M', '01S']);
    await page.clock.runFor(1);
    expect(await read()).toEqual(['01D', '01H', '01M', '02S']);
    await page.clock.setSystemTime(new Date((r.blockTimes.settlement.time - 100) * 1000));
    await page.clock.runFor(1000);
    expect(await read()).toEqual(['00D', '00H', '00M', '00S']);
    await expect(page.getByRole('timer')).toHaveAttribute('aria-label', '0 days 0 hours 0 minutes since the hammer');
  });
  test(`audit Sale ${id}: all actions disable throughout a recheck and re-enable on completion`, async ({ page }) => {
    await page.goto(`${SALEROOM}?sale=${id}`);
    await holds(page);
    let release!: () => void;
    await page.route('**/verification_key.json', async (route) => { await new Promise<void>((r) => { release = r; }); await route.continue(); });
    await page.getByRole('button', { name: 'Check the published result' }).click();
    await expect(page.locator('.verify button:disabled')).toHaveCount(3);
    await expect.poll(() => typeof release).toBe('function');
    release();
    await holds(page);
  });
}

test('audit static pages remain usable without a Rust verifier and do not relabel the recorded audit as fresh', async ({ page }) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await page.goto(EVIDENCE);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel('Audit output, recorded 23 Oct 2026')).toBeVisible();
  const command = (await page.locator('#provenance .term .c').innerText()).replace(/^\$ /, '').split(' ');
  // Omit the complaint argument: absence is detected before any live scan and no
  // complaint document or wallet is opened by this preflight check.
  const err = await promisify(execFile)(command[0], command.slice(1, 6), {
    cwd: (await import('./fixtures')).root,
    env: { ...process.env, SBA_VERIFY_BIN: '/nonexistent/sba-verify' }, timeout: 60_000,
  }).then(() => null, (e: { stdout: string; stderr: string }) => e);
  expect(err).not.toBeNull();
  expect(err!.stdout + err!.stderr).toContain('Setup required: SBA_VERIFY_BIN');
  expect(err!.stdout).not.toContain('all checks pass');
  await expect(page.getByLabel('Audit output, recorded 23 Oct 2026')).toBeVisible();
  await page.goto(SALEROOM);
  await holds(page);
});
