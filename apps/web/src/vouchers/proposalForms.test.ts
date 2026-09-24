import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type IntakeKind, customerLedgerOf, deterministicUuid, extractionSchema, localDate, openBills, proposeFromExtraction } from '@minimalerp/domain';
import type { InboxItem } from '@minimalerp/ports';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { formToDraft } from './model';
import { entryFormFromProposal, inboxBanner, itemSeedOf, partySeedOf, salesFormFromProposal } from './proposalForms';
import { defaultSalesLedger, formToSalesDraft } from './salesModel';

const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const typeOf = (books: Books, base: string) => books.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;
const main = (books: Books) => {
  const w = books.masters.warehouses.find((x) => x.isActive);
  return { id: w?.id as string, label: w?.name as string };
};

/** What the `intake` function makes of a document, as it lands in the inbox. */
function inboxItem(books: Books, kind: IntakeKind, reading: Record<string, unknown>, subject = 'PO from customer'): InboxItem {
  const proposal = proposeFromExtraction(kind, extractionSchema.parse(reading), { masters: books.masters, vouchers: books.vouchers, orders: books.orders, today: localDate(books.vouchers[0]?.date ?? '2024-04-01') });
  return { id: crypto.randomUUID(), kind, proposal, mailSubject: subject, createdAt: '2024-05-01T10:00:00Z' };
}

const date = (books: Books) => (books.vouchers.at(-1)?.date ?? '2024-04-01') as string;

describe('a customer PO proposal in the Sales Order window', () => {
  it('fills what was matched, keeps the document words where the item is unknown, and posts under the inbox id once an item is chosen', async () => {
    const books = await demo();
    const item = inboxItem(books, 'salesOrder', {
      partyName: 'ABC INDUSTRIES',
      date: date(books),
      poNumber: 'ABC/PO/991',
      lines: [
        { description: 'Hex bolt', code: 'FG-BL-M8', qty: '2000', rate: '6.25' },
        { description: 'Bracket type-B as per drawing 44-B', qty: '50', rate: '41', unit: 'Nos' },
      ],
    });
    const form = salesFormFromProposal(item, books.masters, { typeId: typeOf(books, 'salesOrder'), newKey: () => crypto.randomUUID(), orders: books.orders });
    expect(form.id).toBe(item.id);
    expect(form.partyId).toBe(id('party', 'ABC Industries'));
    expect(form.partyDetails?.gstin).toBeDefined();
    expect(form.reference).toBe('ABC/PO/991');
    expect(form.lines.map((l) => [l.itemId, l.itemLabel, l.qty, l.rate])).toEqual([
      [id('stockItem', 'ABC Hex Bolt M8'), 'ABC Hex Bolt M8', '2000', '6.25'],
      ['', 'Bracket type-B as per drawing 44-B', '50', '41'],
    ]);
    expect(inboxBanner(item)?.text).toContain('is not one of your items');

    // the engine refuses a line that is still only words…
    expect((await books.post(formToSalesDraft(form, 'salesOrder', books.masters).draft)).ok).toBe(false);
    // …and takes it once the person picked the item
    const chosen = { ...form, lines: form.lines.map((l, i) => (i === 1 ? { ...l, itemId: id('stockItem', 'Mounting Bracket'), itemLabel: 'Mounting Bracket' } : l)) };
    const posted = await books.post(formToSalesDraft(chosen, 'salesOrder', books.masters).draft);
    if (!posted.ok) throw new Error(JSON.stringify(posted.issues));
    expect(posted.value.voucher.id).toBe(item.id);
  });

  it('an unknown customer is the document’s name in the party field, and Alt+C would create it from the name, GSTIN and address', async () => {
    const books = await demo();
    const item = inboxItem(books, 'salesOrder', { partyName: 'Zenith Motors', partyGstin: '29AABCZ9999Q1ZX', partyAddress: 'Hosur Road, Bengaluru', date: date(books), lines: [] });
    const form = salesFormFromProposal(item, books.masters, { typeId: typeOf(books, 'salesOrder'), newKey: () => crypto.randomUUID(), orders: books.orders });
    expect([form.partyId, form.partyLabel]).toEqual(['', 'Zenith Motors']);
    expect(partySeedOf(item.proposal)).toEqual({ name: 'Zenith Motors', gstin: '29AABCZ9999Q1ZX', address: 'Hosur Road, Bengaluru' });
  });
});

