import { MemoryBackend } from '@minimalerp/adapter-memory';
import { deterministicUuid } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { docProfile, invoiceKindOf, orderKindOf } from './kinds';
import {
  blankSalesForm,
  customerOptions,
  defaultSalesLedger,
  formToSalesDraft,
  invoiceFormFromOrder,
  isBlankSales,
  openOrderLines,
  openOrdersOf,
  orderCallName,
  partyDetailsOfParty,
  previewSales,
  salesFormFromVoucher,
  salesLedgerOptions,
  switchSales,
} from './salesModel';

const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);
const steel = () => id('party', 'Steel Supplies Pvt Ltd');

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const typeOf = (books: Books, base: string) => books.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;
const purchaseOrder = (books: Books) => books.vouchers.find((v) => books.masters.voucherType(v.voucherTypeId)?.baseKind === 'purchaseOrder');
const main = (books: Books) => {
  const w = books.masters.warehouses.find((x) => x.isActive);
  return { id: w?.id as string, label: w?.name as string };
};

describe('the four documents: what differs is one profile', () => {
  it('sales faces the customer, purchase the supplier; an invoice and its order pair up on each side', () => {
    expect(docProfile('sales')).toMatchObject({ side: 'sales', invoice: true, role: 'customer', noun: 'customer', ledgerGroup: 'sales-accounts', refLabel: 'Cust PO / ref', done: 'delivered' });
    expect(docProfile('purchase')).toMatchObject({ side: 'purchase', invoice: true, role: 'vendor', noun: 'supplier', ledgerGroup: 'purchase-accounts', refLabel: 'PO / ref', done: 'received' });
    expect(docProfile('purchaseOrder')).toMatchObject({ order: true, invoice: false, refLabel: 'Supplier ref' });
    expect([invoiceKindOf('purchase'), orderKindOf('purchase'), invoiceKindOf('sales'), orderKindOf('sales')]).toEqual(['purchase', 'purchaseOrder', 'sales', 'salesOrder']);
  });

  it('the party and ledger pickers follow the side', async () => {
    const books = await demo();
    expect(customerOptions(books.masters, 'purchase').map((o) => o.name)).toEqual(expect.arrayContaining(['Steel Supplies Pvt Ltd', 'Bharat Chemicals', 'Kumar Engineering Works']));
    expect(customerOptions(books.masters, 'purchase').map((o) => o.name)).not.toContain('ABC Industries');
    expect(customerOptions(books.masters, 'sales').map((o) => o.name)).not.toContain('Steel Supplies Pvt Ltd');
    expect(salesLedgerOptions(books.masters, 'purchase').map((o) => o.name)).toEqual(['Purchase - Raw Material']);
    expect(defaultSalesLedger(books.masters, 'purchase')?.label).toBe('Purchase - Raw Material');
    expect(defaultSalesLedger(books.masters, 'sales')?.label).toBe('Sales - Domestic');
  });
});

