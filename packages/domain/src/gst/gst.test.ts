import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { IssueCode, type Result } from '../errors';
import { type LedgerId, type StockItemId, type WarehouseId, asCompanyId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { partyLedgerId } from '../masters/records';
import { seedCompany } from '../masters/seed';
import { SYSTEM_LEDGERS, ensureSystemLedgers, systemLedgerId } from '../masters/systemLedgers';
import { formatMoney } from '../money';
import { prepareVoucher } from '../posting/engine';
import { prepareAlteration, prepareCancellation } from '../posting/lifecycle';
import { type PostingPlan } from '../posting/plan';
import { StockBook } from '../stock/book';
import { trialBalance } from '../reports/trialBalance';
import { openBills } from '../vouchers/allocations';
import { deriveGstHeader } from '../vouchers/kinds/gstDoc';
import { gstinCheckChar } from '../masters/rules';
import { gstInvoices, gstReconciliation, gstTotals, gstr1Export, gstr1Rows, gstr1Section, gstr1Validation, gstr3b, hsnRows } from '../reports/gst';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { OrderBook } from '../orders/orderBook';

const newId = (n: string) => deterministicUuid(`gst|${n}`);
const kinds = defaultVoucherKinds();
const D = (s: string) => localDate(s);

/** A company in Maharashtra (27) that buys from Maharashtra and Gujarat (24) and sells to Maharashtra and Delhi (07). */
class Env {
  masters: Masters;
  vouchers: Voucher[] = [];
  private plans = new Map<string, PostingPlan>();
  private seq = 0;
  readonly bolt = newId('bolt') as StockItemId;
  readonly main: WarehouseId;
  readonly acme = newId('acme'); // 27
  readonly delhi = newId('delhi'); // 07
  readonly steel = newId('steel'); // 27 vendor
  readonly gujarat = newId('gujarat'); // 24 vendor
  readonly sales = newId('sales') as LedgerId;
  readonly purchases = newId('purchases') as LedgerId;
  readonly bank = newId('bank') as LedgerId;

  constructor(charge = true) {
    let masters = seedCompany({ name: 'T', fyStart: D('2024-04-01'), newId });
    const run = (kind: string, id: string, data: unknown) => {
      const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      masters = r.value.masters;
    };
    const nos = masters.units.find((u) => u.symbol === 'Nos')?.id as string;
    run('stockItem', this.bolt, { name: 'Bolt', unitId: nos, itemType: 'finished', hsn: '7318' });
    run('party', this.acme, { name: 'Acme Ltd', roles: ['customer'], stateCode: '27', gstin: '27AAPFU0939F1Z' + gstinCheckChar('27AAPFU0939F1Z') });
    run('party', this.delhi, { name: 'Delhi Traders', roles: ['customer'], stateCode: '07' });
    run('party', this.steel, { name: 'Steel Co', roles: ['vendor'], stateCode: '27' });
    run('party', this.gujarat, { name: 'Gujarat Steel', roles: ['vendor'], stateCode: '24' });
    const group = (key: string) => newId(`group:${key}`);
    run('ledger', this.sales, { name: 'Sales', groupId: group('sales-accounts') });
    run('ledger', this.purchases, { name: 'Purchases', groupId: group('purchase-accounts') });
    run('ledger', this.bank, { name: 'HDFC', groupId: group('bank-accounts') });
    if (charge) masters = masters.with({ company: { ...masters.company, gstin: '27AABCD1234E1Z' + gstinCheckChar('27AABCD1234E1Z'), stateCode: '27', chargeGst: true } });
    this.masters = masters;
    this.main = masters.warehouses[0]?.id as WarehouseId;
    // 5,000 bolts brought forward at 40.00 (no accounting effect: the periodic method)
    this.must({ id: newId('open'), voucherTypeId: this.type('stockOpening'), date: '2024-04-01', itemId: this.bolt, warehouseId: this.main, qty: '5000', rate: '40' });
  }

  private type = (base: string) => this.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;
  stock = (): StockBook => new StockBook(this.vouchers.filter((v) => v.status === 'posted').flatMap((v) => this.plans.get(v.id)?.stock ?? []));
  journal = () => this.vouchers.filter((v) => v.status === 'posted').flatMap((v) => this.plans.get(v.id)?.journal ?? []);
  ledgerName = (id: string): string => this.masters.ledger(id as LedgerId)?.name ?? id;
  plan = (v: Voucher) => this.plans.get(v.id) as PostingPlan;
  details = (partyId: string) => ({ partyId, mailingName: 'X' });

  /** Lines are [qty, rate, gstRate?]; the header is derived the way the browser derives it. */
  private invoice(kind: 'sales' | 'purchase', party: string, lines: [string, string, string?][], over: Record<string, unknown> = {}) {
    const ls = lines.map(([qty, rate, gstRate]) => ({ itemId: this.bolt, warehouseId: this.main, qty, rate, ...(gstRate === undefined ? {} : { gstRate }), hsn: '7318' }));
    const partyDetails = this.details(party);
    const gst = deriveGstHeader(this.masters, kind, { partyId: party, partyDetails, lines: ls });
    return {
      id: newId(`${kind}-${this.vouchers.length}`),
      voucherTypeId: this.type(kind),
      date: '2024-05-12',
      partyId: party,
      partyDetails,
      ...(kind === 'sales' ? { salesLedgerId: this.sales } : { purchaseLedgerId: this.purchases, billNo: 'SS/1' }),
      dueDate: '2024-06-11',
      lines: ls,
      ...(gst ? { gst } : {}),
      ...over,
    };
  }
  sale = (party: string, lines: [string, string, string?][], over: Record<string, unknown> = {}) => this.invoice('sales', party, lines, over);
  purchase = (party: string, lines: [string, string, string?][], over: Record<string, unknown> = {}) => this.invoice('purchase', party, lines, over);

  receipt(lines: unknown[], over: Record<string, unknown> = {}) {
    return { id: newId(`rec-${this.vouchers.length}`), voucherTypeId: this.type('receipt'), date: '2024-05-20', accountLedgerId: this.bank, lines, ...over };
  }

  post(input: unknown): Result<Voucher> {
    const r = prepareVoucher(input, this.masters, kinds, this.stock(), OrderBook.empty);
    if (!r.ok) return r;
    const type = r.value.voucherType;
    const v: Voucher = {
      id: r.value.draft.id,
      companyId: asCompanyId('c'),
      voucherTypeId: type.id,
      financialYearId: r.value.financialYear.id,
      number: `${type.baseKind.toUpperCase()}/${String(++this.seq).padStart(4, '0')}`,
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
    const r = prepareCancellation(v, v.version, this.masters, this.stock(), OrderBook.empty);
    if (r.ok) {
      this.vouchers[this.vouchers.indexOf(v)] = { ...v, status: 'cancelled', version: v.version + 1 };
      this.plans.set(v.id, { journal: [], stock: [], links: [] });
    }
    return r;
  }
  alter(v: Voucher, input: unknown): Result<Voucher> {
    const r = prepareAlteration({ existing: v, input, expectedVersion: v.version, masters: this.masters, registry: kinds, stock: this.stock(), orders: OrderBook.empty });
    if (!r.ok) return r;
    const updated: Voucher = { ...v, content: r.value.draft, date: r.value.draft.date, version: v.version + 1 };
    this.vouchers[this.vouchers.indexOf(v)] = updated;
    this.plans.set(v.id, r.value.plan);
    return { ok: true, value: updated };
  }
  /** The journal of one voucher as [ledger, side, amount]. */
  rows(v: Voucher): [string, string, string][] {
    return this.plan(v).journal.map((l) => [this.ledgerName(l.ledgerId), l.side, formatMoney(l.amount)]);
  }
  balance = (name: string): bigint => this.journal().filter((l) => this.ledgerName(l.ledgerId) === name).reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0n);
  balanced = (): boolean => {
    const t = trialBalance(this.journal(), { from: D('2024-04-01'), to: D('2025-03-31') });
    return t.totalClosingDebit === t.totalClosingCredit;
  };
}

const codes = (r: Result<unknown>): string[] => (r.ok ? [] : r.issues.map((i) => i.code));
const paths = (r: Result<unknown>): (string | undefined)[] => (r.ok ? [] : r.issues.map((i) => i.path));

describe('GST on a Sales Invoice', () => {
  it('within the state: the customer owes items + tax, sales gets the items, CGST and SGST each go to their Output ledger', () => {
    const e = new Env();
    const v = e.must(e.sale(e.acme, [['10', '100', '18']]));
    expect(e.rows(v)).toEqual([['Acme Ltd', 'debit', '1180.00'], ['Sales', 'credit', '1000.00'], ['Output CGST', 'credit', '90.00'], ['Output SGST', 'credit', '90.00']]);
    expect(e.balanced()).toBe(true);
    expect(e.balance('Output CGST')).toBe(-9000n);
  });

  it('between states: IGST alone', () => {
    const e = new Env();
    const v = e.must(e.sale(e.delhi, [['10', '100', '18']]));
    expect(e.rows(v)).toEqual([['Delhi Traders', 'debit', '1180.00'], ['Sales', 'credit', '1000.00'], ['Output IGST', 'credit', '180.00']]);
    expect(e.balanced()).toBe(true);
  });

  it('several rates on one invoice: tax per rate, all in the same posting', () => {
    const e = new Env();
    const v = e.must(e.sale(e.acme, [['10', '100', '18'], ['20', '50', '5'], ['1', '10']]));
    // taxable 1,000 @18 + 1,000 @5 + 10 nil = 2,010; tax 180 + 50 = 230
    expect(e.rows(v)).toEqual([['Acme Ltd', 'debit', '2240.00'], ['Sales', 'credit', '2010.00'], ['Output CGST', 'credit', '115.00'], ['Output SGST', 'credit', '115.00']]);
  });

  it('the bill is the invoice total WITH tax, named by the invoice number; stock is valued as it always was', () => {
    const e = new Env();
    const v = e.must(e.sale(e.acme, [['10', '100', '18']]));
    const bills = openBills(e.vouchers, e.masters, partyLedgerId(e.acme as never, 'customer') as LedgerId);
    expect(bills.map((b) => [b.ref, formatMoney(b.pending)])).toEqual([[v.number, '1180.00']]);
    // ten bolts left the store at their cost (40), the tax and the selling price play no part
    expect(e.plan(v).stock.map((m) => [m.direction, m.qty])).toEqual([['out', 100_000n]]);
    expect(e.stock().positionAt(e.bolt, D('2024-12-31')).value).toBe(19_960_000n); // 4,990 left at 40.00 = 1,99,600.00: the sale price and the tax play no part
  });

  it('a line with no rate, or 0%, is not taxed; an invoice with no rated line is exactly what it was before GST', () => {
    const e = new Env();
    const v = e.must(e.sale(e.acme, [['10', '100'], ['5', '10', '0']]));
    expect(e.rows(v)).toEqual([['Acme Ltd', 'debit', '1050.00'], ['Sales', 'credit', '1050.00']]);
    expect(v.content).not.toHaveProperty('gst');
  });

  it('tax that is not what the lines come to is refused, and so is rated lines with no statement of the supply', () => {
    const e = new Env();
    const draft = e.sale(e.acme, [['10', '100', '18']]) as { gst: Record<string, unknown> };
    const wrong = e.post({ ...draft, gst: { ...draft.gst, cgst: '80.00' } });
    expect(codes(wrong)).toEqual([IssueCode.GstInvalid]);
    expect(paths(wrong)).toEqual(['gst.cgst']);
    const none = e.post({ ...draft, gst: undefined });
    expect(codes(none)).toEqual([IssueCode.GstInvalid]);
    // IGST claimed for a supply within the state
    expect(codes(e.post({ ...draft, gst: { supplyState: '27', placeOfSupply: '27', cgst: '0', sgst: '0', igst: '180.00' } }))).toEqual([IssueCode.GstInvalid, IssueCode.GstInvalid, IssueCode.GstInvalid]);
  });

  it('a sale is made from the company’s own state', () => {
    const e = new Env();
    const draft = e.sale(e.acme, [['10', '100', '18']]) as { gst: Record<string, unknown> };
    const r = e.post({ ...draft, gst: { ...draft.gst, supplyState: '24' } });
    expect(paths(r)).toContain('gst.supplyState');
  });

  it('cancelling reverses the tax with the rest; altering re-derives it', () => {
    const e = new Env();
    const v = e.must(e.sale(e.acme, [['10', '100', '18']]));
    const altered = e.alter(v, { ...(e.sale(e.acme, [['20', '100', '18']]) as object), id: v.id });
    expect(altered.ok).toBe(true);
    expect(e.balance('Output CGST')).toBe(-18000n);
    expect(e.cancel(altered.ok ? altered.value : v).ok).toBe(true);
    expect(e.balance('Output CGST')).toBe(0n);
    expect(e.balanced()).toBe(true);
  });
});

describe('GST is off unless the company charges it', () => {
  it('an invoice with no rates posts exactly as before; one with a rate is refused, saying why', () => {
    const e = new Env(false);
    const plain = e.must(e.sale(e.acme, [['10', '100']]));
    expect(e.rows(plain)).toEqual([['Acme Ltd', 'debit', '1000.00'], ['Sales', 'credit', '1000.00']]);
    const rated = e.post(e.sale(e.acme, [['10', '100', '18']], { gst: { supplyState: '27', placeOfSupply: '27', cgst: '90.00', sgst: '90.00', igst: '0' } }));
    expect(codes(rated)).toEqual([IssueCode.GstInvalid]);
    expect(rated.ok ? '' : rated.issues[0]?.message).toContain('Charge GST');
    // the header is not derived while GST is off, so a rated line alone is refused too
    expect(codes(e.post(e.sale(e.acme, [['10', '100', '18']])))).toEqual([IssueCode.GstInvalid]);
  });

  it('switching it on needs the company’s GSTIN', () => {
    const e = new Env(false);
    const r = prepareMasterCommand({ op: 'alter', kind: 'company', id: e.masters.company.id, data: { name: 'T', chargeGst: 'yes' } }, e.masters);
    expect(r.ok).toBe(false);
    const ok = prepareMasterCommand({ op: 'alter', kind: 'company', id: e.masters.company.id, data: { name: 'T', gstin: '27AABCD1234E1Z' + gstinCheckChar('27AABCD1234E1Z'), chargeGst: 'yes' } }, e.masters);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.value.masters.company.chargeGst).toBe(true);
    expect(ok.ok && ok.value.masters.company.stateCode).toBe('27');
  });
});

