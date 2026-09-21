import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { IssueCode, type Result } from '../errors';
import { type LedgerId, type StockItemId, type WarehouseId, asCompanyId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { partyLedgerId } from '../masters/records';
import { seedCompany } from '../masters/seed';
import { formatMoney } from '../money';
import { prepareVoucher } from '../posting/engine';
import { prepareAlteration, prepareCancellation } from '../posting/lifecycle';
import { type PostingPlan } from '../posting/plan';
import { profitAndLoss } from '../reports/financials';
import { StockBook } from '../stock/book';
import { parseQty } from '../stock/quantity';
import { billRefProblems, openBills } from '../vouchers/allocations';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { type OrderBook, orderBookOf } from './orderBook';

const newId = (n: string) => deterministicUuid(`pu|${n}`);
const kinds = defaultVoucherKinds();
const D = (s: string) => localDate(s);

/** A little company that buys from Steel Supplier and sells to Acme, keeping its books the way the backends do. */
class Env {
  masters: Masters;
  vouchers: Voucher[] = [];
  private plans = new Map<string, PostingPlan>();
  private seq = new Map<string, number>();
  readonly bolt = newId('bolt') as StockItemId;
  readonly sheet = newId('sheet') as StockItemId;
  readonly acme = newId('acme');
  readonly supplier = newId('supplier');
  readonly other = newId('other');
  readonly salesLedger = newId('sales-ledger');
  readonly purchases = newId('purchases') as LedgerId;
  readonly rent = newId('rent') as LedgerId;
  readonly main: WarehouseId;

  constructor() {
    let masters = seedCompany({ name: 'T', fyStart: D('2024-04-01'), newId });
    const run = (kind: string, id: string, data: unknown) => {
      const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      masters = r.value.masters;
    };
    const nos = masters.units.find((u) => u.symbol === 'Nos')?.id as string;
    const kg = masters.units.find((u) => u.symbol === 'Kg')?.id as string;
    run('stockItem', this.bolt, { name: 'Bolt', unitId: nos, itemType: 'finished' });
    run('stockItem', this.sheet, { name: 'Sheet', unitId: kg, itemType: 'raw' });
    run('party', this.acme, { name: 'Acme Ltd', roles: ['customer'] });
    run('party', this.supplier, { name: 'Steel Supplier', roles: ['vendor'], creditDays: 30 });
    run('party', this.other, { name: 'Other Supplier', roles: ['vendor'] });
    const group = (key: string) => newId(`group:${key}`);
    run('ledger', this.salesLedger, { name: 'Domestic Sales', groupId: group('sales-accounts') });
    run('ledger', this.purchases, { name: 'Purchases', groupId: group('purchase-accounts') });
    run('ledger', this.rent, { name: 'Rent', groupId: group('indirect-expenses') });
    this.masters = masters;
    this.main = masters.warehouses[0]?.id as WarehouseId;
  }

  private typeId = (base: string) => this.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;
  stock = (): StockBook => new StockBook(this.vouchers.filter((v) => v.status === 'posted').flatMap((v) => this.plans.get(v.id)?.stock ?? []));
  orders = (): OrderBook => orderBookOf(this.vouchers, this.masters);
  journal = () => this.vouchers.filter((v) => v.status === 'posted').flatMap((v) => this.plans.get(v.id)?.journal ?? []);
  details = (partyId: string) => ({ partyId, mailingName: 'X' });

  order(over: Record<string, unknown> = {}) {
    return {
      id: newId(`po-${this.vouchers.length}`),
      voucherTypeId: this.typeId('purchaseOrder'),
      date: '2024-05-01',
      partyId: this.supplier,
      partyDetails: this.details(this.supplier),
      reference: 'Q-55',
      lines: [
        { id: 'a', itemId: this.bolt, qty: '100', rate: '10', dueDate: '2024-05-20' },
        { id: 'b', itemId: this.sheet, qty: '50.5', rate: '80', dueDate: '2024-06-10' },
      ],
      ...over,
    };
  }

  invoice(lines: unknown[], over: Record<string, unknown> = {}) {
    return {
      id: newId(`pur-${this.vouchers.length}`),
      voucherTypeId: this.typeId('purchase'),
      date: '2024-05-12',
      partyId: this.supplier,
      partyDetails: this.details(this.supplier),
      purchaseLedgerId: this.purchases,
      billNo: 'SS/889',
      dueDate: '2024-06-11',
      lines,
      ...over,
    };
  }

  line = (item: StockItemId, qty: string, rate: string, orderRef?: { orderId: string; lineId: string }) => ({
    itemId: item,
    warehouseId: this.main,
    qty,
    rate,
    ...(orderRef ? { orderRef } : {}),
  });

  sale(qty: string, date = '2024-06-01') {
    return {
      id: newId(`sal-${this.vouchers.length}`),
      voucherTypeId: this.typeId('sales'),
      date,
      partyId: this.acme,
      partyDetails: this.details(this.acme),
      salesLedgerId: this.salesLedger,
      dueDate: '2024-07-01',
      lines: [{ itemId: this.bolt, warehouseId: this.main, qty, rate: '25' }],
    };
  }

  post(input: unknown): Result<Voucher> {
    const r = prepareVoucher(input, this.masters, kinds, this.stock(), this.orders());
    if (!r.ok) return r;
    const dup = billRefProblems(r.value.voucherType.baseKind, r.value.draft, this.masters, this.vouchers);
    if (dup.length > 0) return { ok: false, issues: dup };
    const type = r.value.voucherType;
    const n = (this.seq.get(type.id) ?? 0) + 1;
    this.seq.set(type.id, n);
    const v: Voucher = {
      id: r.value.draft.id,
      companyId: asCompanyId('c'),
      voucherTypeId: type.id,
      financialYearId: r.value.financialYear.id,
      number: `${type.baseKind.toUpperCase()}/24-25/${String(n).padStart(4, '0')}`,
      date: r.value.draft.date,
      status: 'posted',
      version: 1,
      revision: 0,
      content: r.value.draft,
    };
    this.vouchers.push(v);
    this.plans.set(v.id, r.value.plan);
    return { ok: true, value: v };
  }

  must(input: unknown): Voucher {
    const r = this.post(input);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }

  cancel(v: Voucher): Result<void> {
    const r = prepareCancellation(v, v.version, this.masters, this.stock(), this.orders());
    if (r.ok) this.vouchers[this.vouchers.indexOf(v)] = { ...v, status: 'cancelled', version: v.version + 1 };
    return r;
  }

  alter(v: Voucher, input: unknown): Result<unknown> {
    return prepareAlteration({ existing: v, input, expectedVersion: v.version, masters: this.masters, registry: kinds, stock: this.stock(), orders: this.orders() });
  }
}

const codes = (r: Result<unknown>): string[] => (r.ok ? [] : r.issues.map((i) => i.code));
const at = (r: Result<unknown>): (string | undefined)[] => (r.ok ? [] : r.issues.map((i) => i.path));

describe('the Purchase Invoice', () => {
  it('debits Purchases and credits the supplier for the total, brings the goods IN at the rate, and raises a bill named by the supplier’s invoice number', () => {
    const e = new Env();
    const v = e.must(e.invoice([e.line(e.bolt, '100', '10'), e.line(e.sheet, '10.5', '80')]));
    const rows = e.journal().filter((l) => l.voucherId === v.id);
    expect(rows.map((l) => [l.ledgerId === e.purchases ? 'Purchases' : l.ledgerId === partyLedgerId(e.supplier as never, 'vendor') ? 'Supplier' : '?', l.side, formatMoney(l.amount)])).toEqual([
      ['Purchases', 'debit', '1840.00'],
      ['Supplier', 'credit', '1840.00'],
    ]);
    const stock = e.stock();
    expect(stock.movements.map((m) => [m.direction, m.itemId === e.bolt ? 'bolt' : 'sheet', m.qty, formatMoney(m.value as never)])).toEqual([
      ['in', 'bolt', parseQty('100'), '1000.00'],
      ['in', 'sheet', parseQty('10.5'), '840.00'],
    ]);
    const bills = openBills(e.vouchers, e.masters, partyLedgerId(e.supplier as never, 'vendor') as LedgerId);
    expect(bills.map((b) => [b.ref, b.side, formatMoney(b.pending), b.dueDate])).toEqual([['SS/889', 'credit', '1840.00', '2024-06-11']]);
  });

  it('needs a vendor, an active purchase ledger under Purchase Accounts, the supplier’s invoice number, and lines', () => {
    const e = new Env();
    expect(codes(e.post(e.invoice([e.line(e.bolt, '1', '10')], { partyId: e.acme, partyDetails: e.details(e.acme) })))).toEqual([IssueCode.SalesDocInvalid]);
    expect(codes(e.post(e.invoice([e.line(e.bolt, '1', '10')], { purchaseLedgerId: e.rent })))).toEqual([IssueCode.SalesDocInvalid]);
    expect(at(e.post(e.invoice([e.line(e.bolt, '1', '10')], { billNo: '  ' })))).toContain('billNo');
    expect(codes(e.post(e.invoice([])))).toEqual([IssueCode.TooFewLines]);
    expect(codes(e.post(e.invoice([e.line(e.bolt, '1', '10')], { dueDate: '2024-05-01' })))).toEqual([IssueCode.SalesDocInvalid]);
    expect(codes(e.post(e.invoice([e.line(e.bolt, '1', '0')])))).toEqual([IssueCode.AmountNotPositive]);
  });

  it('a supplier’s invoice number can be used once per supplier: the same number from another supplier is fine, and an alteration may keep its own', () => {
    const e = new Env();
    const first = e.must(e.invoice([e.line(e.bolt, '10', '10')]));
    const again = e.post(e.invoice([e.line(e.bolt, '5', '10')]));
    expect(codes(again)).toEqual([IssueCode.BillRefInUse]);
    expect(at(again)).toEqual(['billNo']);
    e.must(e.invoice([e.line(e.bolt, '5', '10')], { partyId: e.other, partyDetails: e.details(e.other) }));
    // altering the first, keeping its number, is not a clash with itself
    const same = billRefProblems('purchase', { ...(first.content as object), billNo: 'SS/889' }, e.masters, e.vouchers, first.id);
    expect(same).toEqual([]);
    // once the invoice is cancelled the number is free again
    expect(e.cancel(first).ok).toBe(true);
    expect(e.post(e.invoice([e.line(e.bolt, '5', '10')], { partyId: e.supplier })).ok).toBe(true);
  });

  it('a payment against the supplier’s invoice number settles the bill; a cancelled purchase leaves nothing owing', () => {
    const e = new Env();
    const v = e.must(e.invoice([e.line(e.bolt, '100', '10')])); // 1,000.00
    const ledger = partyLedgerId(e.supplier as never, 'vendor') as LedgerId;
    expect(openBills(e.vouchers, e.masters, ledger).map((b) => [b.ref, formatMoney(b.pending)])).toEqual([['SS/889', '1000.00']]);
    const cash = e.masters.ledgers.find((l) => l.name === 'Cash')?.id;
    const pay = (id: string, amount: string) =>
      e.must({
        id: newId(id),
        voucherTypeId: e.masters.voucherTypes.find((t) => t.baseKind === 'payment')?.id,
        date: '2024-05-20',
        accountLedgerId: cash,
        lines: [{ ledgerId: ledger, amount, allocations: [{ kind: 'against', ref: 'SS/889', amount }] }],
      });
    pay('pay1', '400');
    expect(openBills(e.vouchers, e.masters, ledger).map((b) => [b.ref, formatMoney(b.pending)])).toEqual([['SS/889', '600.00']]);
    pay('pay2', '600');
    expect(openBills(e.vouchers, e.masters, ledger)).toEqual([]);
    const c = new Env();
    const w = c.must(c.invoice([c.line(c.bolt, '100', '10')]));
    c.cancel(w);
    expect(openBills(c.vouchers, c.masters, ledger)).toEqual([]);
    expect(v.status).toBe('posted');
  });

  it('Purchases reach the Trading account and the journal balances', () => {
    const e = new Env();
    e.must(e.invoice([e.line(e.bolt, '100', '10')]));
    const s = profitAndLoss({ masters: e.masters, lines: e.journal(), stock: e.stock(), range: { from: D('2024-04-01'), to: D('2025-03-31') }, openingStockIds: new Set() });
    expect(s.sections[0]?.left.map((l) => [l.label, formatMoney(l.amount)])).toContainEqual(['Purchase Accounts', '1000.00']);
    const dr = e.journal().filter((l) => l.side === 'debit').reduce((a, l) => a + l.amount, 0n);
    const cr = e.journal().filter((l) => l.side === 'credit').reduce((a, l) => a + l.amount, 0n);
    expect(dr).toBe(cr);
  });
});

describe('the Purchase Order and receiving against it', () => {
  it('posts nothing to the accounts or the stock; what is on order is what is still to come, and it is not "committed" stock', () => {
    const e = new Env();
    const po = e.must(e.order());
    expect(e.journal()).toEqual([]);
    expect(e.stock().movements).toEqual([]);
    expect(e.orders().state(po.id)?.status).toBe('open');
    expect([...e.orders().onOrderByItem()].map(([id, q]) => [id === e.bolt ? 'bolt' : 'sheet', q])).toEqual([['bolt', parseQty('100')], ['sheet', parseQty('50.5')]]);
    expect(e.orders().committedByItem().size).toBe(0);
  });

  it('a receipt fills the order line; more than is pending is refused on the cell; the order closes when everything has come', () => {
    const e = new Env();
    const po = e.must(e.order());
    const ref = (lineId: string) => ({ orderId: po.id, lineId });
    e.must(e.invoice([e.line(e.bolt, '60', '10', ref('a'))]));
    expect(e.orders().deliveredOn(po.id, 'a')).toBe(parseQty('60'));
    expect([...e.orders().onOrderByItem()].find(([id]) => id === e.bolt)?.[1]).toBe(parseQty('40'));
    const over = e.post(e.invoice([e.line(e.bolt, '41', '10', ref('a'))], { billNo: 'SS/900' }));
    expect(codes(over)).toEqual([IssueCode.OverDelivery]);
    expect(at(over)).toEqual(['lines.0.qty']);
    expect(over.ok ? '' : over.issues[0]?.message).toContain('40');
    expect(over.ok ? '' : over.issues[0]?.message).toContain('receiving');
    e.must(e.invoice([e.line(e.bolt, '40', '10', ref('a')), e.line(e.sheet, '50.5', '80', ref('b'))], { billNo: 'SS/901' }));
    expect(e.orders().state(po.id)?.status).toBe('closed');
    expect(e.orders().state(po.id)?.reason).toBe('fulfilled');
    expect(e.orders().onOrderByItem().size).toBe(0);
  });

  it('an invoice can only fill its own supplier’s purchase order — not another supplier’s, not a sales order', () => {
    const e = new Env();
    const po = e.must(e.order());
    const wrongSupplier = e.post(e.invoice([e.line(e.bolt, '10', '10', { orderId: po.id, lineId: 'a' })], { partyId: e.other, partyDetails: e.details(e.other), billNo: 'X1' }));
    expect(codes(wrongSupplier)).toEqual([IssueCode.OrderRefInvalid]);
    expect(wrongSupplier.ok ? '' : wrongSupplier.issues[0]?.message).toContain('another supplier');
    // a sales order cannot be received against, and a purchase order cannot be delivered against
    const so = e.must({
      id: newId('so-1'),
      voucherTypeId: e.masters.voucherTypes.find((t) => t.baseKind === 'salesOrder')?.id,
      date: '2024-05-01',
      partyId: e.acme,
      partyDetails: e.details(e.acme),
      lines: [{ id: 'a', itemId: e.bolt, qty: '5', rate: '25', dueDate: '2024-05-20' }],
    });
    const cross = e.post(e.invoice([e.line(e.bolt, '1', '10', { orderId: so.id, lineId: 'a' })], { billNo: 'X2' }));
    expect(codes(cross)).toEqual([IssueCode.OrderRefInvalid]);
    expect(cross.ok ? '' : cross.issues[0]?.message).toContain('is not a purchase order');
    e.must(e.invoice([e.line(e.bolt, '20', '10')], { billNo: 'X3' }));
    const back = e.post({ ...e.sale('1'), lines: [{ itemId: e.bolt, warehouseId: e.main, qty: '1', rate: '25', orderRef: { orderId: po.id, lineId: 'a' } }] });
    expect(codes(back)).toEqual([IssueCode.OrderRefInvalid]);
    expect(back.ok ? '' : back.issues[0]?.message).toContain('is not a sales order');
  });

  it('cancelling a purchase order with receipts is refused; altering it below what has come is refused; cancelling the invoice reopens the line', () => {
    const e = new Env();
    const po = e.must(e.order());
    const inv = e.must(e.invoice([e.line(e.bolt, '60', '10', { orderId: po.id, lineId: 'a' })]));
    expect(codes(e.cancel(po))).toEqual([IssueCode.OrderHasDeliveries]);
    const shrink = e.alter(po, e.order({ id: po.id, lines: [{ id: 'a', itemId: e.bolt, qty: '50', rate: '10', dueDate: '2024-05-20' }] }));
    expect(codes(shrink)).toContain(IssueCode.OrderHasDeliveries);
    expect(e.cancel(inv).ok).toBe(true);
    expect(e.orders().deliveredOn(po.id, 'a')).toBe(0n);
    expect(e.cancel(po).ok).toBe(true);
  });

  it('goods that came in and were sold cannot be un-received: cancelling or shrinking the purchase is refused', () => {
    const e = new Env();
    const inv = e.must(e.invoice([e.line(e.bolt, '100', '10')]));
    e.must(e.sale('80'));
    expect(codes(e.cancel(inv))).toEqual([IssueCode.StockNegative]);
    const less = e.alter(inv, e.invoice([e.line(e.bolt, '50', '10')], { id: inv.id, billNo: 'SS/889' }));
    expect(codes(less)).toContain(IssueCode.StockNegative);
    expect(codes(e.alter(inv, e.invoice([e.line(e.bolt, '90', '10')], { id: inv.id })))).toEqual([]);
  });
});
