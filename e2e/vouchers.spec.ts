/**
 * PHASE 5 EXIT GATE, in a real browser, keyboard only: enter each kind of voucher, switch types on the bottom bar, get errors on the exact line,
 * create a ledger from inside a voucher and come back, change a voucher, and read the books back in the Day Book and the Ledger — sorted,
 * filtered by voucher type, and drilled down to the voucher and back.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, goTo, heading, palette, paletteOptions, test } from './support';

const banner = (page: Page) => page.getByTestId('voucher-banner');
const panel = (page: Page) => page.getByTestId('action-panel');
const focused = (page: Page): Locator => page.locator('[data-vf]:focus');
const dayBookRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

/** Types a payment the way a person would: account, then lines, ending on the narration. */
async function fillPayment(page: Page, account: string, lines: [string, string][], narration = ''): Promise<void> {
  await page.keyboard.type(account);
  await page.keyboard.press('Enter');
  for (const [ledger, amount] of lines) {
    await page.keyboard.type(ledger);
    await page.keyboard.press('Enter');
    await page.keyboard.type(amount);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Enter'); // the empty next line → straight to the narration
  if (narration) await page.keyboard.type(narration);
}

async function openDayBook(page: Page): Promise<void> {
  await goTo(page, 'day book');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Day Book');
}

test.describe('entering vouchers', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('F5 opens a Payment: account first, the action panel lists the types, the date is today', async ({ app }) => {
    await app.keyboard.press('F5');
    await expect(heading(app)).toHaveText('New Payment Voucher');
    await expect(focused(app)).toHaveAttribute('data-vf', 'account');
    await expect(app.getByTestId('voucher-number')).toHaveText('assigned on save');
    for (const label of ['Contra', 'Payment', 'Receipt', 'Journal']) await expect(panel(app)).toContainText(label);
    await expect(app.getByTestId('voucher-weekday')).toHaveText(/day$/);
  });

  test('the type keys are only in the panel inside a voucher', async ({ app }) => {
    await expect(panel(app)).toHaveCount(0); // the Gateway has no panel
    await app.keyboard.press('F7');
    await expect(panel(app)).toContainText('Journal');
    await app.keyboard.press('Escape'); // nothing entered: closes at once
    await expect(panel(app)).toHaveCount(0);
  });

  test('a payment: account, two particulars, narration, Enter → saved with the next number; the form is ready for the next', async ({ app }) => {
    await app.keyboard.press('F5');
    await fillPayment(app, 'hdfc', [['factory', '12,000'], ['electricity', '3450.50']], 'May bills');
    await expect(app.getByTestId('total-amount')).toHaveText('15,450.50');
    await app.keyboard.press('Alt+n'); // Enter on the narration accepts
    await expect(banner(app)).toHaveText(/^Payment PAY\/\d\d-\d\d\/0004 saved\.$/);
    await expect(app.locator('[data-vf="account"]')).toHaveValue('HDFC Bank Current A/c'); // same account, ready for the next
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('');
    await expect(app.getByTestId('voucher-number')).toHaveText('assigned on save');
  });

  test('the account shows its current balance, and a ledger shows its own under it', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('account-balance')).toContainText('Cur Bal: +₹7,56,600.00 Dr');
    await app.keyboard.type('factory');
    await app.keyboard.press('Enter');
    await app.keyboard.type('100');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('line-balance').first()).toContainText('Cur Bal: 25,000.00 Dr');
  });

  test('a receipt and a contra go through the same window', async ({ app }) => {
    await app.keyboard.press('F6');
    await expect(heading(app)).toHaveText('New Receipt Voucher');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.keyboard.type('5,000');
    await app.keyboard.press('Enter');
    // Sharma Traders has an open bill (INV-014): the panel opens BLANK on its type list; Against ref, then the bill is searched for
    await expect(app.getByTestId('kind-picker')).toBeVisible();
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue('');
    await app.keyboard.press('Enter'); // type: Against ref
    await app.keyboard.type('inv-014');
    await app.keyboard.press('Enter'); // takes the bill it finds
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue('INV-014');
    await app.keyboard.press('Enter'); // amount: adds up → done, next line
    await app.keyboard.press('Enter'); // empty ledger: that is all the lines → narration
    await app.keyboard.press('Alt+n'); // accept
    await expect(banner(app)).toHaveText(/^Receipt REC\/\d\d-\d\d\/0003 saved\.$/);
    await app.keyboard.press('F4');
    await expect(heading(app)).toHaveText('New Contra Voucher');
  });

  test('a contra only offers cash and bank ledgers', async ({ app }) => {
    await app.keyboard.press('F4');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('rent');
    await expect(app.getByTestId('picker')).toContainText('No match'); // Factory Rent is not cash or bank
    await app.keyboard.press('Control+a');
    await app.keyboard.press('Escape');
  });

  test('switching types on the bar changes the window in place and the address follows', async ({ app }) => {
    await app.keyboard.press('F5');
    await fillPayment(app, 'hdfc', [['factory', '500']], 'keep me');
    await app.keyboard.press('F6');
    await expect(heading(app)).toHaveText('New Receipt Voucher');
    await expect(app.getByTestId('voucher-type-tag')).toHaveText('Receipt');
    await expect(app.locator('[data-vf="account"]')).toHaveValue('HDFC Bank Current A/c'); // kept
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('Factory Rent'); // kept
    await expect(app.locator('[data-vf="narration"]')).toHaveValue('keep me');
    expect(new URL(app.url()).hash).toBe('#/voucher/new/receipt');

    await app.keyboard.press('F7'); // across layouts: the account cannot come along, and we are told
    await expect(app.getByTestId('voucher-type-tag')).toHaveText('Journal');
    await expect(banner(app)).toContainText('The account (HDFC Bank Current A/c) was cleared');
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('Factory Rent');
    await app.keyboard.press('Escape'); // asks: the draft has content
    await expect(app.getByTestId('leave-dialog')).toBeVisible();
    await app.keyboard.press('Alt+y');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('a journal: By / To, debit and credit columns, live balance, saved when it balances', async ({ app }) => {
    await app.keyboard.press('F7');
    await expect(heading(app)).toHaveText('New Journal Voucher');
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.side');
    await expect(app.locator('[data-vf="l0.side"]')).toHaveValue('By');
    await app.keyboard.press('Enter');
    await app.keyboard.type('rent');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1,500');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="l1.side"]')).toHaveValue('To'); // the next line takes the side that balances
    await expect(app.getByTestId('balance-state')).toContainText('Difference 1,500.00');
    await app.keyboard.press('Enter');
    await app.keyboard.type('bharat');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1500'); // Bharat Chemicals has no open bills: a new one is offered
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('bill-panel')).toBeVisible();
    await expect(app.locator('[data-vf="a1.0.kind"]')).toHaveValue('New ref'); // the panel starts on its type
    await app.keyboard.press('Enter'); // type kept
    await app.keyboard.type('BC-78');
    await app.keyboard.press('Enter'); // ref → due date
    await app.keyboard.press('Enter'); // due → amount
    await app.keyboard.press('Enter'); // amount: adds up → panel closes, next line
    await expect(app.getByTestId('bill-panel')).toHaveCount(0);
    await expect(app.getByTestId('balance-state')).toHaveText('✓ Debit = Credit');
    await expect(app.getByTestId('total-debit')).toHaveText('1,500.00');
    await expect(app.getByTestId('total-credit')).toHaveText('1,500.00');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toHaveText(/^Journal JRN\/\d\d-\d\d\/0002 saved\.$/);
  });

  test('a journal refuses cash and bank, and its picker does not offer them', async ({ app }) => {
    await app.keyboard.press('F7');
    await app.keyboard.press('Enter');
    await app.keyboard.type('hdfc');
    await expect(app.getByTestId('picker')).toContainText('No match');
  });

  test('problems land on the exact line and field, and only after you try to accept', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('factory');
    await app.keyboard.press('Enter');
    await expect(app.getByRole('alert')).toHaveCount(0); // nothing shouted yet
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'Enter an amount' })).toBeVisible();
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.amount'); // focus goes to it
    await app.keyboard.type('abc');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'That is not an amount' })).toBeVisible();
  });

  test('F2 changes the date: "5-5" means 5 May of this financial year', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.press('F2');
    await expect(focused(app)).toHaveAttribute('data-vf', 'date');
    await app.keyboard.type('5-5');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="date"]')).toHaveValue(/^5-May-\d{4}$/);
    await app.keyboard.press('F2');
    await app.keyboard.type('31-2');
    await app.keyboard.press('Enter');
    await expect(app.getByRole('alert').filter({ hasText: 'not a date' })).toBeVisible();
  });

  test('a cash or bank balance shows +₹ (available) or −₹ (overdrawn) beside Dr/Cr; other ledgers stay plain Dr/Cr', async ({ app }) => {
    await app.keyboard.press('F5');
    await fillPayment(app, 'hdfc', [['factory', '800000']]);
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');
    // the window is ready for the next voucher, keeping the account: 7,56,600 − 8,00,000 is overdrawn
    await expect(app.getByTestId('account-balance')).toContainText('Cur Bal: −₹43,400.00 Cr');
    await app.keyboard.press('F4'); // switch to a Contra in place: its particulars are cash/bank too
    await expect(heading(app)).toHaveText('New Contra Voucher');
    await app.locator('[data-vf="l0.ledger"]').fill('petty');
    await expect(app.getByTestId('picker')).toContainText('+₹23,000.00 Dr');
  });

  test('Alt+C inside a voucher: create the missing ledger, come back with it chosen and the draft intact', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('Legal Fees');
    await expect(app.getByTestId('picker')).toContainText('Alt');
    await app.keyboard.press('Alt+c');
    await expect(app.getByTestId('report-dialog')).toContainText('Create what?'); // a ledger, or a customer/vendor (a Party)
    await app.keyboard.press('Enter'); // Ledger
    await expect(heading(app)).toHaveText('Create Ledger');
    await expect(app.locator('[data-field="name"]')).toHaveValue('Legal Fees');
    await app.keyboard.press('Tab');
    await app.keyboard.type('indirect exp');
    await app.keyboard.press('Control+a');

    await expect(heading(app)).toHaveText('New Payment Voucher');
    await expect(app.locator('[data-vf="account"]')).toHaveValue('HDFC Bank Current A/c'); // the draft is exactly as left
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('Legal Fees');
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.ledger');
    await app.keyboard.press('Enter');
    await app.keyboard.type('2500');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');
  });

  test('a half-entered voucher survives a reload', async ({ app }) => {
    await app.keyboard.press('F5');
    await fillPayment(app, 'hdfc', [['factory', '750']], 'to be continued');
    await app.waitForTimeout(700); // the draft is written a moment after you stop typing
    await app.reload();
    await expect(heading(app)).toHaveText('New Payment Voucher');
    await expect(app.locator('[data-vf="account"]')).toHaveValue('HDFC Bank Current A/c');
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('Factory Rent');
    await expect(app.locator('[data-vf="l0.amount"]')).toHaveValue('750');
    await expect(app.locator('[data-vf="narration"]')).toHaveValue('to be continued');
  });

  test('Esc from a voucher with content asks before throwing it away', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Escape'); // back to the account (no list is open: nothing was typed in the ledger field)
    await app.keyboard.press('Escape'); // the window: asks
    await expect(app.getByTestId('leave-dialog')).toBeVisible();
    await app.keyboard.type('x');
    await expect(app.getByTestId('leave-dialog')).toBeVisible(); // typing does not reach the field beneath, and does not answer the question
    await expect(app.locator('[data-vf="l0.ledger"]')).not.toHaveValue(/x/);
    await app.keyboard.press('Escape'); // Esc = No: stay
    await expect(app.getByTestId('leave-dialog')).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Payment Voucher');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+y');
    await expect(heading(app)).toHaveText('Gateway');
  });
});

