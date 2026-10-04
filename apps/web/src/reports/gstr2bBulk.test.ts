import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type Gstr2bRow, deterministicUuid, money } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { partyDetailsOfParty, salesLedgerOptions } from '../vouchers/salesModel';
import { bulkPurchases, optionByName, templateOf } from './gstr2bBulk';

const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);

/** The demo company with GST switched on (it ships with it off). */
async function demo(): Promise<{ host: BooksHost; books: Books }> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const c = r.value.masters.company;
  const on = await r.value.execute({ op: 'alter', kind: 'company', id: c.id, data: { ...c, chargeGst: true } } as never);
  if (!on.ok) throw new Error(JSON.stringify(on.issues));
  return { host, books: host.current! };
}

const steel = (books: Books) => books.masters.party(id('party', 'Steel Supplies Pvt Ltd') as never)!;
const lastDate = (books: Books) => books.vouchers.map((v) => v.date).sort().at(-1)!;
let n = 0;
const newId = () => deterministicUuid(`bulk|${n++}`);

/** A purchase of Steel Supplies (Gujarat: IGST) with the given lines. */
async function buy(host: BooksHost, books: Books, billNo: string, lines: object[]): Promise<Books> {
  const date = lastDate(books);
  const draft = { id: newId(), voucherTypeId: books.masters.voucherTypes.find((t) => t.baseKind === 'purchase')!.id, date, partyId: steel(books).id, partyDetails: partyDetailsOfParty(steel(books)), purchaseLedgerId: salesLedgerOptions(books.masters, 'purchase')[0]!.id, billNo, dueDate: date, lines };
  // the GST header the engine re-checks: IGST on the rated lines
  const taxable = (lines as { qty: string; rate: string; gstRate?: string }[]).filter((l) => l.gstRate).reduce((t, l) => t + Number(l.qty) * Number(l.rate), 0);
  const posted = await books.post({ ...draft, ...(taxable > 0 ? { gst: { supplyState: '24', placeOfSupply: books.masters.company.stateCode, cgst: '0', sgst: '0', igst: String((taxable * 18) / 100) } } : {}) } as never);
  if (!posted.ok) throw new Error(JSON.stringify(posted.issues));
  return host.current!;
}

const row = (books: Books, over: Partial<Gstr2bRow> & { number: string }): Gstr2bRow => ({
  key: `file:${over.number}`,
  status: 'not-in-books',
  gstin: steel(books).gstin as string,
  supplier: 'STEEL SUPPLIES PRIVATE LIMITED',
  fileDate: lastDate(books),
  file: { taxable: money(100_000n), cgst: money(0n), sgst: money(0n), igst: money(18_000n) },
  tax: money(18_000n),
  note: '',
  ...over,
});

const entryOf = (books: Books) => {
  const ledger = salesLedgerOptions(books.masters, 'purchase')[0]!;
  return { text: 'Cutting charges', unit: '', hsn: '998898', ledgerId: ledger.id, ledgerLabel: ledger.name };
};
const run = (books: Books, rows: Gstr2bRow[]) => bulkPurchases({ rows, entry: entryOf(books), masters: books.masters, stock: books.stock, orders: books.orders, vouchers: books.vouchers, newId });

