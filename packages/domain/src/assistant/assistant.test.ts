import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { type LedgerId, type StockItemId, type WarehouseId, asCompanyId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { seedCompany } from '../masters/seed';
import { orderBookOf } from '../orders/orderBook';
import { prepareVoucher } from '../posting/engine';
import type { JournalLine, PostingPlan } from '../posting/plan';
import { StockBook } from '../stock/book';
import type { StockMovement } from '../stock/movement';
import { customerLedgerOf } from '../vouchers/kinds/documents';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { ASSISTANT_TOOLS, assistantPrompt, describeScreen, runLookup } from './assistant';
import type { AssistantBooks } from './lookups';

const newId = (n: string) => deterministicUuid(`assistant|${n}`);
const kinds = defaultVoucherKinds();

/** Micro Components in small: the 14188 blank and two variants made from it, Honeywell as customer, a supplier, a bank. */
class Books {
  masters: Masters;
  vouchers: Voucher[] = [];
  private plans = new Map<string, PostingPlan>();
  readonly blank = newId('14188') as StockItemId;
  readonly v1 = newId('14188-1') as StockItemId;
  readonly v18 = newId('14188-18') as StockItemId;
  readonly honeywell = newId('honeywell');
  readonly vendor = newId('vendor');
  readonly sales = newId('sales');
  readonly purchases = newId('purchases') as LedgerId;
  readonly bank = newId('bank') as LedgerId;
  readonly main: WarehouseId;

  constructor() {
    let m = seedCompany({ name: 'Micro Components', fyStart: localDate('2026-04-01'), newId });
    const run = (kind: string, id: string, data: unknown) => {
      const r = prepareMasterCommand({ op: 'create', kind, id, data }, m);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      m = r.value.masters;
    };
    const nos = m.units.find((u) => u.symbol === 'Nos')?.id;
    const group = (key: string) => newId(`group:${key}`);
    run('stockItem', this.blank, { name: '14188- Orifice Blank,90', code: '14188', unitId: nos, itemType: 'raw' });
    run('stockItem', this.v1, { name: '14188-1 - PLT,ORIF,24.0MM', code: '14188-1', unitId: nos, itemType: 'trading' });
    run('stockItem', this.v18, { name: '14188-18 - PLT,ORIF,31.0MM DIA', code: '14188-18', unitId: nos, itemType: 'trading' });
    run('party', this.honeywell, { name: 'Eclipse Combustion Pvt Ltd', roles: ['customer'], creditDays: 45 });
    run('party', this.vendor, { name: 'Sai Profile Cutting', roles: ['vendor'], creditDays: 30 });
    run('ledger', this.sales, { name: 'Sales', groupId: group('sales-accounts') });
    run('ledger', this.purchases, { name: 'Purchases', groupId: group('purchase-accounts') });
    run('ledger', this.bank, { name: 'HDFC Bank', groupId: group('bank-accounts') });
    this.masters = m;
    this.main = m.warehouses[0]?.id as WarehouseId;
  }

  type = (base: string) => this.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;

  post(input: Record<string, unknown>): Voucher {
    const stock = new StockBook(this.movements());
    const r = prepareVoucher({ id: newId(`v${this.vouchers.length}`), ...input }, this.masters, kinds, stock, orderBookOf(this.vouchers, this.masters));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const n = this.vouchers.length + 1;
    const v: Voucher = {
      id: r.value.draft.id,
      companyId: asCompanyId('c'),
      voucherTypeId: r.value.voucherType.id,
      financialYearId: r.value.financialYear.id,
      number: `26-27/${String(n).padStart(3, '0')}`,
      date: r.value.draft.date,
      status: 'posted',
      version: 1,
      revision: 0,
      content: r.value.draft,
    };
    const plan = {
      ...r.value.plan,
      journal: r.value.plan.journal.map((l, i) => ({ ...l, voucherId: v.id, date: v.date, lineNo: i + 1 })),
      stock: r.value.plan.stock.map((s, i) => ({ ...s, voucherId: v.id, date: v.date, lineNo: i + 1 })),
    } as unknown as PostingPlan;
    this.vouchers.push(v);
    this.plans.set(v.id, plan);
    return v;
  }

  movements = (): StockMovement[] => this.vouchers.flatMap((v) => (this.plans.get(v.id)?.stock ?? []) as StockMovement[]);
  books = (today = '2026-09-26'): AssistantBooks => ({
    masters: this.masters,
    vouchers: this.vouchers,
    lines: this.vouchers.flatMap((v) => (this.plans.get(v.id)?.journal ?? []) as JournalLine[]),
    movements: this.movements(),
    today: localDate(today),
  });
}

const details = (partyId: string) => ({ partyId, mailingName: 'X' });

function micro(): Books {
  const b = new Books();
  // 50 blanks bought; 2 × 14188-18 made and sold; Honeywell's open PO for one 14188-1
  b.post({ voucherTypeId: b.type('purchase'), date: '2026-09-01', partyId: b.vendor, partyDetails: details(b.vendor), purchaseLedgerId: b.purchases, billNo: 'SPC/77', dueDate: '2026-10-01', lines: [{ itemId: b.blank, warehouseId: b.main, qty: '50', rate: '200' }] });
  b.post({ voucherTypeId: b.type('purchase'), date: '2026-09-02', partyId: b.vendor, partyDetails: details(b.vendor), purchaseLedgerId: b.purchases, billNo: 'SPC/78', dueDate: '2026-10-02', lines: [{ itemId: b.v18, warehouseId: b.main, qty: '2', rate: '300' }] });
  b.post({ voucherTypeId: b.type('sales'), date: '2026-09-10', partyId: b.honeywell, partyDetails: details(b.honeywell), salesLedgerId: b.sales, reference: '4423609974', dueDate: '2026-09-20', lines: [{ itemId: b.v18, warehouseId: b.main, qty: '2', rate: '500' }] });
  b.post({ voucherTypeId: b.type('receipt'), date: '2026-09-15', accountLedgerId: b.bank, lines: [{ ledgerId: customerLedgerOf(b.honeywell as never), amount: '400', allocations: [{ kind: 'against', ref: '26-27/003', amount: '400' }] }] });
  b.post({
    voucherTypeId: b.type('salesOrder'),
    date: '2026-09-16',
    partyId: b.honeywell,
    partyDetails: details(b.honeywell),
    reference: '4423830117',
    lines: [{ id: 'l1', itemId: b.v1, qty: '1', rate: '450', dueDate: '2026-09-30' }],
  });
  return b;
}

describe('the assistant\'s look-ups', () => {
  it('stock of a family code: the blank itself, and its variants with their stock', () => {
    const r = runLookup(micro().books(), 'stock', { item: '14188' }) as Record<string, unknown>;
    expect(r).toMatchObject({ found: true, code: '14188', inStock: '50 Nos', type: 'raw material' });
    expect((r['family'] as { rows: { code: string; inStock: string }[] }).rows.map((x) => [x.code, x.inStock])).toEqual([
      ['14188-1', '0 Nos'],
      ['14188-18', '0 Nos'],
    ]);
  });

  it('an exact code is that item only — 14188-1 is never 14188-18', () => {
    const r = runLookup(micro().books(), 'stock', { item: '14188-1' }) as Record<string, unknown>;
    expect(r).toMatchObject({ found: true, code: '14188-1', inStock: '0 Nos' });
    expect(r['family']).toBeUndefined();
  });

  it('a word matching several items asks which one; an unknown one says so', () => {
    expect(runLookup(micro().books(), 'stock', { item: 'orif' })).toMatchObject({ found: false, note: 'Several items match: say which one.' });
    expect(runLookup(micro().books(), 'stock', { item: 'MX99' })).toMatchObject({ found: false, note: 'No item has this code or name.' });
  });

  it("open customer orders for an item: the customer's PO, pending and due", () => {
    const r = runLookup(micro().books(), 'orders', { item: '14188-1' }) as { rows: Record<string, unknown>[] };
    expect(r.rows).toEqual([
      expect.objectContaining({ customerPo: '4423830117', party: 'Eclipse Combustion Pvt Ltd', item: '14188-1 - PLT,ORIF,24.0MM', due: '2026-09-30', pending: '1 Nos', status: 'Open' }),
    ]);
    expect((runLookup(micro().books('2026-10-02'), 'orders', { party: 'eclipse' }) as { rows: Record<string, unknown>[] }).rows[0]).toMatchObject({ overdue: true });
  });

  it('invoices: amount, customer PO and how much is still unpaid', () => {
    const r = runLookup(micro().books(), 'invoices', { party: 'eclipse' }) as { rows: Record<string, unknown>[] };
    expect(r.rows[0]).toMatchObject({ number: '26-27/003', reference: '4423609974', amount: '₹ 1,000.00', paid: 'part — ₹ 600.00 still due', due: '2026-09-20', daysLate: 6 });
  });

  it('outstanding: a party\'s open bills, and everyone\'s total', () => {
    expect(runLookup(micro().books(), 'outstanding', { party: 'eclipse' })).toMatchObject({ total: '₹ 600.00', overdue: '₹ 600.00' });
    expect(runLookup(micro().books(), 'outstanding', { side: 'payable' })).toMatchObject({ total: '₹ 10,600.00' });
  });

  it('what is on screen reads from the books, not from the browser', () => {
    const b = micro();
    const inv = b.vouchers[2] as Voucher;
    expect(describeScreen(b.books(), { type: 'voucher', id: inv.id })).toContain('26-27/003');
    expect(describeScreen(b.books(), { type: 'voucher', id: inv.id })).toContain('Eclipse Combustion');
    expect(describeScreen(b.books(), { type: 'master', kind: 'stockItem', id: b.v1 })).toBe('Stock item 14188-1 — 14188-1 - PLT,ORIF,24.0MM');
    expect(describeScreen(b.books(), { type: 'report', title: 'Sales Order Register' })).toBe('Sales Order Register');
  });

  it('the rules, the taught facts and the screen go into the instruction; every look-up is declared', () => {
    const p = assistantPrompt({ company: 'Micro Components', today: localDate('2026-09-26'), facts: [{ number: 1, text: 'We keep 50 blanks of 14188.' }], screen: 'Stock item 14188-1' });
    expect(p).toContain('Micro Components');
    expect(p).toContain('Never guess');
    expect(p).toContain('1. We keep 50 blanks of 14188.');
    expect(p).toContain('Stock item 14188-1');
    expect(ASSISTANT_TOOLS.map((t) => t.name)).toEqual(['find_items', 'stock', 'orders', 'outstanding', 'invoices', 'remember', 'forget']);
    expect(runLookup(micro().books(), 'no_such', {})).toEqual({ error: 'There is no look-up called no_such' });
  });
});