describe('a purchase invoice form', () => {
  it('builds the purchase draft: the purchase ledger, the supplier’s invoice number and the due date', async () => {
    const books = await demo();
    const form = { ...blankSalesForm('p1', typeOf(books, 'purchase'), '2026-06-01', 'k1', { warehouse: main(books), salesLedger: defaultSalesLedger(books.masters, 'purchase') }), partyId: steel(), partyLabel: 'Steel Supplies Pvt Ltd', billNo: ' SS/901 ' };
    form.lines = [{ ...form.lines[0]!, itemId: id('stockItem', 'MS Sheet 2mm'), itemLabel: 'MS Sheet 2mm', qty: '100', rate: '59' }];
    const { draft } = formToSalesDraft(form, 'purchase');
    expect(draft).toMatchObject({ purchaseLedgerId: form.salesLedgerId, billNo: 'SS/901', dueDate: form.due, partyId: steel() });
    expect(draft).not.toHaveProperty('salesLedgerId');
    expect((draft.lines as { warehouseId: string }[])[0]?.warehouseId).toBe(main(books).id);
  });

  it('asks for the supplier invoice number where it belongs, then accepts a complete form', async () => {
    const books = await demo();
    const typeId = typeOf(books, 'purchase');
    const base = { ...blankSalesForm('p1', typeId, '2026-06-01', 'k1', { warehouse: main(books), salesLedger: defaultSalesLedger(books.masters, 'purchase') }), partyId: steel(), partyLabel: 'Steel Supplies Pvt Ltd', partyDetails: partyDetailsOfParty(books.masters.party(steel() as never)!) };
    const line = { ...base.lines[0]!, itemId: id('stockItem', 'MS Sheet 2mm'), itemLabel: 'MS Sheet 2mm', qty: '100', rate: '59' };
    const missing = previewSales({ ...base, lines: [line] }, 'purchase', books.masters, books.stock, books.orders);
    expect(missing.ok).toBe(false);
    expect(missing.issues).toContainEqual({ field: 'billno', message: 'Enter the supplier’s invoice number' });
    const ok = previewSales({ ...base, billNo: 'SS/901', lines: [line] }, 'purchase', books.masters, books.stock, books.orders, undefined, books.vouchers);
    expect(ok.issues).toEqual([]);
    expect(ok.total).toBe(590000n); // 100 × 59.00
  });

  it('a supplier invoice number the supplier already has is refused on its own field', async () => {
    const books = await demo();
    // BC-77 is a bill of Bharat Chemicals (posted by the demo's journal)
    const bharat = id('party', 'Bharat Chemicals');
    const form = { ...blankSalesForm('p2', typeOf(books, 'purchase'), '2026-06-01', 'k1', { warehouse: main(books), salesLedger: defaultSalesLedger(books.masters, 'purchase') }), partyId: bharat, partyLabel: 'Bharat Chemicals', partyDetails: partyDetailsOfParty(books.masters.party(bharat as never)!), billNo: 'BC-77' };
    form.lines = [{ ...form.lines[0]!, itemId: id('stockItem', 'MS Sheet 2mm'), itemLabel: 'MS Sheet 2mm', qty: '1', rate: '1' }];
    const r = previewSales(form, 'purchase', books.masters, books.stock, books.orders, undefined, books.vouchers);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ field: 'billno', code: 'BILL_REF_IN_USE' });
    expect(previewSales({ ...form, billNo: 'BC-78' }, 'purchase', books.masters, books.stock, books.orders, undefined, books.vouchers).ok).toBe(true);
  });
});

