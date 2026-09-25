/**
 * Transactions grouped by area (Sales / Purchase / Inventory / General), a LIST for each voucher type with New on its panel, and a create
 * window that closes back to where it was opened from (Alt+N = Save and new, for rapid entry).
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

const panel = (page: Page) => page.getByTestId('action-panel');
const banner = (page: Page) => page.getByTestId('voucher-banner');
const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

/** Gateway › Transactions › the named list. */
async function openList(page: Page, row: string): Promise<void> {
  await page.getByRole('option', { name: /^Transactions/ }).click();
  await expect(heading(page)).toHaveText('Transactions');
  await page.getByRole('option', { name: new RegExp(`^${row}`) }).click();
}

/** A one-line sales invoice over the counter to Sharma Traders, typed the way a person would. */
async function fillInvoice(page: Page): Promise<void> {
  await page.keyboard.type('sharma');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Enter'); // PO, E-way Bill No., sales ledger, bill due
  await page.keyboard.type('machine oil');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // godown
  await page.keyboard.press('Enter'); // no order
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('250');
}

test.describe('the grouped Transactions screen', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('headed groups — Sales, Purchase, Inventory, General, the AI Inbox, then Import / Export — each with its voucher types, and their keys', async ({ app }) => {
    await app.getByRole('option', { name: /^Transactions/ }).click();
    await expect(heading(app)).toHaveText('Transactions');
    await expect(app.getByTestId('menu-group').locator('.menu-group-title')).toHaveText(['Sales', 'Purchase', 'Inventory', 'General', 'AI Inbox', 'Import / Export']);
    const group = (name: string) => app.getByTestId('menu-group').filter({ has: app.locator('.menu-group-title', { hasText: name }) });
    await expect(group('Sales').getByRole('option')).toHaveText([/Sales Vouchers/, /Sales Orders/, /New Credit Note/, /Quotations/, /New Delivery Note/]);
    await expect(group('Sales').getByRole('option').first()).toContainText('F8');
    await expect(group('Sales').getByRole('option').nth(1)).toContainText('Shift');
    await expect(group('Purchase').getByRole('option')).toHaveText([/Purchase Vouchers/, /Purchase Orders/, /New Debit Note/, /New Receipt Note/]);
    await expect(group('Purchase').getByRole('option').first()).toContainText('F9');
    await expect(group('Purchase').getByRole('option').nth(1)).toContainText('Shift');
    await expect(group('Purchase').getByRole('option').nth(2)).toContainText('Phase 7');
    await expect(group('Purchase').getByRole('option').nth(3)).toContainText('Phase 8');
    await expect(group('Inventory').getByRole('option')).toHaveText([/Stock Journal Vouchers/]);
    await expect(group('General').getByRole('option')).toHaveText([/Contra Vouchers/, /Payment Vouchers/, /Receipt Vouchers/, /Journal Vouchers/]);
    // near the end, so the lists keep their places: the documents sent from Gmail, waiting to be accepted
    await expect(group('AI Inbox').getByRole('option')).toHaveText([/AI Inbox/]);
    await expect(group('Import / Export').getByRole('option')).toHaveText([/Import \/ Export/]);
  });

  test('one cursor walks all the groups with the arrow keys and Enter opens the row', async ({ app }) => {
    await app.getByRole('option', { name: /^Transactions/ }).click();
    await app.keyboard.press('ArrowDown'); // Sales Orders
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Sales Orders');
    expect(new URL(app.url()).hash).toBe('#/report/vouchers/salesOrder');
  });
});