test.describe('bill-wise details', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('paying a supplier offers its open bill; accepting keeps the parts adding up', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('steel');
    await app.keyboard.press('Enter');
    await app.keyboard.type('5000');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('bill-panel')).toBeVisible();
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue(''); // nothing is chosen for the person
    await expect(app.getByTestId('open-bills')).toContainText('PO-2210 (1,10,000.00');
    await expect(app.getByText('✓ Adds up to the line')).toBeVisible();
    await app.keyboard.press('Enter'); // type: Against ref
    await app.keyboard.type('po-22');
    await app.keyboard.press('Enter'); // the search box takes the bill
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue('PO-2210');
    await expect(app.locator('[data-vf="a0.0.amount"]')).toHaveValue('5000.00'); // part of it: the rest stays open
    await app.keyboard.press('Enter'); // amount → done
    await expect(app.getByTestId('bill-panel')).toHaveCount(0);
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');
  });

  test('a part that does not add up is refused where you are, and can be corrected', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('steel');
    await app.keyboard.press('Enter');
    await app.keyboard.type('5000');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // type: Against ref
    await app.keyboard.press('Enter'); // ref empty: opens the search box
    await app.keyboard.press('Enter'); // takes the highlighted bill
    await app.keyboard.type('3000'); // amount typed over: 2,000 short
    await expect(app.getByText('2,000.00 still to allocate')).toBeVisible();
    await app.keyboard.press('Enter'); // adds a row for the rest, on account
    await expect(app.locator('[data-vf="a0.1.kind"]')).toHaveValue('On account');
    await expect(app.locator('[data-vf="a0.1.amount"]')).toHaveValue('2000.00');
  });

  test('Esc leaves the bill panel without losing the line', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('steel');
    await app.keyboard.press('Enter');
    await app.keyboard.type('5000');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('bill-panel')).toHaveCount(0);
    await expect(app.locator('[data-vf="l0.amount"]')).toHaveValue('5000');
    await expect(heading(app)).toHaveText('New Payment Voucher');
  });
});

