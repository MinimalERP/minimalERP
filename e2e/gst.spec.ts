/**
 * PHASE 9, in a real browser: GST on the Sales and Purchase invoice (a company switch, per-line rate from the item, CGST+SGST inside the state, IGST outside),
 * TDS the customer deducted against a bill on the Receipt, and the GST reports — GSTR-1 (invoices, HSN summary, the check before the export, the export
 * itself), GSTR-3B (output, input "to review", net) — every figure drilling back to the invoice and the tax ledger. Keyboard first.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

const banner = (page: Page) => page.getByTestId('voucher-banner');
const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

/** Company Settings › Alter › Charge GST = Yes. (The demo company ships with GST off so its figures are what they always were.) */
async function chargeGst(page: Page): Promise<void> {
  await goTo(page, 'company settings');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Display Company: Demo Manufacturing Pvt Ltd');
  await page.keyboard.press('Alt+a');
  const field = page.locator('[data-field="chargeGst"]');
  await field.click();
  await page.keyboard.type('yes');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

/** Gateway › Reports › the named report. */
async function openReport(page: Page, name: string): Promise<void> {
  await goTo(page, name);
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText(name);
}

/** F8 → customer, item, qty, rate: ends on the line's GST % cell. */
async function sale(page: Page, customer: string, item: string, qty: string, rate: string): Promise<void> {
  await page.keyboard.press('F8');
  await expect(heading(page)).toHaveText('New Sales Voucher');
  await expect(page.locator('[data-vf="party"]')).toBeFocused();
  await page.keyboard.type(customer);
  await page.keyboard.press('Enter'); // → PO
  await page.keyboard.press('Enter'); // → sales ledger
  await page.keyboard.press('Enter'); // → bill due
  await page.keyboard.press('Enter'); // → item
  await page.keyboard.type(item);
  await page.keyboard.press('Enter'); // → godown
  await page.keyboard.press('Enter'); // → against order
  await page.keyboard.press('Enter'); // → qty
  await expect(page.locator('[data-vf="l0.qty"]')).toBeFocused();
  await page.keyboard.type(qty);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-vf="l0.rate"]')).toBeFocused();
  await page.keyboard.type(rate);
  await page.keyboard.press('Enter'); // → GST %
  await expect(page.locator('[data-vf="l0.gst"]')).toBeFocused();
}

test.describe('GST on invoices', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('with Charge GST off (the demo company) an invoice is the items alone: no GST column, no tax lines', async ({ app }) => {
    await app.keyboard.press('F8');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await expect(app.getByText('GST %', { exact: true })).toHaveCount(0);
    await expect(app.getByTestId('gst-summary')).toHaveCount(0);
  });

  test('Charge GST on: CGST + SGST inside the state, IGST outside it, and the invoice total carries the tax', async ({ app }) => {
    await chargeGst(app);
    await sale(app, 'abc ind', 'abc hex', '100', '100'); // ABC Industries is in Maharashtra, like the company
    await expect(app.locator('[data-vf="l0.gst"]')).toHaveValue('18'); // the item's GST rate
    await expect(app.getByTestId('gst-taxable')).toHaveText('10,000.00');
    await expect(app.getByTestId('gst-cgst')).toHaveText('900.00');
    await expect(app.getByTestId('gst-sgst')).toHaveText('900.00');
    await expect(app.getByTestId('invoice-total')).toHaveText('11,800.00');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');

    await app.keyboard.type('sharma'); // Sharma Traders is in Delhi: the tax goes to the Centre whole
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.type('machine oil');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter');
    await app.keyboard.type('10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('250');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('gst-igst')).toHaveText('450.00');
    await expect(app.getByTestId('gst-cgst')).toHaveCount(0);
    await expect(app.getByTestId('invoice-total')).toHaveText('2,950.00');
    await app.keyboard.press('Control+a');
  });
});

