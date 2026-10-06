/**
 * The mobile interface (ADR-0027), on a touch phone and by taps alone: a phone gets it automatically, it moves like the desktop (Gateway →
 * menu → list → record, Back returns), its figures are the books' own, and "Desktop version" switches to the full app and back. A desktop
 * never loads it.
 */
import { type Page, expect, test } from '@playwright/test';

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } } as const;

const title = (page: Page) => page.locator('.m-title');
const row = (page: Page, text: string | RegExp) => page.locator('.m-row').filter({ hasText: text });

/** Fails the test on any console error or uncaught exception, as the desktop fixture does. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

async function openDemo(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('mobile-app')).toBeVisible();
  await page.getByTestId('load-demo').tap();
  await expect(title(page)).toHaveText('Demo Manufacturing Pvt Ltd');
}

test.describe('on a phone', () => {
  test.use(PHONE);

  test('the mobile interface opens by itself — not the desktop shell — and says how to start when no company is open', async ({ page }) => {
    const problems = watch(page);
    await page.goto('/');
    await expect(page.getByTestId('mobile-app')).toBeVisible();
    await expect(page.locator('.shell')).toHaveCount(0);
    await expect(page.locator('.m-main')).toContainText('No company is open yet');
    await expect(page.getByTestId('to-desktop')).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('the Gateway shows the day’s figures and the same four doors as the desktop; every row is big enough for a thumb', async ({ page }) => {
    const problems = watch(page);
    await openDemo(page);
    await expect(page.getByTestId('home-receivable')).toContainText('₹');
    await expect(page.getByTestId('home-payable')).toContainText('₹');
    for (const door of ['Transactions', 'Parties', 'Stock', 'Utilities']) await expect(row(page, new RegExp(`^${door}`))).toBeVisible();
    for (const r of await page.locator('button.m-row').all()) expect((await r.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(48);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // never sideways
    expect(problems).toEqual([]);
  });

  test('Transactions → Sales Vouchers → an invoice, and Back returns step by step — the phone’s Back and the bar’s alike', async ({ page }) => {
    const problems = watch(page);
    await openDemo(page);
    await row(page, /^Transactions/).tap();
    await expect(title(page)).toHaveText('Transactions');
    await expect(page.locator('.m-group-title')).toHaveText(['Sales', 'Purchase', 'General']);
    await row(page, 'Sales Vouchers').tap();
    await expect(title(page)).toHaveText('Sales Vouchers');
    const invoices = page.getByTestId('doc-row');
    await expect(invoices.first()).toContainText('SAL/');
    await invoices.first().tap();
    await expect(title(page)).toHaveText(/^Sales SAL\//);
    await expect(page.getByTestId('doc-line').first()).toBeVisible();
    await expect(page.getByTestId('doc-total')).toContainText('₹');

    await page.goBack(); // the phone's Back
    await expect(title(page)).toHaveText('Sales Vouchers');
    await page.getByRole('button', { name: 'Back' }).tap(); // the bar's
    await expect(title(page)).toHaveText('Transactions');
    await page.goBack();
    await expect(title(page)).toHaveText('Demo Manufacturing Pvt Ltd');
    await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(0); // the Gateway has nowhere to go back to
    expect(problems).toEqual([]);
  });

  test('a customer: what it owes, its open bills, its documents — and a bill opens the invoice that raised it', async ({ page }) => {
    const problems = watch(page);
    await openDemo(page);
    await row(page, /^Parties/).tap();
    await page.getByLabel('Filter by name').fill('abc');
    await expect(page.getByTestId('party-row')).toHaveCount(1);
    await page.getByTestId('party-row').tap();
    await expect(title(page)).toHaveText('ABC Industries');
    await expect(page.getByTestId('party-receivable')).toContainText('₹');
    await expect(page.getByTestId('bill-row').first()).toBeVisible();
    await expect(page.locator('.m-actions')).toContainText('Call');
    await page.getByTestId('bill-row').first().tap();
    await expect(page.locator('.m-main')).toContainText('ABC Industries'); // the voucher behind the bill (here the balance brought forward)
    expect(problems).toEqual([]);
  });

  test('stock: an item’s quantity in the list is the book’s, and its page shows the movements behind it', async ({ page }) => {
    const problems = watch(page);
    await openDemo(page);
    await row(page, /^Stock/).tap();
    await page.getByLabel('Filter by item').fill('machine oil');
    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row')).toContainText('80'); // 120 brought forward, 40 sold in the demo
    await page.getByTestId('item-row').tap();
    await expect(title(page)).toHaveText('Machine Oil');
    await expect(page.getByTestId('item-stock')).toContainText('80');
    await expect(page.locator('.m-group').filter({ hasText: 'Latest movements' }).locator('.m-row').first()).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('Go to on the Gateway finds a party, an item and a voucher by its number', async ({ page }) => {
    const problems = watch(page);
    await openDemo(page);
    const box = page.getByLabel('Go to: party, item or voucher no.');
    await box.fill('abc');
    await expect(row(page, 'ABC Industries')).toBeVisible();
    await expect(page.locator('.m-row-sub', { hasText: 'Stock item' }).first()).toBeVisible(); // "ABC" is in an item's name too
    await box.fill('SAL/');
    await row(page, /SAL\//).first().tap();
    await expect(title(page)).toHaveText(/^Sales SAL\//);
    expect(problems).toEqual([]);
  });

  test('an invoice prints from the phone: one Original, the document alone', async ({ page }) => {
    const problems = watch(page);
    await openDemo(page);
    await page.evaluate(() => void (window.print = () => {}));
    await row(page, /^Transactions/).tap();
    await row(page, 'Sales Vouchers').tap();
    await page.getByTestId('doc-row').first().tap();
    const number = ((await title(page).textContent()) ?? '').replace('Sales ', '');
    await page.getByTestId('doc-print').tap();
    const copies = page.locator('#print-root .print-copy');
    await expect(copies).toHaveCount(1);
    await expect(copies.first()).toContainText(number);
    await expect(copies.first()).toContainText('ORIGINAL');
    expect(problems).toEqual([]);
  });

  test('Desktop version switches to the full app and is remembered; ?ui=mobile comes back', async ({ page }) => {
    await openDemo(page);
    await row(page, /^Utilities/).tap();
    await page.getByTestId('to-desktop').tap();
    await expect(page.locator('.shell')).toBeVisible();
    await expect(page.getByTestId('mobile-app')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('ui')).toBe('desktop');
    await page.goto('/'); // no ?ui=: the choice was saved on this device
    await expect(page.locator('.shell')).toBeVisible();
    await page.goto('/?ui=mobile');
    await expect(page.getByTestId('mobile-app')).toBeVisible();
    await page.goto('/');
    await expect(page.getByTestId('mobile-app')).toBeVisible();
  });
});

test('a desktop gets the desktop app and never loads the mobile interface', async ({ page }) => {
  const loaded: string[] = [];
  page.on('request', (r) => loaded.push(r.url()));
  await page.goto('/');
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.getByTestId('mobile-app')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(loaded.filter((u) => /mobile\/(mount|MobileApp|data|nav)|mobile\.css/.test(u))).toEqual([]);
});
