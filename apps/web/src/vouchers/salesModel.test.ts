import { MemoryBackend } from '@minimalerp/adapter-memory';
import { IssueCode, deterministicUuid, formatQty } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from '../books/books';
import { loadDemoCompany } from '../books/demo';
import { createLocalFactory, memoryStore } from '../books/local';
import { addDays } from './format';
import {
  type SalesForm,
  blankSalesForm,
  blankSalesLine,
  customerOptions,
  defaultSalesLedger,
  dueDateFor,
  fieldOfSalesPath,
  formToSalesDraft,
  godownWithStock,
  hasNoLines,
  invoiceFormFromOrder,
  isBlankSales,
  openOrderLines,
  openOrdersOf,
  orderCallName,
  partyDetailsOfParty,
  previewSales,
  salesFormFromVoucher,
  salesKindOf,
  salesLedgerOptions,
  switchSales,
  withOrderLines,
} from './salesModel';

const id = (kind: string, name: string) => deterministicUuid(`demo|${kind}|${name}`);
const item = (name: string) => id('stockItem', name);
const party = (name: string) => id('party', name);

async function demo(): Promise<Books> {
  const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: memoryStore(), newIdSeed: () => 'seed-1' }));
  const r = await loadDemoCompany(host);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const typeOf = (books: Books, base: string) => books.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;
const orderNumbered = (books: Books, reference: string) => books.vouchers.find((v) => (v.content as { reference?: string }).reference === reference && books.masters.voucherType(v.voucherTypeId)?.baseKind === 'salesOrder');
const godown = (books: Books) => {
  const w = books.masters.warehouses.find((x) => x.name === 'Finished Goods Store');
  return { id: w?.id as string, label: 'Finished Goods Store' };
};

