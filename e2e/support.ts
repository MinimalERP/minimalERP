import { type Page, expect, test as base } from '@playwright/test';

export interface KeyRecord {
  readonly key: string;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly defaultPrevented: boolean;
}

/**
 * Every test starts from a clean browser profile (Playwright gives each test its own context, so
 * localStorage is empty), fails on any console error or uncaught exception, and can ask
 * "did the app consume that key?" — the thing that keeps F5 from reloading the page.
 */
export const test = base.extend<{ app: Page; keys: () => Promise<KeyRecord[]> }>({
  app: async ({ page }, use) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
    });

    await page.goto('/');
    await expect(page.locator('.shell')).toBeVisible();
    // Record, AFTER the app's own capture listener, whether each key was left alone or consumed.
    await page.evaluate(() => {
      const w = window as unknown as { __keys: unknown[] };
      w.__keys = [];
      window.addEventListener(
        'keydown',
        (e) => w.__keys.push({ key: e.key, alt: e.altKey, ctrl: e.ctrlKey, defaultPrevented: e.defaultPrevented }),
        { capture: true },
      );
    });

    await use(page);
    expect(problems, 'the app logged errors').toEqual([]);
  },

  keys: async ({ app }, use) => {
    await use(() => app.evaluate(() => (window as unknown as { __keys: KeyRecord[] }).__keys));
  },
});

export { expect };

export const heading = (page: Page) => page.getByRole('heading', { level: 1 });
export const selectedRow = (page: Page) => page.locator('[role="option"][aria-selected="true"]');
export const palette = (page: Page) => page.getByTestId('goto');
/** Rows INSIDE the palette. The screen behind it has its own list, so an unscoped getByRole('option') sees both. */
export const paletteOptions = (page: Page) => palette(page).getByRole('option');
export const paletteSelected = (page: Page) => palette(page).locator('[role="option"][aria-selected="true"]');

/** Types into the Go To palette and waits for results to settle. */
export async function goTo(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Alt+g');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type(text);
}

/** Moves the list cursor down until the selected row contains `text` — keyboard only. */
export async function moveTo(page: Page, text: string): Promise<void> {
  for (let i = 0; i < 400; i++) { // the shortcut list has grown with every phase
    if ((await selectedRow(page).textContent())?.includes(text)) return;
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`could not reach a row containing "${text}"`);
}
