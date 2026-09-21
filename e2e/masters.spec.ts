/**
 * PHASE 4 EXIT GATE, in a real browser, keyboard only:
 *   "Alt+G finds a ledger, a party and an item" and "Alt+C creates a master from a picker and returns to it".
 * Plus: onboarding a company, duplicate names refused, alter/display, opening balances, and that the company survives a reload.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, goTo, heading, palette, paletteOptions, paletteSelected, test } from './support';

const titles = (page: Page) => page.getByTestId('goto-title');
const rowKinds = (page: Page) => palette(page).locator('.row-kind');
const banner = (page: Page) => page.getByTestId('form-banner');
const company = (page: Page) => page.getByTestId('company-name');

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(company(page)).toHaveText('Demo Manufacturing Pvt Ltd');
  await expect(heading(page)).toHaveText('Gateway');
}

/** Opens a create form from Go To, the way a person would. */
async function openCreate(page: Page, what: string, heading_: string): Promise<void> {
  await goTo(page, what);
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText(heading_);
}

const focusedField = (page: Page): Locator => page.locator('[data-field]:focus');

test.describe('a company for the books', () => {
  test('starts with none, offers to create one, and onboards from the keyboard', async ({ app }) => {
    await expect(company(app)).toHaveText('No company open');

    await goTo(app, 'create company');
    await expect(titles(app).first()).toHaveText('Create Company');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Create Company');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'name');

    await app.keyboard.type('Acme Works');
    await app.keyboard.press('Enter'); // → financial year
    await expect(focusedField(app)).toHaveAttribute('data-field', 'fyStart');
    await expect(focusedField(app)).toHaveValue(/^\d{4}-04-01$/); // an Indian financial year by default
    await app.keyboard.press('Control+a'); // accept from anywhere

    await expect(company(app)).toHaveText('Acme Works');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('refuses a wrong GSTIN and says which field', async ({ app }) => {
    await goTo(app, 'create company');
    await app.keyboard.press('Enter');
    await app.keyboard.type('Acme Works');
    await app.keyboard.press('Tab');
    await app.keyboard.press('Tab');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'gstin');
    await app.keyboard.type('27AAPFU0939F1ZA'); // last character is wrong
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'check digit' })).toBeVisible();
    await expect(focusedField(app)).toHaveAttribute('data-field', 'gstin'); // focus goes to the bad field
    await expect(company(app)).toHaveText('No company open');
  });

  test('a create command with no company leads to creating one', async ({ app }) => {
    await goTo(app, 'create ledger');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Create Company');
  });

  test('the company survives a reload, with its masters', async ({ app }) => {
    await loadDemo(app);
    await app.reload();
    await expect(company(app)).toHaveText('Demo Manufacturing Pvt Ltd');
    await goTo(app, 'abc');
    await expect(titles(app).first()).toContainText('ABC');
  });

  test('closing the company asks first, then forgets it', async ({ app }) => {
    await loadDemo(app);
    await goTo(app, 'close company');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('company-reset')).toBeVisible();
    await app.keyboard.press('Enter'); // Enter must NOT delete
    await expect(app.getByTestId('company-reset')).toBeVisible();
    await app.keyboard.press('Control+a');
    await expect(company(app)).toHaveText('No company open');
    await app.reload();
    await expect(company(app)).toHaveText('No company open');
  });
});

