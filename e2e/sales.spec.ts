/**
 * PHASE 6b, in a real browser: the Sales Order (a document with a due date on every line) and the Sales Invoice (Dr customer / Cr sales, the
 * goods out of stock, the order lines it names filled) on one item-line window; the Cust PO on an invoice bringing what remains on that
 * order; an order turned into an invoice for what is pending; the Sales Order Register (fill 12/18, bold open lines); an item's sales
 * orders through Go To. Keyboard first, the same worksheet, the same panel.
 *
 * The demo company brings three orders: ABC's PO-4471 (bolts delivered in full, brackets 120/300, frames 0/20), Sharma's SH/PO/88 (delivered
 * in full, so closed) and Kumar's KEW-12 (800 bolts, nothing delivered).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, goTo, heading, paletteOptions, test } from './support';

const banner = (page: Page) => page.getByTestId('voucher-banner');
const panel = (page: Page) => page.getByTestId('action-panel');
const focused = (page: Page): Locator => page.locator('[data-vf]:focus');
const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });
const lines = (page: Page) => page.locator('.vrow.sales-row');

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

async function openRegister(page: Page): Promise<void> {
  await goTo(page, 'sales order register');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Sales Order Register');
}

/** Enter, then wait for the cursor to have moved on — so the next thing typed lands in the next cell, never the one just left. */
async function enterNext(page: Page): Promise<void> {
  const from = await page.evaluate(() => document.activeElement?.getAttribute('data-vf') ?? '');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-vf') ?? '')).not.toBe(from);
}

/** One order line, the way a person types it: item, due date, quantity, rate — then Enter starts the next line. */
async function orderLine(page: Page, item: string, due: string, qty: string, rate: string): Promise<void> {
  await page.keyboard.type(item);
  await enterNext(page);
  await page.keyboard.type(due);
  await enterNext(page);
  await page.keyboard.type(qty);
  await enterNext(page);
  await page.keyboard.type(rate);
  await enterNext(page);
}

/** The register row of a PO and item (the register is on screen). */
const registerRow = (page: Page, reference: string, item: string) => gridRows(page).filter({ hasText: reference }).filter({ hasText: item });

