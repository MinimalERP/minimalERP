/**
 * How the entry windows behave, whatever the voucher: a NEW window always opens clean (what was half-entered and closed is gone; only a page
 * reload brings a draft back), a list opens only when something is typed and shows only what matches (saying so when nothing does), and choosing a
 * party pulls nothing in from its orders — an invoice is a regular invoice until an order is chosen.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

/** Esc out of a window that has content: it asks; Alt+Y leaves. */
async function leaveWithContent(page: Page): Promise<void> {
  for (let i = 0; i < 12 && (await page.getByTestId('leave-dialog').count()) === 0; i++) await page.keyboard.press('Escape'); // back field by field, then the window asks
  await expect(page.getByTestId('leave-dialog')).toBeVisible();
  await page.keyboard.press('Alt+y');
  await expect(heading(page)).toHaveText('Gateway');
}

test.describe('a new window opens clean, every time', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('a half-entered Sales Invoice that was closed is not there when the next one opens', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // PO / ref
    await app.keyboard.press('Enter'); // E-way Bill No.
    await app.keyboard.press('Enter'); // sales ledger
    await app.keyboard.press('Enter'); // bill due
    await app.keyboard.type('machine oil');
    await app.keyboard.press('Enter');
    await app.waitForTimeout(600); // long enough for a draft to have been written
    await leaveWithContent(app);
    await app.keyboard.press('F8');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await expect(app.locator('[data-vf="party"]')).toHaveValue('');
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('');
  });

  test('a half-entered Payment that was closed is not there when the next one opens', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('freight');
    await app.keyboard.press('Enter');
    await app.keyboard.type('777');
    await app.waitForTimeout(600);
    await leaveWithContent(app);
    await app.keyboard.press('F5');
    await expect(app.locator('[data-vf="account"]')).toHaveValue('');
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('');
    await expect(app.locator('[data-vf="l0.amount"]')).toHaveValue('');
  });

  test('a half-entered Stock Journal that was closed is not there when the next one opens', async ({ app }) => {
    await app.keyboard.press('F10');
    await expect(heading(app)).toHaveText('New Stock Journal Voucher');
    await app.keyboard.press('Enter'); // Out → the item
    await app.keyboard.type('abc hex');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('ABC Hex Bolt M8');
    await app.waitForTimeout(600);
    await leaveWithContent(app);
    await app.keyboard.press('F10');
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('');
  });

  test('a page reload still brings back what was half-entered (the draft is for a crash, not for leaving)', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('freight');
    await app.keyboard.press('Enter');
    await app.keyboard.type('321');
    await app.waitForTimeout(700);
    await app.reload();
    await expect(app.locator('[data-vf="account"]')).toHaveValue('HDFC Bank Current A/c');
  });
});

test.describe('lists open only when something is typed, and offer only what matches', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('the party field: no list on arrival; what you type narrows it to matches; no match says so', async ({ app }) => {
    await app.keyboard.press('F8');
    await expect(app.locator('[data-vf="party"]')).toBeFocused();
    await expect(app.getByTestId('picker')).toHaveCount(0); // nothing typed: no list of every customer
    await app.keyboard.type('sha');
    await expect(app.getByTestId('picker').getByRole('option')).toHaveText([/Sharma Traders/]); // only what matches
    await app.keyboard.type('zzz');
    await expect(app.getByTestId('picker')).toContainText('No match');
    await expect(app.getByTestId('picker').getByRole('option')).toHaveCount(0);
  });

  test('a chosen value shows no list; typing over it lists matches again', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.locator('[data-vf="party"]').click();
    await expect(app.getByTestId('picker')).toHaveCount(0); // "Sharma Traders" is already chosen
    await app.locator('[data-vf="party"]').fill('abc');
    await expect(app.getByTestId('picker').getByRole('option').first()).toContainText('ABC Industries');
    await expect(app.getByTestId('picker')).not.toContainText('Sharma');
  });

  test('the ledger field of a Payment and the item field of a Stock Journal follow the same rule', async ({ app }) => {
    await app.keyboard.press('F5');
    await expect(app.getByTestId('picker')).toHaveCount(0);
    await app.keyboard.type('hdfc');
    await expect(app.getByTestId('picker').getByRole('option')).toHaveText([/HDFC Bank Current A\/c/]);
    await app.keyboard.type('qqq');
    await expect(app.getByTestId('picker')).toContainText('No match');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+y');
    await app.keyboard.press('F10');
    await app.keyboard.press('Enter'); // Out → the item
    await expect(app.getByTestId('picker')).toHaveCount(0);
    await app.keyboard.type('bolt');
    await expect(app.getByTestId('picker').getByRole('option').first()).toContainText('Bolt');
  });

  test('a master form’s reference field too: no list until typed', async ({ app }) => {
    await goTo(app, 'create ledger');
    await app.keyboard.press('Enter');
    await app.keyboard.type('Freight Inward');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('picker')).toHaveCount(0);
    await app.keyboard.type('indirect exp');
    await expect(app.getByTestId('picker').getByRole('option').first()).toHaveText(/Indirect Expenses/);
  });
});

test.describe('an invoice is a regular invoice until an order is chosen', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('choosing a customer that has an open order fills nothing in; the invoice can be made without the order', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await expect(app.getByLabel('Customer PO or reference')).toHaveValue('');
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('');
    await expect(app.getByTestId('voucher-banner')).toHaveCount(0);
    // an over-the-counter line for the same customer, not against its order
    await app.keyboard.press('Enter'); // PO / ref (left empty)
    await app.keyboard.press('Enter'); // E-way Bill No.
    await app.keyboard.press('Enter'); // sales ledger
    await app.keyboard.press('Enter'); // bill due
    await app.keyboard.type('machine oil');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // godown
    await app.keyboard.press('Enter'); // no order
    await app.keyboard.type('2');
    await app.keyboard.press('Enter');
    await app.keyboard.type('250');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Gateway'); // saved
  });
});
