/**
 * PHASE 6a, in a real browser: the Stock Journal (stock moving with no accounting effect), stock never below zero, opening stock from the
 * item form, the Stock Summary and the Item ledger — keyboard first, the same worksheet, the same panel.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, goTo, heading, paletteOptions, test } from './support';

const banner = (page: Page) => page.getByTestId('voucher-banner');
const panel = (page: Page) => page.getByTestId('action-panel');
const focused = (page: Page): Locator => page.locator('[data-vf]:focus');
const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

async function openSummary(page: Page): Promise<void> {
  await goTo(page, 'stock summary');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Stock Summary');
}

/** One stock line, typed the way a person would: item, godown, quantity (and rate for an In), then Enter to start the next line. */
async function fillLine(page: Page, item: string, godown: string, qty: string, rate?: string): Promise<void> {
  await page.keyboard.press('Enter'); // side → item
  await page.keyboard.type(item);
  await page.keyboard.press('Enter');
  await page.keyboard.type(godown);
  await page.keyboard.press('Enter');
  await page.keyboard.type(qty);
  await page.keyboard.press('Enter');
  if (rate !== undefined) {
    await page.keyboard.type(rate);
    await page.keyboard.press('Enter');
  }
}

test.describe('the Stock Journal window', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('F10 opens it: the same worksheet with Particulars, Godown, Qty, Rate and Value, a panel, and an Out to start with', async ({ app }) => {
    await app.keyboard.press('F10');
    await expect(heading(app)).toHaveText('New Stock Journal Voucher');
    await expect(app.getByTestId('voucher-type-tag')).toHaveText('Stock Journal');
    const grid = app.getByRole('group', { name: 'Entries' });
    for (const label of ['Particulars', 'Godown', 'Qty', 'Rate', 'Value']) await expect(grid).toContainText(label);
    await expect(app.locator('[data-vf="l0.side"]')).toHaveValue('Out');
    await expect(app.locator('[data-vf="l0.wh"]')).toHaveValue('Main Location');
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.side');
    await expect(panel(app)).toBeVisible();
    await expect(panel(app).locator('[data-command="voucher.accept"]')).toBeEnabled();
    await expect(panel(app).locator('[data-command="voucher.switch.payment"]')).toBeDisabled(); // stock is not an accounting voucher
    await expect(app.getByTestId('voucher-form').getByRole('button')).toHaveCount(2); // no action buttons in the form: the panel has them — only the window's × (title bar) and the × that clears the line
    await expect(app.getByTestId('window-close')).toBeVisible();
  });

  test('a transfer between godowns is an Out and an In; it is saved, numbered STJ/, and changes no total', async ({ app }) => {
    await app.keyboard.press('F10');
    await fillLine(app, 'abc hex', 'finished', '10'); // Out of the Finished Goods Store
    await expect(app.locator('[data-vf="l1.side"]')).toHaveValue('In'); // the next line is the other side
    await fillLine(app, 'abc hex', 'main', '10', ''); // In to the main godown — the rate is prefilled with what the stock costs
    await expect(app.locator('[data-vf="l1.rate"]')).toHaveValue('4.5');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('Stock Journal STJ/');
    await expect(banner(app)).toContainText('saved.');

    await openSummary(app);
    await app.keyboard.type('bolt');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRows(app).first()).toContainText('3,000'); // the item is where it was (5,000 less the 2,000 the demo's invoice sold); only its godowns changed
    await expect(app.getByTestId('stock-closing-value')).toHaveText('13,500.00');
  });

  test('an Out’s value comes from the stock, live, and the totals show it', async ({ app }) => {
    await app.keyboard.press('F10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('mounting');
    await app.keyboard.press('Enter');
    await app.keyboard.type('finished');
    await app.keyboard.press('Enter');
    await app.keyboard.type('100');
    await expect(app.getByTestId('out-rate').first()).toHaveText('38');
    await expect(app.getByTestId('line-value').first()).toHaveText('3,800.00');
    await expect(app.getByTestId('total-out')).toHaveText('3,800.00');
  });

  test('an Out beyond the stock is refused on its own quantity cell, naming the item and godown, and nothing is saved', async ({ app }) => {
    await app.keyboard.press('F10');
    await fillLine(app, 'fabricated', 'finished', '61'); // only 60 were made; the next (empty) line is ignored
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'Not enough Fabricated Frame in Finished Goods Store' })).toBeVisible();
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.qty');
    await expect(banner(app)).toHaveCount(0);
  });

  test('an Out starts in the godown that HOLDS the item, and the note says where the stock is; asking a godown that has none says where it is', async ({ app }) => {
    await app.keyboard.press('F10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('mounting');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="l0.wh"]')).toHaveValue('Finished Goods Store'); // not the main godown: the brackets are not there
    await app.keyboard.type('main'); // …but ask the main godown anyway (the godown field has the cursor)
    await app.keyboard.press('Enter');
    await app.keyboard.type('5');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'Not enough Mounting Bracket in Main Location' })).toBeVisible();
    await expect(app.getByRole('alert').filter({ hasText: 'It is in Finished Goods Store 680' })).toBeVisible();
    await app.keyboard.press('ArrowUp');
    await expect(app.getByTestId('stock-note').first()).toContainText('in Finished Goods Store 680');
  });

  test('the stock under an item is shown like a balance: “Stock: 60 Nos @ ₹950”', async ({ app }) => {
    await app.keyboard.press('F10');
    await fillLine(app, 'fabricated', 'finished', '1');
    await expect(app.getByTestId('stock-note').first()).toContainText('Stock: 60 Nos @ ₹950');
  });

  test('Esc keeps its order here too: the list, then back a field, then the question', async ({ app }) => {
    await app.keyboard.press('F10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('mount');
    await expect(app.getByTestId('picker')).toBeVisible();
    await app.keyboard.press('Escape'); // the list only
    await expect(app.getByTestId('picker')).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Stock Journal Voucher');
    await app.keyboard.press('Escape'); // back to the In/Out cell (what was typed is dropped)
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.side');
    await app.keyboard.press('Escape'); // nothing entered: leaves
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('cancelling a stock journal from its display takes its stock out of the books, and a cancelled one cannot be cancelled again', async ({ app }) => {
    await goTo(app, 'day book');
    await app.keyboard.press('Enter');
    await app.keyboard.type('frames fabricated');
    await expect(gridRows(app)).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Stock Journal STJ/');
    await expect(panel(app).locator('[data-command="voucher.cancel"]')).toBeEnabled();
    await app.keyboard.press('Alt+x');
    await expect(app.getByTestId('cancel-confirm')).toBeVisible();
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Day Book');

    await openSummary(app);
    await expect(gridRows(app)).toHaveCount(6); // the frames are gone from stock… but ABC's PO-4471 still wants 20, so they stay listed (committed, with nothing to meet it)
    await expect(gridRows(app).filter({ hasText: 'MS Sheet 2mm' })).toContainText('2,500'); // …and the sheet is back
  });
});

test.describe('opening stock, the Stock Summary and the Item ledger', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('the summary lists the items with stock, and what it adds up to', async ({ app }) => {
    await openSummary(app);
    await expect(gridRows(app)).toHaveCount(6);
    for (const name of ['ABC Hex Bolt M8', 'Fabricated Frame', 'Machine Oil', 'Mounting Bracket', 'MS Rod 12mm', 'MS Sheet 2mm']) {
      await expect(gridRows(app).filter({ hasText: name })).toHaveCount(1);
    }
    await expect(app.getByTestId('stock-closing-value')).toHaveText('3,46,140.00'); // 3,68,100.00 less the goods the demo's two sales invoices took out
    for (const key of ['voucher.changeDate', 'grid.sort', 'grid.filter', 'grid.clear']) await expect(panel(app).locator(`[data-command="${key}"]`)).toBeEnabled();
    await expect(panel(app).locator('[data-command="report.types"]')).toBeDisabled(); // voucher types mean nothing for a list of items
  });

  test('sorting and filtering are the grid’s own: Alt+S on the value column, Alt+L on the quantity', async ({ app }) => {
    await openSummary(app);
    for (let i = 0; i < 8; i++) await app.keyboard.press('Tab'); // → Closing value
    await expect(app.getByRole('columnheader', { name: /Closing value/ })).toHaveClass(/active/);
    await app.keyboard.press('Alt+s');
    await app.keyboard.press('Alt+s'); // descending
    await expect(gridRows(app).first()).toContainText('MS Sheet 2mm');
    await app.keyboard.press('Alt+k');
    for (let i = 0; i < 2; i++) await app.keyboard.press('Shift+Tab'); // → Closing qty
    await app.keyboard.press('Alt+l');
    await expect(app.getByTestId('report-dialog')).toContainText('Filter Closing qty');
    await app.keyboard.type('1000');
    await app.keyboard.press('Control+a');
    await expect(gridRows(app)).toHaveCount(3);
    await expect(app.getByTestId('chip')).toContainText('Closing qty');
  });

  test('Enter on an item opens its ledger; Enter on a movement opens the voucher; Esc goes back, to the same row each time', async ({ app }) => {
    await openSummary(app);
    await app.keyboard.type('bolt');
    await expect(gridRows(app)).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Stock: ABC Hex Bolt M8');
    await expect(app.getByTestId('stock-opening')).toContainText('Opening'); // (a period that starts before any movement: nothing yet)
    await expect(gridRows(app)).toHaveCount(6); // opening stock, the godown transfer's In and Out, the sales invoice — and the two sales orders that have bolts
    await expect(app.getByTestId('stock-closing')).toContainText('3,000');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText(/^Display Sales SAL\/\d\d-\d\d\/\d{4}$/); // the top row is the newest movement: the demo's invoice
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Stock: ABC Hex Bolt M8');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Stock Summary');
    await expect(app.getByRole('textbox', { name: 'Quick filter' })).toHaveValue('bolt'); // the view is as it was left
  });

  test('Go To finds a stock item and offers its Stock ledger', async ({ app }) => {
    await goTo(app, 'i:mounting');
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app)).toContainText(['Display Stock Item', 'Alter Stock Item', 'Stock ledger']);
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Stock: Mounting Bracket');
    await expect(app.getByTestId('stock-closing')).toContainText('680'); // 800 less the 120 the demo's invoice delivered against PO-4471
  });

  test('a new stock item can bring its opening stock: quantity, rate and godown, posted with it', async ({ app }) => {
    await goTo(app, 'create stock item');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Create Stock Item');
    await app.keyboard.type('Washer 8mm');
    for (let i = 0; i < 3; i++) await app.keyboard.press('Enter'); // code, alias, group
    await app.keyboard.press('Enter'); // the group is optional → unit
    await app.keyboard.type('nos');
    await app.keyboard.press('Enter');
    await expect(app.locator('.form-section')).toContainText('Opening stock (optional)');
    await app.locator('[data-field="openQty"]').fill('250');
    await app.locator('[data-field="openRate"]').fill('1.2');
    await app.keyboard.press('Control+a');
    await expect(app.getByTestId('form-banner')).toContainText('created');
    await openSummary(app);
    await app.keyboard.type('washer');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRows(app).first()).toContainText('250');
    await expect(gridRows(app).first()).toContainText('300.00'); // 250 × 1.20
  });

  test('a service has no stock: the opening fields are not offered', async ({ app }) => {
    await goTo(app, 'create stock item');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-field="openQty"]')).toHaveCount(1);
    await app.locator('[data-field="itemType"]').fill('service');
    await app.keyboard.press('Tab');
    await expect(app.locator('[data-field="openQty"]')).toHaveCount(0);
  });
});
