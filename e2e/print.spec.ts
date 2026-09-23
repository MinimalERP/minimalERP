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
    await expect.poll(() => printedCount(app)).toBe(1);
  });
});