test.describe('the GST reports', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
    await chargeGst(app);
    await sale(app, 'abc ind', 'abc hex', '100', '100');
    await app.keyboard.press('Alt+n'); // 11,800: CGST 900 + SGST 900
    await expect(banner(app)).toContainText('saved.');
    await sale(app, 'sharma', 'machine oil', '10', '250'); // Delhi: IGST 450
    await save(app); // 2,950
    await goTo(app, 'home');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('Reports has a GST group with GSTR-1 and GSTR-3B', async ({ app }) => {
    await app.getByRole('option', { name: /^Reports/ }).click();
    await expect(heading(app)).toHaveText('Reports');
    await expect(app.getByRole('option', { name: /^GSTR-1/ })).toBeVisible();
    await expect(app.getByRole('option', { name: /^GSTR-3B/ })).toBeVisible();
  });

  test('GSTR-1: one row per invoice and rate, totals that agree with the tax ledgers, Enter opens the invoice', async ({ app }) => {
    await openReport(app, 'GSTR-1');
    await expect(gridRows(app)).toHaveCount(2);
    await expect(app.getByTestId('gst-t-taxable')).toHaveText('12,500.00');
    await expect(app.getByTestId('gst-t-cgst')).toHaveText('900.00');
    await expect(app.getByTestId('gst-t-sgst')).toHaveText('900.00');
    await expect(app.getByTestId('gst-t-igst')).toHaveText('450.00');
    await expect(app.getByTestId('gst-t-tax')).toHaveText('2,250.00');
    await expect(app.getByTestId('gst-t-value')).toHaveText('14,750.00');
    await expect(app.getByTestId('gst-reconciliation')).toContainText('Output CGST');
    await expect(app.getByTestId('recon-output-cgst')).toContainText('✓');
    await expect(app.getByTestId('recon-output-igst')).toContainText('✓');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Sales SAL/');
  });

  test('GSTR-1 HSN summary groups by HSN and rate; Enter on an HSN opens the invoices that carry it', async ({ app }) => {
    await openReport(app, 'GSTR-1');
    await app.keyboard.press('Alt+v');
    await expect(heading(app)).toHaveText('GSTR-1: HSN summary');
    await expect(gridRows(app)).toHaveCount(2);
    await expect(gridRows(app).filter({ hasText: '7318' })).toHaveCount(1);
    await expect(gridRows(app).filter({ hasText: '2710' })).toHaveCount(1);
    await app.keyboard.type('2710');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('GSTR-1');
    await expect(gridRows(app)).toHaveCount(1);
  });

  test('GSTR-1 says what is missing before it will export, and exports when nothing is', async ({ app }) => {
    await openReport(app, 'GSTR-1');
    // the demo party has a valid GSTIN and every line has an HSN: nothing blocks
    await expect(app.getByTestId('gst-ready')).toBeVisible();
    const download = app.waitForEvent('download');
    await app.keyboard.press('Alt+b');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^GSTR1_27AABCD1234E1Z.*\.json$/);
    await expect(app.getByTestId('gst-notice')).toContainText('saved');
  });

  test('GSTR-3B: output tax, input tax shown TO REVIEW (never claimed), and the net position', async ({ app }) => {
    await openReport(app, 'GSTR-3B');
    await expect(app.getByTestId('gst-itc-note')).toContainText('to review');
    await expect(app.getByTestId('gst-output')).toHaveText('2,250.00');
    await expect(app.getByTestId('gst-review')).toHaveText('0.00');
    await expect(app.getByTestId('gst-net')).toHaveText('2,250.00');
    await expect(app.getByTestId('gst-reconciliation')).toContainText('Output IGST');
    // Enter on the outward-supplies line opens the invoices behind it
    await app.getByRole('row', { name: /Taxable outward supplies/ }).first().click();
    await expect(heading(app)).toHaveText('GSTR-1');
  });

  test('F2 asks for the financial year and month; another month is another return', async ({ app }) => {
    await openReport(app, 'GSTR-1');
    await app.keyboard.press('F2');
    await expect(app.getByRole('dialog')).toBeVisible();
    await app.keyboard.type('26-27');
    await app.keyboard.press('Enter');
    await app.keyboard.type('jan');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('gst-period')).toContainText('Jan 2027');
    await expect(app.getByTestId('report-empty')).toBeVisible();
  });
});

