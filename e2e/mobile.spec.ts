/**
 * The voucher window on a phone (below 640px): each line is a small card — the item on its own row, the figures under it —
 * so nothing overlaps and the page never scrolls sideways. On a desktop it stays the worksheet, column headings and all.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

async function openSharmaInvoice(page: Page): Promise<void> {
  await goTo(page, 'day book');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Day Book');
  await page.keyboard.type('sharma');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toContainText('Display Sales');
}

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('not laid out');
  return b;
};
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('the voucher window on a phone', () => {
  test.beforeEach(async ({ app }) => {
    await app.setViewportSize({ width: 390, height: 844 });
    await loadDemo(app);
  });

  test('a Sales invoice line: the item has its own row, the figures sit under it with captions, nothing overlaps', async ({ app }) => {
    await openSharmaInvoice(app);
    const row = app.locator('.vrow').first();
    const item = row.locator('.vc-ledger');
    await expect(item.locator('input').first()).toHaveValue('Machine Oil');
    expect((await box(item)).width).toBeGreaterThan((await box(row)).width * 0.6);

    const itemBox = await box(item);
    for (const cell of ['.vc-qty', '.vc-rate', '.vc-value']) {
      const b = await box(row.locator(cell));
      expect(b.y, `${cell} starts below the item`).toBeGreaterThanOrEqual(itemBox.y + itemBox.height - 1);
    }
    await expect(app.locator('.vhdr')).toBeHidden(); // the captions stand in for the column headings
    expect(await noSidewaysScroll(app)).toBe(true);
  });

  test('a long breadcrumb (New Stock Journal Voucher) shortens instead of widening the page', async ({ app }) => {
    await app.keyboard.press('F10');
    await expect(heading(app)).toHaveText('New Stock Journal Voucher');
    expect(await noSidewaysScroll(app)).toBe(true);
  });
});

test('on a desktop the voucher window is still the worksheet: column headings shown, one line per row', async ({ app }) => {
  await app.setViewportSize({ width: 1366, height: 768 });
  await loadDemo(app);
  await openSharmaInvoice(app);
  await expect(app.locator('.vhdr')).toBeVisible();
  const row = app.locator('.vrow').first();
  await expect(row).toHaveCSS('display', 'grid');
  expect(Math.abs((await box(row.locator('.vc-ledger'))).y - (await box(row.locator('.vc-value'))).y)).toBeLessThan(2);
});

test.describe('Esc and Enter above the on-screen keyboard', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('with the keyboard open they float over it; a tap is the key itself, and the field keeps the focus', async ({ page }) => {
    // Playwright opens no on-screen keyboard: stand one in, taking the lower 394px of the screen.
    await page.addInitScript(() => {
      const fake = new EventTarget() as EventTarget & { height: number; offsetTop: number; width: number };
      Object.assign(fake, { height: 450, offsetTop: 0, width: 390 });
      Object.defineProperty(window, 'visualViewport', { get: () => fake });
    });
    await page.goto('/');
    await expect(page.locator('.shell')).toBeVisible();
    await loadDemo(page);

    const keys = page.getByTestId('keyboard-keys');
    await expect(keys).toBeVisible();
    const strip = await box(keys);
    expect(strip.y + strip.height).toBeLessThanOrEqual(451); // sitting on the keyboard, not under it

    await page.keyboard.press('F8');
    await expect(heading(page)).toHaveText('New Sales Voucher');
    await page.keyboard.type('sharma');
    await keys.getByRole('button', { name: 'Enter' }).tap();
    await expect(page.getByLabel('Customer PO or reference')).toBeFocused(); // Enter took the customer and moved on
    await expect(page.locator('[data-vf="party"]')).toHaveValue('Sharma Traders');

    await keys.getByRole('button', { name: 'Esc' }).tap();
    await expect(page.locator('[data-vf="party"]')).toBeFocused(); // Esc steps back a field, as the key does
  });
});

test('a desktop never shows the floating keys', async ({ app }) => {
  await app.setViewportSize({ width: 1366, height: 768 });
  await loadDemo(app);
  await app.keyboard.press('F8');
  await expect(heading(app)).toHaveText('New Sales Voucher');
  await expect(app.getByTestId('keyboard-keys')).toHaveCount(0);
});

test.describe('a touch screen reaches what the keys do (no Alt key on a phone)', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  async function unknownItem(page: Page): Promise<void> {
    await page.goto('/');
    await expect(page.locator('.shell')).toBeVisible();
    await loadDemo(page);
    await page.keyboard.press('F8');
    await expect(heading(page)).toHaveText('New Sales Voucher');
    await page.keyboard.type('sharma');
    await page.keyboard.press('Enter');
    await page.locator('[data-vf="l0.item"]').click();
    await page.keyboard.type('Blower Plate 370');
    await expect(page.getByTestId('picker')).toContainText('creates “Blower Plate 370”');
  }

  test('"No match — Alt+C creates …" is tapped: the item is created from the typed name, and the field keeps the focus until then', async ({ page }) => {
    await unknownItem(page);
    await page.getByTestId('picker').getByRole('button', { name: /creates/ }).tap();
    await expect(heading(page)).toHaveText('Create Stock Item');
    await expect(page.locator('[data-field="name"]')).toHaveValue('Blower Plate 370');
  });

  test('Keys opens the panel without taking the focus from the field, so its Create acts on it', async ({ page }) => {
    await unknownItem(page);
    await page.getByRole('button', { name: 'Keys' }).tap();
    await expect(page.locator('[data-vf="l0.item"]')).toBeFocused();
    const create = page.getByTestId('action-panel').locator('[data-command="master.createInline"]');
    await expect(create).toBeEnabled();
    await create.tap();
    await expect(heading(page)).toHaveText('Create Stock Item');
  });

  test('a key drawn in a hint is pressed by a tap on it: "Alt+C new ledger" on the Ledgers list', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.shell')).toBeVisible();
    await loadDemo(page);
    await goTo(page, 'ledgers');
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText('Ledgers');
    await page.locator('.lede .kbd-tap').last().tap();
    await expect(heading(page)).toHaveText('Create Ledger');
  });
});

test('the phone\'s Back is Esc inside the app, and leaves only from the Gateway', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.shell')).toBeVisible();
  await loadDemo(page);
  await goTo(page, 'ledgers');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Ledgers');
  await page.goBack();
  await expect(page.locator('.shell')).toBeVisible(); // still in the app
  await expect(page).toHaveURL(/#\/gateway$/); // Back did what Esc does: the list closed, back to the Gateway
  await expect(heading(page)).not.toHaveText('Ledgers');
  await page.goBack(); // on the Gateway, Back leaves
  await expect(page).not.toHaveURL(/#\/gateway$/);
});

test.describe('swipes and the Back button on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  /** A finger drawn sideways across the voucher's title (not a field): from x1 to x2 in 150 ms. */
  const swipe = (page: Page, x1: number, x2: number) =>
    page.evaluate(
      ([a, b]) => {
        const el = document.querySelector('.voucher-screen h1, .voucher-screen .vtitle') as Element;
        const touch = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
        el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(a)], changedTouches: [touch(a)], bubbles: true }));
        return new Promise<void>((done) =>
          setTimeout(() => {
            el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(b)], bubbles: true }));
            done();
          }, 150),
        );
      },
      [x1, x2] as const,
    );

  test('a sideways swipe on a displayed voucher turns it, as the ‹ › arrows do; right to left is the next one', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.shell')).toBeVisible();
    await loadDemo(page);
    await openSharmaInvoice(page);
    await swipe(page, 60, 330); // left to right: the previous one
    await expect(page.locator('.screen')).toContainText('ABC Industries');
    await swipe(page, 330, 60); // right to left: the next one
    await expect(page.locator('.screen')).toContainText('Sharma Traders');
  });

  test('on the Gateway Back asks "Exit MinimalERP?": Stay keeps the app, and a Back while it asks leaves', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.shell')).toBeVisible();
    await loadDemo(page);
    await expect(page).toHaveURL(/#\/gateway$/);
    await page.locator('.topbar').tap(); // the person has touched the app (Chrome honours Back entries only after that)
    await page.goBack();
    await expect(page.locator('.exit-card')).toContainText('Exit MinimalERP?');
    await page.getByRole('button', { name: 'Stay' }).tap();
    await expect(page.locator('.exit-ask')).toHaveCount(0);
    await page.goBack();
    await expect(page.locator('.exit-card')).toBeVisible(); // asked again
    await page.goBack();
    await expect(page).not.toHaveURL(/#\/gateway$/); // Back while it asks: gone
  });

  test('inside the app, Back after Back keeps stepping back (Esc) and never drops out of the app', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.shell')).toBeVisible();
    await loadDemo(page);
    await goTo(page, 'ledgers');
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText('Ledgers');
    await page.keyboard.type('factory rent');
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText('Display Ledger: Factory Rent');
    await page.goBack();
    await expect(heading(page)).toHaveText('Ledgers');
    await page.goBack();
    await expect(page).toHaveURL(/#\/gateway$/);
    await expect(page.locator('.shell')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.exit-card')).toBeVisible();
  });
});