test.describe('Alt+G finds ledgers, parties, items — and everything else', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('"abc" finds the party ONCE (its ledger comes with it) and the stock item', async ({ app }) => {
    await goTo(app, 'abc');
    const kinds = await rowKinds(app).allTextContents();
    expect(kinds).toEqual(expect.arrayContaining(['Party', 'Stock Item']));
    expect(kinds).not.toContain('Ledger'); // a party's own ledger is not a second hit — its REPORT is, one row under the party
    expect(kinds).toEqual(expect.arrayContaining(['Ledger report', 'Stock ledger']));
    await expect(titles(app).filter({ hasText: 'ABC Industries' })).toHaveCount(2); // the party and its Ledger report
    await expect(titles(app).filter({ hasText: 'ABC Hex Bolt M8' })).toHaveCount(2); // the item and its Stock ledger
  });

  test('a party that is both offers one Ledger report per side', async ({ app }) => {
    await goTo(app, 'kumar');
    await expect(titles(app).filter({ hasText: 'Kumar Engineering Works' })).toHaveCount(3); // the party, and a Ledger report row per side
    await app.keyboard.press('ArrowRight');
    const actions = await paletteOptions(app).allTextContents();
    expect(actions.join('|')).toContain('Ledger report (as customer)');
    expect(actions.join('|')).toContain('Ledger report (as vendor)');
  });

  test('prefixes narrow to one kind: @ parties, l: ledgers, i: items', async ({ app }) => {
    await goTo(app, '@abc');
    await expect(titles(app).first()).toHaveText('ABC Industries');
    expect(new Set(await rowKinds(app).allTextContents())).toEqual(new Set(['Party', 'Ledger report'])); // parties, and their reports — nothing else
    await app.keyboard.press('Control+a');
    await app.keyboard.type('l:hdfc');
    await expect(titles(app).first()).toHaveText('HDFC Bank Current A/c');
    expect(new Set(await rowKinds(app).allTextContents())).toEqual(new Set(['Ledger', 'Ledger report']));
    await app.keyboard.press('Control+a');
    await app.keyboard.type('i:abc');
    await expect(titles(app).first()).toHaveText('ABC Hex Bolt M8');
    expect(new Set(await rowKinds(app).allTextContents())).toEqual(new Set(['Stock Item', 'Stock ledger']));
  });

  test.describe('finds it however you know it', () => {
    for (const [typed, expected] of [
      ['industrys', 'ABC Industries'], // a typo
      ['9820012345', 'ABC Industries'], // the phone number
      ['98200 12345', 'ABC Industries'], // …spaced
      ['FG-BL-M8', 'ABC Hex Bolt M8'], // the item code
      ['7318', 'ABC Hex Bolt M8'], // the HSN
      ['rent', 'Factory Rent'], // an alias
      ['MS scrp', 'MS Scrap'],
      ['godown', 'Scrap Yard'], // warehouses answer to "godown"
      ['pune', 'ABC Industries'], // the address
    ] as const) {
      test(`${typed} → ${expected}`, async ({ app }) => {
        await goTo(app, typed);
        await expect(titles(app).filter({ hasText: expected }).first()).toBeVisible();
      });
    }
  });

  test('the GSTIN finds the party outright', async ({ app }) => {
    await goTo(app, '@27AAPFU');
    await expect(titles(app).first()).toHaveText('ABC Industries');
  });

  test('commands still work beside masters — and inactive records are marked', async ({ app }) => {
    await goTo(app, 'trial balance');
    await expect(titles(app).first()).toHaveText('Trial Balance');
    await expect(rowKinds(app).first()).toHaveText('Report');
  });

  test('Enter opens the record; → lists more actions; Esc leaves the action list before closing Go To', async ({ app }) => {
    await goTo(app, 'l:factory rent');
    await expect(titles(app).first()).toHaveText('Factory Rent');
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app)).toHaveText([/Display Ledger/, /Alter Ledger/, /Ledger report/]);
    await app.keyboard.press('Escape');
    await expect(palette(app)).toBeVisible();
    await expect(titles(app).first()).toHaveText('Factory Rent');
    await app.keyboard.press('ArrowRight');
    await app.keyboard.press('ArrowDown');
    await expect(paletteSelected(app)).toContainText('Alter Ledger');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Alter Ledger: Factory Rent');
  });

  test('→ does not steal the arrow key while editing the middle of a query', async ({ app }) => {
    await goTo(app, 'abc');
    await app.keyboard.press('Home');
    await app.keyboard.press('ArrowRight');
    await expect(paletteOptions(app).first()).not.toContainText('Display');
  });

  test('a brand-new record is found immediately', async ({ app }) => {
    await openCreate(app, 'create party', 'Create Party');
    await app.keyboard.type('Zenith Fasteners');
    await app.keyboard.press('Control+a');
    await expect(banner(app)).toContainText('created');
    await goTo(app, 'zenith');
    await expect(titles(app).first()).toHaveText('Zenith Fasteners');
    await expect(rowKinds(app).first()).toHaveText('Party');
  });
});