describe('the line to repeat', () => {
  it('is the supplier’s latest purchase when that is one written line; a purchase of stock items is not repeated', async () => {
    const { host, books } = await demo();
    expect(templateOf(books.vouchers, books.masters, steel(books).gstin as string)).toBeUndefined(); // nothing bought yet
    const main = books.masters.warehouses.find((w) => w.isActive)!.id;
    const withItem = await buy(host, books, 'SS/1', [{ itemId: id('stockItem', 'MS Sheet 2mm'), warehouseId: main, qty: '10', rate: '59', gstRate: '18', hsn: '7208' }]);
    expect(templateOf(withItem.vouchers, withItem.masters, steel(withItem).gstin as string)).toBeUndefined();
    const withText = await buy(host, withItem, 'SS/2', [{ description: 'Cutting charges', unit: 'Nos', qty: '1', rate: '500', gstRate: '18', hsn: '998898' }]);
    expect(templateOf(withText.vouchers, withText.masters, steel(withText).gstin as string)).toMatchObject({ text: 'Cutting charges', unit: 'Nos', hsn: '998898', ledgerLabel: 'Purchase - Raw Material' });
    expect(templateOf(withText.vouchers, withText.masters, '27AAAAA0000A1Z5')).toBeUndefined();
  });

  it('a ledger is named exactly, or by the only one that starts so', () => {
    const options = [{ id: '1', name: 'Cash', sub: '' }, { id: '2', name: 'Petty Cash Box', sub: '' }, { id: '3', name: 'Purchase - Raw Material', sub: '' }];
    expect(optionByName(options, 'cash')?.id).toBe('1');
    expect(optionByName(options, 'pur')?.id).toBe('3');
    expect(optionByName(options, 'p')).toBeUndefined(); // two start with p
    expect(optionByName(options, '')).toBeUndefined();
  });
});

describe('the purchases for a supplier’s missing invoices', () => {
  it('one written line each for the file’s taxable value, at the rate its tax implies; under reverse charge, no GST', async () => {
    const { books } = await demo();
    const { ready, leftOut } = run(books, [row(books, { number: 'G-1' }), row(books, { number: 'G-2', reverseCharge: true, file: { taxable: money(24_500n), cgst: money(613n), sgst: money(612n), igst: money(0n) } })]);
    expect(leftOut).toEqual([]);
    expect(ready.map((r) => [r.row.number, r.taxable, r.tax, r.total])).toEqual([
      ['G-1', 100_000n, 18_000n, 118_000n],
      ['G-2', 24_500n, 0n, 24_500n],
    ]);
    expect(ready[0]?.draft).toMatchObject({ billNo: 'G-1', date: lastDate(books), partyId: steel(books).id, lines: [{ description: 'Cutting charges', hsn: '998898', qty: '1', rate: '1000.00', gstRate: '18' }] });
    expect((ready[1]?.draft['lines'] as object[])[0]).not.toHaveProperty('gstRate');
    expect(ready[1]?.draft).not.toHaveProperty('gst');
    // and they post
    for (const one of ready) expect((await books.post(one.draft)).ok).toBe(true);
  });

  it('leaves out, with the reason: a number the supplier already has, an unknown GSTIN, a date outside the years, GST that is not the file’s', async () => {
    const { host, books } = await demo();
    const after = await buy(host, books, 'SS/2', [{ description: 'Cutting charges', qty: '1', rate: '500', gstRate: '18' }]);
    const { ready, leftOut } = run(after, [
      row(after, { number: 'SS/2' }),
      row(after, { number: 'X-1', gstin: '27AAAAA0000A1Z5' }),
      row(after, { number: 'X-2', fileDate: '1999-01-01' as never }),
      row(after, { number: 'X-3', file: { taxable: money(100_000n), cgst: money(9_000n), sgst: money(9_000n), igst: money(0n) } }), // the file says CGST + SGST; this supplier is in another state
      row(after, { number: 'X-4', file: { taxable: money(100_000n), cgst: money(0n), sgst: money(0n), igst: money(17_000n) } }), // 17% is no GST rate
      row(after, { number: 'OK-1' }),
      row(after, { number: 'ok-1' }),
    ]);
    expect(ready.map((r) => r.row.number)).toEqual(['OK-1']);
    expect(leftOut.map((x) => [x.row.number, x.reason.slice(0, 22)])).toEqual([
      ['SS/2', 'Invoice SS/2 is alread'],
      ['X-1', 'No supplier with GSTIN'],
      ['X-2', 'Its date is outside th'],
      ['X-3', 'Its GST would come to '],
      ['X-4', 'Its GST fits no single'],
      ['ok-1', 'The file has this numb'],
    ]);
  });
});
