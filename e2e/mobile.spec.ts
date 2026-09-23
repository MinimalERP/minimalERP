/**
 * The voucher window on a phone (below 640px): each line is a small card — the item on its own row, the figures under it —
 * so nothing overlaps and the page never scrolls sideways. On a desktop it stays the worksheet, column headings and all.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

async function openSharmaInvoice(page: Page): Promise<void> {
  await goTo(page, 'day book');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Day Book');
  await page.keyboard.type('sharma');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toContainText('Display Sales');
}

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('not laid out');
  return b;
};
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('the voucher window on a phone', () => {
  test.beforeEach(async ({ app }) => {
    await app.setViewportSize({ width: 390, height: 844 });
    await loadDemo(app);
  });

  test('a Sales invoice line: the item has its own row, the figures sit under it with captions, nothing overlaps', async ({ app }) => {
    await openSharmaInvoice(app);
    const row = app.locator('.vrow').first();
    const item = row.locator('.vc-ledger');
    await expect(item.locator('input').first()).toHaveValue('Machine Oil');
    expect((await box(item)).width).toBeGreaterThan((await box(row)).width * 0.6);

    const itemBox = await box(item);
    for (const cell of ['.vc-qty', '.vc-rate', '.vc-value']) {
      const b = await box(row.locator(cell));
      expect(b.y, `${cell} starts below the item`).toBeGreaterThanOrEqual(itemBox.y + itemBox.height - 1);
    }
    await expect(app.locator('.vhdr')).toBeHidden(); // the captions stand in for the column headings
    expect(await noSidewaysScroll(app)).toBe(true);
  });

  test('a long breadcrumb (New Stock Journal Voucher) shortens instead of widening the page', async ({ app }) => {
    await app.keyboard.press('F10');
    await expect(heading(app)).toHaveText('New Stock Journal Voucher');
    expect(await noSidewaysScroll(app)).toBe(true);
  });
});

test('on a desktop the voucher window is still the worksheet: column headings shown, one line per row', async ({ app }) => {
  await app.setViewportSize({ width: 1366, height: 768 });
  await loadDemo(app);
  await openSharmaInvoice(app);
  await expect(app.locator('.vhdr')).toBeVisible();
  const row = app.locator('.vrow').first();
  await expect(row).toHaveCSS('display', 'grid');
  expect(Math.abs((await box(row.locator('.vc-ledger'))).y - (await box(row.locator('.vc-value'))).y)).toBeLessThan(2);
});
