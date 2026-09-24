/**
 * After midnight in India. From 00:00 to 05:30 IST the date in UTC is still yesterday; every "today" in the app must be the date where the
 * person is, or a bill entered today is missing from a report that thinks today is yesterday. (This failed at 01:30 on 24 Sep 2026: a
 * purchase bill typed that night was not in Outstanding Payables.)
 */
import type { Page } from '@playwright/test';
import { expect, goTo, heading, test } from './support';

test.use({ timezoneId: 'Asia/Kolkata' });

const gridRows = (page: Page) => page.getByRole('grid').getByRole('row').filter({ has: page.locator('td') });

test('at 01:30 India time, a purchase bill entered "today" is in Outstanding Payables', async ({ app }) => {
  // 01:30 IST on 24 Sep = 20:00 UTC on 23 Sep
  await app.clock.install({ time: new Date('2026-09-24T01:30:00+05:30') });
  await app.reload();
  await expect(app.locator('.shell')).toBeVisible();
  await goTo(app, 'demo company');
  await app.keyboard.press('Enter');
  await expect(app.getByTestId('company-name')).toHaveText('Demo Manufacturing Pvt Ltd');

  await app.keyboard.press('F9');
  await expect(heading(app)).toHaveText('New Purchase Voucher');
  await app.keyboard.type('bharat');
  await app.keyboard.press('Enter'); // supplier
  await app.keyboard.press('Enter'); // PO / ref
  await app.keyboard.press('Enter'); // purchase ledger
  await app.keyboard.type('BC-MID-1');
  await app.keyboard.press('Enter'); // supplier inv no.
  await app.keyboard.press('Enter'); // bill due
  await app.keyboard.type('ms sheet');
  await app.keyboard.press('Enter');
  await app.keyboard.press('Enter'); // godown
  await app.keyboard.press('Enter'); // no order
  await app.keyboard.type('100');
  await app.keyboard.press('Enter');
  await app.keyboard.type('60');
  await expect(app.getByTestId('total-amount')).toHaveText('6,000.00');
  await app.keyboard.press('Control+a');
  await expect(heading(app)).toHaveText('Gateway');

  await app.getByRole('option', { name: /^Reports/ }).click();
  await app.getByRole('option', { name: /^Outstanding Payables/ }).click();
  await expect(heading(app)).toHaveText('Outstanding Payables');
  await expect(gridRows(app).filter({ hasText: 'Bharat Chemicals' })).toContainText('7,500.00'); // BC-77 (1,500) and tonight's bill
});
