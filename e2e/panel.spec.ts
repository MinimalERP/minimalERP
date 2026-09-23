/**
 * THE ACTION PANEL, THE LEAVE QUESTION AND THE VOUCHER WORKSHEET, in a real browser:
 * the screen's own actions down the right edge on third-level screens (clickable, greyed when nothing would happen, never stealing focus),
 * "Close and leave?" when Esc is pressed with something entered, and a voucher window that reads as a compact sheet.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

const panel = (page: Page) => page.getByTestId('action-panel');
const action = (page: Page, command: string): Locator => panel(page).locator(`[data-command="${command}"]`);
const dialog = (page: Page) => page.getByTestId('leave-dialog');
const focused = (page: Page): Locator => page.locator('[data-vf]:focus');

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

test.describe('the action panel', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('is absent on the Gateway and the menus, present on a voucher, a report, a form and a list', async ({ app }) => {
    await expect(heading(app)).toHaveText('Gateway');
    await expect(panel(app)).toHaveCount(0);
    await app.keyboard.press('Enter'); // Masters (a menu)
    await expect(heading(app)).toHaveText('Masters');
    await expect(panel(app)).toHaveCount(0);
    await app.keyboard.press('Enter'); // Ledgers (a list)
    await expect(heading(app)).toHaveText('Ledgers');
    await expect(panel(app)).toBeVisible();
    await expect(panel(app)).toContainText('Create new');
    await app.keyboard.press('Alt+c'); // a form
    await expect(heading(app)).toHaveText('Create Ledger');
    await expect(panel(app)).toContainText('Accept');
    await app.keyboard.press('Escape'); // nothing entered: closes at once
    await app.keyboard.press('Escape');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
    await goTo(app, 'day book'); // a report
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Day Book');
    for (const label of ['Period', 'Sort', 'Filter', 'Clear filters', 'Voucher types']) await expect(panel(app)).toContainText(label);
  });

  test('is there when a voucher is opened straight from Go To (the stack is only two deep)', async ({ app }) => {
    await goTo(app, 'new receipt voucher');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('New Receipt Voucher');
    await expect(panel(app)).toBeVisible();
  });

  test('a click does what the key does: F5 Payment switches the type and keeps the draft', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('factory');
    await app.keyboard.press('Enter');
    await app.keyboard.type('700');
    await action(app, 'voucher.switch.payment').click();
    await expect(heading(app)).toHaveText('New Payment Voucher');
    await expect(app.locator('[data-vf="account"]')).toHaveValue('HDFC Bank Current A/c');
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('Factory Rent');
    await expect(app.locator('[data-vf="l0.amount"]')).toHaveValue('700');
  });

  test('a click on Date focuses the date; a click on Accept saves the voucher and closes the window back to where it was opened from', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('factory');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1200');
    await action(app, 'voucher.changeDate').click();
    await expect(focused(app)).toHaveAttribute('data-vf', 'date');
    await action(app, 'voucher.accept').click();
    await expect(heading(app)).toHaveText('Gateway'); // opened by F5 from the Gateway: saved, and back there
  });

  test('a click never steals focus from the field being edited', async ({ app }) => {
    await goTo(app, 'day book');
    await app.keyboard.press('Enter');
    await app.keyboard.type('wages');
    const quick = app.getByRole('textbox', { name: 'Quick filter' });
    await expect(quick).toBeFocused();
    await action(app, 'grid.sort').click();
    await expect(quick).toBeFocused(); // still typing in the same box, caret and all
    await expect(quick).toHaveValue('wages');
  });

  test('greys what would do nothing: Alter and Cancel voucher on a new voucher, Deactivate on a new record', async ({ app }) => {
    await app.keyboard.press('F5');
    await expect(action(app, 'master.alter')).toBeDisabled();
    await expect(action(app, 'voucher.cancel')).toBeDisabled();
    await expect(action(app, 'voucher.accept')).toBeEnabled();
    await expect(action(app, 'voucher.partyDetails')).toBeEnabled();
    await expect(action(app, 'voucher.removeLine')).toBeDisabled(); // only one line
  });

  test('on a posted voucher Alter and Cancel voucher are live, Accept and Date are not', async ({ app }) => {
    await goTo(app, 'day book');
    await app.keyboard.press('Enter');
    await app.keyboard.type('wages');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-vf="narration"]')).toHaveAttribute('readonly', '');
    await expect(action(app, 'master.alter')).toBeEnabled();
    await expect(action(app, 'voucher.cancel')).toBeEnabled();
    await expect(action(app, 'voucher.accept')).toBeDisabled();
    await expect(action(app, 'voucher.changeDate')).toBeDisabled();
    await action(app, 'master.alter').click();
    await expect(heading(app)).toContainText('Alter');
  });

  test('goes inert while Go To (or any question) is open', async ({ app }) => {
    await app.keyboard.press('F5');
    await expect(action(app, 'voucher.accept')).toBeEnabled();
    await app.keyboard.press('Alt+g');
    await expect(action(app, 'voucher.accept')).toBeDisabled();
    await expect(action(app, 'voucher.switch.receipt')).toBeDisabled();
    await app.keyboard.press('Escape');
    await expect(action(app, 'voucher.accept')).toBeEnabled();
  });

  test('shows the live key beside each action', async ({ app }) => {
    await app.keyboard.press('F5');
    await expect(action(app, 'voucher.switch.receipt')).toContainText('F6');
    await expect(action(app, 'voucher.accept')).toContainText('Ctrl');
    await expect(action(app, 'app.close')).toContainText('Esc'); // Close shows the key of "back"
  });
});

test.describe('“Close and leave?”', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  async function startPayment(page: Page): Promise<void> {
    await page.keyboard.press('F5');
    await page.keyboard.type('hdfc');
    await page.keyboard.press('Enter');
    await page.keyboard.type('factory');
  }

  /** Esc, one thing per press: the ledger's list, then back to the account — the third press reaches the window itself. */
  async function escToWindow(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  }

  test('a blank window closes with one Esc — no list is open until something is typed, and no question: nothing is entered', async ({ app }) => {
    await app.keyboard.press('F5');
    await expect(app.getByTestId('picker')).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Payment Voucher');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('Esc with something entered asks; focus is on No; Enter keeps you; Esc keeps you', async ({ app }) => {
    await startPayment(app);
    await escToWindow(app);
    await expect(dialog(app)).toBeVisible();
    await expect(dialog(app).locator('[data-choice="no"]')).toBeFocused();
    await app.keyboard.press('Enter'); // the focused choice: No
    await expect(dialog(app)).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Payment Voucher');
    await expect(app.locator('[data-vf="account"]')).toHaveValue('HDFC Bank Current A/c'); // nothing lost
    await expect(focused(app)).toHaveAttribute('data-vf', 'account'); // and the caret is back where it was

    await app.keyboard.press('Escape'); // the window again: asks
    await expect(dialog(app)).toBeVisible();
    await app.keyboard.press('Escape'); // Esc on the question = No
    await expect(dialog(app)).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Payment Voucher');
  });

  test('Yes is reached with → (or Tab) and Enter, or with Alt+Y', async ({ app }) => {
    await startPayment(app);
    await escToWindow(app);
    await app.keyboard.press('ArrowRight');
    await expect(dialog(app).locator('[data-choice="yes"]')).toBeFocused();
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Gateway');

    await startPayment(app);
    await escToWindow(app);
    await app.keyboard.press('Alt+n');
    await expect(dialog(app)).toHaveCount(0);
    await app.keyboard.press('Escape');
    await app.keyboard.press('Alt+y');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('the Close button in the panel asks the same question at once (it does not walk back through popups), and can be answered with the mouse', async ({ app }) => {
    await startPayment(app); // a list is open and a field is half typed
    await action(app, 'app.close').click();
    await expect(dialog(app)).toBeVisible();
    await dialog(app).locator('[data-choice="no"]').click();
    await expect(dialog(app)).toHaveCount(0);
    await action(app, 'app.close').click();
    await dialog(app).locator('[data-choice="yes"]').click();
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('an unchanged master form closes at once (a changed one asks — see masters.spec)', async ({ app }) => {
    await goTo(app, 'l:factory rent');
    await app.keyboard.press('ArrowRight');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Alter Ledger: Factory Rent');
    await app.keyboard.press('Escape'); // untouched
    await expect(heading(app)).not.toContainText('Alter Ledger');
  });
});

test.describe('the voucher window is a compact worksheet', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  for (const [key, name] of [['F4', 'Contra'], ['F5', 'Payment'], ['F6', 'Receipt'], ['F7', 'Journal']] as const) {
    test(`${name}: the first line is on screen at once, the narration sits at the foot below the grid, and there are no buttons in the window`, async ({ app }) => {
      await app.keyboard.press(key);
      await expect(heading(app)).toHaveText(`New ${name} Voucher`);
      const size = app.viewportSize() ?? { width: 1280, height: 720 };
      const first = await app.locator('[data-vf="l0.ledger"]').boundingBox();
      const narration = await app.locator('[data-vf="narration"]').boundingBox();
      const grid = await app.getByRole('group', { name: 'Entries' }).boundingBox();
      expect(first?.y ?? 999).toBeLessThan(260); // right under a thin title and one header row
      expect((narration?.y ?? 0) + (narration?.height ?? 0)).toBeLessThanOrEqual(size.height); // nothing to scroll for
      expect(narration?.y ?? 0).toBeGreaterThanOrEqual((grid?.y ?? 0) + (grid?.height ?? 0) - 1); // below the grid
      await expect(app.getByTestId('voucher-form').getByRole('button')).toHaveCount(2); // Accept and Close live in the panel — the only buttons in the window are the × in its title bar (the mouse's way to close) and the × that clears the line (one line here)
    });
  }

  test('the header is one row: the type tag and number, the weekday and the date', async ({ app }) => {
    await app.keyboard.press('F5');
    const tag = await app.getByTestId('voucher-type-tag').boundingBox();
    const day = await app.getByTestId('voucher-weekday').boundingBox();
    const date = await app.locator('[data-vf="date"]').boundingBox();
    expect(Math.abs((tag?.y ?? 0) - (date?.y ?? 99))).toBeLessThan(12);
    expect(Math.abs((day?.y ?? 0) - (date?.y ?? 99))).toBeLessThan(12);
    expect(tag?.height ?? 99).toBeLessThan(36);
  });

  test('the bill-wise block is a flat set of rows under its line, not a box', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1000');
    await app.keyboard.press('Enter');
    const bills = app.getByTestId('bill-panel');
    await expect(bills).toBeVisible();
    expect(await bills.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid');
    expect(await bills.evaluate((el) => getComputedStyle(el).borderLeftStyle)).not.toBe('dashed');
  });
});

test.describe('Stock Journal on every side panel', () => {
  test('from a report its button opens a new Stock Journal; from a half-entered voucher it opens on top, and Esc comes back to it', async ({ app }) => {
    await loadDemo(app);
    await goTo(app, 'day book');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Day Book');
    await panel(app).locator('[data-command="voucher.new.stockJournal"]').click();
    await expect(heading(app)).toHaveText('New Stock Journal Voucher');

    await goTo(app, 'gateway');
    await app.keyboard.press('Enter');
    await app.keyboard.press('F8');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await app.keyboard.type('sharma');
    await app.keyboard.press('Enter');
    await panel(app).locator('[data-command="voucher.new.stockJournal"]').click();
    await expect(heading(app)).toHaveText('New Stock Journal Voucher');
    await app.keyboard.press('Escape'); // nothing entered in the stock journal: it closes
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await expect(app.locator('[data-vf="party"]')).toHaveValue('Sharma Traders'); // the invoice underneath, as it was left
  });
});