describe('GST on a Purchase Invoice', () => {
  it('within the state: Input CGST + SGST are debited, the supplier is owed the total; stock is at the items’ value alone', () => {
    const e = new Env();
    const v = e.must(e.purchase(e.steel, [['100', '10', '18']]));
    expect(e.rows(v)).toEqual([['Purchases', 'debit', '1000.00'], ['Input CGST', 'debit', '90.00'], ['Input SGST', 'debit', '90.00'], ['Steel Co', 'credit', '1180.00']]);
    expect(e.plan(v).stock.map((m) => [m.direction, m.value])).toEqual([['in', 100_000n]]); // 1,000.00: the tax is not part of the cost
    expect(e.balanced()).toBe(true);
    expect(openBills(e.vouchers, e.masters, partyLedgerId(e.steel as never, 'vendor') as LedgerId).map((b) => [b.ref, formatMoney(b.pending)])).toEqual([['SS/1', '1180.00']]);
  });

  it('from another state: Input IGST', () => {
    const e = new Env();
    const v = e.must(e.purchase(e.gujarat, [['100', '10', '18']]));
    expect(e.rows(v)).toEqual([['Purchases', 'debit', '1000.00'], ['Input IGST', 'debit', '180.00'], ['Gujarat Steel', 'credit', '1180.00']]);
    expect((v.content as unknown as { gst: { supplyState: string; placeOfSupply: string } }).gst).toMatchObject({ supplyState: '24', placeOfSupply: '27' });
  });

  it('a purchase is received in the company’s state', () => {
    const e = new Env();
    const draft = e.purchase(e.steel, [['100', '10', '18']]) as { gst: Record<string, unknown> };
    expect(paths(e.post({ ...draft, gst: { ...draft.gst, placeOfSupply: '24' } }))).toContain('gst.placeOfSupply');
  });
});