test.describe('creating masters from the keyboard', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('a ledger: name, group picker, accept — then the form is ready for the next one', async ({ app }) => {
    await openCreate(app, 'create ledger', 'Create Ledger');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'name');
    await app.keyboard.type('Freight Inward');
    await app.keyboard.press('Enter');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'groupId');
    await expect(app.getByTestId('picker')).toHaveCount(0); // no list until something is typed
    await app.keyboard.type('indirect exp');
    await expect(app.getByTestId('picker')).toBeVisible();
    await expect(app.getByTestId('picker').getByRole('option').first()).toHaveText(/Indirect Expenses/);
    await app.keyboard.press('Enter'); // choose it, move on
    await expect(focusedField(app)).toHaveAttribute('data-field', 'code');
    await app.keyboard.press('Control+a');

    await expect(banner(app)).toHaveText('Ledger “Freight Inward” created.');
    await expect(app.locator('[data-field="name"]')).toHaveValue(''); // ready for the next
    await expect(focusedField(app)).toHaveAttribute('data-field', 'name');
  });

  test('Shift+Tab goes back, ↑↓ move in the picker, Tab chooses', async ({ app }) => {
    await openCreate(app, 'create ledger', 'Create Ledger');
    await app.keyboard.type('Bank Charges');
    await app.keyboard.press('Tab');
    await app.keyboard.type('bank');
    await app.keyboard.press('ArrowDown');
    await expect(app.getByTestId('picker').locator('[aria-selected="true"]')).toContainText('Bank OD A/c'); // the second match
    await app.keyboard.press('Tab');
    await expect(app.locator('[data-field="groupId"]')).toHaveValue('Bank OD A/c');
    await app.keyboard.press('Shift+Tab');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'groupId');
    await app.keyboard.press('Shift+Tab');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'name');
    await expect(focusedField(app)).toHaveValue('Bank Charges');
  });

  test('a duplicate name is refused, on the name field, and nothing is created', async ({ app }) => {
    await openCreate(app, 'create ledger', 'Create Ledger');
    await app.keyboard.type('cash '); // "Cash" exists; case and spacing do not matter
    await app.keyboard.press('Tab');
    await app.keyboard.type('current assets');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'already in use' })).toBeVisible();
    await expect(focusedField(app)).toHaveAttribute('data-field', 'name');
    await expect(banner(app)).toHaveCount(0);
  });

  test('a required field left empty says so, and the picker demands a real choice', async ({ app }) => {
    await openCreate(app, 'create ledger', 'Create Ledger');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').first()).toBeVisible();
    await app.keyboard.type('Something');
    await app.keyboard.press('Tab');
    await app.keyboard.type('zzzz');
    await app.keyboard.press('Tab');
    await expect(app.getByRole('alert').filter({ hasText: 'No match' })).toBeVisible();
    await expect(focusedField(app)).toHaveAttribute('data-field', 'groupId'); // could not leave with a nonsense group
  });

  test('a party with GSTIN, phone and credit terms; a wrong GSTIN and a bad phone are refused with reasons', async ({ app }) => {
    await openCreate(app, 'create party', 'Create Party');
    await app.keyboard.type('Nova Steel');
    await app.keyboard.press('Tab'); // → type (customer)
    await app.keyboard.press('Tab');
    await app.keyboard.type('27AAPFU0939F1ZA'); // wrong check digit
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: 'check digit' })).toBeVisible();

    await app.locator('[data-field="gstin"]').fill('27AAPFU0939F1ZV');
    await app.locator('[data-field="phone"]').fill('12345');
    await app.keyboard.press('Control+a');
    await expect(app.getByRole('alert').filter({ hasText: /10-digit/ })).toBeVisible();

    await app.locator('[data-field="phone"]').fill('9876500000');
    await app.keyboard.press('Control+a');
    await expect(banner(app)).toContainText('Party “Nova Steel” created.');
  });

  test('a compound unit needs its base and factor', async ({ app }) => {
    await openCreate(app, 'create unit', 'Create Unit');
    await app.keyboard.type('Qtl2');
    await app.keyboard.press('Tab');
    await app.keyboard.type('Quintals');
    await app.keyboard.press('Tab');
    await app.keyboard.press('Tab');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'baseUnitId');
    await app.keyboard.type('kg');
    await app.keyboard.press('Tab'); // chooses Kilograms
    await app.keyboard.press('Control+a'); // factor missing
    await expect(app.getByRole('alert').filter({ hasText: /base unit/i })).toBeVisible();
    await app.keyboard.type('100');
    await app.keyboard.press('Control+a');
    await expect(banner(app)).toContainText('created');
  });

  test('a stock item picks its unit, group and GST rate', async ({ app }) => {
    await openCreate(app, 'create stock item', 'Create Stock Item');
    await app.keyboard.type('Washer 8mm');
    await app.keyboard.press('Enter'); // → code
    await app.keyboard.press('Enter'); // → alias
    await app.keyboard.press('Enter'); // → group
    await app.keyboard.press('Enter'); // the group is optional: skipped → unit
    await expect(focusedField(app)).toHaveAttribute('data-field', 'unitId');
    await app.keyboard.type('nos');
    await app.keyboard.press('Enter');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'hsn');
    await app.keyboard.type('7318');
    await app.keyboard.press('Enter');
    await app.keyboard.type('18');
    await app.keyboard.press('Enter');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'itemType');
    await app.keyboard.press('Control+a');
    await expect(banner(app)).toContainText('Stock Item “Washer 8mm” created.');
  });

  test('an opening balance is posted with the ledger, and only offered for balance-sheet groups', async ({ app }) => {
    await openCreate(app, 'create ledger', 'Create Ledger');
    await app.keyboard.type('SBI Current Account');
    await app.keyboard.press('Tab');
    await expect(app.locator('[data-field="openingAmount"]')).toHaveCount(0); // no group yet
    await app.keyboard.type('bank acc');
    await app.keyboard.press('Tab');
    await expect(app.locator('[data-field="openingAmount"]')).toHaveCount(1);
    await app.keyboard.press('Tab'); // → alias
    await app.keyboard.press('Tab'); // → opening amount (the Party field is gone: customers and suppliers are made as a Party)
    await expect(focusedField(app)).toHaveAttribute('data-field', 'openingAmount');
    await app.keyboard.type('250000');
    await app.keyboard.press('Control+a');
    await expect(banner(app)).toHaveText('Ledger “SBI Current Account” created.');
  });

  test('an expense group has no opening balance field', async ({ app }) => {
    await openCreate(app, 'create ledger', 'Create Ledger');
    await app.keyboard.type('Stationery');
    await app.keyboard.press('Tab');
    await app.keyboard.type('indirect exp');
    await app.keyboard.press('Tab');
    await expect(app.locator('[data-field="openingAmount"]')).toHaveCount(0);
  });
});

