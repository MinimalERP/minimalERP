/**
 * Credit and Debit Notes (ADR-0026), in a real browser: a credit note made from a Sales invoice (Alt+Shift+R) with its lines, set against
 * that invoice's bill and bringing the goods back; a debit note typed from Go To, sending goods back to a supplier against a bill of theirs.
 * The same item-line worksheet as the invoice each one reverses — without a due date, an E-way bill or an order column.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, paletteOptions, test } from './support';

const banner = (page: Page) => page.getByTestId('voucher-banner');
const panel = (page: Page) => page.getByTestId('action-panel');
const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

/** The closing stock of Machine Oil, read from its stock ledger. */
async function oilInStock(page: Page): Promise<string> {
  await goTo(page, 'i:machine oil');
  await page.keyboard.press('ArrowRight');
  await expect(paletteOptions(page)).toContainText(['Stock ledger']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Stock: Machine Oil');
  return (await page.getByTestId('stock-closing').textContent()) ?? '';
}

test.describe('Credit and Debit Notes', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('Transactions lists them where the planned rows were, and they are no longer planned', async ({ app }) => {
    await app.getByRole('option', { name: /^Transactions/ }).click();
    const credit = app.getByRole('option', { name: /^Credit Notes/ });
    const debit = app.getByRole('option', { name: /^Debit Notes/ });
    await expect(credit).not.toContainText('Phase');
    await expect(debit).not.toContainText('Phase');
    await credit.click();
    await expect(heading(app)).toHaveText('Credit Notes');
    await expect(panel(app).locator('[data-command="list.new.creditNote"]')).toBeEnabled();
  });

  test('Alt+Shift+R on a Sales invoice makes its credit note: the lines come along, it is set against the invoice, and the goods come back', async ({ app }) => {
    // a sale of 10 Ltr of oil to Sharma at 250.00
    await app.keyboard.press('F8');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // PO
    await app.keyboard.press('Enter'); // E-way Bill No.
    await app.keyboard.press('Enter'); // sales ledger
    await app.keyboard.press('Enter'); // bill due
    await app.keyboard.type('machine oil');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // godown
    await app.keyboard.press('Enter'); // no order
    await app.keyboard.type('10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('250');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');
    await app.keyboard.press('Escape'); // the fresh window has nothing in it: it closes

    await app.getByRole('option', { name: /^Transactions/ }).click();
    await app.getByRole('option', { name: /^Sales Vouchers/ }).click();
    await expect(heading(app)).toHaveText('Sales Vouchers');
    await gridRows(app).filter({ hasText: '2,500.00' }).first().dblclick();
    await expect(heading(app)).toContainText('Display Sales SAL/');
    const invoiceNo = ((await heading(app).textContent()) ?? '').replace('Display Sales ', '').trim();

    // the panel offers the note of this side, and the key makes it
    await expect(panel(app).locator('[data-command="invoice.note"]')).toHaveText(/Credit note/);
    await app.keyboard.press('Alt+Shift+R');
    await expect(heading(app)).toHaveText('New Credit Note');
    await expect(app.getByTestId('next-number')).toHaveText(/^\(CN\/.+0001\)$/);
    // the invoice it is for, its customer and its line — and none of what only an invoice has
    await expect(app.locator('[data-vf="billno"]')).toHaveValue(invoiceNo);
    await expect(app.locator('[data-vf="party"]')).toHaveValue(/Sharma/);
    await expect(app.getByLabel('Line 1 stock item')).toHaveValue('Machine Oil');
    await expect(app.getByLabel('Line 1 quantity')).toHaveValue('10');
    await expect(app.getByLabel('Line 1 rate')).toHaveValue('250');
    await expect(app.locator('[data-vf="due"]')).toHaveCount(0);
    await expect(app.locator('[data-vf="eway"]')).toHaveCount(0);
    await expect(app.locator('[data-vf="l0.ord"]')).toHaveCount(0);
    await expect(app.getByRole('group', { name: 'Entries' })).toContainText('Return into');

    // only 4 came back
    await expect(app.locator(':focus')).toHaveAttribute('data-vf', 'l0.qty');
    await app.keyboard.type('4');
    await expect(app.getByTestId('total-amount')).toHaveText('1,000.00');
    await expect(app.getByTestId('note-against')).toHaveText('1,000.00');
    await app.keyboard.press('Control+a');

    // back on the invoice: its bill is 1,000.00 less
    await expect(heading(app)).toContainText('Display Sales SAL/');
    await expect(app.getByTestId('bill-settled')).toHaveText('1,000.00');
    await expect(app.getByTestId('bill-pending')).toHaveText('1,500.00');

    // the note is in its list, applied in full to the invoice
    await goTo(app, 'credit notes');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Credit Notes');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRows(app).first()).toContainText('CN/');
    await expect(gridRows(app).first()).toContainText(invoiceNo);
    await expect(gridRows(app).first()).toContainText('Applied');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Credit Note CN/');

    // it is emailed and printed as what it is
    await app.keyboard.press('Alt+Shift+E');
    const dialog = app.getByTestId('mail-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Subject')).toHaveValue(/^Credit note CN\/.+ from Demo Manufacturing Pvt Ltd$/);
    await app.keyboard.press('Escape');
    await app.evaluate(() => void (window.print = () => {}));
    await app.keyboard.press('Control+p');
    await app.keyboard.press('Enter'); // 1 copy
    const copy = app.locator('.print-root .print-copy').first();
    await expect(copy).toContainText('Credit Note');
    await expect(copy).toContainText('Against Inv.');
    await expect(copy).toContainText(invoiceNo);
    await app.keyboard.press('Escape');

    // 120 − 40 (demo) − 10 sold + 4 back
    expect(await oilInStock(app)).toContain('74');
  });

  test('a debit note typed from Go To sends goods back to a supplier and is set against the bill it names', async ({ app }) => {
    await goTo(app, 'new debit note');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('New Debit Note');
    await expect(app.getByTestId('next-number')).toHaveText(/^\(DN\/.+0001\)$/);
    await expect(app.getByRole('group', { name: 'Entries' })).toContainText('Send back from');

    await app.keyboard.type('steel supplies');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // reference
    await expect(app.getByLabel('Purchase ledger')).toHaveValue('Purchase - Raw Material');
    await app.keyboard.press('Enter'); // purchase ledger
    await expect(app.locator(':focus')).toHaveAttribute('data-vf', 'billno');
    await app.keyboard.type('PO-2210'); // the supplier's bill brought forward in the demo
    await app.keyboard.press('Enter');
    await app.keyboard.type('machine oil');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="l0.wh"]')).toHaveValue('Main Location'); // where the oil is
    await app.keyboard.press('Enter');
    await app.keyboard.type('5');
    await app.keyboard.press('Enter');
    await app.keyboard.type('200');
    await expect(app.getByTestId('total-amount')).toHaveText('1,000.00');
    await expect(app.getByTestId('note-against')).toHaveText('1,000.00');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('Debit Note DN/');
    await expect(banner(app)).toContainText('saved.');
    await app.keyboard.press('Escape');

    await goTo(app, 'debit notes');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Debit Notes');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRows(app).first()).toContainText('Steel Supplies Pvt Ltd');
    await expect(gridRows(app).first()).toContainText('PO-2210');
    await expect(gridRows(app).first()).toContainText('Applied');

    // 120 − 40 (demo) − 5 sent back
    expect(await oilInStock(app)).toContain('75');
  });

  test('more than there is cannot be sent back: the quantity cell says so and nothing is saved', async ({ app }) => {
    await goTo(app, 'new debit note');
    await app.keyboard.press('Enter');
    await app.keyboard.type('steel supplies');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // reference
    await app.keyboard.press('Enter'); // purchase ledger
    await app.keyboard.press('Enter'); // against no invoice
    await app.keyboard.type('machine oil');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // godown
    await app.keyboard.type('5000');
    await app.keyboard.press('Enter');
    await app.keyboard.type('200');
    await app.keyboard.press('Control+a');
    await expect(app.locator('.vrow .vc-qty')).toContainText('Not enough Machine Oil in Main Location');
    await expect(heading(app)).toHaveText('New Debit Note'); // still the window, nothing saved
    await expect(app.getByTestId('next-number')).toHaveText(/^\(DN\/.+0001\)$/);
  });
});