describe('the system ledgers', () => {
  it('every company has them, with reserved keys; ensuring twice adds nothing, and a company missing them gets each once', () => {
    const e = new Env();
    expect(SYSTEM_LEDGERS.map((s) => e.masters.systemLedger(s.key)?.name)).toEqual(SYSTEM_LEDGERS.map((s) => s.name));
    expect(ensureSystemLedgers(e.masters)).toBe(e.masters); // nothing missing: the very same snapshot
    const stripped = e.masters.with({ ledgers: e.masters.ledgers.filter((l) => l.reservedKey === undefined || l.reservedKey === 'opening-difference') });
    expect(stripped.systemLedger('gst-output-cgst')).toBeUndefined();
    const once = ensureSystemLedgers(stripped);
    const twice = ensureSystemLedgers(once);
    expect(twice).toBe(once);
    expect(once.ledgers.filter((l) => l.reservedKey === 'tds-receivable')).toHaveLength(1);
    expect(once.ledgers.length).toBe(e.masters.ledgers.length);
    // the ids are the same ones a fresh company gets, so an upgraded company and a new one agree
    expect(once.systemLedger('gst-input-igst')?.id).toBe(systemLedgerId(once.company.id, 'gst-input-igst'));
    expect(once.systemLedger('gst-input-igst')?.id).toBe(e.masters.systemLedger('gst-input-igst')?.id);
  });

  it('a ledger the company made by hand with the same name is adopted, entries and all — not duplicated', () => {
    const e = new Env();
    const stripped = e.masters.with({ ledgers: e.masters.ledgers.filter((l) => l.reservedKey !== 'tds-receivable') });
    const groupId = e.masters.groups.all.find((g) => g.reservedKey === 'current-assets')?.id as never;
    const mine = { id: newId('mine') as LedgerId, companyId: stripped.company.id, name: 'tds receivable', groupId, isActive: true };
    const upgraded = ensureSystemLedgers(stripped.with({ ledgers: [...stripped.ledgers, mine] }));
    expect(upgraded.ledgers.filter((l) => l.name.toLowerCase() === 'tds receivable').map((l) => [l.id, l.reservedKey, l.groupId])).toEqual([[mine.id, 'tds-receivable', groupId]]);
    expect(upgraded.systemLedger('tds-receivable')?.id).toBe(mine.id);
    expect(ensureSystemLedgers(upgraded)).toBe(upgraded);
    // a customer's own ledger of that name is never adopted
    const partyLedger = { ...mine, id: newId('pl') as LedgerId, name: 'Output CGST', partyId: e.acme as never, partyRole: 'customer' as const };
    const withParty = ensureSystemLedgers(e.masters.with({ ledgers: [...e.masters.ledgers.filter((l) => l.reservedKey !== 'gst-output-cgst'), partyLedger] }));
    expect(withParty.systemLedger('gst-output-cgst')?.id).not.toBe(partyLedger.id);
  });

  it('cannot be renamed, moved or deactivated', () => {
    const e = new Env();
    const ledger = e.masters.systemLedger('tds-receivable');
    const r = prepareMasterCommand({ op: 'alter', kind: 'ledger', id: ledger?.id as string, data: { name: 'Other', groupId: ledger?.groupId } }, e.masters);
    expect(r.ok ? '' : r.issues[0]?.code).toBe(IssueCode.SystemMasterLocked);
  });
});

