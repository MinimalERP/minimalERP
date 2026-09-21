/**
 * PHASE 8, in a real browser: the Purchase Order and the Purchase Invoice on the same worksheet as Sales — F9 / Shift+F9, the supplier's invoice number
 * naming the bill, goods received into a godown and against order lines (over-receipt refused on the cell), Alt+I from an order, the lists, the
 * order register, stock "On order", and the books following (Outstanding Payables, Profit & Loss). Keyboard first; panel clicks where they exist.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

const panel = (page: Page) => page.getByTestId('action-panel');
const banner = (page: Page) => page.getByTestId('voucher-banner');
const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });
const num = (s: string | null): bigint => BigInt(Math.round(Number((s ?? '0').replace(/[^0-9.-]/g, '')) * 100));

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

/** Gateway › Reports › the named report. */
async function openReport(page: Page, name: string): Promise<void> {
  if ((await heading(page).textContent()) !== 'Reports') {
    await page.getByRole('option', { name: /^Reports/ }).click();
    await expect(heading(page)).toHaveText('Reports');
  }
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
  await expect(heading(page)).toHaveText(name);
}

/** Bharat Chemicals (no purchase order) sells us 100 Kg of MS Sheet at 60 — typed the way a person would. Ends on the rate. */
async function fillBharat(page: Page, billNo: string, qty = '100', rate = '60'): Promise<void> {
  await page.keyboard.type('bharat');
  await page.keyboard.press('Enter'); // supplier → PO / ref
  await page.keyboard.press('Enter'); // PO / ref → purchase ledger
  await page.keyboard.press('Enter'); // purchase ledger (the only one is filled in) → supplier inv no.
  await page.keyboard.type(billNo);
  await page.keyboard.press('Enter'); // → bill due
  await page.keyboard.press('Enter'); // → the first line's item
  await page.keyboard.type('ms sheet');
  await page.keyboard.press('Enter'); // item → godown
  await page.keyboard.press('Enter'); // godown → against order
  await page.keyboard.press('Enter'); // no order → qty
  await page.keyboard.type(qty);
  await page.keyboard.press('Enter');
  await page.keyboard.type(rate);
}

