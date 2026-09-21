import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type BaseKind, applyGridQuery, deterministicUuid, formatMoney, localDate, partyLedgerId } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { addDays } from '../vouchers/format';
import { defaultSalesLedger, invoiceFormFromOrder, previewSales } from '../vouchers/salesModel';
import { listTitle, listTotals, voucherListColumns, voucherListRows, voucherRowClass } from './voucherLists';

const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const rowsOf = (books: Books, kind: BaseKind, asOf = '2000-01-01') =>
  voucherListRows({ vouchers: books.vouchers, lines: books.lines, masters: books.masters, orders: books.orders, kind, asOf: localDate(asOf) });

describe('the voucher lists', () => {
  it('are named the way a person says them', () => {
    expect(listTitle('Sales')).toBe('Sales Vouchers');
    expect(listTitle('Sales Order')).toBe('Sales Orders');
    expect(listTitle('Stock Journal')).toBe('Stock Journal Vouchers');
  });

  it('a sales order is ONE row with an overall status: Open (nothing delivered), Partially filled, Closed (delivered in full)', async () => {
    const books = await demo();
    const rows = rowsOf(books, 'salesOrder');
    expect(rows.map((r) => [r.reference, r.status, formatMoney(r.amount)])).toEqual([
      ['PO-4471', 'Partially filled', '57500.00'], // 2,000 × 6.50 + 300 × 55 + 20 × 1,400 (its bolts are delivered, its brackets partly, its frames not at all)
      ['SH/PO/88', 'Closed', '10400.00'], // delivered in full
      ['KEW-12', 'Open', '5400.00'], // nothing delivered yet
    ]);
    expect(rows.map((r) => voucherRowClass(r))).toEqual(['open-line', 'closed-order', 'open-line']);
  });

  it('closing an order by hand closes it whatever was delivered; cancelling an invoice takes an order back to Open', async () => {
    const books = await demo();
    const kumar = books.vouchers.find((v) => (v.content as { reference?: string }).reference === 'KEW-12');
    expect((await books.alter(kumar?.id as string, kumar?.version as number, { ...(kumar?.content as object), closed: true })).ok).toBe(true);
    expect(rowsOf(books, 'salesOrder').find((r) => r.reference === 'KEW-12')?.status).toBe('Closed');
    const abc = books.vouchers.find((v) => books.masters.voucherType(v.voucherTypeId)?.baseKind === 'sales' && (v.content as { partyId?: string }).partyId === id('party', 'ABC Industries'));
    expect((await books.cancel(abc?.id as string, abc?.version as number)).ok).toBe(true);
    expect(rowsOf(books, 'salesOrder').find((r) => r.reference === 'PO-4471')?.status).toBe('Open');
  });

  it('an invoice is Open until it falls due, Overdue after, and Paid once a receipt settles its bill', async () => {
    const books = await demo();
    const start = books.masters.financialYears[0]?.start as string;
    const invoices = (asOf: string) => rowsOf(books, 'sales', asOf).map((r) => [r.particulars, r.status, formatMoney(r.pending)]);
    // ABC's invoice is dated day 44 with 30 credit days (due day 74); Sharma's day 48 with 45 (due day 93)
    expect(invoices(addDays(start, 60))).toEqual([['ABC Industries', 'Open', '19600.00'], ['Sharma Traders', 'Open', '10400.00']]);
    expect(invoices(addDays(start, 80))).toEqual([['ABC Industries', 'Overdue', '19600.00'], ['Sharma Traders', 'Open', '10400.00']]);
    expect(invoices(addDays(start, 100)).map((r) => r[1])).toEqual(['Overdue', 'Overdue']);

    const number = rowsOf(books, 'sales').find((r) => r.particulars === 'ABC Industries')?.number as string;
    const paid = await books.post({
      id: deterministicUuid('test|receipt'),
      voucherTypeId: books.masters.voucherTypes.find((t) => t.baseKind === 'receipt')?.id,
      date: addDays(start, 70),
      accountLedgerId: id('ledger', 'HDFC Bank Current A/c'),
      lines: [{ ledgerId: partyLedgerId(id('party', 'ABC Industries'), 'customer'), amount: '19600', allocations: [{ kind: 'against', ref: number, amount: '19600' }] }],
    });
    expect(paid.ok).toBe(true);
    expect(invoices(addDays(start, 100))[0]).toEqual(['ABC Industries', 'Paid', '0.00']); // settled: no longer overdue
    expect(voucherRowClass(rowsOf(books, 'sales', addDays(start, 100))[0] as never)).toBe('closed-order'); // (rows are oldest first: ABC's)
  });

  it('a cancelled voucher is struck out, has no amount, and does not count in the total', async () => {
    const books = await demo();
    const sharma = books.vouchers.find((v) => books.masters.voucherType(v.voucherTypeId)?.baseKind === 'sales' && (v.content as { partyId?: string }).partyId === id('party', 'Sharma Traders'));
    expect((await books.cancel(sharma?.id as string, sharma?.version as number)).ok).toBe(true);
    const rows = rowsOf(books, 'sales');
    const gone = rows.find((r) => r.particulars === 'Sharma Traders');
    expect([gone?.status, gone?.cancelled, gone?.amount, voucherRowClass(gone as never)]).toEqual(['Cancelled', true, 0n, 'cancelled']);
    expect(listTotals(rows)).toEqual({ count: 2, amount: 1_960_000n, cancelled: 1 });
  });

  it('the other kinds list what they are about: payments by ledgers and amount, stock journals by items with no amount', async () => {
    const books = await demo();
    const pay = rowsOf(books, 'payment');
    expect(pay).toHaveLength(3);
    expect(pay.map((r) => r.status)).toEqual(['', '', '']); // no lifecycle
    expect(voucherListColumns('payment').map((c) => c.id)).toEqual(['date', 'number', 'particulars', 'narration', 'amount']);
    const stock = rowsOf(books, 'stockJournal');
    expect(stock.map((r) => r.particulars)).toEqual(['ABC Hex Bolt M8', 'MS Sheet 2mm (+2 more)']);
    expect(voucherListColumns('stockJournal').map((c) => c.id)).toEqual(['date', 'number', 'particulars', 'narration']);
    expect(voucherListColumns('salesOrder').map((c) => c.id)).toEqual(['date', 'number', 'particulars', 'reference', 'amount', 'status']);
    expect(voucherListColumns('sales').map((c) => c.id)).toEqual(['date', 'number', 'particulars', 'reference', 'amount', 'pending', 'due', 'status']);
  });

  it('is sortable and filterable like every report: the status is a choice, the money columns range', async () => {
    const books = await demo();
    const rows = rowsOf(books, 'salesOrder');
    const cols = voucherListColumns('salesOrder');
    const open = applyGridQuery(rows, cols, { sort: [], filters: { status: { kind: 'in', values: ['Open', 'Partially filled'] } }, quick: '' });
    expect(open.map((r) => r.reference)).toEqual(['PO-4471', 'KEW-12']);
    const big = applyGridQuery(rows, cols, { sort: [{ column: 'amount', dir: 'desc' }], filters: {}, quick: '' });
    expect(big.map((r) => r.reference)).toEqual(['PO-4471', 'SH/PO/88', 'KEW-12']);
    expect(applyGridQuery(rows, cols, { sort: [], filters: {}, quick: 'kumar' }).map((r) => r.reference)).toEqual(['KEW-12']);
  });

  it('respects the period (by the voucher date)', async () => {
    const books = await demo();
    const start = books.masters.financialYears[0]?.start as string;
    const early = voucherListRows({ vouchers: books.vouchers, lines: books.lines, masters: books.masters, orders: books.orders, kind: 'salesOrder', range: { from: localDate(start), to: localDate(addDays(start, 31)) } });
    expect(early.map((r) => r.reference)).toEqual(['PO-4471']);
  });
});

