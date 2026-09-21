/**
 * ESC CLOSES ONE THING PER PRESS, innermost first:
 *   an open popup list → an open dialog → the bill-wise block → the field being edited (back to the previous field) → the window itself
 *   (which asks "Close and leave?" when something is entered).
 * One Esc is never seen by both a child and the screen's leave guard.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

const picker = (page: Page) => page.getByTestId('picker');
const leaveDialog = (page: Page) => page.getByTestId('leave-dialog');
const focusedVf = (page: Page): Locator => page.locator('[data-vf]:focus');
const focusedField = (page: Page): Locator => page.locator('[data-field]:focus');

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

test.describe('in a voucher', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('popup list → previous field → the window: one thing per Esc, and the question only at the end', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter'); // the account is chosen; now in the first particular
    await app.keyboard.type('fact');
    await expect(picker(app)).toBeVisible();

    await app.keyboard.press('Escape'); // 1: the list — and ONLY the list
    await expect(picker(app)).toHaveCount(0);
    await expect(leaveDialog(app)).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Payment Voucher');
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'l0.ledger');
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('fact'); // what was typed is still there

    await app.keyboard.press('Escape'); // 2: the field: back to the previous one, dropping what was typed but never chosen
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'account');
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('');
    await expect(picker(app)).toHaveCount(0); // arriving by Esc does not pop a list open
    await expect(leaveDialog(app)).toHaveCount(0);

    await app.keyboard.press('Escape'); // 3: nothing left inside the window: it asks (the account is set)
    await expect(leaveDialog(app)).toBeVisible();
    await app.keyboard.press('Escape'); // 4: the question's own Esc = stay
    await expect(leaveDialog(app)).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Payment Voucher');
  });

  test('typing, or ↓, opens the list again after it was closed', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('fact');
    await app.keyboard.press('Escape');
    await expect(picker(app)).toHaveCount(0);
    await app.keyboard.press('ArrowDown'); // ↓ on a closed list shows it again (it does not jump to the next field)
    await expect(picker(app)).toBeVisible();
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'l0.ledger');
    await app.keyboard.press('Escape');
    await expect(picker(app)).toHaveCount(0);
    await app.keyboard.type('o');
    await expect(picker(app)).toBeVisible();
    await expect(app.locator('[data-vf="l0.ledger"]')).toHaveValue('facto');
  });

  test('a dialog takes its own Esc: the voucher beneath and its list are untouched', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('factory');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1200');
    await app.keyboard.press('Alt+p');
    await expect(app.getByTestId('party-details')).toBeVisible();
    await app.keyboard.press('Escape'); // closes Party Details, nothing else
    await expect(app.getByTestId('party-details')).toHaveCount(0);
    await expect(leaveDialog(app)).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Payment Voucher');
    await expect(app.locator('[data-vf="l0.amount"]')).toHaveValue('1200');
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'l0.amount');
  });

  test('the “Create what?” question takes its Esc; the list under it is still there, and closes with the next one', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('Zzz Nobody');
    await expect(picker(app)).toContainText('No match');
    await app.keyboard.press('Alt+c');
    await expect(app.getByTestId('report-dialog')).toContainText('Create what?');
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('report-dialog')).toHaveCount(0);
    await expect(picker(app)).toContainText('No match'); // the list was not closed by the dialog's Esc
    await expect(leaveDialog(app)).toHaveCount(0);
    await app.keyboard.press('Escape'); // now the list
    await expect(picker(app)).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Payment Voucher');
  });

  test('the bill-wise block closes before anything else, and the voucher stays', async ({ app }) => {
    await app.keyboard.press('F6');
    await app.keyboard.type('hdfc');
    await app.keyboard.press('Enter');
    await app.keyboard.type('abc ind');
    await app.keyboard.press('Enter');
    await app.keyboard.type('1000');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('bill-panel')).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('bill-panel')).toHaveCount(0);
    await expect(leaveDialog(app)).toHaveCount(0);
    await expect(heading(app)).toHaveText('New Receipt Voucher');
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'l0.amount');
  });

  test('from the date (F2) Esc goes back to the first entry field, not out of the window', async ({ app }) => {
    await app.keyboard.press('F5');
    await app.keyboard.press('F2');
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'date');
    await app.keyboard.press('Escape');
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'account');
    await expect(heading(app)).toHaveText('New Payment Voucher');
  });

  test('a journal steps back too: amount → ledger → side, then the window', async ({ app }) => {
    await app.keyboard.press('F7');
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'l0.side');
    await app.keyboard.press('Enter'); // → ledger
    await app.keyboard.type('factory');
    await app.keyboard.press('Enter'); // → amount
    await app.keyboard.type('500');
    await app.keyboard.press('Escape'); // amount → ledger (no list is open on an amount)
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'l0.ledger');
    await app.keyboard.press('Escape'); // the ledger's list: its field was reached by Esc, so it is closed already → back to the side
    await expect(focusedVf(app)).toHaveAttribute('data-vf', 'l0.side');
    await app.keyboard.press('Escape'); // first field: the window asks (something is entered)
    await expect(leaveDialog(app)).toBeVisible();
  });
});

test.describe('in a master form', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
  });

  test('popup list → previous field → the window: one thing per Esc', async ({ app }) => {
    await goTo(app, 'create ledger');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Create Ledger');
    await app.keyboard.type('Zed Co');
    await app.keyboard.press('Tab');
    await app.keyboard.type('indirect');
    await expect(picker(app)).toBeVisible();

    await app.keyboard.press('Escape'); // the list only
    await expect(picker(app)).toHaveCount(0);
    await expect(leaveDialog(app)).toHaveCount(0);
    await expect(heading(app)).toHaveText('Create Ledger');
    await expect(focusedField(app)).toHaveAttribute('data-field', 'groupId');

    await app.keyboard.press('Escape'); // the field: back to the name, dropping the unchosen text
    await expect(focusedField(app)).toHaveAttribute('data-field', 'name');
    await expect(app.locator('[data-field="groupId"]')).toHaveValue('');
    await expect(leaveDialog(app)).toHaveCount(0);

    await app.keyboard.press('Escape'); // first field, something entered: asks
    await expect(leaveDialog(app)).toBeVisible();
    await app.keyboard.press('Alt+y');
    await expect(heading(app)).not.toHaveText('Create Ledger');
  });

  test('typing reopens a closed list; a blank form leaves from its first field', async ({ app }) => {
    await goTo(app, 'create ledger');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Tab');
    await app.keyboard.type('ind');
    await app.keyboard.press('Escape');
    await expect(picker(app)).toHaveCount(0);
    await app.keyboard.type('i');
    await expect(picker(app)).toBeVisible();
    await app.keyboard.press('Escape'); // the list
    await app.keyboard.press('Escape'); // back to the name (the unchosen group text is dropped)
    await expect(focusedField(app)).toHaveAttribute('data-field', 'name');
    await app.keyboard.press('Escape'); // nothing entered: closes at once
    await expect(heading(app)).not.toHaveText('Create Ledger');
  });
});