test.describe('the Purchase Invoice window (F9)', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('F9 opens the purchase window: party, PO / ref, purchase ledger, supplier inv no., bill due — and lines that receive into a godown', async ({ app }) => {
    await app.keyboard.press('F9');
    await expect(heading(app)).toHaveText('New Purchase Voucher');
    expect(new URL(app.url()).hash).toBe('#/voucher/new/purchase');
    for (const label of ['Party', 'PO / ref', 'Purchase ledger', 'Supplier inv no.', 'Bill due']) await expect(app.getByText(label, { exact: true }).first()).toBeVisible();
    await expect(app.locator('[data-vf="sledger"]')).toHaveValue('Purchase - Raw Material'); // the only ledger under Purchase Accounts
    await expect(app.getByText('Receive into')).toBeVisible();
    await expect(app.locator('[data-vf="party"]')).toBeFocused();
    await app.keyboard.type('a');
    await expect(app.getByTestId('picker')).toContainText('Steel Supplies Pvt Ltd'); // suppliers only: a customer-only party is not offered
    await expect(app.getByTestId('picker')).not.toContainText('ABC Industries');
  });

  test('typed by keyboard: saves and closes back to the Gateway, and the supplier’s bill appears in Outstanding Payables under THEIR invoice number', async ({ app }) => {
    await app.keyboard.press('F9');
    await fillBharat(app, 'BC-101');
    await expect(app.getByTestId('total-amount')).toHaveText('6,000.00');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Gateway'); // saving closes back to where it was opened

    await openReport(app, 'Outstanding Payables');
    await expect(gridRows(app).filter({ hasText: 'Bharat Chemicals' })).toContainText('7,500.00'); // BC-77 (1,500) and the new bill
    await gridRows(app).filter({ hasText: 'Bharat Chemicals' }).click();
    await expect(heading(app)).toHaveText('Outstanding: Bharat Chemicals');
    await expect(gridRows(app).filter({ hasText: 'BC-101' })).toContainText('6,000.00');
    await gridRows(app).filter({ hasText: 'BC-101' }).click();
    await expect(heading(app)).toHaveText(/^Display Purchase PUR\/\d\d-\d\d\/\d{4}$/); // Enter on the bill opens the invoice that raised it
  });

  test('the books follow: Purchases in the Trading account, the stock in, the Balance Sheet still balanced', async ({ app }) => {
    await app.keyboard.press('F9');
    await fillBharat(app, 'BC-102');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Gateway');

    await openReport(app, 'Profit & Loss');
    await expect(app.getByTestId('stmt-trading-left')).toContainText('Purchase Accounts');
    await expect(app.getByTestId('stmt-trading-left')).toContainText('6,000.00');
    expect(num(await app.getByTestId('stmt-trading-total-left').textContent())).toBe(num(await app.getByTestId('stmt-trading-total-right').textContent()));
    await app.keyboard.press('Escape');
    await openReport(app, 'Balance Sheet');
    expect(num(await app.getByTestId('stmt-balance-sheet-total-left').textContent())).toBe(num(await app.getByTestId('stmt-balance-sheet-total-right').textContent()));
    await app.keyboard.press('Escape');
    await openReport(app, 'Stock Summary');
    await app.keyboard.type('ms sheet');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRows(app).first()).toContainText('2,300.000'); // 2,200 after the demo's conversion + the 100 bought
  });

  test('a supplier invoice number the supplier already has is refused on its own field; the same number from another supplier is fine', async ({ app }) => {
    await app.keyboard.press('F9');
    await fillBharat(app, 'BC-77'); // Bharat's freight bill in the demo
    await app.keyboard.press('Control+a');
    await expect(app.locator('[data-vf="billno"]')).toBeFocused();
    await expect(app.getByRole('alert').filter({ hasText: 'already a bill of this supplier' })).toBeVisible();
    await expect(heading(app)).toHaveText('New Purchase Voucher'); // nothing was saved
    await app.locator('[data-vf="billno"]').fill('BC-78');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('the supplier’s invoice number is required, and says so on its field', async ({ app }) => {
    await app.keyboard.press('F9');
    await fillBharat(app, 'x');
    await app.locator('[data-vf="billno"]').fill('');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'supplier’s invoice number' })).toBeVisible();
    await expect(app.locator('[data-vf="billno"]')).toBeFocused();
  });

  test('F9 and Shift+F9 switch between the invoice and its order in place; F8 from a blank purchase window replaces it with a sales one', async ({ app }) => {
    await app.keyboard.press('F9');
    await expect(heading(app)).toHaveText('New Purchase Voucher');
    await app.keyboard.press('Shift+F9');
    await expect(heading(app)).toHaveText('New Purchase Order');
    await expect(app.getByText('Supplier ref', { exact: true }).first()).toBeVisible();
    await expect(app.locator('[data-vf="billno"]')).toHaveCount(0); // an order has no bill
    await app.keyboard.press('F9');
    await expect(heading(app)).toHaveText('New Purchase Voucher');
    await app.keyboard.press('F8'); // a blank window is replaced by the other side's
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await app.keyboard.press('Escape'); // a blank window with no list open: it closes
    await expect(heading(app)).toHaveText('Gateway');
  });
});

