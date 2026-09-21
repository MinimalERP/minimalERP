/**
 * Going straight to a record's report: Alt+G finds a ledger, a party or a stock item ONCE as the master and ONCE as its report (Ledger report /
 * Stock ledger), and the master's own screen — display, alter or the list — has the report on its panel and on a key (Alt+R, Alt+E).
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, palette, paletteOptions, test } from './support';

const panel = (page: Page) => page.getByTestId('action-panel');

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

test.describe('Alt+G goes to the report directly', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('a party: the master, and right under it its Ledger report — Enter on that row opens the ledger', async ({ app }) => {
    await goTo(app, 'sharma');
    await expect(paletteOptions(app).nth(0)).toContainText('Party');
    await expect(paletteOptions(app).nth(1)).toContainText('Ledger report');
    await expect(paletteOptions(app).nth(1)).toContainText('Sharma Traders');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(palette(app)).toBeHidden();
    await expect(heading(app)).toHaveText(/Ledger: Sharma Traders/);
    await expect(app.getByTestId('ledger-closing')).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('a party that is both customer and vendor has a report row for each ledger', async ({ app }) => {
    await goTo(app, 'kumar');
    await expect(paletteOptions(app)).toHaveCount(3);
    await expect(paletteOptions(app).nth(1)).toContainText('as customer');
    await expect(paletteOptions(app).nth(2)).toContainText('as vendor');
  });

  test('a ledger, and a stock item with its Stock ledger', async ({ app }) => {
    await goTo(app, 'hdfc');
    await expect(paletteOptions(app).nth(1)).toContainText('Ledger report');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/HDFC Bank Current A\/c/);
    await app.keyboard.press('Escape');
    await goTo(app, 'ms sheet');
    await expect(paletteOptions(app).nth(1)).toContainText('Stock ledger');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Stock: MS Sheet 2mm');
  });
});

test.describe('the master’s own screen has the report on its panel and on a key', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('a party (display): the panel button and Alt+R open its ledger; Esc comes back to the party', async ({ app }) => {
    await goTo(app, 'sharma');
    await app.keyboard.press('Enter'); // the party, displayed
    await expect(heading(app)).toContainText('Sharma Traders');
    await expect(panel(app).locator('[data-command="master.ledgerReport"]')).toContainText('Ledger report');
    await expect(panel(app).locator('[data-command="master.ledgerReport"]')).toContainText('Alt');
    await expect(panel(app).locator('[data-command="master.stockLedger"]')).toHaveCount(0); // not an item
    await panel(app).locator('[data-command="master.ledgerReport"]').click();
    await expect(heading(app)).toHaveText(/Ledger: Sharma Traders/);
    await app.keyboard.press('Escape');
    await expect(heading(app)).toContainText('Sharma Traders');
    await app.keyboard.press('Alt+r');
    await expect(heading(app)).toHaveText(/Ledger: Sharma Traders/);
  });

  test('a stock item: the panel has Stock ledger (Alt+E), not Ledger report', async ({ app }) => {
    await goTo(app, 'i:ms sheet');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('MS Sheet 2mm');
    await expect(panel(app).locator('[data-command="master.ledgerReport"]')).toHaveCount(0);
    await panel(app).locator('[data-command="master.stockLedger"]').click();
    await expect(heading(app)).toHaveText('Stock: MS Sheet 2mm');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+e');
    await expect(heading(app)).toHaveText('Stock: MS Sheet 2mm');
  });

  test('a ledger (alter) has it too; a group has neither', async ({ app }) => {
    await goTo(app, 'l:hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Alt+a'); // alter
    await expect(panel(app).locator('[data-command="master.ledgerReport"]')).toBeVisible();
    await app.keyboard.press('Alt+r');
    await expect(heading(app)).toHaveText(/HDFC Bank Current A\/c/);
    await app.keyboard.press('Escape');
    await app.keyboard.press('Escape');
    await goTo(app, 'g:current assets');
    await app.keyboard.press('Enter');
    await expect(panel(app).locator('[data-command="master.ledgerReport"]')).toHaveCount(0);
    await expect(panel(app).locator('[data-command="master.stockLedger"]')).toHaveCount(0);
  });

  test('the Parties list: the highlighted party’s ledger with Alt+R; the Stock Items list: its stock ledger with Alt+E', async ({ app }) => {
    await app.getByRole('option', { name: /^Masters/ }).click();
    await app.getByRole('option', { name: /^Parties/ }).click();
    await expect(heading(app)).toHaveText('Parties');
    await app.keyboard.type('abc');
    await expect(panel(app).locator('[data-command="master.ledgerReport"]')).toBeVisible();
    await app.keyboard.press('Alt+r');
    await expect(heading(app)).toHaveText(/Ledger: ABC Industries/);
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Parties');
    await app.keyboard.press('Escape');
    await app.getByRole('option', { name: /^Stock Items/ }).click();
    await app.keyboard.type('mounting');
    await expect(panel(app).locator('[data-command="master.stockLedger"]')).toBeVisible();
    await app.keyboard.press('Alt+e');
    await expect(heading(app)).toHaveText('Stock: Mounting Bracket');
  });
});
