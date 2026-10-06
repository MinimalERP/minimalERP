/**
 * The Gateway's tasks: what is due this week (read from the books), tasks with a box to tick them done, and enquiries with a status and
 * dated notes of what was done on each.
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

async function loadDemo(page: Page): Promise<void> {
  await goTo(page, 'demo company');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');
}

test.describe('tasks on the Gateway', () => {
  test.beforeEach(async ({ app }) => {
    await loadDemo(app);
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
  });

  test('a task is added, ticked done; an enquiry gets a status and a note; the menu letters still work', async ({ app }) => {
    // the Gateway itself shows no tasks: they are its last section, a letter away
    await expect(app.getByTestId('tasks-panel')).toHaveCount(0);
    await app.keyboard.press('k');
    await expect(heading(app)).toHaveText('Tasks');
    const panel = app.getByTestId('tasks-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'This week' })).toBeVisible();

    await app.getByTestId('task-new').click();
    const dialog = app.getByTestId('task-dialog');
    await dialog.getByLabel('Title').fill('Call Kumar about the plating rate');
    // due today, typed as day-month: a day already past would be read as next year's
    const now = new Date();
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()];
    await dialog.getByLabel('Due').fill(`${now.getDate()}-${now.getMonth() + 1}`);
    await dialog.getByTestId('task-save').click();
    await expect(dialog).toHaveCount(0);
    const task = app.getByTestId('task-list').getByRole('listitem').filter({ hasText: 'Call Kumar' });
    await expect(task).toContainText(`${now.getDate()}-${month}-${now.getFullYear()}`);
    await task.getByRole('checkbox').check();
    await expect(task).toHaveClass(/done/);

    await app.getByTestId('enquiry-new').click();
    await dialog.getByLabel('Title').fill('Honeywell – 14188 blanks');
    await dialog.getByLabel('Note').fill('drawing received');
    await dialog.getByTestId('task-save').click();
    const enquiry = app.getByTestId('enquiry-list').getByRole('listitem').filter({ hasText: 'Honeywell' });
    await expect(enquiry).toContainText('New');
    await expect(enquiry).toContainText('drawing received');
    await enquiry.getByRole('button').click();
    await dialog.getByLabel('Status').selectOption('quoted');
    await dialog.getByLabel('Note').fill('quote sent');
    await dialog.getByTestId('task-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(enquiry).toContainText('Quoted');
    await expect(enquiry).toContainText('quote sent');
    // disposable: Delete, then once more to confirm, and it is gone
    await enquiry.getByRole('button').click();
    await dialog.getByTestId('task-delete').click();
    await expect(dialog.getByTestId('task-delete')).toHaveText('Delete for good?');
    await dialog.getByTestId('task-delete').click();
    await expect(dialog).toHaveCount(0);
    await expect(app.getByTestId('enquiry-list').getByRole('listitem')).toHaveCount(0);

    // Esc closes a task window without saving, and again goes back; the Gateway letters still open the menus
    await app.getByTestId('task-new').click();
    await app.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(heading(app)).toHaveText('Tasks');
    await app.keyboard.press('Escape');
    await expect(heading(app)).toHaveText('Gateway');
    await app.keyboard.press('t');
    await expect(heading(app)).toHaveText('Transactions');
  });
});