test.describe('the Purchase Order and receiving against it', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('Purchase Orders list: the demo’s order is Open; New (panel click) opens the purchase order window and the list gets the new order back', async ({ app }) => {
    await openList(app, 'Purchase Orders');
    await expect(heading(app)).toHaveText('Purchase Orders');
    expect(new URL(app.url()).hash).toBe('#/report/vouchers/purchaseOrder');
    for (const label of ['Supplier', 'Supplier ref', 'Order value', 'Status']) await expect(app.getByRole('columnheader', { name: label, exact: true })).toBeVisible();
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRows(app).first()).toContainText('Steel Supplies Pvt Ltd');
    await expect(gridRows(app).first()).toContainText('SS/Q/31');
    await expect(gridRows(app).first()).toContainText('90,750.00');
    await expect(gridRows(app).first()).toContainText('Open');
    await panel(app).locator('[data-command="list.new.purchaseOrder"]').click();
    await expect(heading(app)).toHaveText('New Purchase Order');
    // a purchase order: supplier, reference, and a due date on each line
    await app.keyboard.type('bharat');
    await app.keyboard.press('Enter'); // supplier → supplier ref
    await app.keyboard.type('Q-77');
    await app.keyboard.press('Enter'); // → first line's item
    await app.keyboard.type('machine oil');
    await app.keyboard.press('Enter'); // item → due date
    await app.keyboard.press('Enter'); // due → qty
    await app.keyboard.type('50');
    await app.keyboard.press('Enter');
    await app.keyboard.type('215');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Purchase Orders'); // closed back to the list
    await expect(gridRows(app)).toHaveCount(2);
    await expect(gridRows(app).first()).toContainText('Bharat Chemicals'); // newest first
    await expect(gridRows(app).first()).toContainText('10,750.00');
  });

  test('Alt+I on the order makes a purchase invoice of what is pending on it: the supplier, our PO number, a line per pending line; the supplier inv no. is the person’s to give', async ({ app }) => {
    await openList(app, 'Purchase Orders');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/^Display Purchase Order PO\/\d\d-\d\d\/\d{4}/);
    await expect(app.getByTestId('order-status')).toHaveText('Open');
    await app.keyboard.press('Alt+i');
    await expect(heading(app)).toHaveText('New Purchase Voucher');
    await expect(app.locator('[data-vf="party"]')).toHaveValue('Steel Supplies Pvt Ltd');
    await expect(app.locator('[data-vf="ref"]')).toHaveValue(/^PO\/\d\d-\d\d\/\d{4}$/);
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('MS Sheet 2mm');
    await expect(app.locator('[data-vf="l0.qty"]')).toHaveValue('1000');
    await expect(app.locator('[data-vf="l0.rate"]')).toHaveValue('59');
    await expect(app.locator('[data-vf="l1.item"]')).toHaveValue('MS Rod 12mm');
    await expect(app.locator('[data-vf="l1.qty"]')).toHaveValue('500');
    await expect(app.getByTestId('total-amount')).toHaveText('90,750.00');
    // no supplier invoice number yet: the window asks for it
    await app.keyboard.press('Control+a');
    await expect(app.locator('[data-vf="billno"]')).toBeFocused();
    await app.keyboard.type('SS/2001');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText(/^Display Purchase Order/); // back on the order
    await expect(app.getByTestId('order-status')).toHaveText('Closed · received in full');
  });

  test('the panel does what the keys do: Invoice pending on an order, Party details on the window; a line can be received against an order line with Alt+O', async ({ app }) => {
    await openList(app, 'Purchase Orders');
    await app.keyboard.press('Enter');
    await panel(app).locator('[data-command="order.invoice"]').click();
    await expect(heading(app)).toHaveText('New Purchase Voucher');
    await expect(panel(app).locator('[data-command="voucher.partyDetails"]')).toBeVisible();
    await expect(panel(app).locator('[data-command="voucher.againstOrder"]')).toBeVisible();
    await app.locator('[data-vf="l0.item"]').click();
    await app.keyboard.press('Alt+o'); // the "against order" cell of this line: this supplier's open order lines for the item
    await expect(app.locator('[data-vf="l0.ord"]')).toBeFocused();
    await expect(app.getByTestId('picker')).toContainText('SS/Q/31');
  });

  test('receiving more than is pending is refused on the quantity cell, in the words of the purchase side; the invoice is not saved', async ({ app }) => {
    await openList(app, 'Purchase Orders');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Alt+i');
    await expect(heading(app)).toHaveText('New Purchase Voucher');
    await app.locator('[data-vf="billno"]').fill('SS/2002');
    await app.locator('[data-vf="l0.qty"]').fill('1200');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: /pending, you are receiving/ })).toBeVisible();
    await expect(app.locator('[data-vf="l0.qty"]')).toBeFocused();
    await expect(heading(app)).toHaveText('New Purchase Voucher');
  });

  test('choosing a supplier with an open order pulls nothing in; choosing the order in the PO / ref field brings its pending lines', async ({ app }) => {
    await app.keyboard.press('F9');
    await app.keyboard.type('steel');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="ref"]')).toHaveValue(''); // a regular invoice until an order is chosen
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('');
    await expect(banner(app)).toHaveCount(0);
    await expect(app.getByTestId('picker')).toContainText('SS/Q/31'); // the field offers the supplier's open orders
    await app.keyboard.type('PO/');
    await app.keyboard.press('Enter');
    await expect(banner(app)).toContainText('2 remaining lines brought in from PO/');
    await expect(app.locator('[data-vf="ref"]')).toHaveValue(/^PO\//);
    await expect(app.locator('[data-vf="l1.item"]')).toHaveValue('MS Rod 12mm');
  });

  test('the Purchase Order Register: one row per order line with what is received and pending; and the stock shows what is on order', async ({ app }) => {
    await openReport(app, 'Purchase Order Register');
    await expect(app.getByRole('columnheader', { name: /Received/ })).toBeVisible();
    await expect(app.getByRole('columnheader', { name: /Supplier ref/ })).toBeVisible();
    await expect(gridRows(app)).toHaveCount(2);
    await expect(gridRows(app).filter({ hasText: 'MS Sheet 2mm' })).toContainText('SS/Q/31');
    await expect(gridRows(app).filter({ hasText: 'MS Sheet 2mm' })).toContainText('0/1,000');
    await expect(app.getByTestId('order-counts')).toContainText('1 order · 2 open lines');
    await expect(app.getByTestId('order-counts')).toContainText('still to receive');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/^Display Purchase Order/);
    await app.keyboard.press('Escape');
    await app.keyboard.press('Escape');
    await openReport(app, 'Stock Summary');
    await expect(app.getByRole('columnheader', { name: /On order/ })).toBeVisible();
    await app.keyboard.type('ms sheet');
    await expect(gridRows(app).first()).toContainText('1,000.000'); // on order
  });

  test('Go To finds the purchase documents and their register', async ({ app }) => {
    for (const [words, title] of [['purchase order register', 'Purchase Order Register'], ['purchase orders', 'Purchase Orders'], ['purchase vouchers', 'Purchase Vouchers']]) {
      await goTo(app, words as string);
      await app.keyboard.press('Enter');
      await expect(heading(app)).toHaveText(title as string);
      await app.keyboard.press('Escape');
    }
  });

  test('the Purchase Vouchers list: newest first, supplier and their invoice number, pending and status; New from its panel', async ({ app }) => {
    await app.keyboard.press('F9');
    await fillBharat(app, 'BC-201');
    await app.keyboard.press('Control+a');
    await openList(app, 'Purchase Vouchers');
    await expect(heading(app)).toHaveText('Purchase Vouchers');
    for (const label of ['Supplier', 'Supplier inv no.', 'Amount', 'Pending', 'Due', 'Status']) await expect(app.getByRole('columnheader', { name: label, exact: true })).toBeVisible();
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRows(app).first()).toContainText('BC-201');
    await expect(gridRows(app).first()).toContainText('6,000.00');
    await expect(gridRows(app).first()).toContainText(/Open|Overdue/);
    await expect(panel(app).locator('[data-command="list.new.purchase"]')).toContainText('New Purchase Voucher');
    await expect(panel(app).locator('[data-command="list.new.sales"]')).toHaveCount(0);
  });
});
