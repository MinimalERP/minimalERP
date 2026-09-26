/**
 * Payment reminders: the panel's “Payment reminder” on an unpaid Sales invoice (the invoice's PDF with its payment status, made and attached) and on a customer's
 * Ledger (its Statement of Account). The demo books are kept in the browser, which has no mail server: the window is checked, and Send is
 * refused with the "needs the online books" message — the sending itself is the server's (tested there).
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

const dialog = (page: Page) => page.getByTestId('mail-dialog');

test.describe('payment reminders', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('an unpaid Sales invoice: the reminder names the bill, and its PDF is made and attached', async ({ app }) => {
    await goTo(app, 'day book');
    await app.keyboard.press('Enter');
    await app.keyboard.type('SAL/26-27/0001');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Display Sales SAL/26-27/0001');
    await expect(app.locator('[data-command="voucher.remind"]')).toContainText('Payment reminder');

    await app.locator('[data-command="voucher.remind"]').click(); // an occasional action: a panel button, no key of its own
    await expect(dialog(app)).toContainText('Payment reminder');
    await expect(dialog(app).getByTestId('mail-to')).toContainText('accounts@abcindustries.in');
    await expect(app.locator('#mail-subject')).toHaveValue('Payment reminder: invoice SAL/26-27/0001 — ₹19,600.00 overdue'); // no Cust PO on this invoice, so none is named (the PO wording: reminders.test)
    await expect(app.locator('#mail-body')).toHaveValue(/our invoice SAL\/26-27\/0001 dated 15-May-2026 for ₹19,600\.00/);
    await expect(app.locator('#mail-body')).toHaveValue(/₹19,600\.00 of it is still unpaid \(\d+ days overdue\)/);
    await expect(dialog(app).getByTestId('mail-attached')).toContainText('SAL-26-27-0001.pdf', { timeout: 20_000 });
    await expect(dialog(app).getByTestId('mail-making')).toHaveCount(0);
    await expect(dialog(app).getByTestId('mail-open')).toBeVisible(); // look at it before it goes

    // the same copy through the print window (to check it, print it or Save as PDF): one plain copy, payment status and all
    await app.evaluate(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => void (window as unknown as { __printed: number }).__printed++;
    });
    await dialog(app).getByTestId('mail-print').click();
    await expect.poll(() => app.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
    await expect(app.locator('.print-root .print-copy')).toHaveCount(1);
    await expect(app.getByTestId('print-payment-status')).toContainText('Balance due');
    await expect(dialog(app)).toBeVisible(); // the mail is still there to send

    await app.keyboard.press('Control+a'); // send: these books cannot, and say so
    await expect(dialog(app)).toContainText('Emailing needs the online books');
    await app.keyboard.press('Escape');
    await expect(dialog(app)).toHaveCount(0);
  });

  test('a paid invoice has no reminder', async ({ app }) => {
    await goTo(app, 'day book');
    await app.keyboard.press('Enter');
    await app.keyboard.type('SAL/26-27/0001');
    await app.keyboard.press('Enter');
    await app.keyboard.press('F6'); // the receipt that settles it
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Display Sales SAL/26-27/0001');
    await expect(app.locator('[data-command="voucher.remind"]')).toHaveCount(0);
  });

  test('a customer’s Ledger: the reminder lists the pending bills and attaches the Statement of Account', async ({ app }) => {
    await goTo(app, 'abc industries');
    await app.keyboard.press('ArrowDown'); // its Ledger report
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Ledger: ABC Industries');

    await app.locator('[data-command="ledger.remind"]').click();
    await expect(dialog(app)).toContainText('ABC Industries (statement of account)');
    await expect(app.locator('#mail-subject')).toHaveValue('Payment reminder: ₹79,600.00 due to Demo Manufacturing Pvt Ltd');
    await expect(app.locator('#mail-body')).toHaveValue(/INV-001 {2}dated 1-Apr-2026 {2}due 1-May-2026 {2}₹60,000\.00 \(\d+ days overdue\)/);
    await expect(app.locator('#mail-body')).toHaveValue(/SAL\/26-27\/0001 {2}dated 15-May-2026 {2}due 14-Jun-2026/);
    await expect(app.locator('#mail-body')).toHaveValue(/Total pending: ₹79,600\.00/);
    await expect(dialog(app).getByTestId('mail-attached')).toContainText(/^Statement of Account - ABC Industries - .+\.pdf/, { timeout: 20_000 });
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Ledger: ABC Industries');
  });

  test('a ledger that is not a customer’s has no reminder', async ({ app }) => {
    await goTo(app, 'steel supplies');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/Ledger: Steel Supplies/);
    await expect(app.locator('[data-command="ledger.remind"]')).toHaveCount(0);
  });
});
