/**
 * One-time (written) lines on invoices: for what is sold or bought once and is not worth a stock item. Alt+T on the item cell opens a
 * small form — description, HSN / SAC, qty, unit — and the line is billed like any other, with no stock moved. The grid itself is the same.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

const banner = (page: Page) => page.getByTestId('voucher-banner');

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

/** From the item cell of line 1: write the text, Alt+T, fill the small form, apply — the cursor lands on the rate. */
async function writeOneTimeLine(page: Page, text: string, hsn: string, qty: string, unit: string): Promise<void> {
  await page.keyboard.type(text);
  await page.keyboard.press('Alt+t');
  await expect(page.getByText('one-time line (not a stock item)')).toBeVisible();
  await page.keyboard.press('Enter'); // description, as typed
  await page.keyboard.type(hsn);
  await page.keyboard.press('Enter');
  await page.keyboard.type(qty); // replaces the proposed 1 (each field's text is selected when it is reached)
  await page.keyboard.press('Enter');
  await page.keyboard.type(unit);
  await page.keyboard.press('Enter'); // the last field applies
  await expect(page.locator('[data-vf="l0.rate"]')).toBeFocused();
}

test.describe('one-time lines', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('a Sales Invoice with a written line: billed, and it opens again with its written line', async ({ app }) => {
    await app.keyboard.press('F8');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await app.keyboard.type('sharma');
    for (let k = 0; k < 5; k++) await app.keyboard.press('Enter'); // party, PO, E-way, sales ledger, bill due → the first item cell
    await expect(app.locator('[data-vf="l0.item"]')).toBeFocused();

    await writeOneTimeLine(app, 'Machining charges job 44', '998898', '2', 'nos');
    await expect(app.getByTestId('one-time-note')).toContainText('HSN 998898');
    await expect(app.getByTestId('one-time-note')).toContainText('Nos');
    await app.keyboard.type('2500');
    await expect(app.getByTestId('total-amount')).toHaveText('5,000.00');
    await app.keyboard.press('Alt+n'); // save and new
    await expect(banner(app)).toContainText('saved.');

    // the list shows it; it opens with its written line
    await app.keyboard.press('Escape');
    await goTo(app, 'sales vouchers');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Sales Vouchers');
    await app.getByRole('grid').getByRole('row').filter({ hasText: '5,000.00' }).first().click();
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('Machining charges job 44');
  });

  test('inside the small form Ctrl+A does nothing — only Enter moves on, and Enter on the last field applies', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('sharma');
    for (let k = 0; k < 5; k++) await app.keyboard.press('Enter');
    await app.keyboard.type('Packing');
    await app.keyboard.press('Alt+t');
    await app.keyboard.press('Control+a');
    await expect(app.getByText('one-time line (not a stock item)')).toBeVisible(); // still open, nothing applied
    await expect(heading(app)).toHaveText('New Sales Voucher'); // the voucher was not saved and closed
    for (let k = 0; k < 4; k++) await app.keyboard.press('Enter'); // description, HSN, qty, unit
    await expect(app.getByText('one-time line (not a stock item)')).toBeHidden();
    await expect(app.getByTestId('one-time-note')).toBeVisible();
  });

  test('the small form refuses a quantity of nothing and a unit that is not one of yours', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('sharma');
    for (let k = 0; k < 5; k++) await app.keyboard.press('Enter');
    await app.keyboard.type('Packing');
    await app.keyboard.press('Alt+t');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.type('0');
    await app.keyboard.press('Enter');
    await app.keyboard.type('boxes of nine');
    await app.keyboard.press('Enter');
    await expect(app.getByText('Enter a quantity above zero')).toBeVisible();
  });

  test('a Purchase Invoice takes a written line too', async ({ app }) => {
    await app.keyboard.press('F9');
    await expect(heading(app)).toHaveText('New Purchase Voucher');
    await app.keyboard.type('bharat');
    await app.keyboard.press('Enter'); // party
    await app.keyboard.press('Enter'); // PO / ref
    await app.keyboard.press('Enter'); // purchase ledger
    await app.keyboard.type('BC-900');
    await app.keyboard.press('Enter'); // supplier inv no.
    await app.keyboard.press('Enter'); // bill due
    await expect(app.locator('[data-vf="l0.item"]')).toBeFocused();
    await writeOneTimeLine(app, 'Freight to Chakan', '996511', '1', '');
    await app.keyboard.type('1200');
    await expect(app.getByTestId('total-amount')).toHaveText('1,200.00');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Gateway');
  });
});
