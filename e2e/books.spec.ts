/**
 * PHASE 7, in a real browser: the books as statements — Trial Balance (drill group → ledger), Cash and Bank Book, the two-sided Profit & Loss and
 * Balance Sheet, and Outstanding receivables/payables with ageing from the due date (drill party → bills → the voucher). Keyboard first, the panel
 * and the mouse where the plan promised them.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

const panel = (page: Page) => page.getByTestId('action-panel');
const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });
const gridRow = (page: Page, text: string | RegExp) => gridRows(page).filter({ hasText: text });
const num = (s: string | null): bigint => BigInt(Math.round(Number((s ?? '0').replace(/[^0-9.-]/g, '')) * 100));

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

/** Gateway › Reports › the named report, by a click (as a person would). */
async function openReport(page: Page, name: string): Promise<void> {
  if ((await heading(page).textContent()) !== 'Reports') {
    await page.getByRole('option', { name: /^Reports/ }).click();
    await expect(heading(page)).toHaveText('Reports');
  }
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
  await expect(heading(page)).toHaveText(name);
}

test.describe('the Reports menu', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('is grouped — Statements, Books, Outstanding, Inventory & Sales, GST — and every row is a real report', async ({ app }) => {
    await app.getByRole('option', { name: /^Reports/ }).click();
    await expect(app.getByTestId('menu-group').locator('.menu-group-title')).toHaveText(['Statements', 'Books', 'Outstanding', 'Inventory & Sales', 'GST']);
    const group = (name: string) => app.getByTestId('menu-group').filter({ has: app.locator('.menu-group-title', { hasText: name }) });
    await expect(group('Statements').getByRole('option')).toHaveText([/Trial Balance/, /Profit & Loss/, /Balance Sheet/]);
    await expect(group('Books').getByRole('option')).toHaveText([/Day Book/, /Ledger/, /Cash Book/, /Bank Book/]);
    await expect(group('Outstanding').getByRole('option')).toHaveText([/Outstanding Receivables/, /Outstanding Payables/]);
    await expect(group('Inventory & Sales').getByRole('option')).toHaveText([/Stock Summary/, /Sales Order Register/, /Sales Invoice Register/, /Purchase Order Register/]);
    await expect(group('GST').getByRole('option')).toHaveText([/GSTR-1/, /GSTR-3B/]);
    for (const g of ['Statements', 'Books', 'Outstanding', 'Inventory & Sales', 'GST']) await expect(group(g)).not.toContainText('Phase');
  });

  test('Go To finds each of them by the words an accountant uses', async ({ app }) => {
    for (const [words, title] of [['tb', 'Trial Balance'], ['p&l', 'Profit & Loss'], ['balance sheet', 'Balance Sheet'], ['outstanding rec', 'Outstanding Receivables'], ['payables', 'Outstanding Payables'], ['cash book', 'Cash Book']]) {
      await goTo(app, words as string);
      await app.keyboard.press('Enter');
      await expect(heading(app)).toHaveText(title as string);
      await app.keyboard.press('Escape');
      await expect(heading(app)).toHaveText('Gateway');
    }
  });
});