test.describe('the Sales Order window', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('Shift+F8 opens it: the same worksheet with Particulars, Due date, Qty, Rate and Amount, a panel, and the customer first', async ({ app }) => {
    await app.keyboard.press('Shift+F8');
    await expect(heading(app)).toHaveText('New Sales Order');
    await expect(app.getByTestId('voucher-type-tag')).toHaveText('Sales Order');
    const grid = app.getByRole('group', { name: 'Entries' });
    for (const label of ['Particulars', 'Due date', 'Qty', 'Rate', 'Amount']) await expect(grid).toContainText(label);
    await expect(grid).not.toContainText('Godown'); // an order moves no goods
    await expect(focused(app)).toHaveAttribute('data-vf', 'party');
    await expect(app.getByLabel('Customer PO or reference')).toBeVisible();
    await expect(panel(app)).toBeVisible();
    await expect(panel(app).locator('[data-command="voucher.accept"]')).toBeEnabled();
    await expect(panel(app).locator('[data-command="voucher.switch.sales"]')).toBeEnabled();
    await expect(panel(app).locator('[data-command="voucher.switch.salesOrder"]')).toBeEnabled();
    await expect(panel(app).locator('[data-command="voucher.partyDetails"]')).toBeEnabled();
    await expect(panel(app).locator('[data-command="voucher.againstOrder"]')).toBeDisabled(); // only an invoice is against an order
  });

  test('two lines with their own due dates are saved as SO/…, post nothing to the accounts or the stock, and read back with each line’s date', async ({ app }) => {
    await app.keyboard.press('Shift+F8');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.keyboard.type('PO-9001');
    await app.keyboard.press('Enter');
    await orderLine(app, 'mounting', '15-12', '10', '55');
    await orderLine(app, 'machine oil', '20-1', '5', '250');
    await expect(app.getByTestId('total-amount')).toHaveText('1,800.00'); // 10 × 55 + 5 × 250
    await app.keyboard.press('Enter'); // an empty item on the last line: that is all the lines
    await expect(focused(app)).toHaveAttribute('data-vf', 'narration');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('Sales Order SO/');
    await expect(banner(app)).toContainText('saved.');

    // nothing moved: the stock is as it was, and the order is in the Day Book with no amounts
    await goTo(app, 'stock summary');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('stock-closing-value')).toHaveText('3,46,140.00');

    await openRegister(app);
    await expect(gridRows(app)).toHaveCount(7);
    const bracket = registerRow(app, 'PO-9001', 'Mounting Bracket');
    await expect(bracket).toContainText('0/10');
    await expect(bracket).toContainText('15-Dec');
    await expect(registerRow(app, 'PO-9001', 'Machine Oil')).toContainText('20-Jan');
    await expect(bracket).toHaveClass(/open-line/);
  });

  test('a line with no due date, no quantity or a quantity a unit cannot take is refused on that cell', async ({ app }) => {
    await app.keyboard.press('Shift+F8');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // no PO
    await app.keyboard.type('mounting');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // due date as it is
    await app.keyboard.type('2.5'); // bracket are counted in whole Nos
    await app.keyboard.press('Enter');
    await app.keyboard.type('55');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'counted in whole Nos' })).toBeVisible();
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.qty');
    await expect(banner(app)).toHaveCount(0);
  });

  test('a posted order shows how far each line is filled and whether it is open; it can be closed by hand, and then nothing can be delivered against it', async ({ app }) => {
    await openRegister(app);
    await app.keyboard.type('PO-4471');
    await expect(gridRows(app)).toHaveCount(3);
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Sales Order SO/');
    await expect(app.getByTestId('order-status')).toHaveText('Open');
    const fills = app.getByTestId('line-fill');
    await expect(fills).toHaveText(['2,000/2,000', '120/300', '0/20']);
    await expect(app.locator('.vrow.open-line')).toHaveCount(2); // the brackets and the frames are still to deliver
    await expect(panel(app).locator('[data-command="order.close"]')).toBeEnabled();
    await expect(panel(app).locator('[data-command="order.invoice"]')).toBeEnabled();
    await app.keyboard.press('Alt+k');
    await expect(app.getByTestId('close-confirm')).toBeVisible();
    await app.keyboard.press('Escape'); // leave it open
    await expect(app.getByTestId('close-confirm')).toHaveCount(0);
    await expect(heading(app)).toContainText('Display Sales Order SO/');
    await app.keyboard.press('Alt+k');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Sales Order Register');
    await expect(registerRow(app, 'PO-4471', 'Mounting Bracket')).toContainText('Closed');
    await expect(registerRow(app, 'PO-4471', 'Mounting Bracket')).toHaveClass(/closed-order/);
    await expect(registerRow(app, 'PO-4471', 'Mounting Bracket')).not.toHaveClass(/open-line/);

    // …and the customer has no open order left: an invoice for ABC is over the counter
    await app.keyboard.press('F8');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await expect(app.getByLabel('Customer PO or reference')).toHaveValue('');
  });
});