describe('the purchase lists', () => {
  const steel = () => id('party', 'Steel Supplies Pvt Ltd');
  const typeOf = (books: Books, base: string) => books.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;

  /** A purchase invoice for what is pending on the demo's purchase order, posted the way the window posts it. */
  async function receive(books: Books, billNo: string, qty?: string) {
    const po = books.vouchers.find((v) => books.masters.voucherType(v.voucherTypeId)?.baseKind === 'purchaseOrder')!;
    const warehouse = books.masters.warehouses.find((w) => w.isActive)!;
    const form = invoiceFormFromOrder(po, books.orders, books.masters, {
      id: crypto.randomUUID(),
      typeId: typeOf(books, 'purchase'),
      date: addDays(books.masters.financialYears[0]?.start as string, 60),
      newKey: () => crypto.randomUUID(),
      warehouse: { id: warehouse.id, label: warehouse.name },
      salesLedger: defaultSalesLedger(books.masters, 'purchase'),
    })!;
    form.billNo = billNo;
    if (qty) form.lines = form.lines.map((l, i) => (i === 0 ? { ...l, qty } : l));
    const p = previewSales(form, 'purchase', books.masters, books.stock, books.orders, undefined, books.vouchers);
    expect(p.issues).toEqual([]);
    const r = await books.post(p.draft);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value.voucher;
  }

  it('the demo’s purchase order is one row: Open, its value, the supplier’s reference', async () => {
    const books = await demo();
    const rows = rowsOf(books, 'purchaseOrder');
    expect(rows.map((r) => [r.particulars, r.reference, r.status, formatMoney(r.amount)])).toEqual([['Steel Supplies Pvt Ltd', 'SS/Q/31', 'Open', '90750.00']]); // 1,000 × 59 + 500 × 63.50
    expect(voucherListColumns('purchaseOrder').map((c) => [c.id, c.label])).toEqual([['date', 'Date'], ['number', 'Voucher no.'], ['particulars', 'Supplier'], ['reference', 'Supplier ref'], ['amount', 'Order value'], ['status', 'Status']]);
    expect(listTitle('Purchase Order')).toBe('Purchase Orders');
    expect(listTitle('Purchase')).toBe('Purchase Vouchers');
  });

  it('a purchase invoice is a row with the supplier’s invoice number, what is still pending on its bill, when it falls due, and Open / Paid / Overdue', async () => {
    const books = await demo();
    await receive(books, 'SS/1001');
    const rows = rowsOf(books, 'purchase');
    expect(rows.map((r) => [r.particulars, r.billNo, r.status])).toEqual([['Steel Supplies Pvt Ltd', 'SS/1001', 'Open']]);
    expect(rows[0]?.pending).toBe(rows[0]?.amount); // nothing paid yet
    expect(rows[0]?.due).not.toBe('');
    expect(voucherListColumns('purchase').map((c) => c.id)).toEqual(['date', 'number', 'particulars', 'billNo', 'amount', 'pending', 'due', 'status']);
    // long after it falls due it is Overdue
    expect(rowsOf(books, 'purchase', '2099-01-01').map((r) => r.status)).toEqual(['Overdue']);
    // paid against the supplier's number, it is Paid
    const bill = rows[0]!;
    const pay = await books.post({
      id: crypto.randomUUID(),
      voucherTypeId: typeOf(books, 'payment'),
      date: addDays(books.masters.financialYears[0]?.start as string, 70),
      accountLedgerId: books.masters.ledgers.find((l) => l.name === 'HDFC Bank Current A/c')?.id,
      lines: [{ ledgerId: partyLedgerId(steel(), 'vendor'), amount: formatMoney(bill.amount as never), allocations: [{ kind: 'against', ref: 'SS/1001', amount: formatMoney(bill.amount as never) }] }],
    });
    expect(pay.ok).toBe(true);
    expect(rowsOf(books, 'purchase').map((r) => r.status)).toEqual(['Paid']);
  });

  it('a purchase order becomes Partially filled, then Closed as goods are received against it', async () => {
    const books = await demo();
    await receive(books, 'SS/1001', '400'); // 400 of the 1,000 Kg of sheet (the rod line comes too)
    expect(rowsOf(books, 'purchaseOrder').map((r) => r.status)).toEqual(['Partially filled']);
  });
});
