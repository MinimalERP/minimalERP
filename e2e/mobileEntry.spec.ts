/**
 * Touch entry on the phone (ADR-0027, stage 2): a Sales Invoice, Sales Order, Quotation or Delivery Challan made with taps alone — the
 * customer and the items from full-screen lists, a line opened from the bottom for its quantity, the total and Save under the thumb. The
 * figures and the refusals are the engine's, as on the desktop; a half-entered document survives leaving the page.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

const title = (page: Page) => page.locator('.m-title').first();
const picker = (page: Page) => page.getByTestId('picker');
const sheet = (page: Page) => page.getByTestId('line-sheet');

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

async function openDemo(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('load-demo').tap();
  await expect(title(page)).toHaveText('Demo Manufacturing Pvt Ltd');
}

async function startNew(page: Page, kind: 'sales' | 'salesOrder' | 'quotation' | 'deliveryChallan'): Promise<void> {
  await page.getByTestId('gateway-new').tap();
  await page.getByTestId(`new-${kind}`).tap();
}

async function chooseCustomer(page: Page, name: string): Promise<void> {
  await page.getByTestId('entry-party').tap();
  await picker(page).getByLabel('Search customers').fill(name);
  await picker(page).getByTestId('pick-row').first().tap();
  await expect(picker(page)).toHaveCount(0);
}

/** Add item → search → tap: the line's sheet is open on it. */
async function addItem(page: Page, name: string): Promise<void> {
  await page.getByTestId('entry-add').tap();
  await picker(page).getByLabel('Search items').fill(name);
  await picker(page).getByTestId('pick-row').first().tap();
  await expect(sheet(page)).toBeVisible();
}

