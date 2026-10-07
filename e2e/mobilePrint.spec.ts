/**
 * Printing from the phone (ADR-0027, stage 4), by taps: "Print / PDF" asks which copies — the desktop's own list — and then prints them,
 * or makes a PDF to send or keep. In the Android app the PDF goes to the phone's share sheet through the bridge.
 */
import { type Page, expect, test } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

const title = (page: Page) => page.locator('.m-title').first();
const row = (page: Page, text: string | RegExp) => page.locator('.m-row').filter({ hasText: text });
const copies = (page: Page) => page.locator('#print-root .print-copy');

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

async function openInvoice(page: Page): Promise<string> {
  await page.getByTestId('load-demo').tap();
  await expect(title(page)).toHaveText('Demo Manufacturing Pvt Ltd');
  await page.evaluate(() => void (window.print = () => {}));
  await row(page, /^Transactions/).tap();
  await row(page, 'Sales Vouchers').tap();
  await page.getByTestId('doc-row').first().tap();
  return ((await title(page).textContent()) ?? '').replace('Sales ', '');
}

test('Print asks which copies: three print as Original, Duplicate, Triplicate; "Triplicate only" prints one; the choice is remembered; Back closes the sheet', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  const number = await openInvoice(page);

  await page.getByTestId('doc-print').tap();
  const sheet = page.getByTestId('print-sheet');
  await expect(sheet).toContainText(`Print ${number}`);
  for (const choice of ['1 copy', '2 copies', '3 copies', '4 copies', 'Duplicate only', 'Triplicate only', 'Extra Copy only']) await expect(sheet).toContainText(choice);
  await expect(page.getByTestId('copies-1')).toHaveAttribute('aria-pressed', 'true'); // one Original, until this phone prints otherwise
  await expect(copies(page)).toHaveCount(0); // nothing prints until Print is tapped

  await page.goBack(); // the phone's Back closes the sheet, not the document
  await expect(sheet).toHaveCount(0);
  await expect(title(page)).toHaveText(`Sales ${number}`);

  await page.getByTestId('doc-print').tap();
  await page.getByTestId('copies-3').tap();
  await expect(page.getByTestId('copies-3')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('print-go').tap();
  await expect(sheet).toHaveCount(0);
  await expect(copies(page)).toHaveCount(3);
  for (const [i, label] of ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE'].entries()) {
    await expect(copies(page).nth(i)).toContainText(label);
    await expect(copies(page).nth(i)).toContainText(number);
  }

  // the sheet opens on what was printed last
  await page.getByTestId('doc-print').tap();
  await expect(page.getByTestId('copies-3')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('copies-triplicate').tap();
  await page.getByTestId('print-go').tap();
  await expect(copies(page)).toHaveCount(1);
  await expect(copies(page).first()).toContainText('TRIPLICATE');
  await expect(copies(page).first()).not.toContainText('ORIGINAL');
  expect(problems).toEqual([]);
});

test('in the Android app, Share PDF hands the phone a PDF of the copies chosen, named after the voucher; Save PDF keeps it', async ({ page }) => {
  const problems = watch(page);
  await page.addInitScript(() => {
    const got: { how: string; name: string; mime: string; base64: string }[] = [];
    (window as unknown as { got: typeof got }).got = got;
    (window as unknown as { MinimalERPAndroid: unknown }).MinimalERPAndroid = {
      takeSharedFiles: () => '[]',
      print: () => undefined,
      openExternal: () => undefined,
      saveFile: (name: string, mime: string, base64: string) => void got.push({ how: 'save', name, mime, base64 }),
      shareFile: (name: string, mime: string, base64: string) => void got.push({ how: 'share', name, mime, base64 }),
    };
  });
  await page.goto('/?ui=mobile');
  const number = await openInvoice(page);
  const name = `${number.replace(/\//g, '-')}.pdf`;
  const got = () => page.evaluate(() => (window as unknown as { got: { how: string; name: string; mime: string; base64: string }[] }).got.map((g) => ({ how: g.how, name: g.name, mime: g.mime, head: atob(g.base64.slice(0, 8)).slice(0, 4), size: g.base64.length })));

  await page.getByTestId('doc-print').tap();
  await page.getByTestId('copies-2').tap();
  await page.getByTestId('print-share').tap();
  await expect(page.getByTestId('print-sheet')).toHaveCount(0, { timeout: 30_000 });
  const two = await got();
  expect(two).toHaveLength(1);
  expect(two[0]).toMatchObject({ how: 'share', name, mime: 'application/pdf', head: '%PDF' });

  await page.getByTestId('doc-print').tap();
  await expect(page.getByTestId('copies-2')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('copies-1').tap();
  await page.getByTestId('print-save').tap();
  await expect(page.getByTestId('print-sheet')).toHaveCount(0, { timeout: 30_000 });
  const both = await got();
  expect(both).toHaveLength(2);
  expect(both[1]).toMatchObject({ how: 'save', name, mime: 'application/pdf', head: '%PDF' });
  expect(both[1]!.size).toBeLessThan(both[0]!.size); // one page, not two
  expect(problems).toEqual([]);
});

test('an Android app from before sharing is asked to update, and can still print and save', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { MinimalERPAndroid: unknown }).MinimalERPAndroid = { takeSharedFiles: () => '[]', print: () => undefined, openExternal: () => undefined, saveFile: () => undefined };
  });
  await page.goto('/?ui=mobile');
  await openInvoice(page);
  await page.getByTestId('doc-print').tap();
  await expect(page.getByTestId('print-update')).toContainText('update the app');
  await expect(page.getByTestId('print-share')).toHaveCount(0);
  await expect(page.getByTestId('print-go')).toBeVisible();
  await expect(page.getByTestId('print-save')).toBeVisible();
});