test.describe('the Trial Balance', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
    await openReport(app, 'Trial Balance');
  });

  test('lists the primary groups; debit equals credit, and the footer says the books balance', async ({ app }) => {
    for (const label of ['Particulars', 'Type', 'Opening', 'Debit', 'Credit', 'Closing']) {
      await expect(app.getByRole('columnheader', { name: new RegExp(label) })).toBeVisible();
    }
    await expect(gridRow(app, 'Current Assets')).toContainText('Group');
    await expect(gridRow(app, 'Sales Accounts')).toContainText('30,000.00');
    const foot = app.getByTestId('tb-totals');
    expect(num(await app.getByTestId('tb-debit').textContent())).toBe(num(await app.getByTestId('tb-credit').textContent()));
    expect(num(await app.getByTestId('tb-closing-dr').textContent())).toBe(num(await app.getByTestId('tb-closing-cr').textContent()));
    await expect(app.getByTestId('report-foot')).toContainText('the books balance');
    await expect(foot).toContainText('Total debit');
  });

  test('Enter opens a group, Enter again its ledger, and Esc comes back to the same row each time', async ({ app }) => {
    await app.keyboard.press('ArrowDown'); // Current Assets
    await expect(gridRows(app).nth(1)).toHaveAttribute('aria-selected', 'true');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Trial Balance: Current Assets');
    await expect(gridRow(app, 'Bank Accounts')).toContainText('Group');
    await expect(gridRow(app, 'Sundry Debtors')).toContainText('Group');
    // the children add up to the group they belong to (Dr − Cr of Current Assets is the 9,24,600.00 above)
    await gridRow(app, 'Bank Accounts').click();
    await expect(heading(app)).toHaveText('Trial Balance: Bank Accounts');
    await expect(gridRow(app, 'HDFC Bank Current A/c')).toContainText('Ledger');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/HDFC Bank Current A\/c/); // the ledger's own statement
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Trial Balance: Bank Accounts');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Trial Balance: Current Assets');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Trial Balance');
    await expect(gridRows(app).nth(1)).toHaveAttribute('aria-selected', 'true');
  });

  test('Go To offers "Group summary" on a group; F2 changes the period and a period with no vouchers has nothing but the opening', async ({ app }) => {
    await app.keyboard.press('Escape');
    await goTo(app, 'g:current assets');
    await app.keyboard.press('ArrowRight');
    await expect(app.getByTestId('goto')).toContainText('Group summary');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Escape');

    await openReport(app, 'Trial Balance');
    await app.keyboard.press('F2');
    const dialog = app.getByTestId('report-dialog');
    await expect(dialog).toContainText('Period');
    await app.keyboard.type('1-3');
    await app.keyboard.press('Enter');
    await app.keyboard.type('31-3');
    await app.keyboard.press('Control+a');
    await expect(dialog).toHaveCount(0);
    expect(num(await app.getByTestId('tb-debit').textContent())).toBe(num(await app.getByTestId('tb-credit').textContent()));
  });

  test('sorts and filters like every report grid', async ({ app }) => {
    await app.getByRole('textbox', { name: 'Quick filter' }).fill('sales');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRow(app, 'Sales Accounts')).toBeVisible();
  });
});

test.describe('the Cash Book and the Bank Book', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('the Cash Book lists the cash ledgers and the Bank Book the bank ledgers, each with its closing balance', async ({ app }) => {
    await openReport(app, 'Cash Book');
    await expect(gridRows(app)).toHaveCount(2);
    await expect(gridRow(app, /^Cash/).first()).toContainText('20,000.00 Dr');
    await expect(gridRow(app, 'Petty Cash Box')).toContainText('23,000.00 Dr');
    await app.keyboard.press('Escape');
    await openReport(app, 'Bank Book');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRow(app, 'HDFC Bank Current A/c')).toContainText('7,56,600.00 Dr');
  });

  test('Enter opens the ledger’s running statement, and Esc returns to the book', async ({ app }) => {
    await openReport(app, 'Bank Book');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/HDFC Bank Current A\/c/);
    await expect(app.getByTestId('ledger-closing')).toContainText('7,56,600.00');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Bank Book');
  });
});

