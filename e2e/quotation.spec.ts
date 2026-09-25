/**
 * A quotation is simple: customer, items, quantities and rates — no dates. It can be altered until a sales order is made from it
 * (Alt+Shift+O); from then on it is kept as it was. Also here: the breadcrumb's earlier steps are links, and Refresh reloads the books.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

const panel = (page: Page) => page.getByTestId('action-panel');
const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

async function openQuotations(page: Page): Promise<void> {
  await page.getByRole('option', { name: /^Transactions/ }).click();
  await page.getByRole('option', { name: /^Quotations/ }).click();
  await expect(heading(page)).toHaveText('Quotation Vouchers');
}

test.describe('the Quotation window', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('no dates on it; a sales order made from it carries the lines, and the quote is then locked', async ({ app }) => {
    await openQuotations(app);
    await panel(app).locator('[data-command="list.new.quotation"]').click();
    await expect(heading(app)).toHaveText('New Quotation');
    // the number it will get, greyed beside "assigned on save" (the demo has no quotation yet)
    await expect(app.getByTestId('voucher-number')).toHaveText('assigned on save');
    await expect(app.getByTestId('next-number')).toHaveText(/^\(QT\/.+0001\)$/);
    const hinted = (await app.getByTestId('next-number').textContent())!.slice(1, -1);
    // Particulars, Qty, Rate (GST %), Amount — no due date anywhere
    await expect(app.locator('.vhdr .vc-due')).toHaveCount(0);
    await expect(app.locator('[data-vf="due"]')).toHaveCount(0);
    await expect(app.locator('[data-vf="l0.ldue"]')).toHaveCount(0);

    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // no reference
    await expect(app.locator(':focus')).toHaveAttribute('data-vf', 'l0.item');
    await app.keyboard.type('mounting');
    await app.keyboard.press('Enter');
    await expect(app.locator(':focus')).toHaveAttribute('data-vf', 'l0.qty');
    await app.keyboard.type('10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('55');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Quotation Vouchers');
    await expect(gridRows(app)).toHaveCount(1);

    // open it: it can still be altered, and a sales order made from it
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Quotation QT/');
    await expect(app.getByTestId('voucher-number')).toHaveText(hinted); // it got the number it said it would
    await expect(app.getByTestId('next-number')).toHaveCount(0); // a saved voucher shows only its own number
    await expect(panel(app).locator('[data-command="master.alter"]')).toBeEnabled();
    await app.keyboard.press('Alt+Shift+O');
    await expect(heading(app)).toHaveText('New Sales Order');
    await expect(app.getByLabel('Line 1 quantity')).toHaveValue('10');
    await app.keyboard.press('Control+a');

    // back on the quote: it names its order and cannot change any more
    await expect(heading(app)).toContainText('Quotation QT/');
    await expect(app.getByTestId('quote-status')).toContainText('Sales order SO/');
    await expect(panel(app).locator('[data-command="master.alter"]')).toBeDisabled();
    await expect(panel(app).locator('[data-command="voucher.cancel"]')).toBeDisabled();
    await expect(panel(app).locator('[data-command="quotation.order"]')).toHaveCount(0);
  });
});

test.describe('emailing a voucher to its party', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('Alt+Shift+E offers only this party’s addresses, the template filled in, and the PDF you choose', async ({ app }) => {
    await openQuotations(app);
    await panel(app).locator('[data-command="list.new.quotation"]').click();
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // no reference
    await app.keyboard.type('mounting');
    await app.keyboard.press('Enter');
    await app.keyboard.type('10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('55');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Quotation Vouchers');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Quotation QT/');

    await app.keyboard.press('Alt+Shift+E');
    const dialog = app.getByTestId('mail-dialog');
    await expect(dialog).toBeVisible();
    await expect(app.getByTestId('mail-to')).toHaveText(/^\s*accounts@abcindustries\.in\s*$/); // ABC's only address, and nobody else's
    await expect(dialog.getByLabel('Subject')).toHaveValue(/^Quotation QT\/.+ from Demo Manufacturing Pvt Ltd$/);
    await expect(dialog.getByLabel('Message')).toHaveValue(/^Dear ABC Industries,/);

    await app.getByTestId('mail-file').setInputFiles({ name: 'QT-signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 signed') });
    await expect(app.getByTestId('mail-attached')).toContainText('QT-signed.pdf');
    await app.getByTestId('mail-send').click();
    // these books live in the browser: sending needs the online books (and your Gmail script)
    await expect(dialog.getByRole('alert')).toContainText('Emailing needs the online books');
    await app.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(heading(app)).toContainText('Display Quotation QT/');
  });
});

test.describe('the top bar', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('an earlier step of the breadcrumb is a link back to it; a window with something entered still asks first', async ({ app }) => {
    await openQuotations(app);
    await expect(app.locator('.crumbs')).toContainText('Gateway › Transactions');
    await app.getByTestId('crumb').filter({ hasText: 'Transactions' }).click();
    await expect(heading(app)).toHaveText('Transactions');
    await app.getByTestId('crumb').filter({ hasText: 'Gateway' }).click();
    await expect(heading(app)).toHaveText('Gateway');

    await app.keyboard.press('F8');
    await app.keyboard.type('sharma');
    await app.getByTestId('crumb').filter({ hasText: 'Gateway' }).click();
    await expect(app.getByTestId('leave-dialog')).toBeVisible();
  });

  test('Refresh loads the books again and keeps the window open', async ({ app }) => {
    await openQuotations(app);
    await app.getByTestId('refresh').click();
    await expect(app.getByTestId('refresh')).toHaveText('Refresh');
    await expect(heading(app)).toHaveText('Quotation Vouchers');
  });
});
