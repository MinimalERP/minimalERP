/**
 * Print: the copy-count dialog (keyboard-operable, Esc cancels), the mechanism (one `window.print()` call, that many
 * `.print-copy` sections, the right labels — Original/Duplicate/Triplicate/Extra Copy), for a simple voucher (Payment),
 * an item-invoice voucher (Sales), and a report (Day Book), and that Invoice/PDF Settings fields the sample was built
 * around (bank details, terms) show on the printed invoice and are left off entirely when blank.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

const dayBookRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });
const printCopies = (page: Page) => page.locator('.print-root .print-copy');
const printedCount = (page: Page) => page.evaluate(() => (window as unknown as { __printed?: number }).__printed ?? 0);

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

async function openSalesList(page: Page): Promise<void> {
  await page.getByRole('option', { name: /^Transactions/ }).click();
  await page.getByRole('option', { name: /^Sales Vouchers/ }).click();
  await expect(heading(page)).toHaveText('Sales Vouchers');
}

async function openDayBook(page: Page): Promise<void> {
  await goTo(page, 'day book');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Day Book');
}

test.describe('Print', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
    // window.print() opens a real OS dialog Playwright cannot see or close — stub it and count the calls instead.
    // (The app fixture has already loaded the page by the time a test runs, so this must patch the live page —
    // addInitScript would only take effect on a FUTURE navigation, and this single-page app makes none.)
    await app.evaluate(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => {
        (window as unknown as { __printed: number }).__printed++;
      };
    });
  });

  test('under real print media, the printed content is actually visible and the app chrome is not — not just present in the DOM', async ({ app }) => {
    // A regression test for a real bug: `.print-copy` can exist in the DOM (every other assertion here would pass) while
    // being invisible, if #print-root is nested inside an ancestor that print.css also hides — it must be a DIRECT
    // child of .shell. Only `emulateMedia` catches that; a plain DOM query does not.
    await openDayBook(app);
    await app.keyboard.type('wages');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Control+p');
    await app.keyboard.press('Enter'); // 1 copy

    await app.emulateMedia({ media: 'print' });
    await expect(printCopies(app).first()).toBeVisible();
    await expect(printCopies(app).first()).toContainText('PAY/');
    await expect(app.locator('.topbar')).toBeHidden();
    await expect(app.locator('.main')).toBeHidden();
    await app.emulateMedia({ media: 'screen' });
  });

  test('a Payment: the copy-count dialog is keyboard-operable, and 3 copies prints 3 labelled pages in one window.print() call', async ({ app }) => {
    await openDayBook(app);
    await app.keyboard.type('wages');
    await expect(dayBookRows(app)).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/^Display Payment PAY\/\d\d-\d\d\/0003$/);

    await app.keyboard.press('Control+p');
    await expect(app.getByTestId('report-dialog')).toContainText('Print');
    const options = app.getByTestId('report-dialog').getByRole('option');
    await expect(options).toHaveCount(4);
    await expect(options.first()).toContainText('1 copy');

    // Down twice: 1 copy -> 2 copies -> 3 copies
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');

    await expect(printCopies(app)).toHaveCount(3);
    await expect(printCopies(app).nth(0)).toContainText('ORIGINAL');
    await expect(printCopies(app).nth(1)).toContainText('DUPLICATE');
    await expect(printCopies(app).nth(2)).toContainText('TRIPLICATE');
    await expect(printCopies(app).first()).toContainText('PAY/');
    await expect(printCopies(app).first()).toContainText('Salaries & Wages');
    await expect(printCopies(app).first().locator('.inv-narration')).toHaveText('Narration: Wages'); // captioned
    await expect.poll(() => printedCount(app)).toBe(1);
  });

  test('Esc cancels: no copies mounted, window.print() never called', async ({ app }) => {
    await openDayBook(app);
    await app.keyboard.type('wages');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Control+p');
    await expect(app.getByTestId('report-dialog')).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('report-dialog')).toHaveCount(0);
    await expect(printCopies(app)).toHaveCount(0);
    expect(await printedCount(app)).toBe(0);
  });

  test('an item-invoice document (Sales): 4 copies (Original, Duplicate, Triplicate, Extra Copy), Bill To on the page, one window.print() call', async ({ app }) => {
    await openDayBook(app);
    await app.keyboard.type('sharma');
    await expect(dayBookRows(app).first()).toBeVisible();
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display');

    await app.keyboard.press('Control+p');
    await app.keyboard.press('ArrowUp'); // wraps to the last option: 4 copies
    await app.keyboard.press('Enter');

    await expect(printCopies(app)).toHaveCount(4);
    await expect(printCopies(app).nth(3)).toContainText('EXTRA COPY');
    await expect(printCopies(app).first()).toContainText('Bill To');
    await expect(printCopies(app).first()).toContainText('Sharma Traders');
    await expect(printCopies(app).first()).toContainText('Machine Oil');
    await expect.poll(() => printedCount(app)).toBe(1);
  });

  test("a Sales invoice prints the customer's GSTIN, the Place of Supply and a full-page border — exactly one A4 page per copy", async ({ app }) => {
    await openDayBook(app);
    await app.keyboard.type('sharma');
    await expect(dayBookRows(app).first()).toBeVisible();
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display');
    await app.keyboard.press('Control+p');
    await app.keyboard.press('ArrowDown'); // 2 copies
    await app.keyboard.press('Enter');

    const first = printCopies(app).first();
    await expect(first.locator('.inv-parties > div').first()).toContainText('GSTIN: 07AAACR5055K1Z');
    await expect(first.locator('.inv-pos')).toHaveText('Place of Supply: Delhi (07)');

    await app.emulateMedia({ media: 'print' });
    await expect(first).toHaveCSS('border-top-style', 'solid');
    // The frame is a full page however few lines there are, and never spills a blank page: 2 copies -> 2 pages.
    const pdf = await app.pdf({ preferCSSPageSize: true });
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)).toHaveLength(2);
    await app.emulateMedia({ media: 'screen' });
  });

  test('Invoice / PDF Settings: fill in bank details, they persist and show on the next invoice printed; a field left blank is left off', async ({ app }) => {
    await goTo(app, 'invoice / pdf settings');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Invoice / PDF Settings');

    await app.locator('[data-field="bankName"]').fill('HDFC Bank');
    await app.locator('[data-field="bankAccountNo"]').fill('50200012345678');
    // IFSC and Branch are deliberately left blank — the printed block must still show what WAS entered.
    await app.locator('[data-field="invoiceNote"]').fill('Thank you for your business.');
    await app.keyboard.press('Control+a'); // Save
    await expect(app.getByTestId('invoice-settings-saved')).toBeVisible();

    // Reopen the screen: the values were actually persisted, not just held in the form.
    await app.keyboard.press('Escape');
    await goTo(app, 'invoice / pdf settings');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-field="bankName"]')).toHaveValue('HDFC Bank');
    await expect(app.locator('[data-field="bankIfsc"]')).toHaveValue('');
    await app.keyboard.press('Escape');

    await openDayBook(app);
    await app.keyboard.type('wages');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Control+p');
    await app.keyboard.press('Enter'); // 1 copy
    await expect(printCopies(app).first()).toContainText('HDFC Bank');
    await expect(printCopies(app).first()).toContainText('50200012345678');
    await expect(printCopies(app).first()).toContainText('Thank you for your business.');
    await expect(printCopies(app).first()).not.toContainText('IFSC'); // never a label with nothing after it
  });

  test('a Sales list: Ctrl+Space picks invoices, Ctrl+P asks the copies once and prints every picked invoice in that many copies', async ({ app }) => {
    await openSalesList(app);
    await app.keyboard.press('Control+Space'); // picks the first row, moves to the next
    await app.keyboard.press('Control+Space');
    await expect(app.getByTestId('list-picked')).toContainText('2 selected');
    await app.keyboard.press('Control+p');
    await app.keyboard.press('ArrowDown'); // 2 copies
    await app.keyboard.press('Enter');
    await expect(printCopies(app)).toHaveCount(4);
    await expect(printCopies(app).nth(0)).toContainText('Sharma Traders');
    await expect(printCopies(app).nth(1)).toContainText('DUPLICATE');
    await expect(printCopies(app).nth(2)).toContainText('ABC Industries');
    await expect.poll(() => printedCount(app)).toBe(1);
  });

  test('a dispatch docket: one customer only; page one the invoices (number, PO, amount) and the consignment, page two the items added together', async ({ app }) => {
    await openSalesList(app);
    await app.keyboard.press('Control+Space');
    await app.keyboard.press('Control+Space');
    await app.keyboard.press('Alt+d');
    await expect(app.getByTestId('list-notice')).toContainText('one customer');
    await expect(app.getByTestId('report-dialog')).toHaveCount(0);

    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Sales');
    await app.keyboard.press('Alt+d');
    await expect(app.getByTestId('report-dialog')).toContainText('Dispatch docket');
    await app.keyboard.press('Enter'); // Dispatch No. as offered
    await app.keyboard.press('Enter'); // today
    await app.keyboard.type('4');
    await app.keyboard.press('Enter');
    await app.keyboard.type('XYZ Logistics');
    await app.keyboard.press('Enter');
    await app.keyboard.type('LR-778');
    await app.keyboard.press('Enter');

    await expect(printCopies(app)).toHaveCount(2);
    const one = printCopies(app).nth(0);
    await expect(one).toContainText('DISPATCH DOCKET');
    await expect(one).toContainText(/OD-\d{4}-00001/);
    await expect(one).toContainText('Invoices Included');
    await expect(one).toContainText('SAL/');
    await expect(one).toContainText('Bill To');
    await expect(one).toContainText('Ship To');
    await expect(one).toContainText('XYZ Logistics');
    await expect(one).toContainText('LR-778');
    const two = printCopies(app).nth(1);
    await expect(two).toContainText('Machine Oil');
    await expect(two).toContainText(/Total \(\d+ items?\)/);
    await expect.poll(() => printedCount(app)).toBe(1);

    // the next docket is offered the next number
    await app.keyboard.press('Alt+d');
    await expect(app.getByTestId('report-dialog').locator('input').first()).toHaveValue(/OD-\d{4}-00002/);
    await app.keyboard.press('Escape');
  });

  test('a displayed voucher turns to the next / previous one of its type: PgDn / PgUp, → / ←, and the ‹ › side arrows', async ({ app }) => {
    await openSalesList(app);
    await app.keyboard.type('abc');
    await app.keyboard.press('Enter');
    await expect(app.locator('.screen')).toContainText('ABC Industries');
    await app.keyboard.press('PageDown');
    await expect(app.locator('.screen')).toContainText('Sharma Traders');
    await app.keyboard.press('PageUp');
    await expect(app.locator('.screen')).toContainText('ABC Industries');
    await expect(app.getByRole('button', { name: 'Previous voucher' })).toBeDisabled(); // the first one
    await app.keyboard.press('ArrowRight');
    await expect(app.locator('.screen')).toContainText('Sharma Traders');
    await app.keyboard.press('ArrowLeft');
    await expect(app.locator('.screen')).toContainText('ABC Industries');
    await app.getByRole('button', { name: 'Next voucher' }).click();
    await expect(app.locator('.screen')).toContainText('Sharma Traders');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Sales Vouchers');
  });

  test('the Day Book prints every visible row, no copy-count dialog, no app chrome', async ({ app }) => {
    await openDayBook(app);
    const shown = await dayBookRows(app).count();
    expect(shown).toBeGreaterThan(0);

    await app.keyboard.press('Control+p');
    await expect(app.getByTestId('report-dialog')).toHaveCount(0); // a report is not sent to anyone: no Original/Duplicate choice
    await expect(printCopies(app)).toHaveCount(1);
    const printedRows = printCopies(app).locator('table.items tbody tr');
    await expect(printedRows).toHaveCount(shown);
    await expect(printCopies(app)).toContainText('Day Book');
    await expect(printCopies(app).getByTestId('print-report-head').locator('.rpt-company')).toHaveText('Demo Manufacturing Pvt Ltd'); // under its company's name
    await expect.poll(() => printedCount(app)).toBe(1);
  });

  test('a party ledger prints as a Statement of Account, framed like an invoice: company heading, the party and a summary, oldest first between opening and closing, and its open bills — the screen unchanged', async ({ app }) => {
    await goTo(app, 'abc industries');
    await app.keyboard.press('ArrowDown'); // its Ledger report
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Ledger: ABC Industries');
    await expect(app.getByTestId('ledger-company')).toHaveCount(0); // the screen stays minimal

    await app.keyboard.press('Control+p');
    const page = printCopies(app).first();
    await expect(page).toHaveClass(/bordered/); // framed like a voucher, not a plain report page
    const head = page.getByTestId('print-report-head'); // a report's heading is centred: the company, then the document
    await expect(head).toHaveCSS('text-align', 'center');
    await expect(head.locator('.rpt-company')).toHaveText('Demo Manufacturing Pvt Ltd');
    await expect(head).toContainText('GSTIN: 27AABCD1234E1Z8');
    await expect(head.locator('.name')).toHaveText('Statement of Account');
    await expect(page.locator('.inv-parties')).toContainText('ABC Industries');
    await expect(page).toContainText('accounts@abcindustries.in');
    const rows = page.locator('table.items').first().locator('tbody tr');
    await expect(rows).toHaveCount(5); // opening, three entries, closing
    await expect(rows.first()).toContainText('Opening balance');
    await expect(rows.nth(1)).toContainText('OB/0003'); // oldest first
    await expect(rows.last()).toContainText('Closing balance');
    await expect(rows.last()).toContainText('79,600.00 Dr');
    const bills = page.locator('.rpt-more table.items tbody tr');
    await expect(bills).toHaveCount(3); // INV-001, SAL/26-27/0001, total
    await expect(bills.first()).toContainText('Part paid');
    await expect(bills.last()).toContainText('79,600.00');
  });
});
