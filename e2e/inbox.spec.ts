/**
 * The AI Inbox (ADR-0023) in the browser, on books kept in this browser (no server to read documents with): it is reachable from
 * Transactions and Go To, says what it is for when empty, and Upload (Alt+U) takes a PDF, asks what it is, and — offline — says that
 * reading needs the online books. (Reading and matching are covered by the unit and database tests.)
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

test.describe('the AI Inbox', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('opens from Go To and, empty, says how documents get here', async ({ app }) => {
    await goTo(app, 'ai inbox');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('AI Inbox');
    expect(new URL(app.url()).hash).toBe('#/inbox');
    await expect(app.getByTestId('inbox-empty')).toContainText('Send to ERP');
    await expect(app.getByTestId('inbox-empty')).toContainText('Alt+U');
  });

  test('Upload: a PDF, then what it is — offline, the books say reading needs the online company', async ({ app }) => {
    await goTo(app, 'ai inbox');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('AI Inbox');

    const chooser = app.waitForEvent('filechooser');
    await app.keyboard.press('Alt+U');
    await (await chooser).setFiles({ name: 'po-6804.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await expect(app.getByText('What is po-6804.pdf?')).toBeVisible();
    await app.keyboard.press('Enter'); // Sales Order, the first choice
    await expect(app.getByTestId('inbox-error')).toContainText('needs the online books');
  });

  test('Upload refuses what cannot be read before sending anything', async ({ app }) => {
    await goTo(app, 'ai inbox');
    await app.keyboard.press('Enter');
    const chooser = app.waitForEvent('filechooser');
    await app.keyboard.press('Alt+U');
    await (await chooser).setFiles({ name: 'orders.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK') });
    await expect(app.getByTestId('inbox-error')).toContainText('choose a PDF or a photo');
  });
});