describe('TDS on a Receipt', () => {
  /** Invoice 100,000 to Acme (no GST), then what the customer pays against it. */
  const setup = () => {
    const e = new Env();
    const inv = e.must(e.sale(e.acme, [['1000', '100']]));
    const ledger = partyLedgerId(e.acme as never, 'customer');
    const against = (amount: string, tds?: string) => [{ ledgerId: ledger, amount, allocations: [{ kind: 'against', ref: inv.number, amount, ...(tds ? { tds } : {}) }] }];
    return { e, inv, ledger, against };
  };

  it('a receipt without TDS posts exactly as before', () => {
    const { e, against } = setup();
    const v = e.must(e.receipt(against('100000')));
    expect(e.rows(v)).toEqual([['HDFC', 'debit', '100000.00'], ['Acme Ltd', 'credit', '100000.00']]);
  });

  it('₹100,000 settled with ₹2,000 TDS: Dr Bank 98,000, Dr TDS Receivable 2,000, Cr Customer 100,000 — and the bill is settled in full', () => {
    const { e, ledger, against } = setup();
    const v = e.must(e.receipt(against('100000', '2000')));
    expect(e.rows(v)).toEqual([['HDFC', 'debit', '98000.00'], ['TDS Receivable', 'debit', '2000.00'], ['Acme Ltd', 'credit', '100000.00']]);
    expect(openBills(e.vouchers, e.masters, ledger as LedgerId)).toEqual([]); // the whole invoice is settled
    expect(e.balance('TDS Receivable')).toBe(200_000n);
    expect(e.balance('HDFC')).toBe(9_800_000n);
    expect(e.balance('Acme Ltd')).toBe(0n);
    expect(e.balanced()).toBe(true);
  });

  it('the TDS stays on the allocation, against the invoice it was deducted from', () => {
    const { e, inv, against } = setup();
    const v = e.must(e.receipt(against('100000', '2000')));
    const alloc = (v.content as unknown as { lines: { allocations: { ref: string; amount: bigint; tds: bigint }[] }[] }).lines[0]?.allocations[0];
    expect(alloc).toMatchObject({ ref: inv.number, amount: 10_000_000n, tds: 200_000n });
  });

  it('TDS on one of several bills; the rest of the receipt is unaffected', () => {
    const { e, inv, ledger } = setup();
    const inv2 = e.must(e.sale(e.acme, [['500', '100']]));
    const v = e.must(
      e.receipt([
        {
          ledgerId: ledger,
          amount: '150000',
          allocations: [
            { kind: 'against', ref: inv.number, amount: '100000', tds: '2000' },
            { kind: 'against', ref: inv2.number, amount: '50000' },
          ],
        },
      ]),
    );
    expect(e.rows(v)).toEqual([['HDFC', 'debit', '148000.00'], ['TDS Receivable', 'debit', '2000.00'], ['Acme Ltd', 'credit', '150000.00']]);
    expect(openBills(e.vouchers, e.masters, ledger as LedgerId)).toEqual([]);
  });

  it('one receipt for several invoices, each settled in part with its own TDS: two bills of 1,500, 1,490 paid after 5 TDS on each, so each bill has paid 750 and 750 is still due on each', () => {
    const e = new Env();
    const a = e.must(e.sale(e.acme, [['15', '100']]));
    const b = e.must(e.sale(e.acme, [['15', '100']]));
    const ledger = partyLedgerId(e.acme as never, 'customer');
    expect(openBills(e.vouchers, e.masters, ledger as LedgerId).map((x) => formatMoney(x.pending))).toEqual(['1500.00', '1500.00']);
    const v = e.must(
      e.receipt([
        {
          ledgerId: ledger,
          amount: '1500',
          allocations: [
            { kind: 'against', ref: a.number, amount: '750', tds: '5' },
            { kind: 'against', ref: b.number, amount: '750', tds: '5' },
          ],
        },
      ]),
    );
    expect(e.rows(v)).toEqual([['HDFC', 'debit', '1490.00'], ['TDS Receivable', 'debit', '10.00'], ['Acme Ltd', 'credit', '1500.00']]);
    expect(openBills(e.vouchers, e.masters, ledger as LedgerId).map((x) => [x.ref, formatMoney(x.pending)])).toEqual([[a.number, '750.00'], [b.number, '750.00']]);
    expect(e.balance('TDS Receivable')).toBe(1_000n);
    expect(e.balance('HDFC')).toBe(149_000n);
    expect(e.balanced()).toBe(true);
    // the other 750 of each is then settled by a second receipt, TDS-free, and both bills are gone
    e.must(e.receipt([{ ledgerId: ledger, amount: '1500', allocations: [{ kind: 'against', ref: a.number, amount: '750' }, { kind: 'against', ref: b.number, amount: '750' }] }]));
    expect(openBills(e.vouchers, e.masters, ledger as LedgerId)).toEqual([]);
  });

  it('TDS cannot exceed the allocation, must be above zero, and is only for a bill being settled', () => {
    const { e, ledger, inv, against } = setup();
    const over = e.post(e.receipt(against('100000', '100001')));
    expect(paths(over)).toContain('lines.0.allocations.0.tds'); // on the very cell
    expect(new Set(codes(over))).toEqual(new Set([IssueCode.TdsInvalid]));
    expect(codes(e.post(e.receipt(against('100000', '0'))))).toEqual([IssueCode.TdsInvalid]);
    const onAccount = e.post(e.receipt([{ ledgerId: ledger, amount: '1000', allocations: [{ kind: 'onAccount', amount: '1000', tds: '10' }] }]));
    expect(codes(onAccount)).toEqual([IssueCode.TdsInvalid]);
    expect(inv.status).toBe('posted');
  });

  it('a receipt that is all TDS reaches no bank and is refused', () => {
    const { e, against } = setup();
    expect(codes(e.post(e.receipt(against('100000', '100000'))))).toEqual([IssueCode.TdsInvalid]);
  });

  it('only a Receipt deducts TDS: a payment or a journal refuses it', () => {
    const { e, ledger } = setup();
    const pay = e.post({
      id: newId('pay'),
      voucherTypeId: e.masters.voucherTypes.find((t) => t.baseKind === 'payment')?.id,
      date: '2024-05-20',
      accountLedgerId: e.bank,
      lines: [{ ledgerId: partyLedgerId(e.steel as never, 'vendor'), amount: '100', allocations: [{ kind: 'against', ref: 'X', amount: '100', tds: '10' }] }],
    });
    expect(codes(pay)).toContain(IssueCode.TdsInvalid);
    expect(ledger).toBeDefined();
  });

  it('a second receipt against the same invoice cannot settle it again: no double settlement of what is already paid', () => {
    const { e, ledger, against } = setup();
    e.must(e.receipt(against('100000', '2000')));
    expect(openBills(e.vouchers, e.masters, ledger as LedgerId)).toEqual([]);
    // the invoice is gone from the open bills, so a payment "against" it settles nothing: it shows as money in the customer's favour, not a bill
    e.must(e.receipt(against('500')));
    expect(openBills(e.vouchers, e.masters, ledger as LedgerId)).toEqual([]);
    expect(e.balance('Acme Ltd')).toBe(-50_000n);
  });

  it('altering the receipt re-posts the TDS; cancelling takes it away and the bill is open again', () => {
    const { e, ledger, against } = setup();
    const v = e.must(e.receipt(against('100000', '2000')));
    const altered = e.alter(v, { ...(e.receipt(against('100000', '3000')) as object), id: v.id });
    expect(altered.ok).toBe(true);
    expect(e.balance('TDS Receivable')).toBe(300_000n);
    expect(e.balance('HDFC')).toBe(9_700_000n);
    const gone = e.alter(altered.ok ? altered.value : v, { ...(e.receipt(against('100000')) as object), id: v.id });
    expect(gone.ok).toBe(true);
    expect(e.balance('TDS Receivable')).toBe(0n);
    expect(e.balance('HDFC')).toBe(10_000_000n);
    expect(e.cancel(gone.ok ? gone.value : v).ok).toBe(true);
    expect(openBills(e.vouchers, e.masters, ledger as LedgerId).map((b) => formatMoney(b.pending))).toEqual(['100000.00']);
    expect(e.balance('TDS Receivable')).toBe(0n);
    expect(e.balanced()).toBe(true);
  });
});

