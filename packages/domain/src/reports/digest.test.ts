import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { type LedgerId, type StockItemId, type WarehouseId, asCompanyId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { seedCompany } from '../masters/seed';
import { money } from '../money';
import { orderBookOf } from '../orders/orderBook';
import { prepareVoucher } from '../posting/engine';
import type { JournalLine, PostingPlan } from '../posting/plan';
import { StockBook } from '../stock/book';
import { customerLedgerOf } from '../vouchers/kinds/documents';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { dailyDigest, digestHtml, digestSheetRows, dueItemRows, inr } from './digest';

const newId = (n: string) => deterministicUuid(`digest|${n}`);
const kinds = defaultVoucherKinds();

/** A small company: one customer on 30 days, one supplier on 10, one item in stock, one bank. */
class Books {
  masters: Masters;
  vouchers: Voucher[] = [];
  private plans = new Map<string, PostingPlan>();
  readonly bolt = newId('bolt') as StockItemId;
  readonly acme = newId('acme');
  readonly steel = newId('steel');
  readonly sales = newId('sales');
  readonly purchases = newId('purchases') as LedgerId;
  readonly bank = newId('bank') as LedgerId;
  readonly main: WarehouseId;

  constructor() {
    let m = seedCompany({ name: 'Padekar Engineering', fyStart: localDate('2024-04-01'), newId });
    const run = (kind: string, id: string, data: unknown) => {
      const r = prepareMasterCommand({ op: 'create', kind, id, data }, m);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      m = r.value.masters;
    };
    const group = (key: string) => newId(`group:${key}`);
    run('stockItem', this.bolt, { name: 'Hex Bolt', unitId: m.units.find((u) => u.symbol === 'Nos')?.id, itemType: 'finished' });
    run('party', this.acme, { name: 'Acme Ltd', roles: ['customer'], creditDays: 30 });
    run('party', this.steel, { name: 'Steel Supplier', roles: ['vendor'], creditDays: 10 });
    run('ledger', this.sales, { name: 'Sales', groupId: group('sales-accounts') });
    run('ledger', this.purchases, { name: 'Purchases', groupId: group('purchase-accounts') });
    run('ledger', this.bank, { name: 'HDFC Bank', groupId: group('bank-accounts') });
    this.masters = m;
    this.main = m.warehouses[0]?.id as WarehouseId;
  }

  type = (base: string) => this.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;
  lines = (): JournalLine[] => this.vouchers.flatMap((v) => (this.plans.get(v.id)?.journal ?? []) as JournalLine[]);

  post(input: Record<string, unknown>): Voucher {
    const stock = new StockBook(this.vouchers.flatMap((v) => this.plans.get(v.id)?.stock ?? []));
    const r = prepareVoucher({ id: newId(`v${this.vouchers.length}`), ...input }, this.masters, kinds, stock, orderBookOf(this.vouchers, this.masters));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const n = this.vouchers.length + 1;
    const v: Voucher = {
      id: r.value.draft.id,
      companyId: asCompanyId('c'),
      voucherTypeId: r.value.voucherType.id,
      financialYearId: r.value.financialYear.id,
      number: `${r.value.voucherType.baseKind.toUpperCase()}/${n}`,
      date: r.value.draft.date,
      status: 'posted',
      version: 1,
      revision: 0,
      content: r.value.draft,
    };
    // journal lines carry the voucher's id and date (as the backends store them)
    const plan = { ...r.value.plan, journal: r.value.plan.journal.map((l, i) => ({ ...l, voucherId: v.id, date: v.date, lineNo: i + 1 })) } as unknown as PostingPlan;
    this.vouchers.push(v);
    this.plans.set(v.id, plan);
    return v;
  }

  digest(asOn: string, inboxWaiting = 0) {
    return dailyDigest({ vouchers: this.vouchers, lines: this.lines(), masters: this.masters, orders: orderBookOf(this.vouchers, this.masters), asOn: localDate(asOn), inboxWaiting });
  }
}

const details = (partyId: string) => ({ partyId, mailingName: 'X' });

function trading(): Books {
  const b = new Books();
  b.post({ voucherTypeId: b.type('purchase'), date: '2024-05-01', partyId: b.steel, partyDetails: details(b.steel), purchaseLedgerId: b.purchases, billNo: 'SS/1', dueDate: '2024-05-11', lines: [{ itemId: b.bolt, warehouseId: b.main, qty: '1000', rate: '4' }] });
  b.post({ voucherTypeId: b.type('purchase'), date: '2024-05-20', partyId: b.steel, partyDetails: details(b.steel), purchaseLedgerId: b.purchases, billNo: 'SS/2', dueDate: '2024-06-12', lines: [{ itemId: b.bolt, warehouseId: b.main, qty: '100', rate: '4' }] });
  b.post({ voucherTypeId: b.type('sales'), date: '2024-05-02', partyId: b.acme, partyDetails: details(b.acme), salesLedgerId: b.sales, dueDate: '2024-06-01', lines: [{ itemId: b.bolt, warehouseId: b.main, qty: '200', rate: '10' }] });
  b.post({ voucherTypeId: b.type('sales'), date: '2024-06-09', partyId: b.acme, partyDetails: details(b.acme), salesLedgerId: b.sales, dueDate: '2024-07-09', lines: [{ itemId: b.bolt, warehouseId: b.main, qty: '50', rate: '10' }] });
  b.post({ voucherTypeId: b.type('receipt'), date: '2024-06-09', accountLedgerId: b.bank, lines: [{ ledgerId: customerLedgerOf(b.acme as never), amount: '500', allocations: [{ kind: 'against', ref: 'SALES/3', amount: '500' }] }] });
  b.post({
    voucherTypeId: b.type('salesOrder'),
    date: '2024-06-09',
    partyId: b.acme,
    partyDetails: details(b.acme),
    reference: 'PO-9',
    lines: [
      { id: 'a', itemId: b.bolt, qty: '10', rate: '10', dueDate: '2024-06-12' },
      { id: 'b', itemId: b.bolt, qty: '10', rate: '10', dueDate: '2024-07-30' },
    ],
  });
  return b;
}

describe('the daily report', () => {
  it('says what happened yesterday, from the Day Book', () => {
    const d = trading().digest('2024-06-10');
    expect(d.yesterday).toBe('2024-06-09');
    expect(d.day).toEqual({ sales: money(50000n), purchases: money(0n), receipts: money(50000n), payments: money(0n), vouchers: 3, orders: 1 });
  });

  it('who owes us and how much is late; what we must pay this week; which order lines are due', () => {
    const d = trading().digest('2024-06-10');
    // SALES/3 (2000, due 1 Jun) is 9 days late, less the 500 received; SALES/4 (500) is not yet due
    expect(d.receivables.total).toBe(money(200000n));
    expect(d.receivables.overdue).toBe(money(150000n));
    expect(d.receivables.topOverdue).toEqual([{ name: 'Acme Ltd', overdue: money(150000n), oldestDays: 9 }]);
    // SS/1 was due 11 May (late), SS/2 is due 12 Jun (this week)
    expect(d.payablesDue.bills.map((b) => b.ref)).toEqual(['SS/1', 'SS/2']);
    expect(d.payablesDue.total).toBe(money(440000n));
    // line a due 12 Jun (this week), line b 30 Jul (not yet)
    expect(d.orders).toEqual({
      overdueLines: 0,
      dueThisWeek: 1,
      lines: [{ dueDate: '2024-06-12', custPo: 'PO-9', number: 'SALESORDER/6', party: 'Acme Ltd', item: 'Hex Bolt', pending: '10 Nos', overdue: false, daysLate: 0 }],
    });
    // two days after it was due, the same line is late — with its PO still on it
    expect(trading().digest('2024-06-14').orders.lines[0]).toMatchObject({ custPo: 'PO-9', overdue: true, daysLate: 2 });
    expect(d.gstNetThisMonth).toBeUndefined(); // the company does not charge GST
  });

  it('reads as a mail and as sheet rows', () => {
    const d = trading().digest('2024-06-10', 2);
    const html = digestHtml(d);
    expect(html).toContain('Padekar Engineering');
    expect(html).toContain('₹ 1,500.00');
    expect(html).toContain('SS/1');
    expect(html).toContain('2 documents waiting in the AI Inbox');
    expect(digestSheetRows(d)).toContainEqual(['2024-06-10', 'Receivables overdue', 1500]);
    // the due items: a row each with its due date and the customer's PO
    expect(html).toContain('Cust PO');
    expect(html).toContain('PO-9');
    expect(html).toContain('12-06-2024');
    expect(dueItemRows(d)).toEqual([['2024-06-10', '2024-06-12', 'PO-9', 'Acme Ltd', 'Hex Bolt', '10 Nos', 'SALESORDER/6', 'due']]);
  });

  it('writes rupees the Indian way', () => {
    expect(inr(money(12345678900n))).toBe('₹ 12,34,56,789.00');
    expect(inr(money(99n))).toBe('₹ 0.99');
    expect(inr(money(-150000n))).toBe('-₹ 1,500.00');
  });

  it('a quiet day on empty books is all zeros, never a failure', () => {
    const d = new Books().digest('2024-06-10');
    expect(d.day.vouchers).toBe(0);
    expect(d.receivables.total).toBe(money(0n));
    expect(digestHtml(d)).toContain('Nothing due');
  });
});