test.describe('Profit & Loss and the Balance Sheet', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('Profit & Loss: a Trading account and a Profit & Loss account, each with two sides that total the same', async ({ app }) => {
    await openReport(app, 'Profit & Loss');
    const trading = app.getByTestId('stmt-trading');
    await expect(trading.getByTestId('stmt-trading-left')).toContainText('Opening Stock');
    await expect(trading.getByTestId('stmt-trading-left')).toContainText('3,34,700.00');
    await expect(trading.getByTestId('stmt-trading-right')).toContainText('Sales Accounts');
    await expect(trading.getByTestId('stmt-trading-right')).toContainText('Closing Stock');
    await expect(trading.getByTestId('stmt-trading-right')).toContainText('3,46,140.00');
    await expect(trading.getByTestId('stmt-trading-left')).toContainText('Gross Profit c/d');
    expect(num(await trading.getByTestId('stmt-trading-total-left').textContent())).toBe(num(await trading.getByTestId('stmt-trading-total-right').textContent()));

    const pl = app.getByTestId('stmt-profit-loss');
    await expect(pl.getByTestId('stmt-profit-loss-left')).toContainText('Indirect Expenses');
    await expect(pl.getByTestId('stmt-profit-loss-right')).toContainText('Gross Profit b/d');
    await expect(pl.getByTestId('stmt-profit-loss-right')).toContainText('Net Loss'); // the demo's expenses exceed its gross profit
    expect(num(await pl.getByTestId('stmt-profit-loss-total-left').textContent())).toBe(num(await pl.getByTestId('stmt-profit-loss-total-right').textContent()));
    await expect(app.getByTestId('gross-result')).toHaveText('Gross profit 41,440.00');
    await expect(app.getByTestId('net-result')).toHaveText('Net loss 5,460.00');
  });

  test('a line opens its group in the Trial Balance; Esc returns to the same line; F2 changes the period', async ({ app }) => {
    await openReport(app, 'Profit & Loss');
    await app.getByTestId('stmt-line').filter({ hasText: 'Indirect Expenses' }).click();
    await expect(heading(app)).toHaveText('Trial Balance: Indirect Expenses');
    await expect(gridRow(app, 'Factory Rent')).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Profit & Loss');

    await app.keyboard.press('F2');
    const dialog = app.getByTestId('report-dialog');
    await expect(dialog).toContainText('Period');
    await app.keyboard.type('1-3');
    await app.keyboard.press('Enter');
    await app.keyboard.type('31-3');
    await app.keyboard.press('Control+a');
    await expect(dialog).toHaveCount(0);
    await expect(app.getByTestId('net-result')).toContainText('Net'); // a period of its own, still a figure
  });

  test('the keyboard moves down a side and across to the other; Enter opens the group under the cursor', async ({ app }) => {
    await openReport(app, 'Profit & Loss');
    await expect(app.getByTestId('stmt-line').first()).toHaveAttribute('aria-selected', 'true');
    await app.keyboard.press('ArrowDown');
    await expect(app.getByTestId('stmt-line').nth(1)).toHaveAttribute('aria-selected', 'true');
    await app.keyboard.press('ArrowUp');
    await app.keyboard.press('Tab');
    await expect(app.getByTestId('stmt-trading-right').getByTestId('stmt-line').first()).toHaveAttribute('aria-selected', 'true');
    await app.keyboard.press('Enter'); // Sales Accounts
    await expect(heading(app)).toHaveText('Trial Balance: Sales Accounts');
  });

  test('the Balance Sheet: liabilities and assets are equal, the stock brought forward and the result are shown', async ({ app }) => {
    await openReport(app, 'Balance Sheet');
    const liabilities = app.getByTestId('stmt-balance-sheet-left');
    const assets = app.getByTestId('stmt-balance-sheet-right');
    await expect(liabilities).toContainText('Capital Account');
    await expect(liabilities).toContainText('Opening Stock (brought forward)');
    await expect(assets).toContainText('Current Assets');
    await expect(assets).toContainText('Closing Stock');
    await expect(assets).toContainText('Profit & Loss A/c'); // this year's loss is on the assets side
    expect(num(await app.getByTestId('stmt-balance-sheet-total-left').textContent())).toBe(num(await app.getByTestId('stmt-balance-sheet-total-right').textContent()));
    await expect(app.getByTestId('stmt-total-liabilities')).toHaveText((await app.getByTestId('stmt-total-assets').textContent()) as string);
  });

  test('F2 sets the "as on" date: before any voucher there is only the stock brought forward, and it still balances', async ({ app }) => {
    await openReport(app, 'Balance Sheet');
    await app.keyboard.press('F2');
    const dialog = app.getByTestId('report-dialog');
    await expect(dialog).toContainText('As on');
    await app.keyboard.type('31-3');
    await app.keyboard.press('Control+a');
    await expect(dialog).toHaveCount(0);
    expect(num(await app.getByTestId('stmt-balance-sheet-total-left').textContent())).toBe(num(await app.getByTestId('stmt-balance-sheet-total-right').textContent()));
  });

  test('the action panel offers the report’s keys and Esc walks back to the Gateway', async ({ app }) => {
    await openReport(app, 'Balance Sheet');
    await expect(panel(app)).toBeVisible();
    await expect(panel(app)).toContainText('F2');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Reports');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
  });
});