test.describe('party details', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('Alt+P opens the window, prefilled from the party; accept keeps a snapshot on the voucher', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1000');
    await app.keyboard.press('Enter'); // the bill panel
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+p');
    const dialog = app.getByTestId('party-details');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-pd="party"]')).toHaveValue('ABC Industries');
    await expect(dialog.locator('[data-pd="mailing"]')).toHaveValue('ABC Industries');
    await expect(dialog.locator('[data-pd="billLines"]')).toHaveValue('Plot 14, MIDC Bhosari, Pune');
    await expect(dialog.locator('[data-pd="gstin"]')).toHaveValue(/^27AAPFU0939F1Z/);
    await expect(dialog.locator('[data-pd="registration"]')).toHaveValue('Regular');
    await app.keyboard.press('Control+a');
    await expect(dialog).toHaveCount(0);
    await expect(app.getByTestId('party-summary')).toContainText('ABC Industries');
  });

  test('ship-to can be another address, entered by hand and saved to the party for next time', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1000');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+p');
    const dialog = app.getByTestId('party-details');
    const field = (k: string) => dialog.locator(`[data-pd="${k}"]`);
    // walk to "Ship to" and choose manual entry
    for (let i = 0; i < 8; i++) await app.keyboard.press('Tab');
    await expect(field('shipMode')).toBeFocused();
    await app.keyboard.press('ArrowDown'); // → Primary address
    await app.keyboard.press('ArrowDown'); // → Enter manually
    await expect(field('shipMode')).toHaveValue('Enter manually…');
    await app.keyboard.press('Tab');
    await app.keyboard.type('ABC — Chakan unit');
    await app.keyboard.press('Tab');
    await app.keyboard.type('Gat 45, Chakan, Pune');
    await app.keyboard.press('Tab');
    await app.keyboard.type('27');
    await app.keyboard.press('Tab'); // place of supply
    await app.keyboard.press('Tab'); // save as
    await expect(field('saveAs')).toBeFocused();
    await app.keyboard.type('Chakan unit');
    await app.keyboard.press('Control+a');
    await expect(dialog).toHaveCount(0);

    // the address is now a saved choice on the party
    await goTo(app, '@abc');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Display Party: ABC Industries');
  });

  test('a wrong GSTIN is refused on its field', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1000');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+p');
    const dialog = app.getByTestId('party-details');
    await dialog.locator('[data-pd="gstin"]').fill('27AAPFU0939F1ZA');
    await app.keyboard.press('Control+a');
    await expect(dialog.getByRole('alert').filter({ hasText: 'check digit' })).toBeVisible();
    await app.keyboard.press('Escape'); // cancel keeps the voucher as it was
    await expect(dialog).toHaveCount(0);
    await expect(app.getByTestId('party-summary')).toHaveCount(0);
  });
});