test.describe('TDS deducted by a customer, on the Receipt', () => {
  test('the receipt settles the whole bill: the bank gets the amount less the TDS, TDS Receivable holds the rest, and the bill is gone from Outstanding', async ({ app }) => {
    await loadDemo(app);
    await chargeGst(app);
    await sale(app, 'kumar', 'machine oil', '10', '250'); // Kumar Engineering is in Karnataka: 2,500 + IGST 450 = 2,950
    await expect(app.getByTestId('invoice-total')).toHaveText('2,950.00');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');

    await app.keyboard.press('F6');
    await expect(heading(app)).toHaveText('New Receipt Voucher');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await app.keyboard.type('2,900'); // what the customer paid: 2,950 less the 50 TDS it deducted
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // type: Against ref
    await app.keyboard.type('sal');
    await app.keyboard.press('Enter'); // the search box takes the invoice's own bill
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue(/^SAL\//);
    await app.keyboard.press('Enter'); // amount: what was received against this bill
    await app.keyboard.type('50'); // the TDS, beside it
    await expect(app.getByTestId('bill-tds')).toContainText('TDS deducted 50.00');
    await expect(app.getByTestId('bill-tds')).toContainText('Received 2,900.00');
    await expect(app.getByTestId('bill-tds')).toContainText('bills settled by 2,950.00'); // 2,900 + 50 = the whole invoice
    await app.keyboard.press('Enter'); // TDS → adds up → next line
    await app.keyboard.press('Enter'); // empty ledger: that is all the lines → narration
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');

    // the tax ledger holds the TDS…
    await goTo(app, 'l:tds receivable');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('TDS Receivable');
    await app.keyboard.press('Alt+r');
    await expect(app.getByTestId('ledger-closing')).toContainText('50.00');
    // …and the customer owes nothing
    await openReport(app, 'Outstanding Receivables');
    await expect(app.getByRole('grid')).not.toContainText('Kumar Engineering');
  });
});

test.describe('input GST on purchases is shown to review, never claimed', () => {
  test('a purchase invoice with GST lands in GSTR-3B under TO REVIEW; the eligible credit stays zero', async ({ app }) => {
    await loadDemo(app);
    await chargeGst(app);
    await app.keyboard.press('F9');
    await expect(heading(app)).toHaveText('New Purchase Voucher');
    await app.keyboard.type('steel'); // Steel Supplies is in Gujarat: IGST
    await app.keyboard.press('Enter'); // → PO / ref
    await app.keyboard.press('Enter'); // → purchase ledger
    await app.keyboard.press('Enter'); // → supplier inv no.
    await app.keyboard.type('SS-77');
    await app.keyboard.press('Enter'); // → bill due
    await app.keyboard.press('Enter'); // → item
    await app.keyboard.type('ms sheet');
    await app.keyboard.press('Enter'); // → godown
    await app.keyboard.press('Enter'); // → against order
    await app.keyboard.press('Enter'); // → qty
    await app.keyboard.type('100');
    await app.keyboard.press('Enter');
    await app.keyboard.type('100');
    await app.keyboard.press('Enter'); // → GST %
    await expect(app.locator('[data-vf="l0.gst"]')).toHaveValue('18');
    await expect(app.getByTestId('gst-igst')).toHaveText('1,800.00');
    await expect(app.getByTestId('invoice-total')).toHaveText('11,800.00');
    await app.keyboard.press('Control+a');

    await openReport(app, 'GSTR-3B');
    await expect(app.getByTestId('gst-review')).toHaveText('1,800.00');
    await expect(app.getByTestId('gst-output')).toHaveText('0.00');
    await expect(app.getByTestId('gst-net')).toHaveText('0.00'); // claiming nothing under review
    await expect(app.getByRole('row', { name: /TO REVIEW/ })).toContainText('1,800.00');
    await expect(app.getByTestId('recon-input-igst')).toContainText('✓');
  });
});

/** Ctrl+A on an invoice: saved, and the window has closed back to where it was opened. */
async function save(page: Page): Promise<void> {
  await page.keyboard.press('Control+a');
  await expect(heading(page)).not.toHaveText('New Sales Voucher');
}

test.describe('the check before the GSTR-1 export', () => {
  test('a line with no GST rate is listed as something to fix, and the export is refused until it is fixed', async ({ app }) => {
    await loadDemo(app);
    await chargeGst(app);
    await sale(app, 'abc ind', 'abc hex', '100', '100');
    await save(app); // keep 18 → this one is fine
    await sale(app, 'sharma', 'machine oil', '10', '250');
    await save(app);
    await sale(app, 'abc ind', 'mounting', '5', '40');
    await save(app);
    await sale(app, 'abc ind', 'machine oil', '1', '250');
    await app.locator('[data-vf="l0.gst"]').fill(''); // no rate on this line
    await save(app);
    await openReport(app, 'GSTR-1');
    await expect(app.getByTestId('gst-errors')).toContainText('no GST rate');
    let downloaded = false;
    app.once('download', () => (downloaded = true));
    await app.keyboard.press('Alt+b');
    await expect(app.getByTestId('gst-notice')).toContainText('Nothing was exported');
    expect(downloaded).toBe(false);
  });
});

/** The demo company charges no GST: two plain invoices of 1,500 to Kumar Engineering (15 Ltr of Machine Oil at 100). */
async function twoInvoicesOf1500(page: Page): Promise<void> {
  await page.keyboard.press('F8');
  for (let n = 0; n < 2; n++) {
    await expect(page.locator('[data-vf="party"]')).toBeFocused(); // a fresh window each time (Alt+N saves and starts the next)
    await page.keyboard.type('kumar');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
    await page.keyboard.type('machine oil');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
    await expect(page.locator('[data-vf="l0.qty"]')).toBeFocused();
    await page.keyboard.type('15');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-vf="l0.rate"]')).toBeFocused();
    await page.keyboard.type('100');
    await expect(page.getByTestId('total-amount')).toHaveText('1,500.00');
    await page.keyboard.press('Alt+n');
    await expect(banner(page)).toContainText('saved.');
  }
}