test.describe('the Sales Invoice window', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('F8 opens it: a godown and an order for each line, the sales ledger and the bill’s due date; Ctrl+A saves it as SAL/, out of stock and into the customer’s account', async ({ app }) => {
    await app.keyboard.press('F8');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await expect(app.getByTestId('voucher-type-tag')).toHaveText('Sales');
    const grid = app.getByRole('group', { name: 'Entries' });
    for (const label of ['Particulars', 'Godown', 'Against order', 'Qty', 'Rate', 'Amount']) await expect(grid).toContainText(label);
    await expect(app.getByLabel('Sales ledger')).toHaveValue('Sales - Domestic');
    await expect(panel(app).locator('[data-command="voucher.againstOrder"]')).toBeEnabled();

    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter'); // Sharma has no open order: nothing to fill
    await expect(app.getByLabel('Customer PO or reference')).toHaveValue('');
    await app.keyboard.press('Enter'); // PO
    await app.keyboard.press('Enter'); // E-way Bill No.
    await app.keyboard.press('Enter'); // sales ledger
    await app.keyboard.press('Enter'); // bill due (the date + Sharma's 45 days)
    await app.keyboard.type('machine oil');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="l0.wh"]')).toHaveValue('Main Location'); // where the oil is
    await app.keyboard.press('Enter'); // godown
    await app.keyboard.press('Enter'); // no order
    await app.keyboard.type('10');
    await app.keyboard.press('Enter');
    await app.keyboard.type('250');
    await expect(app.getByTestId('line-amount').first()).toHaveText('2,500.00');
    await expect(app.getByTestId('total-amount')).toHaveText('2,500.00');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('Sales SAL/');
    await expect(banner(app)).toContainText('saved.');

    // the goods went out (oil: 120 − 40 − 10 = 70 Ltr) and the customer owes it
    await goTo(app, 'i:machine oil');
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app)).toContainText(['Stock ledger', 'Sales orders']);
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Stock: Machine Oil');
    await expect(app.getByTestId('stock-closing')).toContainText('70');
  });

  test('choosing a customer with an open order pulls NOTHING in — a regular invoice; the order is chosen in the Cust PO field, and then the REMAINING items come in as lines, in the godown that holds them', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    // a regular invoice: no PO, no order items, no notice — even though ABC has an open order
    await expect(app.getByLabel('Customer PO or reference')).toHaveValue('');
    await expect(lines(app)).toHaveCount(1);
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('');
    await expect(banner(app)).toHaveCount(0);
    // the Cust PO field offers the customer's open orders; choosing one brings what remains on it
    await expect(app.getByTestId('picker')).toContainText('PO-4471');
    await app.keyboard.type('PO-44');
    await app.keyboard.press('Enter');
    await expect(app.getByLabel('Customer PO or reference')).toHaveValue('PO-4471');
    await expect(banner(app)).toContainText('2 remaining lines brought in from SO/');
    await expect(lines(app)).toHaveCount(2); // the bolts were delivered in full: only what remains
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('Mounting Bracket');
    await expect(app.locator('[data-vf="l0.wh"]')).toHaveValue('Finished Goods Store'); // not the main godown: that is where the brackets are
    await expect(app.locator('[data-vf="l0.qty"]')).toHaveValue('180'); // 300 ordered, 120 delivered
    await expect(app.locator('[data-vf="l0.rate"]')).toHaveValue('55');
    await expect(app.locator('[data-vf="l1.item"]')).toHaveValue('Fabricated Frame');
    await expect(app.locator('[data-vf="l1.qty"]')).toHaveValue('20');
    await expect(app.getByTestId('order-note').first()).toContainText('180 of 300 pending');
    await expect(app.getByTestId('total-amount')).toHaveText('37,900.00'); // 180 × 55 + 20 × 1,400
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');

    // the order is now delivered in full: closed, its lines muted, nothing bold
    await openRegister(app);
    await expect(registerRow(app, 'PO-4471', 'Mounting Bracket')).toContainText('300/300');
    await expect(registerRow(app, 'PO-4471', 'Fabricated Frame')).toContainText('20/20');
    await expect(gridRows(app).filter({ hasText: 'PO-4471' }).filter({ hasText: 'Closed' })).toHaveCount(3);
    await expect(app.locator('tr.open-line')).toHaveCount(1); // only Kumar's KEW-12 is left
  });

  test('over-delivery is refused on the quantity cell, saying how much is pending; a smaller quantity is accepted and shows as 500/800, still bold', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await app.keyboard.type('KEW'); // choose the order: only then do its items come in
    await app.keyboard.press('Enter');
    await expect(app.getByLabel('Customer PO or reference')).toHaveValue('KEW-12');
    await expect(app.locator('[data-vf="l0.qty"]')).toHaveValue('800');
    await app.locator('[data-vf="l0.qty"]').fill('900');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: '800 Nos pending, you are delivering 900 Nos' })).toBeVisible();
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.qty');
    await expect(banner(app)).toHaveCount(0);
    await app.locator('[data-vf="l0.qty"]').fill('500');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');

    await openRegister(app);
    const row = registerRow(app, 'KEW-12', 'ABC Hex Bolt M8');
    await expect(row).toContainText('500/800');
    await expect(row).toContainText('300'); // pending
    await expect(row).toHaveClass(/open-line/);
    await expect(row).toContainText('overdue'); // due in the demo's May; it is later than that now
  });

  test('stock that is not there is refused on its quantity cell, and no order line is filled', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    for (let i = 0; i < 4; i++) await app.keyboard.press('Enter'); // PO, E-way Bill No., sales ledger, bill due
    await app.keyboard.type('fabricated');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Enter'); // godown (the main one is offered when nothing holds it… the frames are in the Finished Goods Store)
    await app.keyboard.press('Enter');
    await app.keyboard.type('61');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1400');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'Not enough Fabricated Frame' })).toBeVisible();
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.qty');
  });

  test('the Cust PO field lists the customer’s open orders; Alt+O picks the order line for one item, with what is pending', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter'); // PO filled, two lines brought in
    await app.locator('[data-vf="l0.item"]').click();
    await app.keyboard.press('Alt+o');
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.ord');
    await expect(app.getByTestId('picker')).toContainText('PO-4471');
    await expect(app.getByTestId('picker')).toContainText('180 Nos pending of 300 Nos');
  });

  test('× on a line takes it out of the table, and the totals follow; the only line is emptied, not removed', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.type('PO-44'); // choose the order: its remaining items come in
    await app.keyboard.press('Enter');
    await expect(lines(app)).toHaveCount(2);
    await expect(app.getByTestId('total-amount')).toHaveText('37,900.00');
    await app.getByRole('button', { name: 'Remove line 2' }).click(); // the frames
    await expect(lines(app)).toHaveCount(1);
    await expect(app.getByTestId('total-amount')).toHaveText('9,900.00');
    await app.getByRole('button', { name: 'Remove line 1' }).click(); // the only line
    await expect(lines(app)).toHaveCount(1);
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('');
    await expect(app.getByTestId('total-amount')).toHaveText('0.00');
    await expect(app.getByRole('button', { name: 'Remove line 1' })).toBeVisible();
  });

  test('picking another PO from the Cust PO field adds its remaining lines after what is there', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await app.keyboard.type('KEW');
    await app.keyboard.press('Enter'); // KEW-12: one line
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('ABC Hex Bolt M8');
    await expect(lines(app)).toHaveCount(1);
    // Kumar has just the one open order: choosing it again adds nothing, and says so
    await app.locator('[data-vf="ref"]').click();
    await expect(app.getByTestId('picker')).toContainText('KEW-12');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(banner(app)).toContainText('Nothing more to bring in');
    await expect(lines(app)).toHaveCount(1);
  });

  test('cancelling the invoice frees the quantity: the order is pending again', async ({ app }) => {
    await goTo(app, 'day book');
    await app.keyboard.press('Enter');
    await app.keyboard.type('SAL/');
    await expect(gridRows(app)).toHaveCount(2); // the demo's two invoices
    await gridRows(app).filter({ hasText: 'ABC Industries' }).first().click();
    await expect(heading(app)).toContainText('Display Sales SAL/');
    await app.keyboard.press('Alt+x');
    await expect(app.getByTestId('cancel-confirm')).toBeVisible();
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Day Book');
    await openRegister(app);
    await expect(registerRow(app, 'PO-4471', 'ABC Hex Bolt M8')).toContainText('0/2,000');
    await expect(registerRow(app, 'PO-4471', 'ABC Hex Bolt M8')).toHaveClass(/open-line/);
    await expect(registerRow(app, 'PO-4471', 'Mounting Bracket')).toContainText('0/300');
  });
});