describe('the sales form', () => {
  it('starts with one empty line, and a blank form is one with nothing entered (a default godown, date or ledger is not "entered")', async () => {
    const books = await demo();
    const main = books.masters.warehouses[0];
    const form = blankSalesForm('v1', typeOf(books, 'sales'), '2026-05-01', 'k1', { warehouse: { id: main?.id as string, label: 'Main Location' }, salesLedger: defaultSalesLedger(books.masters) });
    expect(form.lines).toHaveLength(1);
    expect(form.lines[0]).toMatchObject({ itemId: '', warehouseLabel: 'Main Location', due: '2026-05-01' });
    expect(form.salesLedgerLabel).toBe('Sales - Domestic'); // the only ledger under Sales Accounts
    expect(isBlankSales(form)).toBe(true);
    expect(hasNoLines(form)).toBe(true);
    expect(isBlankSales({ ...form, reference: 'PO-1' })).toBe(false);
    expect(isBlankSales({ ...form, ewayBillNo: 'EWB-1' })).toBe(false);
    expect(isBlankSales({ ...form, lines: [{ ...blankSalesLine('k1'), qty: '1' }] })).toBe(false);
  });

  it('knows which document a voucher type is, and offers customers only — and only the ledgers under Sales Accounts', async () => {
    const books = await demo();
    expect(salesKindOf(books.masters, typeOf(books, 'sales'))).toBe('sales');
    expect(salesKindOf(books.masters, typeOf(books, 'salesOrder'))).toBe('salesOrder');
    expect(salesKindOf(books.masters, typeOf(books, 'payment'))).toBeUndefined();
    expect(customerOptions(books.masters).map((o) => o.name)).toEqual(['ABC Industries', 'Kumar Engineering Works', 'Sharma Traders']); // Steel Supplies and Bharat are vendors
    expect(salesLedgerOptions(books.masters).map((o) => o.name)).toEqual(['Sales - Domestic']);
  });

  it('builds the order draft (a stable id and a due date on every line) and the invoice draft (a godown and the order line it fills); empty lines are left out', async () => {
    const books = await demo();
    const base = { ...blankSalesForm('v1', 't', '2026-05-01', 'k1'), partyId: 'p1', reference: ' PO-9 ', narration: ' n ' };
    const filled = (key: string, extra: object) => ({ ...blankSalesLine(key, { id: 'w1', label: 'Main' }, '2026-05-20'), itemId: 'i1', itemLabel: 'Bolt', qty: ' 5 ', rate: '9', ...extra });
    const form: SalesForm = { ...base, lines: [filled('a', {}), blankSalesLine('b'), filled('c', { orderId: 'o1', orderLineId: 'l1' })] };
    const order = formToSalesDraft(form, 'salesOrder');
    expect(order.kept).toEqual([0, 2]);
    expect(order.draft).toMatchObject({ id: 'v1', partyId: 'p1', reference: 'PO-9', narration: 'n' });
    expect(order.draft['lines']).toEqual([
      { id: 'a', itemId: 'i1', qty: '5', rate: '9', dueDate: '2026-05-20' },
      { id: 'c', itemId: 'i1', qty: '5', rate: '9', dueDate: '2026-05-20' },
    ]);
    expect(order.draft['closed']).toBeUndefined();
    const invoice = formToSalesDraft({ ...form, salesLedgerId: 'sl', due: '2026-06-01', ewayBillNo: ' EWB-4471 ' }, 'sales');
    expect(invoice.draft).toMatchObject({ salesLedgerId: 'sl', dueDate: '2026-06-01', ewayBillNo: 'EWB-4471' });
    expect(formToSalesDraft({ ...form, salesLedgerId: 'sl', due: '2026-06-01' }, 'purchase').draft['ewayBillNo']).toBeUndefined();
    expect(invoice.draft['lines']).toEqual([
      { itemId: 'i1', qty: '5', rate: '9', warehouseId: 'w1' },
      { itemId: 'i1', qty: '5', rate: '9', warehouseId: 'w1', orderRef: { orderId: 'o1', lineId: 'l1' } },
    ]);
    expect(formToSalesDraft({ ...form, closed: true }, 'salesOrder').draft['closed']).toBe(true);
    expect(books).toBeDefined();
  });

  it('puts a problem on the cell it belongs to, counting only the lines actually sent', () => {
    expect(fieldOfSalesPath('lines.1.qty', [0, 2])).toBe('line.2.qty');
    expect(fieldOfSalesPath('lines.0.orderRef', [3])).toBe('line.3.ord');
    expect(fieldOfSalesPath('lines.0.warehouseId', [0])).toBe('line.0.wh');
    expect(fieldOfSalesPath('lines.0.dueDate', [0])).toBe('line.0.ldue');
    expect(fieldOfSalesPath('lines.0.itemId', [0])).toBe('line.0.item');
    expect(fieldOfSalesPath('partyId', [])).toBe('party');
    expect(fieldOfSalesPath('partyDetails', [])).toBe('party');
    expect(fieldOfSalesPath('salesLedgerId', [])).toBe('sledger');
    expect(fieldOfSalesPath('dueDate', [])).toBe('due');
    expect(fieldOfSalesPath('reference', [])).toBe('ref');
    expect(fieldOfSalesPath('lines', [0])).toBe('general');
    expect(fieldOfSalesPath(undefined, [])).toBe('general');
  });
});