test.describe('a list per voucher type', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('Sales Vouchers: newest first, customer / PO / amount, its own New button and no other type button', async ({ app }) => {
    await openList(app, 'Sales Vouchers');
    await expect(heading(app)).toHaveText('Sales Vouchers');
    expect(new URL(app.url()).hash).toBe('#/report/vouchers/sales');
    for (const label of ['Date', 'Voucher no.', 'Customer', 'Cust PO / ref', 'Amount', 'Pending', 'Due', 'Status']) await expect(app.getByRole('columnheader', { name: new RegExp(label) })).toBeVisible();
    await expect(gridRows(app)).toHaveCount(2);
    await expect(gridRows(app).first()).toContainText('Sharma Traders'); // dated later than ABC's
    await expect(gridRows(app).first()).toContainText(/Open|Overdue/); // unpaid: which one depends on today's date against its due date
    await expect(gridRows(app).last()).toContainText('ABC Industries');
    await expect(panel(app).locator('[data-command="list.new.sales"]')).toBeEnabled();
    await expect(panel(app).locator('[data-command="list.new.sales"]')).toContainText('New Sales Voucher');
    await expect(panel(app).locator('[data-command="list.new.payment"]')).toHaveCount(0);
    await expect(app.getByTestId('list-total')).toBeVisible();
    // the grid's own keys work on it
    await app.keyboard.type('abc');
    await expect(gridRows(app)).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Sales SAL/');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Sales Vouchers'); // back on the same list, same view
  });

  test('Sales Orders: ONE row per order with an overall status — Open, Partially filled or Closed — open ones in bold, closed ones muted', async ({ app }) => {
    await openList(app, 'Sales Orders');
    await expect(heading(app)).toHaveText('Sales Orders');
    for (const label of ['Cust PO / ref', 'Order value', 'Status']) await expect(app.getByRole('columnheader', { name: new RegExp(label) })).toBeVisible();
    await expect(app.getByRole('columnheader', { name: /Open lines/ })).toHaveCount(0); // the line-by-line fill is in the reports
    await expect(gridRows(app)).toHaveCount(3);
    const po = gridRows(app).filter({ hasText: 'PO-4471' });
    await expect(po).toContainText('Partially filled'); // its bolts are delivered, its brackets partly, its frames not at all
    await expect(po).toHaveClass(/open-line/);
    await expect(gridRows(app).filter({ hasText: 'KEW-12' })).toContainText('Open'); // nothing delivered yet
    await expect(gridRows(app).filter({ hasText: 'SH/PO/88' })).toContainText('Closed');
    await expect(gridRows(app).filter({ hasText: 'SH/PO/88' })).toHaveClass(/closed-order/);
    await app.keyboard.type('kew');
    await expect(gridRows(app)).toHaveCount(1);
  });

  test('Payment Vouchers (General) and Stock Journal Vouchers (Inventory) have their own columns', async ({ app }) => {
    await openList(app, 'Payment Vouchers');
    await expect(gridRows(app)).toHaveCount(3);
    await expect(app.getByRole('columnheader', { name: /Particulars/ })).toBeVisible();
    await expect(app.getByRole('columnheader', { name: /Amount/ })).toBeVisible();
    await app.keyboard.press('Escape');
    await app.getByRole('option', { name: /^Stock Journal Vouchers/ }).click();
    await expect(gridRows(app)).toHaveCount(2);
    await expect(app.getByRole('columnheader', { name: /Items/ })).toBeVisible();
    await expect(app.getByRole('columnheader', { name: /Amount/ })).toHaveCount(0); // a stock journal has no accounting effect
  });

  test('Esc unwinds the list, then Transactions, then the Gateway', async ({ app }) => {
    await openList(app, 'Sales Vouchers');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Transactions');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
  });
});

test.describe('creating from a list, and closing back to it', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('New (panel click) then the window then Ctrl+A: back on the list with a notice, the new row selected and counted', async ({ app }) => {
    await openList(app, 'Sales Vouchers');
    await panel(app).locator('[data-command="list.new.sales"]').click();
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await fillInvoice(app);
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Sales Vouchers');
    await expect(app.getByTestId('list-notice')).toContainText('Sales SAL/');
    await expect(app.getByTestId('list-notice')).toContainText('saved.');
    await expect(gridRows(app)).toHaveCount(3);
    await expect(app.locator('tr.selected')).toContainText('500.00'); // the new one (2 x 250) is under the cursor
  });

  test('the F-key on the list does the same (F8 on the Sales list); a window with nothing entered closes back to it', async ({ app }) => {
    await openList(app, 'Sales Vouchers');
    await app.keyboard.press('F8');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await app.keyboard.press('Escape'); // nothing is entered and no list is open: the window closes
    await expect(heading(app)).toHaveText('Sales Vouchers');
    await app.keyboard.press('F8');
    await fillInvoice(app);
    await app.keyboard.press('Control+a');
    await expect(app.getByTestId('list-notice')).toContainText('saved.');
    await expect(gridRows(app)).toHaveCount(3);
  });

  test('Alt+N (Save and new) keeps the window: the saved banner and a blank form for the next; the list has the vouchers when it closes', async ({ app }) => {
    await openList(app, 'Sales Vouchers');
    await app.keyboard.press('F8');
    await fillInvoice(app);
    await expect(panel(app).locator('[data-command="voucher.acceptAndNew"]')).toBeEnabled();
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await expect(app.locator('[data-vf="party"]')).toHaveValue('');
    await app.keyboard.press('Escape'); // the window (nothing entered, no list open)
    await expect(heading(app)).toHaveText('Sales Vouchers');
    await expect(gridRows(app)).toHaveCount(3);
  });

  test('a window opened from the Gateway (F8) closes back to the Gateway', async ({ app }) => {
    await app.keyboard.press('F8');
    await fillInvoice(app);
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('an accounting voucher closes back to its list too', async ({ app }) => {
    await openList(app, 'Contra Vouchers');
    await panel(app).locator('[data-command="list.new.contra"]').click();
    await expect(heading(app)).toHaveText('New Contra Voucher');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('cash');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1000');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Contra Vouchers');
    await expect(app.getByTestId('list-notice')).toContainText('Contra');
    await expect(gridRows(app)).toHaveCount(2);
  });
});