// ---- GSTR-1 and GSTR-3B --------------------------------------------------------------------------------------------------

const MAY = { from: D('2024-05-01'), to: D('2024-05-31') };
const JUNE = { from: D('2024-06-01'), to: D('2024-06-30') };

/** May: a B2B sale to Acme (18% and 5%), a B2CS sale to Delhi (5%) and a large B2CL sale to Delhi; June: one more; and two May purchases. */
function books() {
  const e = new Env();
  const b2b = e.must(e.sale(e.acme, [['10', '100', '18'], ['20', '50', '5']], { date: '2024-05-10' })); // taxable 2,000 → 180 + 50
  const b2cs = e.must(e.sale(e.delhi, [['4', '100', '5']], { date: '2024-05-12' })); // 400 → IGST 20
  const b2cl = e.must(e.sale(e.delhi, [['3000', '100', '18']], { date: '2024-05-15' })); // 3,00,000 → IGST 54,000: invoice value 3,54,000
  const june = e.must(e.sale(e.acme, [['1', '100', '18']], { date: '2024-06-03' }));
  const p1 = e.must(e.purchase(e.steel, [['100', '10', '18']], { date: '2024-05-08', billNo: 'SS/10' })); // Input CGST + SGST 90 + 90
  const p2 = e.must(e.purchase(e.gujarat, [['100', '20', '12']], { date: '2024-05-09', billNo: 'GS/1' })); // Input IGST 240
  return { e, b2b, b2cs, b2cl, june, p1, p2 };
}
const invoicesOf = (e: Env, side: 'sales' | 'purchase', range = MAY) => gstInvoices({ vouchers: e.vouchers, masters: e.masters, side, range });

