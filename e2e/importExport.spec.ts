/**
 * Bulk Import / Export via CSV, in a real browser, keyboard only: reachable from Go To, cycles between
 * Items / Parties / Vouchers (Alt+K), imports a CSV directly for Items (Alt+U) and shows a summary,
 * exports the same kind back out (Alt+E), and stages a Vouchers CSV into the AI Inbox instead of posting it.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

const ITEMS_CSV = 'name,code,alias,group,unit,hsn,gstRate,itemType\nTest Bolt,TB-1,,,Nos,7318,18,finished';
const VOUCHERS_CSV =
  'docRef,kind,partyName,partyGstin,partyAddress,date,poNumber,invoiceNumber,dueDate,subtotal,grandTotal,description,code,hsn,qty,unit,rate,amount,gstRate,lineDueDate\n' +
  'INV-TEST,sales,Test Customer,,,2026-01-15,,,,,,Test charge,,,1,Nos,100,,,';

test.describe('Import / Export', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('opens from Go To and shows the kind picker', async ({ app }) => {
    await goTo(app, 'import');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Import / Export');
    expect(new URL(app.url()).hash).toBe('#/import-export');
    await expect(app.getByText('Items —', { exact: false })).toBeVisible();
  });

  test('Items: importing a CSV creates the item and shows a summary; export downloads it back out', async ({ app }) => {
    await goTo(app, 'import');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Import / Export');

    const chooser = app.waitForEvent('filechooser');
    await app.keyboard.press('Alt+U');
    await (await chooser).setFiles({ name: 'items.csv', mimeType: 'text/csv', buffer: Buffer.from(ITEMS_CSV) });
    await expect(app.getByTestId('io-result')).toContainText('1 created');
    await expect(app.getByTestId('io-result')).toContainText('0 updated');

    const download = app.waitForEvent('download');
    await app.keyboard.press('Alt+E');
    const file = await download;
    expect(file.suggestedFilename()).toBe('items.csv');
    const path = await file.path();
    const fs = await import('node:fs');
    expect(fs.readFileSync(path as string, 'utf8')).toContain('Test Bolt');

    // it's a real master now, findable like any other
    await goTo(app, 'test bolt');
    await expect(app.getByTestId('goto-title').first()).toHaveText('Test Bolt');
  });

  test('Vouchers: importing a CSV stages one AI Inbox item instead of posting anything', async ({ app }) => {
    await goTo(app, 'import');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Alt+K'); // Items -> Parties
    await app.keyboard.press('Alt+K'); // Parties -> Vouchers
    await expect(app.getByText('Vouchers / Sales Orders')).toBeVisible();

    const chooser = app.waitForEvent('filechooser');
    await app.keyboard.press('Alt+U');
    await (await chooser).setFiles({ name: 'vouchers.csv', mimeType: 'text/csv', buffer: Buffer.from(VOUCHERS_CSV) });
    await expect(app.getByTestId('io-result')).toContainText('1 queued in the AI Inbox');

    await goTo(app, 'ai inbox');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('AI Inbox');
    // the party doesn't exist in this company, so it's correctly flagged unmatched — resolved later via Alt+C
    await expect(app.getByText('Sales Invoice · Test Customer')).toBeVisible();
    await expect(app.getByText('No customer called "Test Customer"')).toBeVisible();
  });
});