describe("a supplier's bill proposal in the Purchase window", () => {
  it("brings the supplier's invoice number, the purchase ledger and the godown, and posts", async () => {
    const books = await demo();
    const item = inboxItem(books, 'purchase', {
      partyName: 'Steel Supplies Pvt Ltd',
      date: date(books),
      invoiceNumber: 'SSP/24-25/0771',
      lines: [{ description: 'MS SHEET 2 MM', code: 'RM-SH-2', hsn: '7208', qty: '500', rate: '59.5', gstRate: '18' }],
    });
    const form = salesFormFromProposal(item, books.masters, {
      typeId: typeOf(books, 'purchase'),
      newKey: () => crypto.randomUUID(),
      orders: books.orders,
      warehouse: main(books),
      salesLedger: defaultSalesLedger(books.masters, 'purchase'),
    });
    expect(form.billNo).toBe('SSP/24-25/0771');
    expect(form.salesLedgerLabel).toBe('Purchase - Raw Material');
    expect(form.lines[0]).toMatchObject({ itemId: id('stockItem', 'MS Sheet 2mm'), warehouseId: main(books).id, qty: '500', rate: '59.5' });
    const posted = await books.post(formToSalesDraft(form, 'purchase', books.masters).draft);
    if (!posted.ok) throw new Error(JSON.stringify(posted.issues));
    expect(posted.value.voucher.id).toBe(item.id);
  });

  it('a new item made from a line starts with its HSN, GST rate and unit', async () => {
    const books = await demo();
    const seed = itemSeedOf(books.masters, { itemLabel: 'SS Washer M8', hsn: '7318', gstRate: '18' }, 'nos.');
    const eighteen = books.masters.gstRates.find((r) => r.ratePercent === '18')?.id;
    const nos = books.masters.units.find((u) => u.symbol === 'Nos')?.id;
    expect(seed).toEqual({ name: 'SS Washer M8', hsn: '7318', gstRateId: eighteen, unitId: nos });
    expect(eighteen && nos).toBeTruthy();
    expect(itemSeedOf(books.masters, { itemLabel: 'Thing', hsn: 'n/a', gstRate: '7' })).toEqual({ name: 'Thing' });
    // "<part number> - <description>": the part number becomes the new item's code
    expect(itemSeedOf(books.masters, { itemLabel: '841012179 - Linkage with Lever' })).toEqual({ name: '841012179 - Linkage with Lever', code: '841012179' });
    expect(itemSeedOf(books.masters, { itemLabel: 'Bracket - type B' })).toEqual({ name: 'Bracket - type B' }); // no digits: not a part number
  });
});

describe('a payment advice proposal in the Receipt window', () => {
  it('settles the open bill it names — TDS beside it — through the bank it was paid into, and posts', async () => {
    const books = await demo();
    const abc = customerLedgerOf(id('party', 'ABC Industries') as never);
    const bill = openBills(books.vouchers, books.masters, abc)[0];
    if (!bill) throw new Error('the demo company should have an open bill of ABC Industries');
    const pending = Number(bill.pending) / 100;
    const tds = Math.round(pending) / 100; // 1%
    const item = inboxItem(books, 'receipt', {
      partyName: 'ABC Industries',
      date: date(books),
      amount: String(pending - tds),
      instrument: 'UTR HDFCN52024999',
      bankAccount: 'HDFC',
      bills: [{ ref: bill.ref, amount: String(pending), tds: String(tds) }],
    });
    const form = entryFormFromProposal(item, books.masters, typeOf(books, 'receipt'));
    expect(form.lines[0]?.ledgerId).toBe(abc);
    expect(form.lines[0]?.allocations).toEqual([expect.objectContaining({ kind: 'against', ref: bill.ref })]);
    expect(form.narration).toBe('Ref UTR HDFCN52024999');
    // the demo has more than one bank: the person picks it when the advice does not say which
    const bank = form.accountId || (books.masters.ledgers.find((l) => l.name === 'HDFC Bank Current A/c')?.id as string);
    const posted = await books.post(formToDraft({ ...form, accountId: bank }, 'single-entry').draft);
    if (!posted.ok) throw new Error(JSON.stringify(posted.issues));
    expect(posted.value.voucher.id).toBe(item.id);
    expect(openBills(books.vouchers, books.masters, abc).find((b) => b.ref === bill.ref)).toBeUndefined();
  });
});

describe('the inbox of books kept in this browser', () => {
  it('is empty until something is put in; posting the proposal takes it out', async () => {
    const books = await demo();
    expect(await books.inbox()).toEqual({ ok: true, value: [] });
    const item = inboxItem(books, 'salesOrder', { partyName: 'ABC Industries', date: date(books), lines: [{ code: 'FG-BL-M8', qty: '10', rate: '6' }] });
    (books.backend as unknown as MemoryBackend).putInbox(item);
    const one = await books.inbox();
    expect(one.ok && one.value.length).toBe(1);
    const form = salesFormFromProposal(item, books.masters, { typeId: typeOf(books, 'salesOrder'), newKey: () => crypto.randomUUID(), orders: books.orders });
    const posted = await books.post(formToSalesDraft(form, 'salesOrder', books.masters).draft);
    expect(posted.ok).toBe(true);
    expect(await books.inbox()).toEqual({ ok: true, value: [] });
    // and a rejected one simply goes
    (books.backend as unknown as MemoryBackend).putInbox({ ...item, id: crypto.randomUUID() });
    const waiting = await books.inbox();
    if (!waiting.ok || !waiting.value[0]) throw new Error('expected one waiting');
    expect((await books.rejectInbox(waiting.value[0].id)).ok).toBe(true);
    expect(await books.inbox()).toEqual({ ok: true, value: [] });
  });
});