test.describe('a receipt for several invoices, each settled in part', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
    await twoInvoicesOf1500(app);
  });

  test('two open invoices of 1,500, 1,490 received with 5 TDS on each: both bills are settled 750 and stay open for 750', async ({ app }) => {
    await app.keyboard.press('F6');
    await expect(heading(app)).toHaveText('New Receipt Voucher');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1490'); // what the customer paid: 1,500 less 5 TDS on each of the two invoices
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue(''); // the panel opens blank, on its type
    await app.keyboard.press('Enter'); // type: Against ref
    await app.keyboard.press('Enter'); // ref empty: opens the search box
    await app.keyboard.press('Enter'); // takes the highlighted (oldest) bill
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue(/^SAL\//);
    await expect(app.locator('[data-vf="a0.0.amount"]')).toHaveValue('1490.00'); // what is received, against the first bill to begin with
    await app.keyboard.type('745'); // …745 of it is for this invoice (+ 5 TDS = 750)
    await app.keyboard.press('Enter');
    await app.keyboard.type('5');
    await app.keyboard.press('Enter'); // 750 still to allocate: another row, empty, starting at its type
    await expect(app.locator('[data-vf="a0.1.kind"]')).toBeFocused();
    await expect(app.locator('[data-vf="a0.1.kind"]')).toHaveValue('Against ref');
    await expect(app.locator('[data-vf="a0.1.ref"]')).toHaveValue(''); // no bill is filled in for it
    await expect(app.locator('[data-vf="a0.1.amount"]')).toHaveValue('745.00'); // what is left of what was received
    await expect(app.getByTestId('bill-picker')).toHaveCount(0);
    await app.keyboard.press('Enter'); // type kept (Against ref) → the search box
    await app.keyboard.type('sal'); // matches the open bills; the first bill is already used above, so one is left
    await expect(app.getByTestId('bill-picker').getByRole('option')).toHaveCount(1);
    await app.keyboard.press('Enter'); // takes it
    await expect(app.locator('[data-vf="a0.1.ref"]')).toHaveValue(/^SAL\//);
    await expect(app.locator('[data-vf="a0.1.ref"]')).not.toHaveValue(await app.locator('[data-vf="a0.0.ref"]').inputValue());
    await expect(app.locator('[data-vf="a0.1.amount"]')).toBeFocused();
    await app.keyboard.press('Enter'); // amount (750 kept)
    await app.keyboard.type('5');
    await expect(app.getByTestId('bill-tds')).toContainText('Received 1,490.00 + TDS deducted 10.00');
    await expect(app.getByTestId('bill-tds')).toContainText('bills settled by 1,500.00');
    await expect(app.getByText('✓ Adds up to the line')).toBeVisible();
    await app.keyboard.press('Enter'); // done with the bills → next line
    await app.keyboard.press('Enter'); // empty ledger: that is all the lines → narration
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');

    // each invoice has been paid 750: 750 of each is still due, 1,500 in all
    await openReport(app, 'Outstanding Receivables');
    await expect(gridRows(app).filter({ hasText: 'Kumar' })).toContainText('1,500.00');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await expect(gridRows(app)).toHaveCount(2);
    await expect(gridRows(app).nth(0)).toContainText('750.00');
    await expect(gridRows(app).nth(1)).toContainText('750.00');
  });

  test('Esc leaves the bill panel; coming back to the amount and pressing Enter offers it again, as it was', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1500');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('bill-panel')).toBeVisible();
    await app.keyboard.press('Enter'); // type: Against ref
    await app.keyboard.press('Enter'); // ref empty: opens the search box
    await app.keyboard.press('Enter'); // takes the highlighted bill
    const ref = await app.locator('[data-vf="a0.0.ref"]').inputValue();
    expect(ref).toMatch(/^SAL\//);
    await app.keyboard.press('Escape'); // Esc steps BACK one field at a time: amount → ref → type → out of the panel
    await expect(app.locator('[data-vf="a0.0.ref"]')).toBeFocused();
    await expect(app.getByTestId('bill-panel')).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(app.locator('[data-vf="a0.0.kind"]')).toBeFocused();
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('bill-panel')).toHaveCount(0);
    await expect(app.locator('[data-vf="l0.amount"]')).toBeFocused();
    await app.keyboard.press('Enter'); // the second time round
    await expect(app.getByTestId('bill-panel')).toBeVisible();
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue(ref);
    // …and once more, after moving on and back
    await app.keyboard.press('Escape');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('bill-panel')).toBeVisible();
    // a changed amount starts the panel afresh: one blank row for the new amount
    await app.keyboard.press('Escape');
    await app.keyboard.type('3000');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue('');
    await expect(app.locator('[data-vf="a0.0.amount"]')).toHaveValue('3000.00');
    await expect(app.locator('[data-vf="a0.1.ref"]')).toHaveCount(0);
  });

  test('↓ on a bill ref lists the party’s open bills; Enter takes one, with what it can be settled for; typing narrows the list', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1000');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('kind-picker').getByRole('option')).toHaveCount(4); // the type list is always visible on its field: Against ref, New ref, Advance, On account
    await app.keyboard.press('Enter'); // type: Against ref
    await expect(app.getByTestId('bill-picker')).toHaveCount(0); // the bill list does not pop open by itself
    await app.keyboard.press('ArrowDown');
    await expect(app.getByTestId('bill-picker').getByRole('option')).toHaveCount(2);
    const listed = (await app.getByTestId('bill-picker').getByRole('option').allTextContents()).map((t) => /SAL\/\d\d-\d\d\/\d{4}/.exec(t)?.[0] ?? '');
    const first = listed[0] ?? '';
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    const second = await app.locator('[data-vf="a0.0.ref"]').inputValue();
    expect(second).toBe(listed[1]);
    expect(second).not.toBe(first);
    await expect(app.locator('[data-vf="a0.0.amount"]')).toBeFocused();
    await expect(app.locator('[data-vf="a0.0.amount"]')).toHaveValue('1000.00'); // part of the second bill

    // typing narrows the list; Esc closes it without choosing
    await app.keyboard.press('Shift+Tab');
    await app.keyboard.type(first.slice(-4));
    await expect(app.getByTestId('bill-picker').getByRole('option')).toHaveCount(1);
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('bill-picker')).toHaveCount(0);
    await expect(app.getByTestId('bill-panel')).toBeVisible();
  });

  /** Receipt of 1,500 from Kumar, split over the two bills: row 1 = 750 (TDS 5), row 2 = 750 (TDS 5). Ends with the panel closed and the cursor on the next line. */
  async function splitOverTwoBills(app: Page): Promise<void> {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1490');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // type
    await app.keyboard.press('Enter'); // ref: opens the search
    await app.keyboard.press('Enter'); // takes a bill
    await app.keyboard.type('745');
    await app.keyboard.press('Enter');
    await app.keyboard.type('5');
    await app.keyboard.press('Enter'); // row 2, blank, at its type
    await app.keyboard.press('Enter'); // type
    await app.keyboard.press('Enter'); // ref: opens the search
    await app.keyboard.press('Enter'); // takes the other bill
    await app.keyboard.press('Enter'); // amount
    await app.keyboard.type('5');
    await app.keyboard.press('Enter'); // adds up: panel closes
    await expect(app.getByTestId('bill-panel')).toHaveCount(0);
  }

  test('Enter walks through EVERY row of the panel — it does not jump from the first row to the next line', async ({ app }) => {
    await splitOverTwoBills(app);
    await app.keyboard.press('Shift+Tab'); // back to the line amount
    await expect(app.locator('[data-vf="l0.amount"]')).toBeFocused();
    await app.keyboard.press('Enter'); // the panel again, as it was: cursor on row 1
    await expect(app.locator('[data-vf="a0.0.kind"]')).toBeFocused();
    await expect(app.locator('[data-vf="a0.1.ref"]')).toHaveValue(/^SAL\//);
    for (const field of ['a0.0.ref', 'a0.0.amount', 'a0.0.tds', 'a0.1.kind', 'a0.1.ref', 'a0.1.amount', 'a0.1.tds']) {
      await app.keyboard.press('Enter');
      await expect(app.locator(`[data-vf="${field}"]`)).toBeFocused(); // every field of every row, in order
    }
    await app.keyboard.press('Enter'); // after the LAST row: on to the next line
    await expect(app.locator('[data-vf="l1.ledger"]')).toBeFocused();
    await expect(app.getByTestId('bill-panel')).toHaveCount(0);
  });

  test('a row made by mistake is taken out with its × or Ctrl+Delete, and what is left to allocate shows again', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1490');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // type
    await app.keyboard.press('Enter'); // ref: opens the search
    await app.keyboard.press('Enter'); // takes a bill
    await app.keyboard.type('745');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // tds left empty: 745 to allocate → a second row
    await expect(app.locator('[data-vf="a0.1.kind"]')).toBeFocused();
    await app.keyboard.press('ArrowDown'); // Against ref → Advance → On account: the mistaken row
    await app.keyboard.press('ArrowDown');
    await expect(app.locator('[data-vf="a0.1.kind"]')).toHaveValue('On account');
    await app.getByRole('button', { name: 'Remove bill row 2' }).click(); // its ×
    await expect(app.locator('[data-vf="a0.1.kind"]')).toHaveCount(0);
    await expect(app.getByText('745.00 still to allocate')).toBeVisible();
    // the same with the keyboard: Enter on the last row's amount adds a row again, Ctrl+Delete takes it out
    await app.locator('[data-vf="a0.0.amount"]').focus();
    await app.keyboard.press('Enter'); // tds
    await app.keyboard.press('Enter'); // last row, 750 short → a new row
    await expect(app.locator('[data-vf="a0.1.kind"]')).toBeFocused();
    await app.keyboard.press('Control+Delete');
    await expect(app.locator('[data-vf="a0.1.kind"]')).toHaveCount(0);
    // removing the only row closes the panel; Enter on the amount offers a blank one again
    await app.keyboard.press('Control+Delete');
    await expect(app.getByTestId('bill-panel')).toHaveCount(0);
    await expect(app.locator('[data-vf="l0.amount"]')).toBeFocused();
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="a0.0.ref"]')).toHaveValue('');
    await expect(app.locator('[data-vf="a0.0.amount"]')).toHaveValue('1490.00');
  });
});