test.describe('from an order to an invoice, and between the two documents', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('Alt+I on an order opens an invoice for what is PENDING: its customer, PO, and a line for each pending line, ready to accept', async ({ app }) => {
    await openRegister(app);
    await app.keyboard.type('PO-4471');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Sales Order SO/');
    await app.keyboard.press('Alt+i');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await expect(app.locator('[data-vf="party"]')).toHaveValue('ABC Industries');
    await expect(app.getByLabel('Customer PO or reference')).toHaveValue('PO-4471');
    await expect(lines(app)).toHaveCount(2);
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('Mounting Bracket');
    await expect(app.locator('[data-vf="l0.qty"]')).toHaveValue('180');
    await expect(app.locator('[data-vf="l1.item"]')).toHaveValue('Fabricated Frame');
    await expect(focused(app)).toHaveAttribute('data-vf', 'l0.qty'); // ready to review
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('Sales SAL/');
    await expect(banner(app)).toContainText('saved.');
    await openRegister(app);
    await expect(gridRows(app).filter({ hasText: 'PO-4471' }).filter({ hasText: 'Closed' })).toHaveCount(3);
  });

  test('the same is one click on the panel: Invoice pending', async ({ app }) => {
    await openRegister(app);
    await app.keyboard.type('KEW-12');
    await app.keyboard.press('Enter');
    await panel(app).locator('[data-command="order.invoice"]').click();
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await expect(app.locator('[data-vf="party"]')).toHaveValue('Kumar Engineering Works');
    await expect(app.locator('[data-vf="l0.qty"]')).toHaveValue('800');
    await expect(app.locator('[data-vf="l0.rate"]')).toHaveValue('6.75');
  });

  test('an order that is delivered in full or closed has nothing to invoice: the button is off', async ({ app }) => {
    await openRegister(app);
    await app.keyboard.type('SH/PO/88');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('order-status')).toContainText('Closed');
    await expect(panel(app).locator('[data-command="order.invoice"]')).toBeDisabled();
    await expect(panel(app).locator('[data-command="order.close"]')).toBeEnabled(); // (closing by hand is still allowed; it is closed by delivery)
  });

  test('switching Sales Order ↔ Sales keeps the customer, PO and lines (a panel click, or F8 / Shift+F8) and says what could not come along', async ({ app }) => {
    await app.keyboard.press('Shift+F8');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.keyboard.type('PO-77');
    await enterNext(app);
    await orderLine(app, 'machine oil', '20-12', '4', '250');
    await panel(app).locator('[data-command="voucher.switch.sales"]').click();
    await expect(heading(app)).toHaveText('New Sales Voucher');
    expect(new URL(app.url()).hash).toBe('#/voucher/new/sales');
    await expect(app.locator('[data-vf="party"]')).toHaveValue('Sharma Traders');
    await expect(app.getByLabel('Customer PO or reference')).toHaveValue('PO-77');
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('Machine Oil');
    await expect(app.locator('[data-vf="l0.qty"]')).toHaveValue('4');
    await expect(app.locator('[data-vf="l0.wh"]')).toHaveValue('Main Location');
    await expect(banner(app)).toContainText('due dates were cleared');
    await app.keyboard.press('Shift+F8');
    await expect(heading(app)).toHaveText('New Sales Order');
    expect(new URL(app.url()).hash).toBe('#/voucher/new/salesOrder');
    await expect(app.locator('[data-vf="l0.item"]')).toHaveValue('Machine Oil');
    await expect(app.locator('[data-vf="l0.ldue"]')).not.toHaveValue('');
    await app.keyboard.press('Escape'); // one Esc from anywhere but the first field only goes back a field…
    await expect(heading(app)).toHaveText('New Sales Order');
  });

  test('an accounting voucher is opened by its key from a sales window, and the other way round; a blank window is replaced, one with entries stays underneath', async ({ app }) => {
    await app.keyboard.press('F8');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await app.keyboard.press('F5'); // nothing entered: replaced
    await expect(heading(app)).toHaveText('New Payment Voucher');
    await app.keyboard.press('Escape'); // a blank window with no list open: it closes
    await expect(heading(app)).toHaveText('Gateway'); // not back to an empty invoice
    await app.keyboard.press('F8');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.keyboard.press('F6'); // something entered: a new window on top
    await expect(heading(app)).toHaveText('New Receipt Voucher');
    await app.keyboard.press('Escape'); // a blank window with no list open: it closes
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await expect(app.locator('[data-vf="party"]')).toHaveValue('Sharma Traders');
  });
});

