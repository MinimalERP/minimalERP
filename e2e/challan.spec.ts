/**
 * The Delivery Challan: goods sent out without a bill, from Transactions › Delivery Challans (or Alt+F8 anywhere). One DC/ series; the
 * purpose — sale (invoiced later) or free of cost — is a field on it. Each line leaves a godown; nothing is posted to the accounts.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, leaveByEscape, test } from './support';

const panel = (page: Page) => page.getByTestId('action-panel');
const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

test.describe('the Delivery Challan window', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('a free-of-cost challan by keyboard: customer, purpose, item from the godown that holds it; the list shows it as FOC', async ({ app }) => {
    await app.getByRole('option', { name: /^Transactions/ }).click();
    await app.getByRole('option', { name: /^Delivery Challans/ }).click();
    await expect(heading(app)).toHaveText('Delivery Challans');
    await app.keyboard.press('Alt+F8');
    await expect(heading(app)).toHaveText('New Delivery Challan');
    await expect(app.getByTestId('next-number')).toHaveText(/^\(DC\/.+0001\)$/);
    // Particulars, Godown, Qty, Rate … — no order, no due date, no sales ledger
    await expect(app.locator('.vhdr .vc-order')).toHaveCount(0);
    await expect(app.locator('[data-vf="due"]')).toHaveCount(0);
    await expect(app.locator('[data-vf="sledger"]')).toHaveCount(0);

    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // no reference
    await expect(app.locator(':focus')).toHaveAttribute('data-vf', 'purpose');
    await expect(app.locator(':focus')).toHaveValue('Sale – invoice later');
    await app.keyboard.type('free');
    await app.keyboard.press('Enter');
    await expect(app.getByLabel('Purpose of the challan')).toHaveValue('Free of cost (FOC)');
    await expect(app.locator(':focus')).toHaveAttribute('data-vf', 'l0.item');
    await app.keyboard.type('mounting');
    await app.keyboard.press('Enter');
    // the brackets are kept in the Finished Goods Store, so the line leaves from there
    await expect(app.locator(':focus')).toHaveAttribute('data-vf', 'l0.wh');
    await expect(app.getByLabel('Line 1 godown')).toHaveValue('Finished Goods Store');
    await app.keyboard.press('Enter');
    await app.keyboard.type('10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('38');
    await app.keyboard.press('Control+a');

    await expect(heading(app)).toHaveText('Delivery Challans');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRows(app).first()).toContainText('FOC');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Delivery Challan DC/');
    await expect(app.getByLabel('Purpose of the challan')).toHaveValue('Free of cost (FOC)');

    // it is emailed like any document: the challan's own template
    await app.keyboard.press('Alt+Shift+E');
    const dialog = app.getByTestId('mail-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Subject')).toHaveValue(/^Delivery challan DC\/.+ from Demo Manufacturing Pvt Ltd$/);
    await app.keyboard.press('Escape');
    await expect(panel(app).locator('[data-command="voucher.print"]')).toBeEnabled();

    // it prints with its name alone, centred across the top (not in the corner, as an accounting voucher's is); that it is free of charge is in the narration
    await app.evaluate(() => void (window.print = () => {}));
    await app.keyboard.press('Control+p');
    await app.keyboard.press('Enter'); // 1 copy
    const copy = app.locator('.print-root .print-copy').first();
    await expect(copy.getByTestId('print-title-centre')).toHaveText('Delivery Challan');
    await expect(copy.locator('.inv-doc .title')).toHaveCount(0);
    await expect(copy.locator('.inv-narration')).toContainText('Free of charge (FOC) – not for sale.');
  });

  test('cannot send more than the godown holds', async ({ app }) => {
    await app.keyboard.press('Alt+F8');
    await expect(heading(app)).toHaveText('New Delivery Challan');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // purpose stays Sale
    await app.keyboard.type('mounting');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.type('5000');
    await app.keyboard.press('Enter');
    await app.keyboard.type('38');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('New Delivery Challan');
    await expect(app.getByText(/Not enough Mounting Bracket in Finished Goods Store/)).toBeVisible();
  });

  test('a sale challan is invoiced with Alt+I: the invoice bills its lines with no godown, and the challan reads Invoiced', async ({ app }) => {
    await app.keyboard.press('Alt+F8');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.type('PO-778');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // Sale – invoice later
    await app.keyboard.type('mounting');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.type('10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('38');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('status').or(app.locator('.notice')).first()).toBeVisible();
    await leaveByEscape(app, 'Gateway'); // opened by Alt+F8: fast entry — saved, fresh; Esc leaves

    await app.getByRole('option', { name: /^Transactions/ }).click();
    await app.getByRole('option', { name: /^Delivery Challans/ }).click();
    await expect(gridRows(app).first()).toContainText('To invoice');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('challan-status')).toHaveText('To invoice');
    await app.keyboard.press('Alt+i');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await expect(app.getByLabel('Line 1 quantity')).toHaveValue('10');
    await expect(app.getByTestId('challan-godown')).toHaveText('sent on challan');
    await expect(app.locator('[data-vf="l0.wh"]')).toHaveCount(0);
    await app.keyboard.press('Control+a');

    // back on the challan: billed in full
    await expect(app.getByTestId('challan-status')).toHaveText('Invoiced');
    await expect(panel(app).locator('[data-command="voucher.cancel"]')).toBeEnabled();
  });

  test('a service item needs no godown: job work on a part that was never our own stock', async ({ app }) => {
    await goTo(app, 'create stock item');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Create Stock Item');
    await app.keyboard.type('Alloy Tube Modification');
    for (let i = 0; i < 4; i++) await app.keyboard.press('Tab'); // code, alias, group, unit
    await app.keyboard.type('Nos');
    await app.keyboard.press('Enter'); // select the unit
    await app.locator('[data-field="itemType"]').fill('service');
    await app.keyboard.press('Tab');
    await app.keyboard.press('Control+a');
    await expect(app.getByTestId('form-banner')).toContainText('created');

    await app.keyboard.press('Alt+F8');
    await expect(heading(app)).toHaveText('New Delivery Challan');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter'); // party
    await app.keyboard.press('Enter'); // no reference
    await app.keyboard.press('Enter'); // purpose stays Sale
    await expect(app.locator('[data-vf="l0.item"]')).toBeFocused();
    await app.keyboard.type('alloy tube');
    await app.keyboard.press('Enter'); // select the service item
    await expect(app.locator('[data-vf="l0.wh"]')).toHaveCount(0); // a service item has no godown
    await app.keyboard.type('1');
    await app.keyboard.press('Enter');
    await app.keyboard.type('2500');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('New Delivery Challan'); // opened by Alt+F8: fast entry — saved, fresh for the next one
    await leaveByEscape(app, 'Gateway');
  });

  test('a returnable challan goes to a supplier and Mark returned brings it back', async ({ app }) => {
    await app.getByRole('option', { name: /^Transactions/ }).click();
    await app.getByRole('option', { name: /^Returnable Challans/ }).click();
    await expect(heading(app)).toHaveText('Returnable Challans');
    await panel(app).locator('[data-command="list.new.returnableChallan"]').click();
    await expect(heading(app)).toHaveText('New Returnable Challan');
    await expect(app.getByTestId('next-number')).toHaveText(/^\(RC\/.+0001\)$/);
    await expect(app.locator('[data-vf="purpose"]')).toHaveCount(0); // no purpose: it is always returnable
    await app.keyboard.type('steel');
    await expect(app.getByTestId('picker')).toContainText('Steel Supplies Pvt Ltd'); // suppliers, not customers
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // no reference
    await app.keyboard.type('machine oil');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // from Main Location
    await app.keyboard.type('5');
    await app.keyboard.press('Enter');
    await app.keyboard.type('210');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Returnable Challans');
    await expect(gridRows(app).first()).toContainText('Out');

    await app.keyboard.press('Enter');
    await expect(app.getByTestId('returnable-status')).toHaveText('Out');

    // it prints as it always has: its title in the corner with the number and date (only the Delivery Challan's is centred)
    await app.evaluate(() => void (window.print = () => {}));
    await app.keyboard.press('Control+p');
    await app.keyboard.press('Enter'); // 1 copy
    const copy = app.locator('.print-root .print-copy').first();
    await expect(copy.locator('.inv-doc .title')).toHaveText('Returnable Challan');
    await expect(copy.getByTestId('print-title-centre')).toHaveCount(0);
    await expect(copy.locator('.inv-narration')).toContainText('Returnable – to be returned to us after the work.');

    await panel(app).locator('[data-command="challan.markReturned"]').click();
    await expect(app.getByTestId('returnable-status')).toHaveText(/^Returned · RC\//);
    await expect(panel(app).locator('[data-command="challan.markReturned"]')).toHaveCount(0);
  });
});
