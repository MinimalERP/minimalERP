import { MemoryBackend } from '@minimalerp/adapter-memory';
import { deterministicUuid, localDate } from '@minimalerp/domain';
import type { InboxItem } from '@minimalerp/ports';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { orderRegisterRows } from '../reports/salesReports';
import { previewSales } from '../vouchers/salesModel';
import { TRANSACTION_GROUPS, dayBook, docList, docView, inStockTab, itemList, orderRegister } from './data';
import { entryKindOfProposal, invoiceFrom, lastRate, lineFor, needsItem, newForm, shipChoices, shipChosen, startForm, withItem, withParty, withShipTo } from './entry';
import { noteWaiting, refreshWaiting, scanProblem, scanSummary, scanWaiting, unread } from './scan';

const TODAY = '2026-06-30';
const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);
const STEEL = id('party', 'Steel Supplies Pvt Ltd');
const OIL = id('stockItem', 'Machine Oil');

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}
const judge = (books: Books, kind: Parameters<typeof previewSales>[1], form: Parameters<typeof previewSales>[0]) => previewSales(form, kind, books.masters, books.stock, books.orders, undefined, books.vouchers);

describe('Scan: what was read waits, and opens as a form to check', () => {
  it('a supplier’s bill read with a known supplier and one unknown line: the form is the desktop’s, the unknown line waits for its item, and it saves as a Purchase under the document’s id', async () => {
    const books = await demo();
    const sent = await books.sendDocument('purchase', {
      extraction: { partyName: 'Steel Supplies Pvt Ltd', date: '2026-06-12', invoiceNumber: 'SS/4411', lines: [{ description: 'Lubricating oil 5L can', qty: '4', rate: '210' }] } as never,
    });
    expect(sent.ok).toBe(true);
    const waiting = (await books.inbox()) as { ok: true; value: readonly InboxItem[] };
    expect(waiting.value).toHaveLength(1);
    const item = waiting.value[0]!;
    expect(entryKindOfProposal(item)).toBe('purchase');
    expect(unread(item)).toBe(false);
    const said = scanSummary(item);
    expect(said.title).toBe('Steel Supplies Pvt Ltd');
    expect(said.sub).toContain('Purchase bill');
    expect(said.value).toBe('1 line');
    expect(said.attention).toBe(true); // the line was not matched to an item: the row says "Check"

    const form = startForm(books, { kind: 'purchase', proposal: item })!;
    expect(form.id).toBe(item.id); // it can only ever be posted once
    expect(form.partyId).toBe(STEEL);
    expect(form.billNo).toBe('SS/4411');
    expect(form.lines).toHaveLength(1);
    expect(needsItem(form.lines[0]!)).toBe(true);
    expect(form.lines[0]!.itemLabel).toBe('Lubricating oil 5L can'); // the document's own words
    expect(judge(books, 'purchase', form).ok).toBe(false);

    // the person says which item it is: the quantity and rate the bill printed stay
    const named = { ...form, lines: [withItem(books, 'purchase', form, form.lines[0]!, OIL)] };
    expect(named.lines[0]).toMatchObject({ itemId: OIL, itemLabel: 'Machine Oil', qty: '4', rate: '210', warehouseLabel: 'Main Location' });
    const verdict = judge(books, 'purchase', named);
    expect(verdict.issues).toEqual([]);
    const posted = await books.post(verdict.draft);
    if (!posted.ok) throw new Error(JSON.stringify(posted.issues));
    expect(posted.value.voucher.id).toBe(item.id);
    expect(posted.value.voucher.number).toMatch(/^PUR\//);
    expect(((await books.inbox()) as { value: readonly unknown[] }).value).toHaveLength(0); // saved: it has left the list
    expect(books.stock.qtyAt(OIL as never, books.masters.warehouses.find((w) => w.name === 'Main Location')!.id, localDate(TODAY))).toBe(840000n); // 80 + 4
  });

  it('a receipt or payment that was read is not opened on the phone; files that cannot be read are refused before anything is sent', async () => {
    const books = await demo();
    await books.sendDocument('receipt', { extraction: { partyName: 'ABC Industries', date: '2026-06-12', amount: '5000' } as never });
    const [item] = ((await books.inbox()) as { value: readonly InboxItem[] }).value;
    expect(entryKindOfProposal(item!)).toBeUndefined();
    expect(scanSummary(item!).value).toMatch(/^₹ 5000(\.00)?$/);
    expect(scanProblem({ name: 'bill.pdf', type: 'application/pdf', size: 1000 })).toBeUndefined();
    expect(scanProblem({ name: 'bill.jpg', type: 'image/jpeg', size: 1000 })).toBeUndefined();
    expect(scanProblem({ name: 'bill.docx', type: 'application/msword', size: 1000 })).toContain('not a PDF or a picture');
    expect(scanProblem({ name: 'big.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 })).toContain('larger than 10 MB');
  });

  it('the Gateway’s waiting count is what was last known, and is asked for at most once a minute', async () => {
    const books = await demo();
    expect(scanWaiting(books)).toBeUndefined();
    expect(await refreshWaiting(books, 1_000)).toBe(0);
    await books.sendDocument('purchase', { extraction: { partyName: 'Steel Supplies Pvt Ltd', date: '2026-06-12', invoiceNumber: 'A1', lines: [{ description: 'Oil', qty: '1', rate: '10' }] } as never });
    expect(await refreshWaiting(books, 30_000)).toBe(0); // within the minute: not asked again
    expect(await refreshWaiting(books, 62_000)).toBe(1);
    noteWaiting(books, 3);
    expect(scanWaiting(books)).toBe(3);
  });
});

describe('a Purchase bill by touch', () => {
  it('starts with the purchase ledger; an item comes in at what this supplier last charged, into the main godown; the supplier’s number is needed and used once', async () => {
    const books = await demo();
    const blank = newForm(books, 'purchase')!;
    expect(blank.salesLedgerLabel).toBe('Purchase - Raw Material');
    const form = withParty(blank, 'purchase', books, STEEL);
    const first = { ...lineFor(books, 'purchase', form, OIL), rate: '200' };
    expect(first).toMatchObject({ qty: '1', warehouseLabel: 'Main Location' });
    expect(lastRate(books, OIL, STEEL, 'purchase')).toBe(''); // never bought yet
    const noNumber = judge(books, 'purchase', { ...form, lines: [first] });
    expect(noNumber.issues.map((i) => i.field)).toEqual(['billno']);
    const ok = judge(books, 'purchase', { ...form, billNo: 'SS/1', lines: [first] });
    expect(ok.issues).toEqual([]);
    expect((await books.post(ok.draft)).ok).toBe(true);
    expect(lastRate(books, OIL, STEEL, 'purchase')).toBe('200');
    expect(lineFor(books, 'purchase', form, OIL).rate).toBe('200');
    // the same supplier invoice number again is refused, on its field
    const again = judge(books, 'purchase', { ...withParty(newForm(books, 'purchase')!, 'purchase', books, STEEL), billNo: 'SS/1', lines: [first] });
    expect(again.issues.map((i) => i.field)).toEqual(['billno']);
    // an open purchase order can be billed from the phone
    const po = books.voucher(docList(books, 'purchaseOrder', TODAY)[0]!.voucherId)!;
    expect(invoiceFrom(books, po)).toBe('Bill received');
    const received = startForm(books, { kind: 'purchase', fromOrder: po.id })!;
    expect(received.lines.length).toBeGreaterThan(0);
    expect(received.lines.every((l) => l.orderId === po.id)).toBe(true);
  });
});

describe('reports and lists on the phone', () => {
  it('the Sales Order Register is the desktop register’s rows, newest order first; the Day Book is one day’s vouchers', async () => {
    const books = await demo();
    const first = books.masters.financialYears[0]!.start;
    const desktop = orderRegisterRows(books.orders, books.masters, first, localDate('9999-12-31'), { side: 'sales', asOf: localDate(TODAY) });
    expect(orderRegister(books, 'sales', TODAY)).toEqual([...desktop].reverse());
    expect(orderRegister(books, 'sales', TODAY).some((r) => r.reference === 'PO-4471' && r.actionable)).toBe(true);
    expect(orderRegister(books, 'purchase', TODAY).length).toBeGreaterThan(0);
    const invoice = docList(books, 'sales', TODAY)[0]!;
    expect(dayBook(books, invoice.date).map((r) => r.voucherId)).toContain(invoice.voucherId);
    expect(dayBook(books, '2030-01-01')).toEqual([]);
  });

  it('a sales order’s list row carries the customer’s PO; Stock has tabs for what is committed and what is on order; a Stock Journal shows what moved', async () => {
    const books = await demo();
    expect(docList(books, 'salesOrder', TODAY).map((r) => r.reference)).toEqual(expect.arrayContaining(['PO-4471', 'KEW-12']));
    const items = itemList(books, TODAY);
    const committed = items.filter((r) => inStockTab(r, 'committed'));
    expect(committed.length).toBeGreaterThan(0);
    expect(committed.every((r) => r.committed > 0n)).toBe(true);
    expect(items.filter((r) => inStockTab(r, 'onOrder')).every((r) => r.onOrder > 0n)).toBe(true);
    expect(items.filter((r) => inStockTab(r, 'all'))).toHaveLength(items.length);
    expect(TRANSACTION_GROUPS.map((g) => g.group)).toEqual(['Sales', 'Purchase', 'Inventory', 'General']);
    const journal = docList(books, 'stockJournal', TODAY)[0];
    if (journal) {
      const view = docView(books, journal.voucherId)!;
      expect(view.item).toBeUndefined();
      expect((view.stock ?? []).length).toBeGreaterThan(0);
    }
  });
});

describe('where a sales document is shipped', () => {
  it('offers the party’s own addresses; the place of supply follows where the goods go, and the engine still accepts the document', async () => {
    const books = await demo();
    const kumar = books.masters.party(id('party', 'Kumar Engineering Works') as never)!;
    const choices = shipChoices(kumar);
    expect(choices.map((c) => c.id)).toEqual(['same', 'own']); // its billing address, and the unit it ships to
    const form = withParty(newForm(books, 'sales')!, 'sales', books, kumar.id);
    expect(shipChosen(kumar, form.partyDetails)).toBe('own'); // a party with a shipping address starts shipped there, as on the desktop
    const billed = withShipTo(form, kumar, 'same');
    expect(billed.partyDetails?.shipTo).toBeUndefined();
    expect(billed.partyDetails?.placeOfSupply).toBe(billed.partyDetails?.billTo?.stateCode);
    expect(shipChosen(kumar, billed.partyDetails)).toBe('same');
    const shipped = withShipTo(billed, kumar, 'own');
    expect(shipped.partyDetails?.shipTo).toMatchObject({ name: 'Kumar Engineering Works', lines: kumar.shipping?.lines });
    expect(shipped.partyDetails?.placeOfSupply).toBe(kumar.shipping?.stateCode ?? shipped.partyDetails?.billTo?.stateCode);
    expect(shipped.partyDetails?.gstin).toBe(form.partyDetails?.gstin); // nothing else about the party changed
    const line = { ...lineFor(books, 'sales', shipped, OIL), rate: '250' };
    expect(judge(books, 'sales', { ...shipped, lines: [line] }).issues).toEqual([]);
    expect(judge(books, 'sales', { ...billed, lines: [line] }).issues).toEqual([]);
    // a party with one address has only "Same as billing"
    const abc = books.masters.party(id('party', 'ABC Industries') as never)!;
    expect(shipChoices(abc).map((c) => c.id)).toEqual(['same']);
  });
});