test.describe('the Sales Order Register', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
    await openRegister(app);
  });

  test('one row per order line: order no, PO, party, item, due, ordered, delivered, pending, fill and status — an open order’s open lines in bold', async ({ app }) => {
    for (const label of ['Order no.', 'Date', 'Cust PO / ref', 'Party', 'Item', 'Due', 'Ordered', 'Delivered', 'Pending', 'Fill', 'Status']) {
      await expect(app.getByRole('columnheader', { name: new RegExp(label) })).toBeVisible();
    }
    await expect(gridRows(app)).toHaveCount(5);
    const bracket = registerRow(app, 'PO-4471', 'Mounting Bracket');
    await expect(bracket).toContainText('ABC Industries');
    await expect(bracket).toContainText('120/300');
    await expect(bracket).toContainText('180'); // pending
    await expect(bracket).toContainText('Open');
    await expect(bracket).toHaveClass(/open-line/);
    await expect(registerRow(app, 'PO-4471', 'ABC Hex Bolt M8')).toContainText('2,000/2,000');
    await expect(registerRow(app, 'PO-4471', 'ABC Hex Bolt M8')).not.toHaveClass(/open-line/); // delivered in full: plain
    await expect(registerRow(app, 'SH/PO/88', 'Machine Oil')).toHaveClass(/closed-order/); // the whole order is delivered: closed
    await expect(app.getByTestId('order-counts')).toContainText('3 orders · 3 open lines');
  });

  test('every column sorts and filters like the other reports: Alt+S on Fill, Alt+L on Status, typing narrows', async ({ app }) => {
    for (let i = 0; i < 9; i++) await app.keyboard.press('Tab'); // → Fill
    await expect(app.getByRole('columnheader', { name: /Fill/ })).toHaveClass(/active/);
    await app.keyboard.press('Alt+s');
    await expect(app.getByRole('columnheader', { name: /Fill/ })).toHaveAttribute('aria-sort', 'ascending');
    await expect(gridRows(app).first()).toContainText('0/'); // nothing delivered yet comes first
    await app.keyboard.press('Alt+s');
    await expect(app.getByRole('columnheader', { name: /Fill/ })).toHaveAttribute('aria-sort', 'descending');
    await expect(gridRows(app).first()).toContainText('/'); // (a line delivered in full first)
    await app.keyboard.press('Tab'); // → Status
    await app.keyboard.press('Alt+l');
    await expect(app.getByTestId('report-dialog')).toContainText('Filter Status');
    await app.keyboard.press('ArrowDown'); // All → Open
    await app.keyboard.press('Enter'); // tick
    await app.keyboard.press('Control+a');
    await expect(gridRows(app)).toHaveCount(4);
    await expect(app.getByTestId('chip')).toContainText('Status');
    await app.keyboard.press('Alt+k');
    await expect(gridRows(app)).toHaveCount(5);
    await app.keyboard.type('kew');
    await expect(gridRows(app)).toHaveCount(1);
    await expect(gridRows(app).first()).toContainText('Kumar Engineering Works');
  });

  test('Enter opens the order and Esc returns to the same row in the same view', async ({ app }) => {
    await app.keyboard.type('mounting');
    await expect(gridRows(app)).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(heading(app)).toContainText('Display Sales Order SO/');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Sales Order Register');
    await expect(app.getByRole('textbox', { name: 'Quick filter' })).toHaveValue('mounting');
    await expect(gridRows(app)).toHaveCount(1);
  });

  test('Go To on an item lists its sales orders: the register for that item alone, with ref no, status and delivered / ordered', async ({ app }) => {
    await goTo(app, 'i:hex bolt');
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app)).toContainText(['Display Stock Item', 'Alter Stock Item', 'Stock ledger', 'Sales orders']);
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Sales orders: ABC Hex Bolt M8');
    expect(new URL(app.url()).hash).toMatch(/^#\/report\/sales-orders\//);
    await expect(gridRows(app)).toHaveCount(2); // PO-4471 (delivered in full) and KEW-12 (nothing yet)
    await expect(registerRow(app, 'PO-4471', 'ABC Hex Bolt M8')).toContainText('2,000/2,000');
    await expect(registerRow(app, 'KEW-12', 'ABC Hex Bolt M8')).toContainText('0/800');
    await expect(registerRow(app, 'KEW-12', 'ABC Hex Bolt M8')).toHaveClass(/open-line/);
  });

  test('the period on F2 limits the register by the order’s date', async ({ app }) => {
    await app.keyboard.press('F2');
    await expect(app.getByTestId('report-dialog')).toContainText('Period');
    await app.keyboard.press('Escape');
    await expect(gridRows(app)).toHaveCount(5);
  });
});

