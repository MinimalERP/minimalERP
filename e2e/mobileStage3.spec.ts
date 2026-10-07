/**
 * The mobile interface, stage 3 (ADR-0027), by taps on a touch phone: Scan (a file is asked "What is it?" and sent to be read), a Purchase
 * bill entered by touch, the order registers and the Day Book, the customer's PO in the order list, the Stock list's tabs, and a Stock
 * Journal.
 */
import { type Page, expect, test } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

const title = (page: Page) => page.locator('.m-title').first();
const row = (page: Page, text: string | RegExp) => page.locator('.m-row').filter({ hasText: text });
const picker = (page: Page) => page.getByTestId('picker');

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('load-demo').tap();
  await expect(title(page)).toHaveText('Demo Manufacturing Pvt Ltd');
});

test('Scan: a chosen file is asked what it is and sent; in the browser-only books the reader says it needs the online company; nothing waits', async ({ page }) => {
  const problems = watch(page);
  await page.getByTestId('gateway-scan').tap();
  await expect(title(page)).toHaveText('Scan');
  await expect(page.getByTestId('scan-photo')).toBeVisible();
  await expect(page.locator('.m-main')).toContainText('Nothing is waiting');

  // a Word file is refused before anything is asked
  await page.getByTestId('scan-file').setInputFiles({ name: 'notes.docx', mimeType: 'application/msword', buffer: Buffer.from('x') });
  await expect(page.getByTestId('scan-error')).toContainText('not a PDF or a picture');
  await expect(page.getByTestId('scan-kind')).toHaveCount(0);

  await page.getByTestId('scan-file').setInputFiles({ name: 'bill-889.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 a bill') });
  await expect(page.getByTestId('scan-kind')).toContainText('bill-889.pdf');
  for (const kind of ['Purchase bill', 'Customer PO', 'Sales invoice', 'Receipt', 'Payment']) await expect(page.getByTestId('scan-kind')).toContainText(kind);
  await page.getByTestId('scan-kind-purchase').tap();
  await expect(page.getByTestId('scan-kind')).toHaveCount(0);
  await expect(page.getByTestId('scan-error')).toBeVisible(); // these books live in the browser: reading needs the online company
  await page.goBack();
  await expect(title(page)).toHaveText('Demo Manufacturing Pvt Ltd');
  expect(problems.filter((p) => !/reader|online|Failed to load/i.test(p))).toEqual([]);
});