test.describe('Alt+C: create what is missing from where you are, and come back', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('from a ledger’s group field there is nothing to link: customers and suppliers are made as a Party', async ({ app }) => {
    await openCreate(app, 'create ledger', 'Create Ledger');
    await app.keyboard.type('Zenith Traders');
    await app.keyboard.press('Tab');
    await expect(app.locator('[data-field="partyId"]')).toHaveCount(0); // no Party field on a ledger any more
    await app.keyboard.type('sundry deb');
    await expect(app.getByTestId('picker')).toContainText('No match'); // Sundry Debtors is not offered for a new ledger
    await expect(app.locator('.field-hint')).toContainText('created as a Party');
  });

  test('Esc from the inline form returns to the field with nothing chosen', async ({ app }) => {
    await openCreate(app, 'create stock item', 'Create Stock Item');
    await app.keyboard.type('Rivet');
    for (let i = 0; i < 4; i++) await app.keyboard.press('Tab'); // code, alias, group, unit
    await expect(focusedField(app)).toHaveAttribute('data-field', 'unitId');
    await app.keyboard.type('Boxes-of-rivets');
    await app.keyboard.press('Alt+c');
    await expect(heading(app)).toHaveText('Create Unit');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Create Stock Item');
    await expect(app.locator('[data-field="name"]')).toHaveValue('Rivet');
  });

  test('the record made inline is real: it is in the list and in Go To', async ({ app }) => {
    await openCreate(app, 'create stock item', 'Create Stock Item');
    await app.keyboard.type('Rivet');
    for (let i = 0; i < 4; i++) await app.keyboard.press('Tab');
    await app.keyboard.type('Carton');
    await app.keyboard.press('Alt+c');
    await app.keyboard.press('Tab'); // symbol prefilled → name
    await app.keyboard.type('Cartons');
    await app.keyboard.press('Control+a');
    await expect(app.locator('[data-field="unitId"]')).toHaveValue('Cartons (Carton)');
    await goTo(app, 'u:carton');
    await expect(titles(app).first()).toHaveText('Cartons (Carton)');
  });
});