test.describe('entering a document by touch', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('a Sales Invoice in a dozen taps: customer, item, quantity, Save — and the goods have left', async ({ page }) => {
    const problems = watch(page);
    await startNew(page, 'sales');
    await expect(title(page)).toHaveText('New Sales Invoice');
    await chooseCustomer(page, 'sharma');
    await expect(page.getByTestId('entry-party')).toContainText('Sharma Traders');

    await addItem(page, 'machine oil');
    await expect(picker(page).or(page.getByTestId('pick-row'))).toHaveCount(0); // the list gave way to the line
    await expect(page.getByTestId('line-qty')).toHaveValue('1');
    await expect(page.getByTestId('line-rate')).toHaveValue('260'); // what Sharma last paid for it
    // the sheet sits on the screen: full width, nothing off the side
    expect(await sheet(page).boundingBox()).toMatchObject({ x: 0, width: 390 });
    expect(await sheet(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByTestId('qty-more').tap();
    await page.getByTestId('qty-more').tap();
    await expect(page.getByTestId('line-qty')).toHaveValue('3');
    await page.getByTestId('qty-less').tap();
    await page.getByTestId('qty-less').tap();
    await page.getByTestId('qty-less').tap(); // never below one
    await expect(page.getByTestId('line-qty')).toHaveValue('1');
    await page.getByTestId('line-qty').fill('3');
    await expect(page.getByTestId('line-done')).toContainText('780.00');
    await page.getByTestId('line-done').tap();
    await expect(sheet(page)).toHaveCount(0);

    await expect(page.getByTestId('entry-line')).toContainText('Machine Oil');
    await expect(page.getByTestId('entry-total')).toHaveText('₹ 780.00');
    // Save is at the bottom, within reach
    const save = await page.getByTestId('entry-save').boundingBox();
    expect((save?.y ?? 0) + (save?.height ?? 0)).toBeGreaterThan(844 - 90);
    await page.getByTestId('entry-save').tap();

    await expect(title(page)).toHaveText(/^Sales SAL\//);
    await expect(page.getByTestId('doc-total')).toContainText('780.00');
    await expect(page.getByTestId('doc-pending')).toContainText('780.00');
    // the saved invoice took the form's place: Back goes to where the form was opened from
    await page.goBack();
    await expect(title(page)).toHaveText('New');
    await page.goBack();
    await page.locator('.m-row').filter({ hasText: /^Stock/ }).tap();
    await page.getByLabel('Filter by item').fill('machine oil');
    await expect(page.getByTestId('item-row')).toContainText('77'); // 80 less the 3
    expect(problems).toEqual([]);
  });

  test('what is missing is said where it is missing, and nothing is saved; too much is refused at once, in the engine’s words', async ({ page }) => {
    const problems = watch(page);
    await startNew(page, 'sales');
    await page.getByTestId('entry-save').tap();
    await expect(page.getByTestId('entry-refused')).toContainText('Choose the customer');
    await expect(page.getByTestId('entry-party')).toContainText('Choose the customer');
    await expect(title(page)).toHaveText('New Sales Invoice');

    await chooseCustomer(page, 'sharma');
    await addItem(page, 'machine oil');
    await page.getByTestId('line-qty').fill('5000');
    await expect(page.getByTestId('line-problem')).toContainText('Not enough Machine Oil');
    await page.getByTestId('line-done').tap();
    await expect(page.getByTestId('entry-line')).toContainText('Not enough Machine Oil');
    await page.getByTestId('entry-save').tap();
    await expect(page.getByTestId('entry-refused')).toContainText('Not enough Machine Oil');
    await expect(title(page)).toHaveText('New Sales Invoice');

    // the line is opened again, and removed
    await page.getByTestId('entry-line').tap();
    await page.getByTestId('line-remove').tap();
    await expect(page.getByTestId('entry-line')).toHaveCount(0);
    // or with the × at its end, in one tap, without opening it
    await addItem(page, 'machine oil');
    await page.getByTestId('line-done').tap();
    await addItem(page, 'bracket');
    await page.getByTestId('line-done').tap();
    await page.getByRole('button', { name: 'Remove Machine Oil' }).tap();
    await expect(page.getByTestId('entry-line')).toHaveCount(1);
    await expect(page.getByTestId('entry-line')).toContainText('Mounting Bracket');
    await expect(sheet(page)).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('the phone’s Back closes the list, then the line, then the page — and a half-entered invoice is still there on returning', async ({ page }) => {
    const problems = watch(page);
    await startNew(page, 'sales');
    await page.getByTestId('entry-party').tap();
    await expect(picker(page)).toBeVisible();
    await page.goBack();
    await expect(picker(page)).toHaveCount(0);
    await expect(title(page)).toHaveText('New Sales Invoice');

    await chooseCustomer(page, 'abc');
    await addItem(page, 'machine oil');
    await page.goBack(); // closes the line's sheet (the list it replaced is not behind it)
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId('entry-line')).toHaveCount(1);

    await page.goBack(); // leaves the page: no question, the draft is kept
    await expect(title(page)).toHaveText('New');
    await page.getByTestId('new-sales').tap();
    await expect(page.getByTestId('entry-restored')).toBeVisible();
    await expect(page.getByTestId('entry-party')).toContainText('ABC Industries');
    await expect(page.getByTestId('entry-line')).toHaveCount(1);
    await page.getByTestId('entry-restored').getByRole('button', { name: 'Start again' }).tap();
    await expect(page.getByTestId('entry-line')).toHaveCount(0);
    await expect(page.getByTestId('entry-party')).toContainText('Choose the customer');
    expect(problems).toEqual([]);
  });

  test('an order from a customer’s page, then “Invoice pending” on it: the lines come along against the order', async ({ page }) => {
    const problems = watch(page);
    await page.locator('.m-row').filter({ hasText: /^Parties/ }).tap();
    await page.getByLabel('Filter by name').fill('sharma');
    await page.getByTestId('party-row').tap();
    await page.getByTestId('party-order').tap();
    await expect(title(page)).toHaveText('New Sales Order');
    await expect(page.getByTestId('entry-party')).toContainText('Sharma Traders'); // already chosen
    await addItem(page, 'machine oil');
    await expect(sheet(page).getByLabel('Line due date')).toBeVisible(); // an order line has its own due date
    await page.getByTestId('line-qty').fill('5');
    await page.getByTestId('line-rate').fill('250');
    await page.getByTestId('line-done').tap();
    await expect(page.getByTestId('entry-total')).toHaveText('₹ 1,250.00');
    await page.getByTestId('entry-save').tap();
    await expect(title(page)).toHaveText(/^Sales Order SO\//);

    await page.getByTestId('doc-invoice').tap();
    await expect(title(page)).toHaveText('New Sales Invoice');
    await expect(page.getByTestId('entry-line')).toContainText('Machine Oil');
    await expect(page.getByTestId('entry-line')).toContainText('SO/'); // against the order
    await expect(page.getByTestId('entry-total')).toHaveText('₹ 1,250.00');
    await page.getByTestId('entry-save').tap();
    await expect(title(page)).toHaveText(/^Sales SAL\//);
    await page.goBack(); // to the order, now delivered in full: nothing left to invoice
    await expect(title(page)).toHaveText(/^Sales Order SO\//);
    await expect(page.getByTestId('doc-invoice')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('a saved invoice is edited: the new quantity is saved; Back with changes asks before discarding', async ({ page }) => {
    const problems = watch(page);
    await page.locator('.m-row').filter({ hasText: /^Transactions/ }).tap();
    await page.locator('.m-row').filter({ hasText: 'Sales Vouchers' }).tap();
    await expect(page.getByTestId('list-new')).toContainText('New Sales Invoice');
    await page.getByTestId('doc-row').first().tap();
    const number = ((await title(page).textContent()) ?? '').replace('Sales ', '');
    await page.getByTestId('doc-edit').tap();
    await expect(title(page)).toHaveText(`Sales Invoice ${number}`);
    await page.getByTestId('entry-line').first().tap();
    await page.getByTestId('line-qty').fill('30');
    await page.getByTestId('line-done').tap();

    await page.goBack(); // changed and not saved: it asks
    await expect(page.getByRole('alertdialog')).toContainText('Discard');
    await page.getByRole('button', { name: 'Keep editing' }).tap();
    await expect(title(page)).toHaveText(`Sales Invoice ${number}`);
    await page.getByTestId('entry-save').tap();
    await expect(title(page)).toHaveText(`Sales ${number}`);
    await expect(page.getByTestId('doc-line').first()).toContainText('30');
    expect(problems).toEqual([]);
  });

  test('a Quotation and a Delivery Challan are the same page: a challan says whether it is billed later or free', async ({ page }) => {
    const problems = watch(page);
    await startNew(page, 'quotation');
    await chooseCustomer(page, 'abc');
    await addItem(page, 'machine oil');
    await page.getByTestId('line-rate').fill('300');
    await page.getByTestId('line-done').tap();
    await page.getByTestId('entry-save').tap();
    await expect(title(page)).toHaveText(/^Quotation QT\//);
    await page.goBack();

    await page.getByTestId('new-deliveryChallan').tap();
    await expect(page.getByRole('group', { name: 'Purpose of the challan' })).toBeVisible();
    await page.getByRole('button', { name: 'Free of cost' }).tap();
    await chooseCustomer(page, 'abc');
    await addItem(page, 'machine oil');
    await page.getByTestId('line-rate').fill('210');
    await page.getByTestId('line-done').tap();
    await page.getByTestId('entry-save').tap();
    await expect(title(page)).toHaveText(/^Delivery Challan DC\//);
    await expect(page.getByTestId('doc-invoice')).toHaveCount(0); // free of cost: never invoiced
    expect(problems).toEqual([]);
  });
});

test.describe('choosing lines of a Sales Order', () => {
  /** A long press: the finger rests on the row for longer than a tap. */
  async function hold(page: Page, line: Locator): Promise<void> {
    await line.dispatchEvent('pointerdown');
    await page.waitForTimeout(650);
    await line.dispatchEvent('pointerup');
  }

  test('a long press chooses a pending line, a tap adds or drops another, and “Invoice pending” becomes “Invoice selected”', async ({ page }) => {
    const problems = watch(page);
    await openDemo(page);
    await page.locator('.m-row').filter({ hasText: /^Transactions/ }).tap();
    await page.locator('.m-row').filter({ hasText: 'Sales Orders' }).tap();
    await page.getByLabel('Filter: number, party, status').fill('ABC');
    await page.getByTestId('doc-row').first().tap(); // PO-4471: bolts delivered, brackets and frames still pending
    await expect(title(page)).toHaveText(/^Sales Order SO\//);
    await expect(page.getByTestId('doc-invoice')).toHaveText('Invoice pending');
    await expect(page.getByTestId('doc-hold-hint')).toContainText('Hold a line');

    const frame = page.getByTestId('doc-line').filter({ hasText: 'Fabricated Frame' });
    const bracket = page.getByTestId('doc-line').filter({ hasText: 'Mounting Bracket' });
    await expect(bracket).toContainText('180 of 300 pending');
    await frame.tap(); // a tap alone chooses nothing
    await expect(page.getByTestId('doc-invoice')).toHaveText('Invoice pending');
    await hold(page, frame);
    await expect(frame).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('doc-invoice')).toHaveText('Invoice selected (1)');
    await bracket.tap(); // once choosing, a tap is enough
    await expect(page.getByTestId('doc-invoice')).toHaveText('Invoice selected (2)');
    await bracket.tap();
    await expect(page.getByTestId('doc-invoice')).toHaveText('Invoice selected (1)');

    await page.getByTestId('doc-invoice').tap();
    await expect(title(page)).toHaveText('New Sales Invoice');
    await expect(page.getByTestId('entry-line')).toHaveCount(1);
    await expect(page.getByTestId('entry-line')).toContainText('Fabricated Frame');
    expect(problems).toEqual([]);
  });
});