describe('previewing with the same engine', () => {
  it('says what is missing on the cell before asking the engine', async () => {
    const books = await demo();
    const form = blankSalesForm('v1', typeOf(books, 'sales'), '2026-05-01', 'k1', { salesLedger: defaultSalesLedger(books.masters) });
    const p = previewSales(form, 'sales', books.masters, books.stock, books.orders);
    expect(p.ok).toBe(false);
    expect(p.issues).toEqual([{ field: 'party', message: 'Choose the customer' }, { field: 'general', message: 'Enter at least one line' }]);
  });

  it('shows the total as typed, whether or not the engine accepts it yet', async () => {
    const books = await demo();
    const form: SalesForm = { ...blankSalesForm('v1', typeOf(books, 'salesOrder'), '2026-05-01', 'k1'), lines: [{ ...blankSalesLine('a', undefined, '2026-05-10'), itemId: item('Machine Oil'), qty: '3', rate: '33.3333' }] };
    const p = previewSales(form, 'salesOrder', books.masters, books.stock, books.orders);
    expect(p.total).toBe(10000n); // 3 × 33.3333 = 99.9999 → 100.00
    expect(p.issues.map((i) => i.field)).toEqual(['party']);
  });

  it('is accepted for an invoice made against an order line, and refuses more than is pending on that very cell, saying how much', async () => {
    const books = await demo();
    const po = orderNumbered(books, 'PO-4471');
    const invoiceType = typeOf(books, 'sales');
    const opts = openOrderLines(books.orders, party('ABC Industries'), item('Mounting Bracket'), 'v1');
    expect(opts.map((o) => [o.number, formatQty(o.pending, 0)])).toEqual([[po?.number, '180']]);
    const base = invoiceFormFromOrder(po as never, books.orders, books.masters, { id: 'v1', typeId: invoiceType, date: '2026-06-30', newKey: () => 'k', warehouse: godown(books), salesLedger: defaultSalesLedger(books.masters) }) as SalesForm;
    expect(previewSales(base, 'sales', books.masters, books.stock, books.orders).issues).toEqual([]);
    const over: SalesForm = { ...base, lines: base.lines.map((l, i) => (i === 0 ? { ...l, qty: '181' } : l)) };
    const p = previewSales(over, 'sales', books.masters, books.stock, books.orders);
    expect(p.ok).toBe(false);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]).toMatchObject({ field: 'line.0.qty', code: IssueCode.OverDelivery });
    expect(p.issues[0]?.message).toContain('180 Nos pending, you are delivering 181 Nos');
  });

  it('refuses an item that is not on the chosen order line, on the order cell', async () => {
    const books = await demo();
    const po = orderNumbered(books, 'PO-4471');
    const base = invoiceFormFromOrder(po as never, books.orders, books.masters, { id: 'v1', typeId: typeOf(books, 'sales'), date: '2026-06-30', newKey: () => 'k', warehouse: godown(books), salesLedger: defaultSalesLedger(books.masters) }) as SalesForm;
    const wrong: SalesForm = { ...base, lines: base.lines.map((l, i) => (i === 0 ? { ...l, itemId: item('Machine Oil'), itemLabel: 'Machine Oil' } : l)) };
    expect(previewSales(wrong, 'sales', books.masters, books.stock, books.orders).issues[0]).toMatchObject({ field: 'line.0.ord', code: IssueCode.OrderRefInvalid });
  });

  it('refuses stock that is not there, on the quantity cell', async () => {
    const books = await demo();
    const form: SalesForm = {
      ...blankSalesForm('v1', typeOf(books, 'sales'), '2026-06-30', 'k1', { salesLedger: defaultSalesLedger(books.masters) }),
      partyId: party('ABC Industries'),
      partyDetails: partyDetailsOfParty(books.masters.party(party('ABC Industries') as never) as never),
      lines: [{ ...blankSalesLine('a', godown(books)), itemId: item('Fabricated Frame'), qty: '61', rate: '1400' }],
    };
    const p = previewSales(form, 'sales', books.masters, books.stock, books.orders);
    expect(p.issues[0]).toMatchObject({ field: 'line.0.qty', code: IssueCode.StockNegative });
  });
});

