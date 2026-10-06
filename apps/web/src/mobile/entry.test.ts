import { MemoryBackend } from '@minimalerp/adapter-memory';
import { IssueCode, deterministicUuid } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { previewSales } from '../vouchers/salesModel';
import { docList } from './data';
import { canAlter, headIssues, invoiceFrom, isBlankEntry, lastRate, lineFor, lineIssues, newForm, startForm, stepQty, withDate, withParty } from './entry';

const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);
const SHARMA = id('party', 'Sharma Traders');
const ABC = id('party', 'ABC Industries');
const OIL = id('stockItem', 'Machine Oil');

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}
const preview = (books: Books, kind: Parameters<typeof previewSales>[1], form: Parameters<typeof previewSales>[0]) => previewSales(form, kind, books.masters, books.stock, books.orders, undefined, books.vouchers);

describe('touch entry fills the desktop’s own form', () => {
  it('a new invoice starts empty, with the sales ledger chosen; a customer brings its details and the bill’s due date', async () => {
    const books = await demo();
    const blank = newForm(books, 'sales')!;
    expect(blank.lines).toEqual([]);
    expect(blank.salesLedgerId).not.toBe('');
    expect(isBlankEntry(blank)).toBe(true);
    const form = withParty(blank, 'sales', books, SHARMA);
    expect(form.partyLabel).toBe('Sharma Traders');
    expect(form.partyDetails?.partyId).toBe(SHARMA);
    expect(form.due > form.date).toBe(true); // Sharma has credit days
    expect(isBlankEntry(form)).toBe(false);
    expect(withParty(form, 'sales', books, 'nobody')).toBe(form);
    // the date moves the due date with it, until someone sets the due date by hand
    const later = withDate(form, 'sales', books, form.due);
    expect(later.due > form.due).toBe(true);
    expect(withDate({ ...form, dueTouched: true }, 'sales', books, form.due).due).toBe(form.due);
  });

  it('an item tapped becomes a line ready to save: one of it, at what this customer last paid, from the godown that holds it', async () => {
    const books = await demo();
    expect(lastRate(books, OIL, SHARMA)).toBe('260');
    expect(lastRate(books, OIL, ABC)).toBe('260'); // never sold to ABC: what anyone last paid
    expect(lastRate(books, 'no-item', SHARMA)).toBe('');
    const form = withParty(newForm(books, 'sales')!, 'sales', books, SHARMA);
    const line = lineFor(books, 'sales', form, OIL);
    expect(line).toMatchObject({ itemId: OIL, itemLabel: 'Machine Oil', qty: '1', rate: '260', warehouseLabel: 'Main Location' });
    const p = preview(books, 'sales', { ...form, lines: [line] });
    expect(p.issues).toEqual([]);
    expect(p.ok).toBe(true);
    expect(p.grand).toBe(26000n);
    // an order line has no godown and is due on the order's date
    const order = withParty(newForm(books, 'salesOrder')!, 'salesOrder', books, SHARMA);
    const ordered = lineFor(books, 'salesOrder', order, OIL);
    expect(ordered.warehouseId).toBe('');
    expect(ordered.due).toBe(order.date);
    expect(preview(books, 'salesOrder', { ...order, lines: [ordered] }).ok).toBe(true);
    expect(withDate({ ...order, lines: [ordered] }, 'salesOrder', books, '2026-12-01').lines[0]?.due).toBe('2026-12-01');
  });

  it('the engine’s refusals land on the line or on the head, as the page shows them', async () => {
    const books = await demo();
    const form = withParty(newForm(books, 'sales')!, 'sales', books, SHARMA);
    const tooMany = preview(books, 'sales', { ...form, lines: [{ ...lineFor(books, 'sales', form, OIL), qty: '5000' }] });
    expect(lineIssues(tooMany.issues, 0).map((i) => i.code)).toEqual([IssueCode.StockNegative]);
    expect(headIssues(tooMany.issues)).toEqual([]);
    const nobody = preview(books, 'sales', newForm(books, 'sales')!);
    expect(headIssues(nobody.issues).map((i) => i.field)).toEqual(expect.arrayContaining(['party', 'general']));
  });

  it('the stepper counts by one and never below one', () => {
    expect(stepQty('1', 1)).toBe('2');
    expect(stepQty('2.5', 1)).toBe('3.5');
    expect(stepQty('2', -1)).toBe('1');
    expect(stepQty('1', -1)).toBe('1');
    expect(stepQty('0.5', -1)).toBe('0.5');
    expect(stepQty('', 1)).toBe('1');
    expect(stepQty('abc', -1)).toBe('abc');
  });

  it('what may be altered or invoiced from the phone: the four kinds while posted; an open order has an invoice to make', async () => {
    const books = await demo();
    const invoice = books.voucher(docList(books, 'sales', '2026-06-30')[0]!.voucherId)!;
    expect(canAlter(books, invoice)).toBe(true);
    expect(invoiceFrom(books, invoice)).toBeUndefined();
    expect(startForm(books, { kind: 'sales', voucherId: invoice.id })?.id).toBe(invoice.id);
    const payment = books.voucher(docList(books, 'payment', '2026-06-30')[0]!.voucherId)!;
    expect(canAlter(books, payment)).toBe(false);
    expect(startForm(books, { kind: 'sales', voucherId: payment.id })).toBeUndefined();

    const orders = docList(books, 'salesOrder', '2026-06-30');
    const open = books.voucher(orders.find((o) => o.status !== 'Closed')!.voucherId)!;
    const closed = books.voucher(orders.find((o) => o.status === 'Closed')!.voucherId)!;
    expect(invoiceFrom(books, open)).toBe('Invoice pending');
    expect(invoiceFrom(books, closed)).toBeUndefined();
    const made = startForm(books, { kind: 'sales', fromOrder: open.id })!;
    expect(made.lines.length).toBeGreaterThan(0);
    expect(made.lines.every((l) => l.orderId === open.id)).toBe(true);
    // an order with nothing pending starts a plain invoice
    expect(startForm(books, { kind: 'sales', fromOrder: closed.id })?.lines).toEqual([]);
    expect(startForm(books, { kind: 'sales', partyId: ABC })?.partyId).toBe(ABC);
  });
});
