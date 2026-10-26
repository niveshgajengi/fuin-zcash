import { test, expect, SALEROOM, sale1, sale2, sale3 } from './fixtures';

test('reverify exact fallback queries retain the Sale 003 record, lots and proof', async ({ page }) => {
  for (const query of ['?sale=bogus', '?sale=004', '?sale=']) {
    await page.goto(SALEROOM + query);
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText('Sale 003 · current rules');
    await expect(page.locator('.sale-meta code')).toHaveText(sale3.auction.name);
    await expect(page.locator('ul.lots > li')).toHaveCount(sale3.deposits.length);
    await expect(page.locator('.verify h2')).toHaveText('The result holds.');
    await expect(page.locator('.verify .step-ok')).toHaveCount(4);
  }
});

test('reverify each tab switch updates the sole selected tab and the labelled panel', async ({ page }) => {
  await page.goto(SALEROOM);
  for (const [id, record] of [['001', sale1], ['002', sale2], ['003', sale3]] as const) {
    const tab = page.getByRole('tab', { name: new RegExp(`Sale ${id}`) });
    await tab.click();
    await expect(page).toHaveURL(new RegExp(`\\?sale=${id}$`));
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveCount(1);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', `tab-${id}`);
    await expect(page.locator('.sale-meta code')).toHaveText(record.auction.name);
    await expect(page.locator('.verify .eyebrow')).toHaveText(`Verify in this tab · Sale ${id}`);
    await expect(page.locator('.verify h2')).toHaveText('The result holds.');
    await expect(page.locator('.verify .step-ok')).toHaveCount(4);
  }
});

test('reverify unrevealed lots state the full forfeit fee and historical non-refund rule', async ({ page }) => {
  await page.goto(`${SALEROOM}?sale=003`);
  await expect(page.locator('.lot-unrevealed .plate')).toHaveText('Never opened');
  await expect(page.locator('.lot-unrevealed .tag')).toHaveText('Unrevealed');
  await expect(page.locator('.lot-unrevealed .why')).toHaveText('Never revealed: left out of the proof, listed in the outcome and forfeited to the seller (memo forfeit:<deposit>), minus its 5,000 zat output fee.');
  await page.goto(`${SALEROOM}?sale=002`);
  await expect(page.locator('.lot-unrevealed .why')).toHaveText('Never revealed: left out of the proof and listed in the outcome. With no refund address it was not refunded; this sale predates the rule that forfeits it to the seller.');
});
