/**
 * Making a customer or a stock item on the phone (ADR-0027, stage 2): from a search that did not find it — "+ Create …", and it is chosen
 * straight into the document — or from the Parties / Stock lists. The few fields a sale needs; the rules are the desktop's.
 */
import { type Page, expect, test } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

const title = (page: Page) => page.locator('.m-title').first();
const picker = (page: Page) => page.getByTestId('picker');
const create = (page: Page) => page.getByTestId('create');

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

test('a quotation for a customer and an item the books did not have: both are made from the search and land on the document', async ({ page }) => {
  const problems = watch(page);
  await page.getByTestId('gateway-new').tap();
  await page.getByTestId('new-quotation').tap();

  await page.getByTestId('entry-party').tap();
  await picker(page).getByLabel('Search customers').fill('Zenith Motors');
  await expect(picker(page)).toContainText('No such customer.');
  await picker(page).getByTestId('pick-create').tap();
  await expect(create(page).locator('.m-title')).toHaveText('New customer');
  await expect(create(page).getByLabel('Customer name')).toHaveValue('Zenith Motors'); // what was typed
  await create(page).getByLabel('Phone').fill('9876543210');
  await page.getByTestId('create-save').tap();
  await expect(create(page)).toHaveCount(0);
  await expect(page.getByTestId('entry-party')).toContainText('Zenith Motors'); // made, and chosen

  await page.getByTestId('entry-add').tap();
  await picker(page).getByLabel('Search items').fill('Gasket Kit');
  await picker(page).getByTestId('pick-create').tap();
  await expect(create(page).getByLabel('Item name')).toHaveValue('Gasket Kit');
  await create(page).getByLabel('HSN or SAC code').fill('8484');
  await page.getByTestId('create-save').tap();
  // made, and it is a line open for its quantity and rate
  await expect(page.getByTestId('line-sheet')).toContainText('Gasket Kit');
  await page.getByTestId('line-rate').fill('120');
  await page.getByTestId('qty-more').tap();
  await page.getByTestId('line-done').tap();
  await expect(page.getByTestId('entry-total')).toHaveText('₹ 240.00');
  await page.getByTestId('entry-save').tap();
  await expect(title(page)).toHaveText(/^Quotation QT\//);
  await expect(page.getByTestId('doc-party')).toContainText('Zenith Motors');
  expect(problems).toEqual([]);
});

test('the phone’s Back leaves the new-record form for the document, not the list it replaced; a taken name is refused in the rules’ words', async ({ page }) => {
  const problems = watch(page);
  await page.getByTestId('gateway-new').tap();
  await page.getByTestId('new-sales').tap();
  await page.getByTestId('entry-add').tap();
  await picker(page).getByTestId('pick-create').tap(); // nothing typed: "+ New item"
  await expect(create(page).getByLabel('Item name')).toHaveValue('');
  await page.getByTestId('create-save').tap();
  await expect(page.getByTestId('create-refused')).toBeVisible(); // a name is needed
  await create(page).getByLabel('Item name').fill('Machine Oil');
  await page.getByTestId('create-save').tap();
  await expect(page.getByTestId('create-refused')).toContainText(/already|exists|in use/i);
  await page.goBack();
  await expect(create(page)).toHaveCount(0);
  await expect(picker(page)).toHaveCount(0);
  await expect(title(page)).toHaveText('New Sales Invoice');
  expect(problems).toEqual([]);
});

test('from the Stock and Parties lists: + New item / + New customer, and the new record’s page opens', async ({ page }) => {
  const problems = watch(page);
  await page.locator('.m-row').filter({ hasText: /^Stock/ }).tap();
  await page.getByTestId('list-new-item').tap();
  await create(page).getByLabel('Item name').fill('Packing Charges');
  await create(page).getByLabel('Type').selectOption('service');
  await page.getByTestId('create-save').tap();
  await expect(title(page)).toHaveText('Packing Charges');
  await page.goBack(); // to the list: the form is gone from the way back
  await expect(title(page)).toHaveText('Stock');
  await page.goBack();

  await page.locator('.m-row').filter({ hasText: /^Parties/ }).tap();
  await page.getByTestId('list-new-customer').tap();
  await create(page).getByLabel('Customer name').fill('Orbit Engineers');
  await page.getByTestId('create-save').tap();
  await expect(title(page)).toHaveText('Orbit Engineers');
  await expect(page.getByTestId('party-invoice')).toBeVisible(); // a customer: it can be invoiced from here
  expect(problems).toEqual([]);
});