test.describe('the Day Book', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('lists every voucher NEWEST first with totals that agree (the demo’s two stock journals, three sales orders, two sales invoices and a purchase order are in it)', async ({ app }) => {
    await openDayBook(app);
    await expect(dayBookRows(app).first()).toContainText('SAL/'); // the newest voucher: the demo's latest invoice
    await expect(dayBookRows(app).last()).toContainText('OB/0001'); // the oldest: an opening balance, on the first day of the year
    await expect(dayBookRows(app)).toHaveCount(21); // 13 accounting + 2 stock journals + 3 sales orders + 2 sales invoices + 1 purchase order
    const foot = app.getByTestId('report-foot');
    await expect(foot).toContainText('21 shown of 21');
    const text = (await foot.textContent()) ?? '';
    const [debit, credit] = [...text.matchAll(/(?:debit|credit) ([\d,]+\.\d\d)/g)].map((m) => m[1]);
    expect(debit).toBe(credit); // every voucher balances, so the book does
  });

  test('a voucher you just entered is in it', async ({ app }) => {
    await app.keyboard.press('F5');
    await fillPayment(app, 'hdfc', [['freight', '999']], 'Unique narration XYZ');
    await app.keyboard.press('Enter');
    await openDayBook(app);
    await expect(dayBookRows(app).filter({ hasText: 'Unique narration XYZ' })).toHaveCount(1);
    await expect(app.getByTestId('report-foot')).toContainText('22 shown of 22');
  });

  test('Alt+S sorts the column, again reverses it, again clears it — with an arrow to show which', async ({ app }) => {
    await openDayBook(app);
    for (let i = 0; i < 5; i++) await app.keyboard.press('Tab'); // → Debit
    await expect(app.getByRole('columnheader', { name: /Debit/ })).toHaveClass(/active/);
    await app.keyboard.press('Alt+s');
    await expect(app.getByRole('columnheader', { name: /Debit/ })).toHaveAttribute('aria-sort', 'ascending');
    await app.keyboard.press('Alt+s');
    await expect(app.getByRole('columnheader', { name: /Debit/ })).toHaveAttribute('aria-sort', 'descending');
    const biggest = await dayBookRows(app).first().textContent();
    expect(biggest).toContain('OB/000'); // an opening balance is the biggest amount
    await app.keyboard.press('Alt+s');
    await expect(app.getByRole('columnheader', { name: /Debit/ })).toHaveAttribute('aria-sort', 'none');
  });

  test('typing narrows every column at once', async ({ app }) => {
    await openDayBook(app);
    await app.keyboard.type('april rent');
    await expect(dayBookRows(app)).toHaveCount(1);
    await expect(dayBookRows(app).first()).toContainText('April rent and power');
    await app.keyboard.press('Alt+k');
    await expect(dayBookRows(app)).toHaveCount(21);
  });

  test('Alt+L filters the column: a choice (voucher type), a range (amount) and text', async ({ app }) => {
    await openDayBook(app);
    await app.keyboard.press('Tab');
    await app.keyboard.press('Tab'); // → Type
    await app.keyboard.press('Alt+l');
    const dialog = app.getByTestId('report-dialog');
    await expect(dialog).toBeVisible();
    await app.keyboard.press('ArrowDown'); // All → first type
    await app.keyboard.press('Enter'); // tick
    await app.keyboard.press('Control+a');
    await expect(dialog).toHaveCount(0);
    await expect(app.getByTestId('chip')).toHaveCount(1);
    const n = await dayBookRows(app).count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(13);

    await app.keyboard.press('Alt+k');
    await expect(app.getByTestId('chip')).toHaveCount(0);
    for (let i = 0; i < 3; i++) await app.keyboard.press('Tab'); // → Narration? go to Debit
    await app.keyboard.press('Alt+l');
    await expect(dialog).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('Alt+T filters by voucher type; the chip says so and can be removed', async ({ app }) => {
    await openDayBook(app);
    await app.keyboard.press('Alt+t');
    await expect(app.getByTestId('report-dialog')).toContainText('Voucher types');
    const options = app.getByTestId('report-dialog').getByRole('option');
    await expect(options.first()).toContainText('All');
    // tick Payment and Receipt
    for (const name of ['Payment', 'Receipt']) {
      await options.filter({ hasText: new RegExp(`^\\s*[☐☑]?\\s*${name}$`) }).click();
    }
    await app.keyboard.press('Control+a');
    await expect(app.getByTestId('chip')).toContainText('Type: Payment, Receipt');
    const types = await dayBookRows(app).allTextContents();
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(t).toMatch(/Payment|Receipt/);
    await app.getByRole('button', { name: /Remove filter/ }).click();
    await expect(dayBookRows(app)).toHaveCount(21);
  });

  test('Enter opens the voucher; Esc returns to the same row in the same view', async ({ app }) => {
    await openDayBook(app);
    await app.keyboard.type('wages');
    await expect(dayBookRows(app)).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/^Display Payment PAY\/\d\d-\d\d\/0003$/);
    await expect(app.locator('[data-vf="narration"]')).toHaveAttribute('readonly', '');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Day Book');
    await expect(app.getByRole('textbox', { name: 'Quick filter' })).toHaveValue('wages'); // the filter is still there
    await expect(dayBookRows(app)).toHaveCount(1);
  });

  test('F2 changes the period; a voucher outside it disappears', async ({ app }) => {
    await openDayBook(app);
    await app.keyboard.press('F2');
    const dialog = app.getByTestId('report-dialog');
    await expect(dialog).toContainText('Period');
    await app.keyboard.type('1-6');
    await app.keyboard.press('Enter'); // to
    await app.keyboard.type('30-6');
    await app.keyboard.press('Control+a');
    await expect(dialog).toHaveCount(0);
    await expect(app.getByTestId('report-empty')).toContainText('Nothing in this period');
  });
});