test.describe('the Esc order and the leave question, on the sales window too', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('the list first, then back a field, then — with something entered — “Close and leave?”', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.keyboard.type('shar');
    await expect(app.getByTestId('picker')).toBeVisible();
    await app.keyboard.press('Escape'); // the list only
    await expect(app.getByTestId('picker')).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await app.keyboard.press('Escape'); // text typed counts as entered: the question
    await expect(app.getByTestId('leave-dialog')).toBeVisible();
    await app.keyboard.press('Escape'); // keep working
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await app.keyboard.press('Enter'); // choose Sharma Traders
    await app.keyboard.press('Escape'); // back to the customer field
    await expect(focused(app)).toHaveAttribute('data-vf', 'party');
    await app.keyboard.press('Escape'); // entered: the question
    await expect(app.getByTestId('leave-dialog')).toBeVisible();
    await app.keyboard.press('Escape'); // keep working
    await expect(heading(app)).toHaveText('New Sales Voucher');
  });

  test('a half-entered order survives a reload as a draft', async ({ app }) => {
    await app.keyboard.press('Shift+F8');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.keyboard.type('PO-DRAFT');
    await app.keyboard.press('Enter');
    await app.waitForTimeout(600); // the draft is kept a moment after typing stops
    await app.reload();
    await expect(heading(app)).toHaveText('New Sales Order');
    await expect(app.getByLabel('Customer PO or reference')).toHaveValue('PO-DRAFT');
    await expect(app.locator('[data-vf="party"]')).toHaveValue('Sharma Traders');
  });
});

