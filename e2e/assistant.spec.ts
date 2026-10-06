/**
 * The floating assistant (v1): a ✦ button on every screen of an open company and Alt+Q open a chat over the screen, which says what is on
 * screen and keeps the conversation across screens. These books live in the browser (no server), so a question gets the plain answer
 * that the assistant needs the online books — the answers themselves are tested against the database (db-tests/assistant.http.test.ts).
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

const panel = (page: Page) => page.getByTestId('assistant-panel');

test('no company open, no assistant; with one, the ✦ button is on every screen', async ({ app }) => {
  await expect(app.getByTestId('assistant-button')).toHaveCount(0);
  await loadDemo(app);
  await expect(app.getByTestId('assistant-button')).toBeVisible();
  await app.keyboard.press('F8');
  await expect(heading(app)).toHaveText('New Sales Voucher');
  await expect(app.getByTestId('assistant-button')).toBeVisible();
});

test('Alt+Q opens it over the screen, says what is on screen, and Esc closes it with the focus back where it was', async ({ app }) => {
  await loadDemo(app);
  await app.keyboard.press('F8');
  await expect(heading(app)).toHaveText('New Sales Voucher');
  const field = app.locator('[data-vf="party"]');
  await expect(field).toBeFocused();

  await app.keyboard.press('Alt+q');
  await expect(panel(app)).toBeVisible();
  await expect(app.getByTestId('assistant-on')).toHaveText('on: New Sales Voucher');
  await expect(app.getByLabel('Your question')).toBeFocused();
  await app.keyboard.type('stock of 14188?'); // letters go to the question, not to the voucher behind
  await expect(field).toHaveValue('');

  await app.keyboard.press('Escape');
  await expect(panel(app)).toHaveCount(0);
  await expect(field).toBeFocused();
  await expect(heading(app)).toHaveText('New Sales Voucher'); // the voucher is still open underneath
});

test('a question: Enter sends it; without the online books it says so plainly; Up brings the question back; ⟲ starts afresh', async ({ app }) => {
  await loadDemo(app);
  await app.getByTestId('assistant-button').click();
  await app.getByLabel('Your question').fill('Open orders due this week?');
  await app.keyboard.press('Enter');
  await expect(panel(app).locator('.assistant-line.user')).toHaveText('Open orders due this week?');
  await expect(panel(app).locator('.assistant-line.problem')).toContainText('The assistant needs the online books');
  await expect(app.getByLabel('Your question')).toHaveValue('');

  await app.keyboard.press('ArrowUp');
  await expect(app.getByLabel('Your question')).toHaveValue('Open orders due this week?');

  // the conversation stays while the assistant is closed and opened again
  await app.keyboard.press('Escape');
  await app.keyboard.press('Alt+q');
  await expect(panel(app).locator('.assistant-line.user')).toHaveCount(1);
  await app.getByRole('button', { name: 'New conversation' }).click();
  await expect(panel(app).locator('.assistant-line')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('the ✦ button opens a full-screen sheet; the phone\'s Back closes it and the screen is as it was', async ({ page }) => {
    await page.goto('/?ui=desktop'); // the desktop app on a phone: asked for, now that a phone gets the mobile interface by itself
    await expect(page.locator('.shell')).toBeVisible();
    await loadDemo(page);
    await goTo(page, 'ledgers');
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText('Ledgers');

    await page.locator('.topbar').tap(); // Chrome honours the app's Back only after a touch
    await page.getByTestId('assistant-button').tap();
    const box = await panel(page).boundingBox();
    expect(box?.width).toBe(390);
    await expect(page.getByTestId('assistant-on')).toHaveText('on: Ledgers');

    await page.goBack();
    await expect(panel(page)).toHaveCount(0);
    await expect(heading(page)).toHaveText('Ledgers');
  });

  test('the ✦ button can be dragged out of the way, and stays there', async ({ page }) => {
    await page.goto('/?ui=desktop'); // the desktop app on a phone: asked for, now that a phone gets the mobile interface by itself
    await expect(page.locator('.shell')).toBeVisible();
    await loadDemo(page);
    const fab = page.getByTestId('assistant-button');
    const before = await fab.boundingBox();
    if (!before) throw new Error('no button');
    await page.mouse.move(before.x + 20, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(before.x - 100, before.y - 200, { steps: 8 });
    await page.mouse.up();
    await expect(panel(page)).toHaveCount(0); // a drag is not a tap
    const after = await fab.boundingBox();
    expect(after?.y).toBeLessThan(before.y - 150);
    await page.reload();
    await expect(page.locator('.shell')).toBeVisible();
    expect(Math.abs(((await fab.boundingBox())?.y ?? 0) - (after?.y ?? 0))).toBeLessThan(2);
  });
});