describe('open orders, and an invoice for what is pending', () => {
  it('a customer’s open orders: one entry each, the line-count and the soonest due date; a customer whose order was delivered in full has none', async () => {
    const books = await demo();
    const abc = openOrdersOf(books.orders, party('ABC Industries'), 'v1');
    expect(abc).toHaveLength(1);
    expect(abc[0]).toMatchObject({ reference: 'PO-4471', lines: 2 }); // the bolt line is delivered in full; the bracket and frame lines are pending
    expect(orderCallName(abc[0] as never)).toBe('PO-4471');
    expect(orderCallName({ reference: '', number: 'SO/26-27/0009' })).toBe('SO/26-27/0009');
    expect(openOrdersOf(books.orders, party('Sharma Traders'), 'v1')).toEqual([]); // delivered in full: closed
    expect(openOrdersOf(books.orders, party('Kumar Engineering Works'), 'v1')).toHaveLength(1);
  });

  it('the invoice for an order’s pending items: its customer, PO and party details, a line per pending order line, quantity = pending, rate = agreed', async () => {
    const books = await demo();
    const po = orderNumbered(books, 'PO-4471');
    const form = invoiceFormFromOrder(po as never, books.orders, books.masters, { id: 'v1', typeId: typeOf(books, 'sales'), date: '2027-03-01', newKey: () => crypto.randomUUID(), warehouse: godown(books), salesLedger: defaultSalesLedger(books.masters) }) as SalesForm;
    expect(form).toMatchObject({ partyLabel: 'ABC Industries', reference: 'PO-4471', salesLedgerLabel: 'Sales - Domestic', date: '2027-03-01' });
    expect(form.due).toBe(addDays('2027-03-01', 30)); // ABC's credit days
    expect(form.partyDetails?.partyId).toBe(party('ABC Industries'));
    expect(form.lines.map((l) => [l.itemLabel, l.qty, l.rate, l.orderLabel, l.warehouseLabel])).toEqual([
      ['Mounting Bracket', '180', '55', po?.number, 'Finished Goods Store'],
      ['Fabricated Frame', '20', '1400', po?.number, 'Finished Goods Store'],
    ]);
    // …and it is accepted by the engine as it stands
    expect(previewSales(form, 'sales', books.masters, books.stock, books.orders).ok).toBe(true);
  });

  it('starts each line in the godown that HOLDS the goods, not blindly in the main one', async () => {
    const books = await demo();
    const main = { id: books.masters.warehouses[0]?.id as string, label: 'Main Location' };
    const date = '2027-03-01';
    // the bolts and brackets are kept in the Finished Goods Store; the oil is in the main godown
    expect(godownWithStock(books.masters, books.stock, item('Mounting Bracket'), date, main)?.label).toBe('Finished Goods Store');
    expect(godownWithStock(books.masters, books.stock, item('Machine Oil'), date, main)?.label).toBe('Main Location');
    expect(godownWithStock(books.masters, books.stock, item('MS Scrap'), date, main)).toEqual(main); // nowhere: the fallback
    const po = orderNumbered(books, 'PO-4471');
    const form = invoiceFormFromOrder(po as never, books.orders, books.masters, { id: 'v1', typeId: typeOf(books, 'sales'), date, newKey: () => crypto.randomUUID(), warehouse: main, stock: books.stock, salesLedger: defaultSalesLedger(books.masters) }) as SalesForm;
    expect(form.lines.map((l) => l.warehouseLabel)).toEqual(['Finished Goods Store', 'Finished Goods Store']);
    expect(previewSales(form, 'sales', books.masters, books.stock, books.orders).issues).toEqual([]); // …so it is accepted as it stands
  });

  it('choosing a PO brings what REMAINS on it: lines already there are kept, empty ones dropped, and asking again adds nothing', async () => {
    const books = await demo();
    const main = { id: books.masters.warehouses[0]?.id as string, label: 'Main Location' };
    const po = orderNumbered(books, 'PO-4471');
    const pending = openOrderLines(books.orders, party('ABC Industries'), undefined, 'v1').filter((o) => o.orderId === po?.id);
    expect(pending.map((o) => [formatQty(o.pending, 0), formatQty(o.ordered, 0)])).toEqual([['180', '300'], ['20', '20']]); // the bolt line is filled: not offered
    const empty = blankSalesForm('v1', typeOf(books, 'sales'), '2027-03-01', 'k0');
    const first = withOrderLines(empty, pending, books.masters, () => crypto.randomUUID(), () => main);
    expect(first.added).toBe(2);
    expect(first.form.lines.map((l) => [l.itemLabel, l.qty, l.rate, l.orderLabel])).toEqual([['Mounting Bracket', '180', '55', po?.number], ['Fabricated Frame', '20', '1400', po?.number]]); // the empty line is gone
    expect(withOrderLines(first.form, pending, books.masters, () => crypto.randomUUID(), () => main).added).toBe(0);
    // an over-the-counter line already on the invoice stays
    const own: SalesForm = { ...empty, lines: [{ ...blankSalesLine('own', main), itemId: item('Machine Oil'), itemLabel: 'Machine Oil', qty: '2', rate: '250' }] };
    const both = withOrderLines(own, pending, books.masters, () => crypto.randomUUID(), () => main);
    expect(both.form.lines.map((l) => l.itemLabel)).toEqual(['Machine Oil', 'Mounting Bracket', 'Fabricated Frame']);
  });

  it('never dated before the order, and nothing to invoice for a closed or fully delivered order', async () => {
    const books = await demo();
    const po = orderNumbered(books, 'PO-4471');
    const early = invoiceFormFromOrder(po as never, books.orders, books.masters, { id: 'v1', typeId: typeOf(books, 'sales'), date: '2000-01-01', newKey: () => 'k' }) as SalesForm;
    expect(early.date).toBe(po?.date);
    const done = orderNumbered(books, 'SH/PO/88');
    expect(invoiceFormFromOrder(done as never, books.orders, books.masters, { id: 'v2', typeId: typeOf(books, 'sales'), date: '2027-03-01', newKey: () => 'k' })).toBeUndefined();
  });

  it('cancelling the invoice makes the whole order pending again — the next invoice for it has every line', async () => {
    const books = await demo();
    const inv = books.vouchers.find((v) => books.masters.voucherType(v.voucherTypeId)?.baseKind === 'sales' && (v.content as { partyId?: string }).partyId === party('ABC Industries'));
    expect((await books.cancel(inv?.id as string, inv?.version as number)).ok).toBe(true);
    const po = orderNumbered(books, 'PO-4471');
    const form = invoiceFormFromOrder(po as never, books.orders, books.masters, { id: 'v1', typeId: typeOf(books, 'sales'), date: '2027-03-01', newKey: () => 'k' }) as SalesForm;
    expect(form.lines.map((l) => [l.itemLabel, l.qty])).toEqual([['ABC Hex Bolt M8', '2000'], ['Mounting Bracket', '300'], ['Fabricated Frame', '20']]);
  });
});