test.describe('every line has a × to clear it', () => {
  test('a Payment particulars line: the × takes a line out, and the only line is emptied instead', async ({ app }) => {
    await loadDemo(app);
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('factory');
    await app.keyboard.press('Enter');
    await app.keyboard.type('100');
    await app.keyboard.press('Enter');
    await app.keyboard.type('electricity');
    await app.keyboard.press('Enter');
    await app.keyboard.type('200');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('total-amount')).toHaveText('300.00');
    await app.getByRole('button', { name: 'Remove line 1' }).click();
    await expect(app.getByTestId('total-amount')).toHaveText('200.00');
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('Electricity & Power');
    await app.getByRole('button', { name: 'Remove line 1' }).click(); // the last one is emptied, not removed
    await expect(app.getByTestId('total-amount')).toHaveText('0.00');
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('');
    await expect(app.locator('[data-vf="l0.ledger"]')).toBeFocused();
  });

  test('a Journal and a Stock Journal have it too', async ({ app }) => {
    await loadDemo(app);
    await app.keyboard.press('F7');
    await expect(app.getByRole('button', { name: 'Remove line 1' })).toBeVisible();
    await app.keyboard.press('Escape');
    await app.keyboard.press('F10');
    await expect(heading(app)).toContainText('Stock Journal');
    await expect(app.getByRole('button', { name: 'Remove line 1' })).toBeVisible();
  });
});