test.describe('the Ledger report', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  async function openLedger(page: Page, name: string): Promise<void> {
    await goTo(page, 'ledger');
    await page.keyboard.press('Enter'); // the Ledger report
    await expect(page.getByTestId('report-dialog')).toContainText('Choose a ledger');
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(heading(page)).toContainText('Ledger:');
  }

  test('asks for a ledger, then shows opening, entries with a running balance, and closing', async ({ app }) => {
    await openLedger(app, 'hdfc');
    await expect(heading(app)).toHaveText('Ledger: HDFC Bank Current A/c');
    await expect(app.getByTestId('ledger-opening')).toContainText('0.00'); // the opening voucher is dated the first day of the year, so it is the first ROW
    await expect(app.getByTestId('ledger-closing')).toHaveText('7,56,600.00 Dr'); // 850000 + 60000 − 33400 − 100000 − 20000
    const rows = dayBookRows(app);
    await expect(rows).toHaveCount(5); // opening voucher, receipt, two payments, contra
    await expect(rows.first()).toContainText('7,56,600.00 Dr'); // newest first: the running balance of the top row is the closing balance
    await expect(rows.last()).toContainText('8,50,000.00 Dr'); // …and the opening voucher is at the bottom
  });

  test('the voucher-type filter shows only those rows and keeps the TRUE running balance', async ({ app }) => {
    await openLedger(app, 'hdfc');
    await app.keyboard.press('Alt+t');
    const options = app.getByTestId('report-dialog').getByRole('option');
    await options.filter({ hasText: /^\s*[☐☑]?\s*Payment$/ }).click();
    await app.keyboard.press('Control+a');
    await expect(app.getByTestId('chip')).toContainText('Type: Payment');
    await expect(dayBookRows(app)).toHaveCount(2);
    // the second payment (15 April) comes after the opening balance and the receipt, so its balance includes them: 7,76,600.00 Dr — not just the payments
    await expect(dayBookRows(app).first()).toContainText('7,76,600.00 Dr'); // (newest first)
    await expect(app.getByTestId('ledger-closing')).toHaveText('7,56,600.00 Dr'); // closing is the ledger's, untouched
    await expect(app.getByTestId('report-foot')).toContainText('Filtered total');
    await expect(app.getByTestId('report-foot')).toContainText('debit 0.00 credit 1,33,400.00');
  });

  test('a row drills down to its voucher and Esc comes back to the same row', async ({ app }) => {
    await openLedger(app, 'hdfc');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Ledger: HDFC Bank Current A/c');
    await expect(app.getByRole('row', { selected: true })).toHaveCount(1);
  });

  test('Alt+G → a party → “Ledger report” opens its statement', async ({ app }) => {
    await goTo(app, '@steel supplies'); // a supplier is a party; its ledger comes with it
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app)).toContainText(['Display Party', 'Alter Party', 'Ledger report']);
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Ledger: Steel Supplies Pvt Ltd');
    await expect(app.getByTestId('ledger-closing')).toHaveText('1,10,000.00 Cr');
  });
});

