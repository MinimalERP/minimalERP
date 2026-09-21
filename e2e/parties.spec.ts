/**
 * THE PARTY IS THE ONE THING YOU CREATE, in a real browser, keyboard only:
 * a customer, a vendor or both, with its billing and shipping address and opening balances in one form — its ledger(s) come with it —
 * one hit in Go To, the right ledger offered first in receipts and payments, and Alt+C inside a voucher offering a Ledger or a Party.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, goTo, heading, palette, paletteOptions, paletteSelected, test } from './support';

const banner = (page: Page) => page.getByTestId('form-banner');
const titles = (page: Page) => page.getByTestId('goto-title');
const picker = (page: Page) => page.getByTestId('picker');
const focusedField = (page: Page): Locator => page.locator('[data-field]:focus');
const field = (page: Page, key: string): Locator => page.locator(`[data-field="${key}"]`);

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

async function openCreateParty(page: Page): Promise<void> {
  await goTo(page, 'create party');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Create Party');
}

test.describe('creating a party', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('one form: type, billing address, a different shipping address, terms and opening balances — and both ledgers appear', async ({ app }) => {
    await openCreateParty(app);
    await expect(focusedField(app)).toHaveAttribute('data-field', 'name');
    await app.keyboard.type('Orbit Engineering');
    await app.keyboard.press('Tab');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'roleType');
    await expect(field(app, 'roleType')).toHaveValue('Customer'); // the usual case is already chosen
    await expect(field(app, 'openVendAmount')).toHaveCount(0); // a customer has no payable opening balance
    await app.keyboard.type('both');
    await app.keyboard.press('Tab');
    await expect(field(app, 'openCustAmount')).toHaveCount(1);
    await expect(field(app, 'openVendAmount')).toHaveCount(1);
    await expect(app.locator('.form-section')).toContainText(['Billing address', 'Shipping address', 'Terms', 'Opening balance (optional)']);

    await field(app, 'address').fill('Plot 5, Sector 7, Noida');
    await field(app, 'stateCode').fill('09');
    await field(app, 'pincode').fill('201301');
    await expect(field(app, 'shipLines')).toHaveCount(0); // "same as billing" until asked otherwise
    await field(app, 'shipMode').fill('diff');
    await app.keyboard.press('Tab');
    await expect(field(app, 'shipLines')).toHaveCount(1);
    await field(app, 'shipLines').fill('Godown 2, Dadri');
    await field(app, 'shipStateCode').fill('09');
    await field(app, 'shipPincode').fill('203207');
    await field(app, 'creditDays').fill('30');
    await field(app, 'openCustAmount').fill('5000');
    await field(app, 'openCustBill').fill('INV-9');
    await field(app, 'openVendAmount').fill('2000');
    await field(app, 'openVendBill').fill('PO-9');
    await app.keyboard.press('Control+a');
    await expect(banner(app)).toHaveText('Party “Orbit Engineering” created.');

    // ONE party hit in Go To (with a ledger report for each side as actions) — and each ledger's report is a hit of its own, right under it
    await goTo(app, 'orbit');
    await expect(titles(app)).toHaveText(['Orbit Engineering', 'Orbit Engineering (as customer)', 'Orbit Engineering (as vendor)']);
    await expect(titles(app).first()).toHaveText('Orbit Engineering');
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app)).toHaveText([/Display Party/, /Alter Party/, /Ledger report \(as customer\)/, /Ledger report \(as vendor\)/]);
    for (let i = 0; i < 3; i++) await app.keyboard.press('ArrowDown');
    await expect(paletteSelected(app)).toContainText('as vendor');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Ledger: Orbit Engineering (Vendor)');
    await expect(app.getByTestId('ledger-closing')).toHaveText('2,000.00 Cr');
  });

  test('a customer’s opening balance is what it owes (Dr) and is posted to its ledger', async ({ app }) => {
    await openCreateParty(app);
    await app.keyboard.type('Delta Fabricators');
    await field(app, 'openCustAmount').fill('7500');
    await field(app, 'openCustBill').fill('INV-77');
    await app.keyboard.press('Control+a');
    await expect(banner(app)).toHaveText('Party “Delta Fabricators” created.');
    await goTo(app, '@delta');
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app)).toHaveText([/Display Party/, /Alter Party/, /Ledger report/]); // one side: no "(as …)"
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Ledger: Delta Fabricators');
    await expect(app.getByTestId('ledger-closing')).toHaveText('7,500.00 Dr');
  });

  test('a wrong pincode or state code is refused on its own field, and nothing is created', async ({ app }) => {
    await openCreateParty(app);
    await app.keyboard.type('Bad Pin Co');
    await field(app, 'pincode').fill('4110');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'six digits' })).toBeVisible();
    await expect(focusedField(app)).toHaveAttribute('data-field', 'pincode');
    await goTo(app, 'bad pin co');
    await expect(titles(app).filter({ hasText: 'Bad Pin Co' })).toHaveCount(0);
  });

  test('altering: a party can become both, but a role is not taken away', async ({ app }) => {
    await goTo(app, '@bharat');
    await app.keyboard.press('ArrowRight');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Alter Party: Bharat Chemicals');
    await expect(field(app, 'roleType')).toHaveValue('Vendor');
    await field(app, 'roleType').focus();
    await expect(picker(app)).toContainText('Both');
    await expect(picker(app)).not.toContainText('Customer —'); // only Vendor and Both are offered
    await expect(picker(app).getByRole('option')).toHaveCount(2);
    await field(app, 'roleType').fill('both');
    await app.keyboard.press('Tab');
    await app.keyboard.press('Control+a');
    // back on the display list; the customer ledger now exists next to the vendor one
    await goTo(app, 'bharat');
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app)).toContainText(['Ledger report (as customer)', 'Ledger report (as vendor)']);
  });
});

test.describe('customers and suppliers are made as a Party', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('Create Ledger does not offer Sundry Creditors: there is nothing to link, a supplier is made as a Party', async ({ app }) => {
    await goTo(app, 'create ledger');
    await app.keyboard.press('Enter');
    await app.keyboard.type('Acme Ltd');
    await app.keyboard.press('Tab');
    await app.keyboard.type('sundry cred');
    await expect(picker(app)).toContainText('No match');
    await expect(app.locator('.field-hint')).toContainText('created as a Party');
  });

  test('a party’s ledger, opened from the Ledgers list, points to its party — and alter goes to the party', async ({ app }) => {
    await app.keyboard.press('Enter'); // Masters
    await expect(heading(app)).toHaveText('Masters');
    await app.keyboard.press('Enter'); // Ledgers
    await expect(heading(app)).toHaveText('Ledgers');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Display Ledger: ABC Industries');
    await expect(app.getByTestId('party-ledger-note')).toContainText('belongs to ABC Industries');
    await app.keyboard.press('Alt+a');
    await expect(heading(app)).toHaveText('Alter Party: ABC Industries'); // never the ledger alone
  });
});

test.describe('in a voucher', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  const firstOption = (page: Page) => picker(page).getByRole('option').first();

  test('a receipt offers the customer ledger of a both-party first; a payment the vendor ledger', async ({ app }) => {
    await app.keyboard.press('F6'); // Receipt
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('kumar');
    await expect(picker(app).getByRole('option')).toHaveCount(2);
    await expect(firstOption(app)).toContainText('Sundry Debtors');
    for (let i = 0; i < 3; i++) await app.keyboard.press('Escape'); // the list, back to the account, then the window: it asks
    await app.keyboard.press('Alt+y');

    await app.keyboard.press('F5'); // Payment
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('kumar');
    await expect(picker(app).getByRole('option')).toHaveCount(2);
    await expect(firstOption(app)).toContainText('Sundry Creditors');
    await expect(firstOption(app)).toContainText('(Vendor)');
  });

  test('Alt+C on a party line asks Ledger or Party; Party makes one and returns with its ledger chosen', async ({ app }) => {
    await app.keyboard.press('F6'); // Receipt: the missing party is a customer
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('Zenith Traders');
    await expect(picker(app)).toContainText('No match');
    await app.keyboard.press('Alt+c');
    await expect(app.getByTestId('report-dialog')).toContainText('Create what?');
    await expect(app.getByTestId('report-dialog').getByRole('option')).toHaveText([/Ledger/, /Customer \/ Vendor \(Party\)/]);
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');

    await expect(heading(app)).toHaveText('Create Party');
    await expect(field(app, 'name')).toHaveValue('Zenith Traders'); // what was typed
    await expect(field(app, 'roleType')).toHaveValue('Customer'); // a receipt: money from a customer
    await app.keyboard.press('Control+a');

    await expect(heading(app)).toHaveText('New Receipt Voucher');
    await expect(app.locator('[data-vf="account"]')).toHaveValue('HDFC Bank Current A/c'); // the draft is as left
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('Zenith Traders');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1500');
    await app.keyboard.press('Enter'); // the bill panel
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+n');
    await expect(app.getByTestId('voucher-banner')).toContainText('saved.');
  });

  test('a cash/bank account is always just a ledger: Alt+C goes straight to Create Ledger', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('Brand New Bank');
    await app.keyboard.press('Alt+c');
    await expect(heading(app)).toHaveText('Create Ledger'); // no question: only a ledger can be cash or bank
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('New Payment Voucher');
  });

  test('Alt+P prefills both addresses from the party', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter'); // the customer ledger
    await app.keyboard.type('1000');
    await app.keyboard.press('Enter'); // the bill panel
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+p');
    const dialog = app.getByTestId('party-details');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-pd="party"]')).toHaveValue('Kumar Engineering Works');
    await expect(dialog.locator('[data-pd="billLines"]')).toHaveValue('Peenya Industrial Area, Bengaluru');
    await expect(dialog.locator('[data-pd="shipMode"]')).toHaveValue('Shipping address'); // the party's own ship-to, not "same as billing"
    await expect(dialog.locator('[data-pd="shipLines"]')).toHaveValue('SIPCOT Industrial Park, Hosur');
    await expect(dialog.locator('[data-pd="place"]')).toHaveValue('33');
    await expect(palette(app)).toHaveCount(0);
  });
});