describe('GSTR-1', () => {
  it('lists the posted sales invoices of the period only — not another month, not a cancelled invoice, not a purchase', () => {
    const { e, june, b2cs, b2b, b2cl } = books();
    expect(invoicesOf(e, 'sales').map((i) => i.voucherId)).toEqual([b2b.id, b2cs.id, b2cl.id]);
    expect(invoicesOf(e, 'sales', JUNE).map((i) => i.voucherId)).toEqual([june.id]);
    e.cancel(b2cs);
    expect(invoicesOf(e, 'sales').map((i) => i.voucherId)).toEqual([b2b.id, b2cl.id]);
    expect(invoicesOf(e, 'sales').every((i) => i.side === 'sales')).toBe(true);
  });

  it('classifies B2B (registered, with a GSTIN), B2CL (unregistered, between states, over ₹2.5 lakh) and B2CS (the rest)', () => {
    const { e } = books();
    expect(invoicesOf(e, 'sales').map((i) => [i.party, gstr1Section(i)])).toEqual([['Acme Ltd', 'B2B'], ['Delhi Traders', 'B2CS'], ['Delhi Traders', 'B2CL']]);
  });

  it('one row per invoice and rate, with GSTIN, place of supply, rate, taxable value, each tax head and the invoice value', () => {
    const { e } = books();
    const rows = gstr1Rows(invoicesOf(e, 'sales'));
    expect(rows.map((r) => [r.party, r.gstin === '' ? '' : r.gstin.slice(0, 2), r.placeOfSupply, r.section, r.rate, formatMoney(r.taxable), formatMoney(r.cgst), formatMoney(r.sgst), formatMoney(r.igst), formatMoney(r.value)])).toEqual([
      ['Acme Ltd', '27', '27', 'B2B', '5', '1000.00', '25.00', '25.00', '0.00', '2230.00'],
      ['Acme Ltd', '27', '27', 'B2B', '18', '1000.00', '90.00', '90.00', '0.00', '2230.00'],
      ['Delhi Traders', '', '07', 'B2CS', '5', '400.00', '0.00', '0.00', '20.00', '420.00'],
      ['Delhi Traders', '', '07', 'B2CL', '18', '300000.00', '0.00', '0.00', '54000.00', '354000.00'],
    ]);
  });

  it('period totals: invoices, taxable value, CGST, SGST, IGST, total GST and invoice value', () => {
    const { e } = books();
    const t = gstTotals(invoicesOf(e, 'sales'));
    expect([t.invoices, formatMoney(t.taxable), formatMoney(t.cgst), formatMoney(t.sgst), formatMoney(t.igst), formatMoney(t.tax), formatMoney(t.value)]).toEqual([3, '302400.00', '115.00', '115.00', '54020.00', '54250.00', '356650.00']);
  });

  it('reconciles with the posted sales invoices: the tax on the invoices is the tax the journal holds on the Output ledgers, head by head', () => {
    const { e } = books();
    const checks = gstReconciliation({ invoices: invoicesOf(e, 'sales'), lines: e.journal(), masters: e.masters, side: 'sales' });
    expect(checks.map((c) => [c.head, formatMoney(c.report), formatMoney(c.ledger), c.ok])).toEqual([['CGST', '115.00', '115.00', true], ['SGST', '115.00', '115.00', true], ['IGST', '54020.00', '54020.00', true]]);
    // the ledger holds June's tax too: the report is the period, the ledger is everything
    expect(e.balance('Output CGST')).toBe(-(11500n + 900n));
  });

  it('HSN summary: per HSN, unit and rate, from the invoice lines — and it adds up to the invoices to the paisa', () => {
    const { e } = books();
    const invs = invoicesOf(e, 'sales');
    const rows = hsnRows(invs);
    expect(rows.map((r) => [r.hsn, r.uqc, r.rate, formatMoney(r.taxable)])).toEqual([['7318', 'NOS', '5', '1400.00'], ['7318', 'NOS', '18', '301000.00']]);
    const t = gstTotals(invs);
    const sum = (pick: (r: (typeof rows)[number]) => bigint) => rows.reduce((s, r) => s + pick(r), 0n);
    expect([sum((r) => r.taxable), sum((r) => r.cgst), sum((r) => r.sgst), sum((r) => r.igst), sum((r) => r.value)]).toEqual([t.taxable, t.cgst, t.sgst, t.igst, t.value]);
    expect(rows.map((r) => r.qty)).toEqual([240_000n, 30_100_000n].map((q) => BigInt(q)));
  });

  it('the HSN is the one on the invoice line, not the item’s today', () => {
    const { e } = books();
    const before = hsnRows(invoicesOf(e, 'sales')).map((r) => r.hsn);
    const changed = prepareMasterCommand({ op: 'alter', kind: 'stockItem', id: e.bolt, data: { name: 'Bolt', unitId: e.masters.stockItem(e.bolt)?.unitId, itemType: 'finished', hsn: '9999' } }, e.masters);
    expect(changed.ok).toBe(true);
    if (changed.ok) e.masters = changed.value.masters;
    expect(hsnRows(invoicesOf(e, 'sales')).map((r) => r.hsn)).toEqual(before);
  });

  it('validation names what is missing and does not invent it: the company’s GSTIN and state, a registered customer’s GSTIN, a line with no rate', () => {
    const e = new Env();
    e.masters = e.masters.with({ company: { ...e.masters.company, gstin: undefined, stateCode: undefined } });
    const none = gstr1Validation(e.masters, []);
    expect(none.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual(['The company has no GSTIN: set it in Company settings', 'The company has no state: set it in Company settings']);

    const f = new Env();
    const reg = f.must(f.sale(f.acme, [['1', '100', '18']], { date: '2024-05-10' }));
    // a registered customer whose voucher carries no GSTIN
    const stripped = { ...reg, content: { ...(reg.content as object), partyDetails: { partyId: f.acme, gstRegistration: 'regular', mailingName: 'X' } } } as unknown as Voucher;
    f.vouchers[f.vouchers.indexOf(reg)] = stripped;
    f.masters = f.masters.with({ parties: f.masters.parties.map((p) => (p.id === f.acme ? { ...p, gstin: undefined } : p)) });
    const bad = gstr1Validation(f.masters, invoicesOf(f, 'sales'));
    expect(bad.map((i) => [i.severity, i.message])).toContainEqual(['error', 'Acme Ltd is registered (regular) but the invoice has no GSTIN']);

    const g = new Env();
    g.must(g.sale(g.acme, [['1', '100']], { date: '2024-05-10' })); // no rate at all
    expect(gstr1Validation(g.masters, invoicesOf(g, 'sales')).some((i) => i.severity === 'error' && i.message.includes('no GST rate'))).toBe(true);
    const clean = books();
    expect(gstr1Validation(clean.e.masters, invoicesOf(clean.e, 'sales')).filter((i) => i.severity === 'error')).toEqual([]); // nothing to fix
  });

  it('a place of supply nothing can name is an error — not a guess', () => {
    const e = new Env();
    const v = e.must(e.sale(e.acme, [['1', '100', '18']], { date: '2024-05-10' }));
    const blank = { ...v, content: { ...(v.content as object), gst: undefined, partyDetails: { partyId: e.acme, mailingName: 'X' } } } as unknown as Voucher;
    e.vouchers[e.vouchers.indexOf(v)] = blank;
    e.masters = e.masters.with({ parties: e.masters.parties.map((p) => (p.id === e.acme ? { ...p, gstin: undefined, stateCode: undefined } : p)) });
    const issues = gstr1Validation(e.masters, invoicesOf(e, 'sales'));
    expect(issues.some((i) => i.severity === 'error' && i.message.startsWith('The place of supply is not known'))).toBe(true);
  });

  it('exports structured data: b2b by GSTIN, b2cl by place of supply, b2cs summarised, an HSN table — and CSV of the same rows', () => {
    const { e } = books();
    const ex = gstr1Export({ masters: e.masters, invoices: invoicesOf(e, 'sales'), period: MAY });
    const j = ex.json as { gstin: string; fp: string; b2b: { ctin: string; inv: { inum: string; idt: string; val: number; pos: string; itms: { itm_det: { rt: number; txval: number; camt: number; samt: number; iamt: number } }[] }[] }[]; b2cl: { pos: string; inv: { val: number }[] }[]; b2cs: { sply_ty: string; pos: string; rt: number; txval: number; iamt: number }[]; hsn: { data: { hsn_sc: string; uqc: string }[] } };
    expect(j.gstin).toBe('27AABCD1234E1Z' + gstinCheckChar('27AABCD1234E1Z'));
    expect(j.fp).toBe('052024');
    expect(j.b2b).toHaveLength(1);
    expect(j.b2b[0]?.ctin).toMatch(/^27AAPFU0939F1Z/);
    expect(j.b2b[0]?.inv[0]).toMatchObject({ idt: '10-05-2024', val: 2230, pos: '27' });
    expect(j.b2b[0]?.inv[0]?.itms.map((i) => [i.itm_det.rt, i.itm_det.txval, i.itm_det.camt, i.itm_det.samt])).toEqual([[5, 1000, 25, 25], [18, 1000, 90, 90]]);
    expect(j.b2cl).toEqual([{ pos: '07', inv: [expect.objectContaining({ val: 354000 })] }]);
    expect(j.b2cs).toEqual([expect.objectContaining({ sply_ty: 'INTER', pos: '07', rt: 5, txval: 400, iamt: 20 })]);
    expect(j.hsn.data.map((h) => [h.hsn_sc, h.uqc])).toEqual([['7318', 'NOS'], ['7318', 'NOS']]);
    expect(ex.invoicesCsv.split('\n')).toHaveLength(1 + 4);
    expect(ex.invoicesCsv.split('\n')[0]).toBe('Invoice no,Date,Customer,GSTIN,Place of supply,Type,Rate %,Taxable value,CGST,SGST,IGST,Invoice value');
    expect(ex.hsnCsv.split('\n')).toHaveLength(1 + 2);
  });
});

describe('GSTR-3B', () => {
  const report = (range = MAY) => {
    const b = books();
    const before = b.e.journal().length;
    const r = gstr3b({ vouchers: b.e.vouchers, lines: b.e.journal(), masters: b.e.masters, range });
    return { ...b, r, before };
  };
  const row = (r: ReturnType<typeof gstr3b>, key: string) => r.rows.find((x) => x.key === key);
  const figs = (x: ReturnType<typeof row>) => [x?.taxable, x?.cgst, x?.sgst, x?.igst, x?.total].map((m) => (m === undefined ? undefined : formatMoney(m)));

  it('outward supplies of the period: taxable value and tax by head, from the posted sales invoices', () => {
    const { r } = report();
    expect(figs(row(r, '3.1a'))).toEqual(['302400.00', '115.00', '115.00', '54020.00', '54250.00']);
    expect(figs(row(r, '3.1c'))).toEqual(['0.00', undefined, undefined, undefined, '0.00']);
    expect(report(JUNE).r.sales).toHaveLength(1);
  });

  it('input tax of the period from the purchase invoices — SHOWN SEPARATELY as "to review", never silently claimed', () => {
    const { r } = report();
    expect(figs(row(r, '4-review'))).toEqual(['3000.00', '90.00', '90.00', '240.00', '420.00']);
    expect(row(r, '4-review')?.review).toBe(true);
    expect(figs(row(r, '4a-eligible'))).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00']); // nothing is claimed
    expect(formatMoney(r.eligible.tax)).toBe('0.00');
  });

  it('net position: output less the eligible input (nothing) — and, said apart, what it would be if all the input under review were eligible', () => {
    const { r } = report();
    expect(figs(row(r, 'net-out'))).toEqual([undefined, '115.00', '115.00', '54020.00', '54250.00']);
    expect(figs(row(r, 'net'))).toEqual([undefined, '115.00', '115.00', '54020.00', '54250.00']); // the whole output is payable: no ITC is claimed
    expect(figs(row(r, 'net-all'))).toEqual([undefined, '25.00', '25.00', '53780.00', '53830.00']); // 115−90, 115−90, 54,020−240
    expect(row(r, 'net-all')?.review).toBe(true);
    expect([r.net.tax, r.netIfAllEligible.tax].map((m) => formatMoney(m))).toEqual(['54250.00', '53830.00']);
  });

  it('reconciles with the underlying posted transactions: every head, sales against the Output ledgers and purchases against the Input ledgers', () => {
    const { r } = report();
    expect(r.reconciliation.sales.map((c) => c.ok)).toEqual([true, true, true]);
    expect(r.reconciliation.purchases.map((c) => [c.head, formatMoney(c.report), formatMoney(c.ledger), c.ok])).toEqual([['CGST', '90.00', '90.00', true], ['SGST', '90.00', '90.00', true], ['IGST', '240.00', '240.00', true]]);
  });

  it('is only a report: opening it changes no journal line, no stock movement, no voucher', () => {
    const { e, before } = report();
    const stockBefore = e.stock().movements.length;
    const vouchersBefore = e.vouchers.length;
    gstr3b({ vouchers: e.vouchers, lines: e.journal(), masters: e.masters, range: MAY });
    gstr3b({ vouchers: e.vouchers, lines: e.journal(), masters: e.masters, range: JUNE });
    expect([e.journal().length, e.stock().movements.length, e.vouchers.length]).toEqual([before, stockBefore, vouchersBefore]);
  });

  it('a period with nothing in it is all zeros; the periods add up to the ledgers', () => {
    const { e } = books();
    const empty = gstr3b({ vouchers: e.vouchers, lines: e.journal(), masters: e.masters, range: { from: D('2024-08-01'), to: D('2024-08-31') } });
    expect(empty.rows.filter((x) => !x.heading).every((x) => (x.total ?? 0n) === 0n)).toBe(true);
    const may = gstr3b({ vouchers: e.vouchers, lines: e.journal(), masters: e.masters, range: MAY });
    const june = gstr3b({ vouchers: e.vouchers, lines: e.journal(), masters: e.masters, range: JUNE });
    expect(may.output.cgst + june.output.cgst).toBe(-e.balance('Output CGST'));
    expect(may.toReview.igst + june.toReview.igst).toBe(e.balance('Input IGST'));
  });
});