test.describe('closing with the mouse, and clicking blank space', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('every creation window has a × in its title bar: a blank one closes at once, one with entries asks “Close and leave?” first', async ({ app }) => {
    await app.keyboard.press('F8');
    await app.getByTestId('window-close').click();
    await expect(heading(app)).toHaveText('Gateway');

    await app.keyboard.press('Shift+F8');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await app.getByTestId('window-close').click();
    await expect(app.getByTestId('leave-dialog')).toBeVisible();
    await app.keyboard.press('Escape'); // keep working
    await expect(heading(app)).toHaveText('New Sales Order');
    await app.getByTestId('window-close').click();
    await app.getByTestId('leave-dialog').getByRole('button', { name: /Yes, close/ }).click();
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('the same × is on the accounting, stock and master creation windows', async ({ app }) => {
    for (const key of ['F5', 'F10']) {
      await app.keyboard.press(key);
      await expect(app.getByTestId('window-close')).toBeVisible();
      await app.getByTestId('window-close').click();
      await expect(heading(app)).toHaveText('Gateway');
    }
    await goTo(app, 'create ledger');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Create Ledger');
    await app.getByTestId('window-close').click();
    await expect(heading(app)).not.toHaveText('Create Ledger');
  });

  test('clicking blank space deactivates the active field; a click on a field, or any key, brings the window back', async ({ app }) => {
    await app.keyboard.press('F8');
    await expect(focused(app)).toHaveAttribute('data-vf', 'party');
    await expect(app.locator('.vcell.active')).toHaveCount(1);
    await app.locator('.vbody').click({ position: { x: 300, y: 250 } });
    await expect(app.locator('[data-vf]:focus')).toHaveCount(0);
    await expect(app.locator('.vcell.active, .vfield.active')).toHaveCount(0);
    await app.keyboard.press('Tab'); // a key command moves the window on from where it was
    await expect(focused(app)).toHaveAttribute('data-vf', 'ref');
    await app.locator('.vbody').click({ position: { x: 300, y: 250 } });
    await expect(app.locator('.vcell.active')).toHaveCount(0);
    await app.locator('[data-vf="ref"]').click();
    await expect(focused(app)).toHaveAttribute('data-vf', 'ref');
    await expect(app.locator('.vcell.active')).toHaveCount(1);
  });
});

test.describe('committed stock: the Stock Summary and the item’s Stock ledger', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('the Stock Summary has Committed (the pending quantity on every open sales order) and Available (closing less committed)', async ({ app }) => {
    await goTo(app, 'stock summary');
    await app.keyboard.press('Enter');
    for (const label of ['Closing qty', 'Closing value', 'Committed', 'Available']) await expect(app.getByRole('columnheader', { name: new RegExp(label) })).toBeVisible();
    const row = (name: string) => gridRows(app).filter({ hasText: name });
    await expect(row('Mounting Bracket')).toContainText('680'); // in stock
    await expect(row('Mounting Bracket')).toContainText('180'); // committed to PO-4471
    await expect(row('Mounting Bracket')).toContainText('500'); // free to promise
    await expect(row('ABC Hex Bolt M8')).toContainText('800'); // KEW-12
    await expect(row('ABC Hex Bolt M8')).toContainText('2,200');
    // it follows the orders: an invoice for the whole of KEW-12 releases the bolts
    await app.keyboard.press('F8');
    await app.keyboard.type('kumar');
    await app.keyboard.press('Enter');
    await app.keyboard.type('KEW'); // choose the order: its 800 bolts come in
    await app.keyboard.press('Enter');
    await app.keyboard.press('Alt+n');
    await expect(banner(app)).toContainText('saved.');
    await goTo(app, 'stock summary');
    await app.keyboard.press('Enter');
    await expect(row('ABC Hex Bolt M8')).toContainText('2,200'); // 3,000 − 800 sold = 2,200 in stock, nothing committed any more
    await expect(row('ABC Hex Bolt M8')).not.toContainText('2,200 ·');
  });

  test('the Stock ledger lists the sales orders too — each line with its fill status — and shows current, committed and available stock below', async ({ app }) => {
    await goTo(app, 'stock summary');
    await app.keyboard.press('Enter');
    await app.keyboard.type('bolt');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Stock: ABC Hex Bolt M8');
    await expect(gridRows(app)).toHaveCount(6); // opening stock, the godown transfer (2), two sales orders, the invoice
    const kew = gridRows(app).filter({ hasText: 'KEW-12' });
    await expect(kew).toContainText('Sales Order');
    await expect(kew).toContainText('0/800');
    await expect(kew).toContainText('Open');
    await expect(kew).toHaveClass(/open-line/);
    const po = gridRows(app).filter({ hasText: 'PO-4471' });
    await expect(po).toContainText('2,000/2,000');
    await expect(po).not.toHaveClass(/open-line/); // delivered in full
    await expect(app.getByTestId('stock-current')).toHaveText('3,000 Nos');
    await expect(app.getByTestId('stock-committed')).toHaveText('800 Nos');
    await expect(app.getByTestId('stock-available')).toHaveText('2,200 Nos');
    // the voucher-type filter is on here too
    await expect(panel(app).locator('[data-command="report.types"]')).toBeEnabled();
    await app.keyboard.press('Alt+t');
    await app.getByTestId('report-dialog').getByRole('option').filter({ hasText: /^\s*[☐☑]?\s*Sales Order$/ }).click();
    await app.keyboard.press('Control+a');
    await expect(app.getByTestId('chip')).toContainText('Type: Sales Order');
    await expect(gridRows(app)).toHaveCount(2);
    // Enter on an order line opens the order
    await gridRows(app).filter({ hasText: 'KEW-12' }).click();
    await expect(heading(app)).toContainText('Display Sales Order SO/');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Stock: ABC Hex Bolt M8');
    await expect(app.getByTestId('chip')).toContainText('Type: Sales Order'); // the view is as it was left
  });
});