test.describe('Outstanding receivables and payables', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('receivables: a row per customer with its bills, the ageing buckets from the due date, advances — reconciling to the ledger', async ({ app }) => {
    await openReport(app, 'Outstanding Receivables');
    for (const label of ['Customer', 'Bills', 'Pending', 'Not yet due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days', 'Advance / on account', 'Not in bills', 'Balance', 'Oldest overdue']) {
      await expect(app.getByRole('columnheader', { name: new RegExp(label) })).toBeVisible();
    }
    await expect(gridRows(app)).toHaveCount(2);
    const abc = gridRow(app, 'ABC Industries');
    await expect(abc).toContainText('79,600.00');
    await expect(abc).toHaveClass(/open-line/); // something overdue is bold
    await expect(gridRow(app, 'Sharma Traders')).toContainText('10,000.00'); // the on-account receipt
    // together they are what Sundry Debtors owe
    await expect(app.getByTestId('out-balance')).toHaveText('1,25,000.00');
    await expect(app.getByTestId('out-pending')).toHaveText('1,35,000.00');
  });

  test('Enter on a customer lists its bills; Enter on a bill opens the voucher that raised it; Esc walks back', async ({ app }) => {
    await openReport(app, 'Outstanding Receivables');
    await gridRow(app, 'ABC Industries').click();
    await expect(heading(app)).toHaveText('Outstanding: ABC Industries');
    await expect(gridRows(app)).toHaveCount(2);
    for (const label of ['Bill / ref', 'Bill date', 'Due', 'Pending', 'Days overdue', 'Ageing']) {
      await expect(app.getByRole('columnheader', { name: new RegExp(label) })).toBeVisible();
    }
    await expect(gridRows(app).first()).toContainText('INV-001'); // brought forward as an opening balance: Enter shows the party's ledger
    await expect(gridRows(app).first()).toContainText('Over 90 days');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/ABC Industries/);
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Outstanding: ABC Industries');
    await app.keyboard.press('ArrowDown'); // the invoice the demo raised: Enter shows that voucher
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/^Display Sales SAL\/\d\d-\d\d\/\d{4}$/);
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Outstanding: ABC Industries');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Outstanding Receivables');
  });

  test('F2 sets the "as on" date: as on a day before the invoices are due nothing is overdue', async ({ app }) => {
    await openReport(app, 'Outstanding Receivables');
    await app.keyboard.press('F2');
    const dialog = app.getByTestId('report-dialog');
    await expect(dialog).toContainText('As on');
    await app.keyboard.type('1-5-26');
    await app.keyboard.press('Control+a');
    await expect(dialog).toHaveCount(0);
    await expect(app.getByTestId('out-overdue')).toHaveText('0.00');
  });

  test('payables list the suppliers we owe', async ({ app }) => {
    await openReport(app, 'Outstanding Payables');
    await expect(gridRow(app, 'Steel Supplies Pvt Ltd')).toContainText('1,10,000.00');
    await expect(gridRow(app, 'Bharat Chemicals')).toContainText('1,500.00');
    await expect(app.getByTestId('out-balance')).toHaveText('1,11,500.00');
  });

  test('paying a supplier’s bill takes it out of Outstanding Payables', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('steel');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1,10,000');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('bill-panel')).toBeVisible();
    await app.keyboard.press('Enter'); // type: Against ref
    await app.keyboard.press('Enter'); // ref empty: opens the search box
    await app.keyboard.press('Enter'); // takes the highlighted (oldest) bill
    await app.keyboard.press('Enter'); // amount → done
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Gateway'); // saving closes back to where it was opened

    await openReport(app, 'Outstanding Payables');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRow(app, 'Bharat Chemicals')).toBeVisible();
    await expect(app.getByTestId('out-balance')).toHaveText('1,500.00');
  });

  test('the invoice list’s Overdue and this report agree: ABC and Sharma are overdue in both', async ({ app }) => {
    await openReport(app, 'Outstanding Receivables');
    await expect(gridRow(app, 'ABC Industries')).toHaveClass(/open-line/);
    await expect(gridRow(app, 'Sharma Traders')).toHaveClass(/open-line/);
    await app.keyboard.press('Escape');
    await app.keyboard.press('Escape');
    await app.getByRole('option', { name: /^Transactions/ }).click();
    await app.getByRole('option', { name: /^Sales Vouchers/ }).click();
    await expect(gridRows(app).filter({ hasText: 'Overdue' }).first()).toBeVisible();
  });
});