describe('the demo’s purchase order and invoicing what is pending on it', () => {
  it('is a document of the purchase side: it commits no stock, it is on order', async () => {
    const books = await demo();
    const po = purchaseOrder(books)!;
    expect(books.orders.state(po.id)?.order.side).toBe('purchase');
    expect(books.orders.committedByItem().get(id('stockItem', 'MS Sheet 2mm') as never)).toBeUndefined();
    expect(books.orders.onOrderByItem().get(id('stockItem', 'MS Sheet 2mm') as never)).toBe(10_000_000n); // 1,000 Kg
  });

  it('offers only the supplier’s open purchase orders (never a customer’s sales orders)', async () => {
    const books = await demo();
    const mine = openOrdersOf(books.orders, steel(), 'new', 'purchase');
    expect(mine).toHaveLength(1);
    expect(orderCallName(mine[0]!, 'purchase')).toBe(mine[0]?.number); // on the purchase side a PO is called by OUR number
    expect(openOrdersOf(books.orders, steel(), 'new', 'sales')).toEqual([]);
    expect(openOrderLines(books.orders, steel(), undefined, 'new', 'purchase').map((l) => l.pending)).toEqual([10_000_000n, 5_000_000n]);
  });

  it('invoiceFormFromOrder makes a purchase invoice of what is pending: the supplier, our PO number, a line per pending line, the purchase ledger — and the supplier inv no. left for the person', async () => {
    const books = await demo();
    const po = purchaseOrder(books)!;
    const form = invoiceFormFromOrder(po, books.orders, books.masters, { id: 'new', typeId: typeOf(books, 'purchase'), date: '2026-06-20', newKey: () => crypto.randomUUID(), warehouse: main(books), salesLedger: defaultSalesLedger(books.masters, 'purchase'), stock: books.stock });
    expect(form).toBeDefined();
    expect(form).toMatchObject({ partyId: steel(), reference: po.number, billNo: '', salesLedgerLabel: 'Purchase - Raw Material' });
    expect(form?.lines.map((l) => [l.itemLabel, l.qty, l.rate, l.warehouseLabel])).toEqual([
      ['MS Sheet 2mm', '1000', '59', main(books).label],
      ['MS Rod 12mm', '500', '63.5', main(books).label],
    ]);
    // with a supplier invoice number it is a valid purchase invoice against the PO
    const r = previewSales({ ...form!, billNo: 'SS/1001' }, 'purchase', books.masters, books.stock, books.orders, undefined, books.vouchers);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('receiving more than is pending is refused on the quantity cell, in the words of the purchase side', async () => {
    const books = await demo();
    const po = purchaseOrder(books)!;
    const form = invoiceFormFromOrder(po, books.orders, books.masters, { id: 'new', typeId: typeOf(books, 'purchase'), date: '2026-06-20', newKey: () => crypto.randomUUID(), warehouse: main(books), salesLedger: defaultSalesLedger(books.masters, 'purchase') })!;
    form.billNo = 'SS/1002';
    form.lines = form.lines.map((l, i) => (i === 0 ? { ...l, qty: '1200' } : l));
    const r = previewSales(form, 'purchase', books.masters, books.stock, books.orders, undefined, books.vouchers);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ field: 'line.0.qty', code: 'OVER_DELIVERY' });
    expect(r.issues[0]?.message).toContain('receiving');
  });

  it('shows the order back the way it was entered: the supplier reference, lines and due dates', async () => {
    const books = await demo();
    const po = purchaseOrder(books)!;
    const form = salesFormFromVoucher(po, books.masters, books.orders);
    expect(form).toMatchObject({ partyId: steel(), reference: 'SS/Q/31' });
    expect(form.lines.map((l) => [l.itemLabel, l.qty])).toEqual([['MS Sheet 2mm', '1000'], ['MS Rod 12mm', '500']]);
    expect(isBlankSales(form)).toBe(false);
  });
});

describe('switching between a purchase order and its invoice', () => {
  it('keeps the supplier, reference and lines; the order’s due dates are replaced by godowns and the supplier’s bill fields', async () => {
    const books = await demo();
    const orderForm = { ...blankSalesForm('o1', typeOf(books, 'purchaseOrder'), '2026-06-01', 'k1'), partyId: steel(), partyLabel: 'Steel Supplies Pvt Ltd', reference: 'Q-9' };
    orderForm.lines = [{ ...orderForm.lines[0]!, itemId: id('stockItem', 'MS Sheet 2mm'), itemLabel: 'MS Sheet 2mm', qty: '100', rate: '59' }];
    const s = switchSales(orderForm, 'purchaseOrder', 'purchase', typeOf(books, 'purchase'), books.masters, { warehouse: main(books), salesLedger: defaultSalesLedger(books.masters, 'purchase') });
    expect(s.form).toMatchObject({ partyId: steel(), reference: 'Q-9', salesLedgerLabel: 'Purchase - Raw Material', billNo: '' });
    expect(s.form.lines[0]).toMatchObject({ itemLabel: 'MS Sheet 2mm', qty: '100', rate: '59', due: '', warehouseLabel: main(books).label });
    expect(s.note).toContain('due dates');
  });
});