test.describe('alter and cancel', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  async function openVoucher(page: Page, text: string): Promise<void> {
    await openDayBook(page);
    await page.keyboard.type(text);
    await expect(dayBookRows(page)).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(heading(page)).toContainText('Display');
  }

  test('Alt+A alters a voucher: change the narration, save, and it shows in the Day Book', async ({ app }) => {
    await openVoucher(app, 'Wages');
    await app.keyboard.press('Alt+a');
    await expect(heading(app)).toContainText('Alter Payment');
    await app.locator('[data-vf="narration"]').fill('Wages for April, corrected');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toContainText('Display Payment');
    await app.keyboard.press('Escape');
    await expect(dayBookRows(app).first()).toContainText('Wages');
    await app.keyboard.press('Escape');
    await openDayBook(app);
    await expect(dayBookRows(app).filter({ hasText: 'Wages for April, corrected' })).toHaveCount(1); // the narration column shows the change
  });

  test('Alt+X cancels after asking; the number stays in the Day Book, struck out, and the books lose it', async ({ app }) => {
    await openVoucher(app, 'Wages');
    await app.keyboard.press('Alt+x');
    await expect(app.getByTestId('cancel-confirm')).toContainText('keeps its number but leaves the books');
    await app.keyboard.press('Escape'); // keep it
    await expect(app.getByTestId('cancel-confirm')).toHaveCount(0);
    await app.keyboard.press('Alt+x');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Day Book');
    const row = dayBookRows(app).filter({ hasText: 'CANCELLED' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('PAY/');
    await expect(row).toHaveClass(/cancelled/);
  });

  test('a cancelled voucher offers neither alter nor cancel again', async ({ app }) => {
    await openVoucher(app, 'Wages');
    await app.keyboard.press('Alt+x');
    await app.keyboard.press('Control+a'); // cancelled → back on the Day Book, still filtered to "Wages"
    await expect(dayBookRows(app)).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(app.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(panel(app).locator('[data-command="master.alter"]')).toBeDisabled();
    await expect(panel(app).locator('[data-command="voucher.cancel"]')).toBeDisabled();
  });
});

test.describe('Go To finds vouchers', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('v: finds by number, narration or amount, and Enter displays the voucher', async ({ app }) => {
    await goTo(app, 'v:rent');
    await expect(palette(app).getByRole('option').first()).toContainText('Voucher');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Payment');
    await app.keyboard.press('Escape');
    await goTo(app, '100000');
    await expect(paletteOptions(app).filter({ hasText: 'Voucher' }).first()).toBeVisible();
  });

  test('a voucher hit lists Display and Alter as actions', async ({ app }) => {
    await goTo(app, 'v:wages');
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app)).toContainText(['Display voucher', 'Alter voucher']);
  });
});