describe('reading a posted document back, and switching between the two', () => {
  it('a posted invoice reads back as the form a person would have typed, and altering it unchanged is accepted (its own delivery does not count against it)', async () => {
    const books = await demo();
    const inv = books.vouchers.find((v) => books.masters.voucherType(v.voucherTypeId)?.baseKind === 'sales' && (v.content as { partyId?: string }).partyId === party('ABC Industries'));
    const form = salesFormFromVoucher(inv as never, books.masters, books.orders);
    expect(form.lines.map((l) => [l.itemLabel, l.warehouseLabel, l.qty, l.rate, l.orderLabel])).toEqual([
      ['ABC Hex Bolt M8', 'Finished Goods Store', '2000', '6.5', orderNumbered(books, 'PO-4471')?.number],
      ['Mounting Bracket', 'Finished Goods Store', '120', '55', orderNumbered(books, 'PO-4471')?.number],
    ]);
    expect(form.dueText).not.toBe('');
    expect(previewSales(form, 'sales', books.masters, books.stock, books.orders).ok).toBe(true);
  });

  it('a posted order reads back with each line’s own due date, and keeps its line ids so its deliveries stay attached', async () => {
    const books = await demo();
    const po = orderNumbered(books, 'PO-4471');
    const form = salesFormFromVoucher(po as never, books.masters, books.orders);
    expect(form.lines.map((l) => [l.key, l.itemLabel, l.qty, l.due])).toEqual([
      ['l1', 'ABC Hex Bolt M8', '2000', addDays(books.masters.financialYears[0]?.start as string, 45)],
      ['l2', 'Mounting Bracket', '300', addDays(books.masters.financialYears[0]?.start as string, 60)],
      ['l3', 'Fabricated Frame', '20', addDays(books.masters.financialYears[0]?.start as string, 75)],
    ]);
    expect(previewSales(form, 'salesOrder', books.masters, books.stock, books.orders).ok).toBe(true);
  });

  it('switching keeps the customer, reference, party details, narration and every line’s item, quantity and rate — and says what it could not carry', async () => {
    const books = await demo();
    const orderType = typeOf(books, 'salesOrder');
    const invoiceType = typeOf(books, 'sales');
    const base = blankSalesForm('v1', orderType, '2026-05-01', 'k1');
    const abc = books.masters.party(party('ABC Industries') as never) as never;
    const order: SalesForm = {
      ...base,
      partyId: party('ABC Industries'),
      partyLabel: 'ABC Industries',
      partyDetails: partyDetailsOfParty(abc),
      reference: 'PO-9',
      narration: 'n',
      lines: [{ ...blankSalesLine('a', undefined, '2026-05-20'), itemId: item('Machine Oil'), itemLabel: 'Machine Oil', qty: '4', rate: '250' }],
    };
    const toInvoice = switchSales(order, 'salesOrder', 'sales', invoiceType, books.masters, { warehouse: godown(books), salesLedger: defaultSalesLedger(books.masters) });
    expect(toInvoice.form).toMatchObject({ typeId: invoiceType, partyLabel: 'ABC Industries', reference: 'PO-9', narration: 'n', salesLedgerLabel: 'Sales - Domestic' });
    expect(toInvoice.form.due).toBe(dueDateFor(books.masters, party('ABC Industries'), '2026-05-01'));
    expect(toInvoice.form.lines[0]).toMatchObject({ itemLabel: 'Machine Oil', qty: '4', rate: '250', due: '', warehouseLabel: 'Finished Goods Store' });
    expect(toInvoice.note).toMatch(/due dates were cleared/);

    const linked: SalesForm = { ...toInvoice.form, lines: [{ ...toInvoice.form.lines[0], orderId: 'o1', orderLineId: 'l1', orderLabel: 'SO/1' } as never] };
    const back = switchSales(linked, 'sales', 'salesOrder', orderType, books.masters);
    expect(back.form.lines[0]).toMatchObject({ itemLabel: 'Machine Oil', qty: '4', orderId: '', warehouseId: '', due: '2026-05-01' });
    expect(back.note).toMatch(/order references were cleared/);
    expect(switchSales(order, 'salesOrder', 'salesOrder', orderType, books.masters).note).toBeUndefined();
  });
});