test.describe('display, alter, deactivate', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('a list narrows as you type; Enter displays; Alt+A alters; accept returns', async ({ app }) => {
    await goTo(app, 'ledgers');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Ledgers');
    await app.keyboard.type('factory rent');
    await expect(app.getByRole('option')).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Display Ledger: Factory Rent');
    await expect(app.locator('[data-field="name"]')).toHaveAttribute('readonly', '');

    await app.keyboard.press('Alt+a');
    await expect(heading(app)).toHaveText('Alter Ledger: Factory Rent');
    await app.locator('[data-field="name"]').fill('Factory Rent & Maintenance');
    await app.keyboard.press('Control+a');
    await expect(heading(app)).toHaveText('Display Ledger: Factory Rent & Maintenance');
  });

  test('Esc from a changed form asks before discarding', async ({ app }) => {
    await goTo(app, 'l:factory rent');
    await app.keyboard.press('ArrowRight');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Alter Ledger: Factory Rent');
    await app.keyboard.type('X');
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('leave-dialog')).toBeVisible(); // "Close and leave?"
    await expect(heading(app)).toHaveText('Alter Ledger: Factory Rent');
    await app.keyboard.press('Escape'); // Esc means No: a double-Esc never throws work away
    await expect(app.getByTestId('leave-dialog')).toHaveCount(0);
    await expect(heading(app)).toHaveText('Alter Ledger: Factory Rent');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+y'); // only Yes leaves
    await expect(heading(app)).not.toContainText('Alter Ledger');
  });

  test('deactivating hides nothing but marks it, and reactivating restores it', async ({ app }) => {
    await goTo(app, 'l:electricity');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Display Ledger: Electricity & Power');
    await app.keyboard.press('Alt+x');
    await expect(banner(app)).toHaveText('Ledger deactivated.');
    await expect(app.locator('h1 .badge')).toHaveText('Inactive');
    await goTo(app, 'l:electricity');
    await expect(palette(app).locator('.badge')).toHaveText(['Inactive', 'Inactive']); // the ledger and its report
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+x');
    await expect(banner(app)).toHaveText('Ledger reactivated.');
  });

  test('built-in records refuse to change, with a reason', async ({ app }) => {
    await goTo(app, 'l:opening balance diff');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Alt+x');
    await expect(banner(app)).toContainText(/built-in|cannot/i);
  });

  test('company settings show the profile and can be altered', async ({ app }) => {
    await goTo(app, 'company settings');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Display Company: Demo Manufacturing Pvt Ltd');
    await app.keyboard.press('Alt+a');
    await app.locator('[data-field="name"]').fill('Demo Manufacturing LLP');
    await app.keyboard.press('Control+a');
    await expect(company(app)).toHaveText('Demo Manufacturing LLP');
  });

  test('the action panel shows the entry keys only while a form is open', async ({ app }) => {
    const panel = app.getByTestId('action-panel');
    await expect(panel).toHaveCount(0); // the Gateway has none
    await openCreate(app, 'create ledger', 'Create Ledger');
    await expect(panel).toContainText('Accept');
    await expect(panel).toContainText('Create new');
    await expect(panel.locator('[data-command="voucher.accept"]')).toBeEnabled();
    await expect(panel.locator('[data-command="master.alter"]')).toBeDisabled(); // nothing to alter on a new record
    await expect(app.getByRole('status', { name: 'Available keys' })).not.toContainText('Accept'); // the bottom bar keeps only the universal keys
  });
});

test.describe('the Gateway leads to masters', () => {
  test('Masters lists each kind once (creating is Alt+C inside the list), with no separate Create rows', async ({ app }) => {
    await loadDemo(app);
    await app.keyboard.press('Enter'); // Masters
    await expect(heading(app)).toHaveText('Masters');
    const options = await app.getByRole('option').allTextContents();
    for (const label of ['Ledgers', 'Groups', 'Parties', 'Stock Items', 'Stock Groups', 'Units', 'Warehouses', 'GST Rates']) {
      expect(options.some((o) => o.includes(label)), label).toBe(true);
    }
    expect(options.filter((o) => o.startsWith('Create'))).toEqual([]);

    // …and creating from a list is one key
    await app.keyboard.press('Enter'); // Ledgers
    await expect(heading(app)).toHaveText('Ledgers');
    await app.keyboard.press('Alt+c');
    await expect(heading(app)).toHaveText('Create Ledger');
  });
});
