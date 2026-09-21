/**
 * PHASE 3 EXIT GATE, in a real browser, keyboard only:
 *   "Alt+G → open a screen → Esc back" and "a keymap override works".
 * Plus the properties that make the keyboard layer trustworthy: the right keys are consumed (so F5
 * does not reload), typing is never hijacked, the palette is truly modal, and it all survives a reload.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, moveTo, palette, paletteOptions, paletteSelected, selectedRow, test } from './support';

const statusbar = (page: Page) => page.getByRole('status', { name: 'Available keys' });
const resultTitles = (page: Page) => page.getByTestId('goto-title');

test.describe('the Gateway', () => {
  test('opens on the main menu with the first row under the cursor', async ({ app }) => {
    await expect(heading(app)).toHaveText('Gateway');
    await expect(app.getByRole('option')).toHaveText([/Masters/, /Transactions/, /Reports/, /Utilities & Settings/]);
    await expect(selectedRow(app)).toContainText('Masters');
    expect(new URL(app.url()).hash).toBe('#/gateway');
  });

  test('arrows move, Enter opens, Esc returns to the SAME row', async ({ app }) => {
    await app.keyboard.press('ArrowDown');
    await expect(selectedRow(app)).toContainText('Transactions');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Transactions');
    expect(new URL(app.url()).hash).toBe('#/menu/transactions');

    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
    await expect(selectedRow(app)).toContainText('Transactions'); // exactly where we left it
  });

  test('the cursor wraps, and Home/End/PageDown jump', async ({ app }) => {
    await app.keyboard.press('ArrowUp');
    await expect(selectedRow(app)).toContainText('Utilities & Settings'); // wrapped from the top
    await app.keyboard.press('ArrowDown');
    await expect(selectedRow(app)).toContainText('Masters');
    await app.keyboard.press('End');
    await expect(selectedRow(app)).toContainText('Utilities & Settings');
    await app.keyboard.press('Home');
    await expect(selectedRow(app)).toContainText('Masters');
  });

  test('Tab and Shift+Tab move through the list as well', async ({ app }) => {
    await app.keyboard.press('Tab');
    await expect(selectedRow(app)).toContainText('Transactions');
    await app.keyboard.press('Shift+Tab');
    await expect(selectedRow(app)).toContainText('Masters');
  });

  test('Esc on the Gateway does nothing — and is not swallowed', async ({ app, keys }) => {
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
    const last = (await keys()).at(-1);
    expect(last).toMatchObject({ key: 'Escape', defaultPrevented: false });
  });

  test('menu rows show their shortcuts and what phase delivers them', async ({ app }) => {
    await app.keyboard.press('ArrowDown'); // Transactions
    await app.keyboard.press('Enter');
    // Transactions is grouped now; each real row is a LIST (with the key of the voucher it creates), the planned ones still say when they arrive
    const sales = app.getByRole('option', { name: /Sales Vouchers/ });
    await expect(sales).toContainText('F8');
    await expect(sales).not.toContainText('Phase'); // Sales is real now (Phase 6b)
    await expect(app.getByRole('option', { name: /Purchase Vouchers/ })).toContainText('F9'); // Purchase is real now (Phase 8)
    await expect(app.getByRole('option', { name: /New Debit Note/ })).toContainText('Phase 7'); // the debit note is still planned
    await expect(app.getByRole('option', { name: /Payment Vouchers/ })).toContainText('F5');
  });
});

test.describe('Go To (Alt+G)', () => {
  test('Alt+G → type → Enter → the screen → Esc → back', async ({ app }) => {
    await goTo(app, 'debit note'); // (GST reports are real now: the credit and debit notes are what is still planned)
    await expect(resultTitles(app).first()).toHaveText('New Debit Note');
    await expect(palette(app)).toContainText('Phase 7');

    await app.keyboard.press('Enter');
    await expect(palette(app)).toBeHidden();
    await expect(heading(app)).toHaveText('New Debit Note');
    await expect(app.getByTestId('planned-screen')).toContainText('Phase 7');
    expect(new URL(app.url()).hash).toBe('#/planned/voucher.new.debitNote');

    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
    expect(new URL(app.url()).hash).toBe('#/gateway');
  });

  test('Esc closes the palette without going anywhere', async ({ app }) => {
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter'); // into Transactions
    await goTo(app, 'trial');
    await app.keyboard.press('Escape');
    await expect(palette(app)).toBeHidden();
    await expect(heading(app)).toHaveText('Transactions'); // Esc closed the palette only
  });

  test('Alt+G again closes it (it toggles)', async ({ app }) => {
    await app.keyboard.press('Alt+g');
    await expect(palette(app)).toBeVisible();
    await app.keyboard.press('Alt+g');
    await expect(palette(app)).toBeHidden();
  });

  test('the input has focus immediately, so typing just works', async ({ app }) => {
    await app.keyboard.press('Alt+g');
    await expect(app.getByRole('combobox', { name: 'Go To' })).toBeFocused();
  });

  test.describe('finds things the way people actually type', () => {
    for (const [typed, expected] of [
      ['trb', 'Trial Balance'], // abbreviation
      ['trail balance', 'Trial Balance'], // typo
      ['daybook', 'Day Book'], // missing space
      ['p&l', 'Profit & Loss'], // via keyword
      ['profit & loss', 'Profit & Loss'], // its own title, ampersand and all
      ['godown', 'Create Warehouse'], // a synonym
      ['hotkeys', 'Keyboard Shortcuts'],
      ['debtors', 'Outstanding Receivables'],
      ['home', 'Gateway'],
    ] as const) {
      test(`${typed} → ${expected}`, async ({ app }) => {
        await goTo(app, typed);
        await expect(resultTitles(app).first()).toHaveText(expected);
      });
    }
  });

  test('highlights the letters that matched', async ({ app }) => {
    await goTo(app, 'trb');
    await expect(app.getByTestId('goto').locator('mark').first()).toBeVisible();
  });

  test('says so when nothing matches, and offers help when empty', async ({ app }) => {
    await app.keyboard.press('Alt+g');
    await expect(app.getByTestId('goto-empty')).toContainText('Type to search');
    await app.keyboard.type('zzzqqq');
    await expect(app.getByTestId('goto-empty')).toContainText('No matches for “zzzqqq”');
  });

  test('Up/Down/Tab/Shift+Tab move the highlight; Enter opens the highlighted one', async ({ app }) => {
    // With a company open, "create" offers the seven masters (before that it also offers Create Company, to start one).
    await goTo(app, 'demo company');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
    await goTo(app, 'create');
    await expect(paletteOptions(app)).toHaveCount(7);
    await expect(paletteSelected(app)).toContainText('Create Group');

    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Tab');
    await expect(paletteSelected(app)).toContainText('Create Party');
    await app.keyboard.press('Shift+Tab');
    await app.keyboard.press('ArrowUp');
    await app.keyboard.press('ArrowUp'); // wraps to the last
    await expect(paletteSelected(app)).toContainText('Create Warehouse');

    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Create Warehouse');
  });

  test('is truly modal: F8 does nothing while it is open', async ({ app, keys }) => {
    await app.keyboard.press('Alt+g');
    await app.keyboard.press('F8');
    await expect(palette(app)).toBeVisible();
    await expect(heading(app)).toHaveText('Gateway');
    expect((await keys()).at(-1)).toMatchObject({ key: 'F8', defaultPrevented: false });
  });

  test('typing is never hijacked, and Home/End move the caret in the input, not the list', async ({ app }) => {
    await app.keyboard.press('Alt+g');
    const input = app.getByRole('combobox', { name: 'Go To' });
    await app.keyboard.type('day book');
    await expect(input).toHaveValue('day book');
    await app.keyboard.press('Home');
    await app.keyboard.type('X');
    await expect(input).toHaveValue('Xday book');
    await app.keyboard.press('End');
    await app.keyboard.type('Y');
    await expect(input).toHaveValue('Xday bookY');
  });

  test('a result you pick becomes a recent, and Alt+P pins a favourite', async ({ app }) => {
    await goTo(app, 'trial bal');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Escape');

    await app.keyboard.press('Alt+g'); // nothing typed: what you used
    await expect(resultTitles(app)).toHaveText(['Trial Balance']);
    await expect(app.getByTestId('goto')).toContainText('Recent');

    await app.keyboard.press('Alt+p');
    await expect(app.getByTestId('goto')).toContainText('Favourite');
    await expect(app.getByLabel('pinned')).toBeVisible();
  });

  test('recents survive a reload', async ({ app }) => {
    await goTo(app, 'day book');
    await app.keyboard.press('Enter');
    await app.reload();
    await app.keyboard.press('Alt+g');
    await expect(resultTitles(app)).toHaveText(['Day Book']);
  });

  test('mouse works too: the Go To button opens it, a click opens a result', async ({ app }) => {
    await app.getByRole('button', { name: 'Go To', exact: true }).click();
    await expect(palette(app)).toBeVisible();
    await app.keyboard.type('cash');
    await paletteOptions(app).filter({ hasText: 'Cash Book' }).click();
    await expect(heading(app)).toHaveText('Cash Book');
  });

  test('clicking outside closes it', async ({ app }) => {
    await app.keyboard.press('Alt+g');
    await app.getByTestId('goto-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(palette(app)).toBeHidden();
  });

  test('is a proper dialog for assistive technology', async ({ app }) => {
    await app.keyboard.press('Alt+g');
    await expect(app.getByRole('dialog', { name: 'Go To' })).toBeVisible();
    await expect(app.getByRole('listbox', { name: 'Results' })).toHaveCount(0); // empty state: no listbox yet
    await app.keyboard.type('sales');
    await expect(app.getByRole('listbox', { name: 'Results' })).toBeVisible();
    await expect(paletteOptions(app).first()).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('function keys', () => {
  for (const [key, title] of [
    ['F4', 'New Contra Voucher'], ['F5', 'New Payment Voucher'], ['F6', 'New Receipt Voucher'],
    ['F7', 'New Journal Voucher'], ['F8', 'New Sales Voucher'], ['F9', 'New Purchase Voucher'],
  ] as const) {
    test(`${key} opens ${title} — and the app consumes the key, so the browser does not act on it`, async ({ app, keys }) => {
      // F5 would RELOAD the page if the app let it through; this marker would vanish.
      await app.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
      await app.keyboard.press(key);
      await expect(heading(app)).toHaveText(title);
      expect((await keys()).at(-1)).toMatchObject({ key, defaultPrevented: true });
      expect(await app.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
    });
  }

  test('a deep path unwinds one Esc at a time', async ({ app }) => {
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter'); // Reports
    await app.keyboard.press('F8');
    await expect(heading(app)).toHaveText('New Sales Voucher');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Reports');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('F2, Ctrl+A and Alt+C are reserved but inert for now — and left for the browser', async ({ app, keys }) => {
    await app.keyboard.press('F2');
    await app.keyboard.press('Control+a');
    await app.keyboard.press('Alt+c');
    await expect(heading(app)).toHaveText('Gateway');
    for (const r of (await keys()).slice(-3)) expect(r.defaultPrevented, r.key).toBe(false);
  });
});

test.describe('addresses', () => {
  test('a deep link opens the screen, with the Gateway beneath it', async ({ app }) => {
    await app.goto('/#/planned/voucher.new.debitNote');
    await expect(heading(app)).toHaveText('New Debit Note');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('editing the address by hand navigates', async ({ app }) => {
    await app.evaluate(() => (window.location.hash = '#/menu/reports'));
    await expect(heading(app)).toHaveText('Reports');
  });

  test('a nonsense address falls back to the Gateway', async ({ app }) => {
    await app.goto('/#/definitely/not/a/screen');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('a reload keeps you on the same screen', async ({ app }) => {
    await goTo(app, 'ledger');
    await app.keyboard.press('Enter');
    const title = await heading(app).textContent();
    await app.reload();
    await expect(heading(app)).toHaveText(title ?? '');
  });
});

test.describe('the status bar shows only keys that work right now', () => {
  test('on the Gateway: Go To, Select and Move — but no Back', async ({ app }) => {
    const bar = statusbar(app);
    await expect(bar).toContainText('Go To');
    await expect(bar).toContainText('Select');
    await expect(bar).toContainText('Move');
    await expect(bar).not.toContainText('Back');
  });

  test('on a sub-screen Back appears; on the Gateway it goes away again', async ({ app }) => {
    await app.keyboard.press('F8');
    await expect(statusbar(app)).toContainText('Back');
    await app.keyboard.press('Escape');
    await expect(statusbar(app)).not.toContainText('Back');
  });

  test('one meaning per key: in the shortcut editor Enter says "Change shortcut", not also "Select"', async ({ app }) => {
    await goTo(app, 'keyboard');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Keyboard Shortcuts');
    await expect(statusbar(app)).toContainText('Change shortcut');
    await expect(statusbar(app)).not.toContainText('Select');
    await expect(statusbar(app).getByText('Enter', { exact: true })).toHaveCount(1);
  });

  test('inside the palette it shows the palette’s keys', async ({ app }) => {
    await app.keyboard.press('Alt+g');
    await expect(statusbar(app)).toContainText('Pin');
    await app.keyboard.press('Escape');
    await expect(statusbar(app)).not.toContainText('Pin');
  });
});

test.describe('changing a shortcut (the keymap override)', () => {
  async function openEditor(app: Page) {
    await goTo(app, 'keyboard');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Keyboard Shortcuts');
  }
  const row = (app: Page, title: string | RegExp) => app.getByRole('option', { name: title });

  test('lists every configurable shortcut with its current keys', async ({ app }) => {
    await openEditor(app);
    await expect(row(app, /Go To…/)).toContainText('Alt');
    await expect(row(app, /New Sales Voucher/)).toContainText('F8');
    await expect(row(app, /Accept \/ save/)).toContainText('Ctrl');
    expect(await app.getByRole('option').count()).toBeGreaterThan(30);
  });

  test('records a new key, and it takes effect immediately', async ({ app }) => {
    await openEditor(app);
    await moveTo(app, 'Go To…');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('capture-prompt')).toContainText('Go To…');

    await app.keyboard.press('Alt+j');
    await expect(app.getByTestId('keymap-message')).toContainText('Go To… is now Alt+J');
    await expect(row(app, /Go To…/)).toContainText('customised');

    await app.keyboard.press('Alt+g'); // the old key no longer does anything
    await expect(palette(app)).toBeHidden();
    await app.keyboard.press('Alt+j'); // the new one does
    await expect(palette(app)).toBeVisible();
  });

  test('the status bar and the Go To button follow the new key', async ({ app }) => {
    await openEditor(app);
    await moveTo(app, 'Go To…');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Alt+j');
    await expect(statusbar(app).locator('[data-command="goto.open"]')).toContainText('J');
    await expect(app.getByRole('button', { name: 'Go To', exact: true })).toContainText('J');
  });

  test('a customised shortcut survives a reload', async ({ app }) => {
    await openEditor(app);
    await moveTo(app, 'Go To…');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Alt+j');
    await expect(app.getByTestId('keymap-message')).toBeVisible();

    await app.reload();
    await app.keyboard.press('Alt+g');
    await expect(palette(app)).toBeHidden();
    await app.keyboard.press('Alt+j');
    await expect(palette(app)).toBeVisible();
  });

  test('refuses a key another command already uses, and says which', async ({ app }) => {
    await openEditor(app);
    await moveTo(app, 'Go To…');
    await app.keyboard.press('Enter');
    await app.keyboard.press('F8');
    await expect(app.getByTestId('keymap-message')).toContainText('already used by “New Sales Voucher”');
    await app.keyboard.press('Alt+g'); // unchanged: still opens the palette
    await expect(palette(app)).toBeVisible();
  });

  test('refuses a plain typing key', async ({ app }) => {
    await openEditor(app);
    await moveTo(app, 'Go To…');
    await app.keyboard.press('Enter');
    await app.keyboard.press('x');
    await expect(app.getByTestId('keymap-message')).toContainText('typing key');
  });

  test('Esc cancels a recording', async ({ app }) => {
    await openEditor(app);
    await moveTo(app, 'Go To…');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('capture-prompt')).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('keymap-message')).toContainText('Cancelled');
    await expect(heading(app)).toHaveText('Keyboard Shortcuts'); // Esc cancelled the recording; it did not go back
  });

  test('Delete removes a shortcut (the command stays reachable), Ctrl+Delete restores it', async ({ app }) => {
    await openEditor(app);
    await moveTo(app, 'New Sales Voucher');
    await app.keyboard.press('Delete');
    await expect(row(app, /New Sales Voucher/)).toContainText('no shortcut');

    await app.keyboard.press('Escape');
    await app.keyboard.press('F8'); // now does nothing…
    await expect(heading(app)).toHaveText('Gateway');
    await goTo(app, 'sales voucher'); // …but Go To still finds it
    await expect(resultTitles(app).first()).toHaveText('New Sales Voucher');
    await app.keyboard.press('Escape');

    await app.evaluate(() => (window.location.hash = '#/settings/keyboard'));
    await moveTo(app, 'New Sales Voucher');
    await app.keyboard.press('Control+Delete');
    await expect(row(app, /New Sales Voucher/)).toContainText('F8');
    await expect(row(app, /New Sales Voucher/)).not.toContainText('customised');
  });

  test('"Reset all" puts everything back', async ({ app }) => {
    await openEditor(app);
    await moveTo(app, 'Go To…');
    await app.keyboard.press('Enter');
    await app.keyboard.press('Alt+j');
    await app.getByRole('button', { name: 'Reset all shortcuts' }).click();
    await expect(row(app, /Go To…/)).not.toContainText('customised');
    await app.keyboard.press('Alt+g');
    await expect(palette(app)).toBeVisible();
  });

  test('while recording, the key you press triggers nothing else', async ({ app }) => {
    await openEditor(app);
    await moveTo(app, 'Go To…');
    await app.keyboard.press('Enter');
    await app.keyboard.press('F8'); // would open a voucher if it were dispatched
    await expect(heading(app)).toHaveText('Keyboard Shortcuts');
  });

  test('the editor is reachable from the Gateway menu too', async ({ app }) => {
    await app.keyboard.press('End'); // Utilities & Settings
    await app.keyboard.press('Enter');
    await expect(selectedRow(app)).toContainText('Keyboard Shortcuts');
    await app.keyboard.press('Enter');
    await expect(heading(app)).toHaveText('Keyboard Shortcuts');
  });
});