describe('the party details a customer brings', () => {
  it('are what the Party Details window would offer: billing, the GST facts, and the party’s own shipping address when it has one', async () => {
    const books = await demo();
    const kumar = partyDetailsOfParty(books.masters.party(party('Kumar Engineering Works') as never) as never);
    expect(kumar).toMatchObject({ partyId: party('Kumar Engineering Works'), mailingName: 'Kumar Engineering Works', gstRegistration: 'regular', placeOfSupply: '33' });
    expect(kumar.billTo).toMatchObject({ lines: 'Peenya Industrial Area, Bengaluru', stateCode: '29', pincode: '560058', country: 'India' });
    expect(kumar.shipTo).toMatchObject({ lines: 'SIPCOT Industrial Park, Hosur', stateCode: '33' });
    const abc = partyDetailsOfParty(books.masters.party(party('ABC Industries') as never) as never);
    expect(abc.shipTo).toBeUndefined();
    expect(abc.placeOfSupply).toBe('27');
  });

  it('due dates follow the party’s credit days', async () => {
    const books = await demo();
    expect(dueDateFor(books.masters, party('ABC Industries'), '2026-05-01')).toBe('2026-05-31'); // 30 days
    expect(dueDateFor(books.masters, party('Sharma Traders'), '2026-05-01')).toBe('2026-06-15'); // 45 days
    expect(dueDateFor(books.masters, 'nobody', '2026-05-01')).toBe('2026-05-01');
  });
});