test('a Purchase bill by taps: supplier, their invoice number, an item received — the goods are in, the bill is owed; the same number again is refused', async ({ page }) => {
  const problems = watch(page);
  await page.getByTestId('gateway-new').tap();
  await page.getByTestId('new-purchase').tap();
  await expect(title(page)).toHaveText('New Purchase Bill');
  await page.getByTestId('entry-party').tap();
  await picker(page).getByLabel('Search suppliers').fill('steel');
  await picker(page).getByTestId('pick-row').first().tap();
  await expect(page.getByTestId('entry-party')).toContainText('Steel Supplies Pvt Ltd');

  await page.getByTestId('entry-add').tap();
  await picker(page).getByLabel('Search items').fill('machine oil');
  await picker(page).getByTestId('pick-row').first().tap();
  await expect(page.getByTestId('line-sheet')).toContainText('Receive into');
  await page.getByTestId('line-qty').fill('20');
  await page.getByTestId('line-rate').fill('200');
  await page.getByTestId('line-done').tap();
  await expect(page.getByTestId('entry-total')).toHaveText('₹ 4,000.00');

  await page.getByTestId('entry-save').tap(); // no supplier invoice number yet
  await expect(page.getByTestId('entry-refused')).toContainText('supplier’s invoice number');
  await page.getByTestId('entry-billno').fill('SS/7001');
  await page.getByTestId('entry-save').tap();
  await expect(title(page)).toHaveText(/^Purchase PUR\//);
  await expect(page.getByTestId('doc-pending')).toContainText('4,000.00');

  // the same supplier invoice number on another bill is refused
  await page.goBack();
  await page.getByTestId('new-purchase').tap();
  await page.getByTestId('entry-party').tap();
  await picker(page).getByLabel('Search suppliers').fill('steel');
  await picker(page).getByTestId('pick-row').first().tap();
  await page.getByTestId('entry-add').tap();
  await picker(page).getByLabel('Search items').fill('machine oil');
  await picker(page).getByTestId('pick-row').first().tap();
  await expect(page.getByTestId('line-rate')).toHaveValue('200'); // what this supplier last charged
  await page.getByTestId('line-done').tap();
  await page.getByTestId('entry-billno').fill('SS/7001');
  await page.getByTestId('entry-save').tap();
  await expect(page.getByTestId('entry-refused')).toContainText('already a bill of this supplier');
  expect(problems).toEqual([]);
});

test('Reports: the Sales Order Register opens on what is pending, earliest due first; All shows every line; a row opens its order; the Day Book lists a day', async ({ page }) => {
  const problems = watch(page);
  await page.getByTestId('gateway-reports').tap();
  await expect(title(page)).toHaveText('Reports');
  await page.getByTestId('report-sales-orders').tap();
  await expect(title(page)).toHaveText('Sales Order Register');
  const rows = page.getByTestId('register-row');
  await expect(rows).toHaveCount(3); // KEW-12's bolts, PO-4471's brackets and frames
  await expect(rows.first()).toContainText('ABC Hex Bolt M8'); // due first
  await expect(rows.first()).toContainText('KEW-12');
  await expect(page.getByTestId('register-overdue')).toBeVisible();
  await expect(page.getByTestId('register-open')).toContainText('Pending (3)');
  await page.getByTestId('register-all').tap();
  await expect(rows).toHaveCount(5);
  await page.getByLabel('Filter: item, customer, PO').fill('PO-4471');
  await expect(rows).toHaveCount(3);
  await rows.filter({ hasText: 'Mounting Bracket' }).tap();
  await expect(title(page)).toHaveText(/^Sales Order SO\//);
  await page.goBack();
  await page.goBack();

  await page.getByTestId('report-purchase-orders').tap();
  await expect(title(page)).toHaveText('Purchase Order Register');
  await expect(page.getByTestId('register-row').first()).toBeVisible();
  await page.goBack();

  await page.getByTestId('report-day-book').tap();
  await expect(title(page)).toHaveText('Day Book');
  await page.getByLabel('Day').fill('2026-05-19'); // the day the demo's oil was sold to Sharma
  await expect(page.getByTestId('daybook-row').filter({ hasText: 'Sharma Traders' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('the Sales Orders list shows the customer’s PO beside the number, and finds an order by it', async ({ page }) => {
  await row(page, /^Transactions/).tap();
  await row(page, 'Sales Orders').tap();
  await expect(page.getByTestId('doc-row').filter({ hasText: 'PO-4471' })).toContainText(/SO\/.+ · PO-4471/);
  await page.getByLabel('Filter: number, party, status').fill('KEW-12');
  await expect(page.getByTestId('doc-row')).toHaveCount(1);
  await expect(page.getByTestId('doc-row')).toContainText('Kumar Engineering Works');
});

test('Stock has tabs: All, Committed (what sales orders are waiting for, and what that leaves free) and On order', async ({ page }) => {
  await row(page, /^Stock/).tap();
  await expect(page.getByTestId('stock-tab-all')).toHaveAttribute('aria-pressed', 'true');
  const all = await page.getByTestId('item-row').count();
  await page.getByTestId('stock-tab-committed').tap();
  const committed = page.getByTestId('item-row');
  await expect(committed.first()).toContainText('on sales orders');
  await expect(committed.first()).toContainText('free');
  expect(await committed.count()).toBeLessThan(all);
  await expect(committed.filter({ hasText: 'Mounting Bracket' })).toContainText('180'); // PO-4471 still wants 180
  await page.getByTestId('stock-tab-onOrder').tap();
  await expect(page.getByTestId('item-row').first()).toContainText('to come');
  await page.getByTestId('stock-tab-all').tap();
  await expect(page.getByTestId('item-row')).toHaveCount(all);
});

test('a Stock Journal by taps: oil out of one godown and into another; it is listed, shows what moved, and the total stock is unchanged', async ({ page }) => {
  const problems = watch(page);
  await row(page, /^Transactions/).tap();
  await expect(page.locator('.m-group-title')).toHaveText(['Sales', 'Purchase', 'Inventory', 'General']);
  await row(page, 'Stock Journal Vouchers').tap();
  await page.getByTestId('list-new').tap();
  await expect(title(page)).toHaveText('New Stock Journal');

  await page.getByTestId('sj-add-out').tap();
  await picker(page).getByLabel('Search items').fill('machine oil');
  await picker(page).getByTestId('pick-row').first().tap();
  await page.getByTestId('sj-qty').fill('10');
  await page.getByTestId('sj-done').tap();
  await page.getByTestId('sj-add-in').tap();
  await picker(page).getByLabel('Search items').fill('machine oil');
  await picker(page).getByTestId('pick-row').first().tap();
  await page.getByTestId('sj-qty').fill('10');
  await expect(page.getByTestId('sj-rate')).not.toHaveValue(''); // coming in at what the book holds it at
  await page.getByTestId('sj-godown').selectOption({ index: 1 });
  await page.getByTestId('sj-done').tap();
  await expect(page.getByTestId('sj-line')).toHaveCount(2);
  await page.getByTestId('sj-save').tap();

  await expect(title(page)).toHaveText(/^Stock Journal STJ\//);
  await expect(page.getByTestId('doc-stock-line')).toHaveCount(2);
  await expect(page.getByTestId('doc-stock-line').first()).toContainText('Out · Machine Oil');
  await page.getByTestId('doc-stock-line').first().tap(); // to the item: 80 still, now in two godowns
  await expect(page.getByTestId('item-stock')).toContainText('80');
  await expect(page.locator('.m-main')).toContainText('Finished Goods Store');
  expect(problems).toEqual([]);
});

test('Ship to on a Sales Invoice and a Delivery Challan: the party’s addresses are offered, and the one chosen is on the document', async ({ page }) => {
  const problems = watch(page);
  for (const kind of ['sales', 'deliveryChallan'] as const) {
    await page.getByTestId('gateway-new').tap();
    await page.getByTestId(`new-${kind}`).tap();
    await expect(page.getByTestId('entry-ship')).toHaveCount(0); // no customer yet: nowhere to ship
    await page.getByTestId('entry-party').tap();
    await picker(page).getByLabel('Search customers').fill('kumar');
    await picker(page).getByTestId('pick-row').first().tap();
    await expect(page.getByTestId('entry-ship')).not.toContainText('Same as billing'); // Kumar ships to its own unit
    await page.getByTestId('entry-ship').tap();
    await expect(page.getByTestId('ship-choice')).toHaveCount(2);
    await page.getByTestId('ship-choice').filter({ hasText: 'Same as billing' }).tap();
    await expect(page.getByTestId('ship-sheet')).toHaveCount(0);
    await expect(page.getByTestId('entry-ship')).toContainText('Same as billing address');
    await page.getByTestId('entry-ship').tap();
    await page.goBack(); // the phone's Back closes the sheet, not the document
    await expect(page.getByTestId('ship-sheet')).toHaveCount(0);
    await expect(title(page)).toHaveText(kind === 'sales' ? 'New Sales Invoice' : 'New Delivery Challan');
    await page.goBack();
    await page.goBack();
    await expect(title(page)).toHaveText('Demo Manufacturing Pvt Ltd');
  }
  expect(problems).toEqual([]);
});
