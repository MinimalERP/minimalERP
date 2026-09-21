import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { IssueCode, type Result } from '../errors';
import { type StockItemId, type VoucherId, type WarehouseId, asCompanyId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { partyLedgerId } from '../masters/records';
import { seedCompany } from '../masters/seed';
import { prepareVoucher } from '../posting/engine';
import { prepareAlteration, prepareCancellation } from '../posting/lifecycle';
import { type PostingPlan, checkPlanInvariants, stampPlan } from '../posting/plan';
import { StockBook } from '../stock/book';
import { formatQty } from '../stock/quantity';
import { openBills } from '../vouchers/allocations';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { type OrderBook, orderBookOf } from './orderBook';

const newId = (n: string) => deterministicUuid(`o|${n}`);
const kinds = defaultVoucherKinds();
const D = (s: string) => localDate(s);

/** A little company with its own books, so the tests read like a day's work. */
class Env {
  masters: Masters;
  vouchers: Voucher[] = [];
  private plans = new Map<string, PostingPlan>();
  private seq = new Map<string, number>();
  readonly bolt = newId('bolt') as StockItemId;
  readonly sheet = newId('sheet') as StockItemId;
  readonly consulting = newId('consulting') as StockItemId;
  readonly acme = newId('acme');
  readonly beta = newId('beta');
  readonly supplier = newId('supplier');
  readonly salesLedger = newId('sales-ledger');
  readonly cashLedger = newId('misc-income');
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
    run('stockItem', this.consulting, { name: 'Consulting', unitId: nos, itemType: 'service' });
    run('party', this.acme, { name: 'Acme Ltd', roles: ['customer'] });
    run('party', this.beta, { name: 'Beta Ltd', roles: ['customer'] });
    run('party', this.supplier, { name: 'Steel Supplier', roles: ['vendor'] });
    const groupId = (key: string) => newId(`group:${key}`);
    run('ledger', this.salesLedger, { name: 'Domestic Sales', groupId: groupId('sales-accounts') });
    run('ledger', this.cashLedger, { name: 'Misc Income', groupId: groupId('indirect-incomes') });
    this.masters = masters;
    this.main = masters.warehouses[0]?.id as WarehouseId;
    // 100 bolts and 50.5 kg of sheet in stock
    this.must(this.openingStock(this.bolt, '100', '10'));
    this.must(this.openingStock(this.sheet, '50.5', '80'));
  }

  private typeId = (base: string) => this.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;

  private openingStock(itemId: string, qty: string, rate: string) {
    return { id: newId(`os-${itemId}`), voucherTypeId: this.typeId('stockOpening'), date: '2024-04-01', itemId, warehouseId: this.main, qty, rate };
  }

  stock = (): StockBook =>
    new StockBook(this.vouchers.filter((v) => v.status === 'posted').flatMap((v) => this.plans.get(v.id)?.stock ?? []));
  orders = (): OrderBook => orderBookOf(this.vouchers, this.masters);

  details = (partyId: string) => ({ partyId, mailingName: 'X' });

  order(over: Record<string, unknown> = {}) {
    return {
      id: newId(`so-${this.vouchers.length}`),
      voucherTypeId: this.typeId('salesOrder'),
      date: '2024-05-01',
      partyId: this.acme,
      partyDetails: this.details(this.acme),
      reference: 'PO-778',
      lines: [
        { id: 'a', itemId: this.bolt, qty: '18', rate: '25', dueDate: '2024-05-20' },
        { id: 'b', itemId: this.sheet, qty: '10.5', rate: '120', dueDate: '2024-06-10' },
      ],
      ...over,
    };
  }

  invoice(lines: unknown[], over: Record<string, unknown> = {}) {
    return {
      id: newId(`sal-${this.vouchers.length}`),
      voucherTypeId: this.typeId('sales'),
      date: '2024-05-12',
      partyId: this.acme,
      partyDetails: this.details(this.acme),
      salesLedgerId: this.salesLedger,
      dueDate: '2024-06-11',
      lines,
      ...over,
    };
  }

  against = (order: Voucher, lineId: string, qty: string, item = this.bolt, rate = '25') => ({
    itemId: item,
    warehouseId: this.main,
    qty,
    rate,
    orderRef: { orderId: order.id, lineId },
  });

  post(input: unknown): Result<Voucher> {
    const r = prepareVoucher(input, this.masters, kinds, this.stock(), this.orders());
    if (!r.ok) return r;
    const type = r.value.voucherType;
    const n = (this.seq.get(type.id) ?? 0) + 1;
    this.seq.set(type.id, n);
    const v: Voucher = {
      id: r.value.draft.id,
      companyId: asCompanyId('c'),
      voucherTypeId: type.id,
      financialYearId: r.value.financialYear.id,
      number: `${type.baseKind === 'sales' ? 'SAL' : type.baseKind === 'salesOrder' ? 'SO' : 'X'}/24-25/${String(n).padStart(4, '0')}`,
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

  plan = (v: Voucher): PostingPlan => this.plans.get(v.id) as PostingPlan;

  alter(v: Voucher, input: unknown): Result<unknown> {
    const r = prepareAlteration({ existing: v, input, expectedVersion: v.version, masters: this.masters, registry: kinds, stock: this.stock(), orders: this.orders() });
    if (!r.ok) return r;
    const at = this.vouchers.findIndex((x) => x.id === v.id);
    const next = { ...v, version: v.version + 1, revision: v.revision + 1, content: r.value.draft };
    this.vouchers[at] = next;
    this.plans.set(v.id, r.value.plan);
    return { ok: true, value: next };
  }

  cancel(v: Voucher): Result<void> {
    const r = prepareCancellation(v, v.version, this.masters, this.stock(), this.orders());
    if (r.ok) this.vouchers[this.vouchers.findIndex((x) => x.id === v.id)] = { ...v, status: 'cancelled', version: v.version + 1 };
    return r;
  }

  codes = (r: Result<unknown>): string[] => (r.ok ? [] : r.issues.map((i) => i.code));
  issues = (r: Result<unknown>) => (r.ok ? [] : r.issues);
}

const fill = (env: Env, order: Voucher) => env.orders().state(order.id)?.lines.map((l) => `${formatQty(l.delivered, 3)}/${formatQty(l.ordered, 3)}`);

describe('a sales order', () => {
  it('posts nothing to the accounts or the stock, and is open with everything pending', () => {
    const env = new Env();
    const so = env.must(env.order());
    const plan = env.plan(so);
    expect(plan).toMatchObject({ journal: [], stock: [], links: [] });
    const state = env.orders().state(so.id);
    expect(state?.status).toBe('open');
    expect(state?.order).toMatchObject({ number: 'SO/24-25/0001', reference: 'PO-778', closed: false });
    expect(state?.lines.map((l) => [l.line.id, l.line.dueDate, l.pending])).toEqual([['a', '2024-05-20', 180000n], ['b', '2024-06-10', 105000n]]);
  });

  it('needs a customer, party details for THAT customer, and at least one line', () => {
    const env = new Env();
    expect(env.issues(env.post(env.order({ partyId: env.supplier, partyDetails: env.details(env.supplier) }))).map((i) => [i.code, i.path])).toEqual([[IssueCode.SalesDocInvalid, 'partyId']]);
    expect(env.issues(env.post(env.order({ partyDetails: undefined }))).map((i) => [i.code, i.path])).toEqual([[IssueCode.PartyDetailsInvalid, 'partyDetails']]);
    expect(env.issues(env.post(env.order({ partyDetails: env.details(env.beta) }))).map((i) => i.path)).toEqual(['partyDetails']);
    expect(env.codes(env.post(env.order({ lines: [] })))).toEqual([IssueCode.TooFewLines]);
    expect(env.codes(env.post(env.order({ partyId: newId('nobody'), partyDetails: undefined })))).toContain(IssueCode.SalesDocInvalid);
  });

  it('checks each line on its own cell: item, quantity for the unit, due date, and duplicate ids', () => {
    const env = new Env();
    const line = (over: Record<string, unknown>) => ({ id: 'a', itemId: env.bolt, qty: '5', rate: '25', dueDate: '2024-05-20', ...over });
    const at = (l: unknown[]) => env.issues(env.post(env.order({ lines: l }))).map((i) => `${i.path}:${i.code}`);
    expect(at([line({ qty: '2.5' })])).toEqual([`lines.0.qty:${IssueCode.StockLineInvalid}`]); // Nos are whole
    expect(at([line({ itemId: env.consulting })])).toEqual([`lines.0.itemId:${IssueCode.StockLineInvalid}`]); // a service has no stock
    expect(at([line({ qty: '0' })])).toEqual([`lines.0.qty:${IssueCode.StockLineInvalid}`]);
    expect(at([line({ dueDate: '2024-04-30' })])).toEqual([`lines.0.dueDate:${IssueCode.SalesDocInvalid}`]); // before the order date
    expect(at([line({}), line({ dueDate: '2024-06-01' })])).toEqual([`lines.1.id:${IssueCode.SalesDocInvalid}`]);
    expect(at([line({ qty: 'x' })])).toEqual([`lines.0.qty:${IssueCode.SchemaInvalid}`]);
  });
});

describe('a sales invoice', () => {
  it('posts Dr customer / Cr sales, takes the goods out of stock, and fills the order line it names', () => {
    const env = new Env();
    const so = env.must(env.order());
    const inv = env.must(env.invoice([env.against(so, 'a', '12')]));
    const plan = env.plan(inv);
    expect(plan.journal.map((l) => [l.ledgerId, l.side, l.amount])).toEqual([
      [partyLedgerId(env.acme, 'customer'), 'debit', 30000n], // 12 × 25.00 = 300.00
      [env.salesLedger, 'credit', 30000n],
    ]);
    expect(plan.stock.map((m) => [m.itemId, m.warehouseId, m.direction, m.qty, m.value])).toEqual([[env.bolt, env.main, 'out', 120000n, undefined]]);
    expect(plan.links.map((l) => [l.voucherId, l.lineNo, l.orderId, l.orderLineId, l.qty])).toEqual([[inv.id, 1, so.id, 'a', 120000n]]);
    expect(checkPlanInvariants(plan)).toEqual([]);
    expect(fill(env, so)).toEqual(['12.000/18.000', '0.000/10.500']);
    expect(env.orders().state(so.id)?.status).toBe('open');
  });

  it('is fine without an order: goods sold over the counter', () => {
    const env = new Env();
    const inv = env.must(env.invoice([{ itemId: env.bolt, warehouseId: env.main, qty: '3', rate: '30' }]));
    expect(env.plan(inv).links).toEqual([]);
    expect(env.plan(inv).journal[0]?.amount).toBe(9000n);
  });

  it('totals each line to the paisa and refuses an invoice that comes to nothing', () => {
    const env = new Env();
    const inv = env.must(
      env.invoice([
        { itemId: env.sheet, warehouseId: env.main, qty: '3', rate: '33.3333' }, // 99.9999 → 100.00
        { itemId: env.bolt, warehouseId: env.main, qty: '1', rate: '0.005' }, // 0.005 → 0.01 (half up)
      ]),
    );
    expect(env.plan(inv).journal[0]?.amount).toBe(10001n);
    const free = env.post(env.invoice([{ itemId: env.bolt, warehouseId: env.main, qty: '1', rate: '0' }]));
    expect(env.codes(free)).toEqual([IssueCode.AmountNotPositive]);
  });

  it('the customer’s line is a NEW BILL named by the invoice number and due on the due date', () => {
    const env = new Env();
    const inv = env.must(env.invoice([{ itemId: env.bolt, warehouseId: env.main, qty: '4', rate: '25' }]));
    const bills = openBills(env.vouchers, env.masters, partyLedgerId(env.acme, 'customer') as never);
    expect(bills).toMatchObject([{ ref: 'SAL/24-25/0001', dueDate: '2024-06-11', pending: 10000n, side: 'debit', voucherId: inv.id }]);
    env.cancel(inv);
    expect(openBills(env.vouchers, env.masters, partyLedgerId(env.acme, 'customer') as never)).toEqual([]);
  });

  it('is refused on the exact line for each way an order line can be wrong', () => {
    const env = new Env();
    const so = env.must(env.order());
    const other = env.must(env.order({ partyId: env.beta, partyDetails: env.details(env.beta) }));
    const on = (line: unknown, over: Record<string, unknown> = {}) =>
      env.issues(env.post(env.invoice([line], over))).map((i) => `${i.path}:${i.code}`);
    expect(on(env.against(so, 'zzz', '1'))).toEqual([`lines.0.orderRef:${IssueCode.OrderRefInvalid}`]); // no such line
    expect(on(env.against(so, 'a', '1', env.sheet))).toEqual([`lines.0.orderRef:${IssueCode.OrderRefInvalid}`]); // another item
    expect(on(env.against(other, 'a', '1'))).toEqual([`lines.0.orderRef:${IssueCode.OrderRefInvalid}`]); // another customer's order
    expect(on(env.against({ ...so, id: newId('nothing') as VoucherId }, 'a', '1'))).toEqual([`lines.0.orderRef:${IssueCode.OrderRefInvalid}`]);
    expect(on(env.against(so, 'a', '1'), { date: '2024-04-30', dueDate: '2024-05-30' })).toEqual([`lines.0.orderRef:${IssueCode.OrderRefInvalid}`]); // before the order
    expect(env.issues(env.post(env.invoice([env.against(so, 'zzz', '1')])))[0]?.message).toMatch(/no such line/);
  });

  it('refuses a closed order, and a customer that is not one', () => {
    const env = new Env();
    const so = env.must(env.order());
    expect(env.alter(so, { ...(so.content as object), closed: true }).ok).toBe(true);
    const refused = env.post(env.invoice([env.against(so, 'a', '1')]));
    expect(env.issues(refused)[0]).toMatchObject({ code: IssueCode.OrderRefInvalid, path: 'lines.0.orderRef' });
    expect(env.issues(refused)[0]?.message).toMatch(/is closed/);
    const notCustomer = env.post(env.invoice([{ itemId: env.bolt, warehouseId: env.main, qty: '1', rate: '5' }], { partyId: env.supplier, partyDetails: env.details(env.supplier) }));
    expect(env.issues(notCustomer)[0]).toMatchObject({ code: IssueCode.SalesDocInvalid, path: 'partyId' });
  });

  it('is booked to a ledger under Sales Accounts, and has a due date that is not before it', () => {
    const env = new Env();
    const line = { itemId: env.bolt, warehouseId: env.main, qty: '1', rate: '5' };
    expect(env.issues(env.post(env.invoice([line], { salesLedgerId: env.cashLedger }))).map((i) => i.path)).toEqual(['salesLedgerId']);
    expect(env.issues(env.post(env.invoice([line], { dueDate: '2024-05-01' }))).map((i) => i.path)).toEqual(['dueDate']);
    expect(env.codes(env.post(env.invoice([])))).toEqual([IssueCode.TooFewLines]);
    expect(env.issues(env.post(env.invoice([line], { partyDetails: undefined }))).map((i) => i.code)).toEqual([IssueCode.PartyDetailsInvalid]);
  });

  it('cannot take stock that is not there: refused on the quantity cell, and no order fill is recorded', () => {
    const env = new Env();
    const so = env.must(env.order({ lines: [{ id: 'a', itemId: env.bolt, qty: '500', rate: '25', dueDate: '2024-05-20' }] }));
    const r = env.post(env.invoice([env.against(so, 'a', '101')]));
    expect(env.issues(r)[0]).toMatchObject({ code: IssueCode.StockNegative, path: 'lines.0.qty' });
    expect(env.orders().linksTo(so.id)).toEqual([]);
  });
});

describe('over-delivery is blocked', () => {
  it('says how much is pending, and counts the invoice’s own other lines against the same order line', () => {
    const env = new Env();
    const so = env.must(env.order());
    env.must(env.invoice([env.against(so, 'a', '10')])); // 10/18
    const over = env.post(env.invoice([env.against(so, 'a', '10')]));
    expect(env.issues(over)).toMatchObject([{ code: IssueCode.OverDelivery, path: 'lines.0.qty', message: 'SO/24-25/0001: 8 Nos pending, you are delivering 10 Nos' }]);
    // 5 + 5 on two lines of one invoice: the second is the one that goes over 8 pending
    const two = env.post(env.invoice([env.against(so, 'a', '5'), env.against(so, 'a', '5')]));
    expect(env.issues(two)).toMatchObject([{ code: IssueCode.OverDelivery, path: 'lines.1.qty', message: 'SO/24-25/0001: 3 Nos pending, you are delivering 5 Nos' }]);
    // exactly the pending quantity is fine, and fills the line
    env.must(env.invoice([env.against(so, 'a', '8')]));
    expect(fill(env, so)).toEqual(['18.000/18.000', '0.000/10.500']);
    const after = env.post(env.invoice([env.against(so, 'a', '1')]));
    expect(env.issues(after)[0]?.message).toMatch(/already delivered in full/);
  });

  it('an order is Open while any line is pending and Closed (fulfilled) when every line is delivered', () => {
    const env = new Env();
    const so = env.must(env.order());
    env.must(env.invoice([env.against(so, 'a', '18')]));
    expect(env.orders().state(so.id)).toMatchObject({ status: 'open' }); // the sheet line is still open
    env.must(env.invoice([{ ...env.against(so, 'b', '10.5', env.sheet, '120') }]));
    expect(env.orders().state(so.id)).toMatchObject({ status: 'closed', reason: 'fulfilled' });
  });

  it('cancelling an invoice reopens what it had filled', () => {
    const env = new Env();
    const so = env.must(env.order());
    const inv = env.must(env.invoice([env.against(so, 'a', '18'), env.against(so, 'b', '10.5', env.sheet, '120')]));
    expect(env.orders().state(so.id)?.status).toBe('closed');
    expect(env.cancel(inv).ok).toBe(true);
    expect(env.orders().state(so.id)).toMatchObject({ status: 'open' });
    expect(fill(env, so)).toEqual(['0.000/18.000', '0.000/10.500']);
  });

  it('altering an invoice takes its own delivery out first, so it can keep or change its own quantity', () => {
    const env = new Env();
    const so = env.must(env.order());
    const inv = env.must(env.invoice([env.against(so, 'a', '18')]));
    const same = env.alter(inv, { ...(inv.content as object) });
    expect(same.ok).toBe(true);
    const more = env.alter(inv, { ...(inv.content as object), lines: [env.against(so, 'a', '19')] });
    expect(env.issues(more)[0]).toMatchObject({ code: IssueCode.OverDelivery, path: 'lines.0.qty' });
    const fewer = env.alter(env.vouchers.find((v) => v.id === inv.id) as Voucher, { ...(inv.content as object), lines: [env.against(so, 'a', '10')] });
    expect(fewer.ok).toBe(true);
    expect(fill(env, so)).toEqual(['10.000/18.000', '0.000/10.500']);
  });
});

describe('altering and cancelling an order that has deliveries', () => {
  const setup = () => {
    const env = new Env();
    const so = env.must(env.order());
    env.must(env.invoice([env.against(so, 'a', '10')]));
    return { env, so };
  };

  it('cannot be cancelled while anything is delivered against it; can be once those invoices are cancelled', () => {
    const { env, so } = setup();
    expect(env.codes(env.cancel(so))).toEqual([IssueCode.OrderHasDeliveries]);
    env.cancel(env.vouchers.find((v) => v.number === 'SAL/24-25/0001') as Voucher);
    expect(env.cancel(so).ok).toBe(true);
  });

  it('cannot shrink a line below what was delivered, drop a delivered line, change its item, or move past the invoice date', () => {
    const { env, so } = setup();
    const lines = (over: Record<string, unknown>[]) => ({ ...(so.content as object), lines: over });
    const a = { id: 'a', itemId: env.bolt, qty: '18', rate: '25', dueDate: '2024-05-20' };
    const b = { id: 'b', itemId: env.sheet, qty: '10.5', rate: '120', dueDate: '2024-06-10' };
    const path = (input: unknown) => env.issues(env.alter(so, input)).map((i) => `${i.path}:${i.code}`);
    expect(path(lines([{ ...a, qty: '9' }, b]))).toEqual([`lines.0.qty:${IssueCode.OrderHasDeliveries}`]);
    expect(path(lines([b]))).toEqual([`lines:${IssueCode.OrderHasDeliveries}`]);
    expect(path(lines([{ ...a, itemId: env.sheet, qty: '18' }, b]))).toEqual([`lines.0.itemId:${IssueCode.OrderHasDeliveries}`]);
    expect(path({ ...lines([a, b]), date: '2024-05-13' })).toEqual([`date:${IssueCode.OrderHasDeliveries}`]);
    expect(path({ ...lines([a, b]), partyId: env.beta, partyDetails: env.details(env.beta) })).toEqual([`partyId:${IssueCode.OrderHasDeliveries}`]);
  });

  it('can still grow, add lines, change other lines’ dates, and be closed by hand', () => {
    const { env, so } = setup();
    const a = { id: 'a', itemId: env.bolt, qty: '20', rate: '26', dueDate: '2024-05-25' };
    const b = { id: 'b', itemId: env.sheet, qty: '10.5', rate: '120', dueDate: '2024-06-30' };
    const c = { id: 'c', itemId: env.bolt, qty: '4', rate: '25', dueDate: '2024-06-30' };
    expect(env.alter(so, { ...(so.content as object), lines: [a, b, c] }).ok).toBe(true);
    expect(fill(env, so)).toEqual(['10.000/20.000', '0.000/10.500', '0.000/4.000']);
    const now = env.vouchers.find((v) => v.id === so.id) as Voucher;
    expect(env.alter(now, { ...(now.content as object), closed: true }).ok).toBe(true);
    expect(env.orders().state(so.id)).toMatchObject({ status: 'closed', reason: 'manual' });
  });
});

describe('the order book', () => {
  it('is derived from posted vouchers only: a cancelled order or invoice is not in it', () => {
    const env = new Env();
    const so = env.must(env.order());
    const inv = env.must(env.invoice([env.against(so, 'a', '5')]));
    expect(orderBookOf(env.vouchers, env.masters).links).toHaveLength(1);
    env.cancel(inv);
    expect(orderBookOf(env.vouchers, env.masters).links).toHaveLength(0);
    expect(env.cancel(so).ok).toBe(true);
    expect(orderBookOf(env.vouchers, env.masters).orders).toHaveLength(0);
  });

  it('answers the same however the vouchers were assembled', () => {
    const env = new Env();
    const so1 = env.must(env.order());
    const so2 = env.must(env.order({ date: '2024-05-02' }));
    env.must(env.invoice([env.against(so1, 'a', '5')]));
    env.must(env.invoice([env.against(so2, 'a', '7'), env.against(so1, 'b', '1', env.sheet, '120')]));
    const forward = orderBookOf(env.vouchers, env.masters);
    const backward = orderBookOf([...env.vouchers].reverse(), env.masters);
    expect(backward.all().map((s) => [s.order.number, s.status, s.lines.map((l) => l.delivered)])).toEqual(
      forward.all().map((s) => [s.order.number, s.status, s.lines.map((l) => l.delivered)]),
    );
  });

  it('withChange leaves the book it was called on untouched', () => {
    const env = new Env();
    const so = env.must(env.order());
    const inv = env.must(env.invoice([env.against(so, 'a', '5')]));
    const book = env.orders();
    const without = book.withChange({ removeLinksOf: [inv.id] });
    expect(book.deliveredOn(so.id, 'a')).toBe(50000n);
    expect(without.deliveredOn(so.id, 'a')).toBe(0n);
    expect(without.order(so.id)).toBeDefined();
    expect(book.withChange({ removeOrders: [so.id] }).order(so.id)).toBeUndefined();
  });
});

describe('the plan invariants of documents and deliveries', () => {
  it('a document posts no journal and no stock; anything else needs its lines', () => {
    const env = new Env();
    const so = env.must(env.order());
    const plan = env.plan(so);
    expect(checkPlanInvariants(plan, { document: true })).toEqual([]);
    expect(checkPlanInvariants(plan).map((i) => i.code)).toContain(IssueCode.PlanTooFewLines);
    const withStock = stampPlan(so.id, so.date, [], [{ itemId: env.bolt, warehouseId: env.main, direction: 'out', qty: 10000n as never }]);
    expect(checkPlanInvariants(withStock, { document: true }).map((i) => i.code)).toContain(IssueCode.PlanInconsistentLines);
  });

  it('a delivery must match the stock going out on its own invoice line', () => {
    const env = new Env();
    const so = env.must(env.order());
    const inv = env.must(env.invoice([env.against(so, 'a', '5')]));
    const plan = env.plan(inv);
    const link = plan.links[0];
    if (!link) throw new Error('no link');
    expect(checkPlanInvariants({ ...plan, links: [{ ...link, qty: 10000n as never }] }).map((i) => i.code)).toContain(IssueCode.PlanInconsistentLines);
    expect(checkPlanInvariants({ ...plan, links: [{ ...link, lineNo: 2 }] }).map((i) => i.code)).toContain(IssueCode.PlanInconsistentLines);
    expect(checkPlanInvariants({ ...plan, links: [link, link] }).map((i) => i.code)).toContain(IssueCode.PlanInconsistentLines);
  });
});
