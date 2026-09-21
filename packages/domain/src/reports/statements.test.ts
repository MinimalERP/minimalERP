import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { type LedgerId, type VoucherId, asCompanyId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { partyLedgerId } from '../masters/records';
import { seedCompany } from '../masters/seed';
import { formatMoney } from '../money';
import { prepareVoucher } from '../posting/engine';
import { type JournalLine, type PostingPlan } from '../posting/plan';
import { StockBook } from '../stock/book';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { OrderBook, orderBookOf } from '../orders/orderBook';
import { balanceSheet, isBalanced, profitAndLoss } from './financials';
import { groupRows, groupTotals, ledgersUnder } from './groupSummary';
import { BUCKETS, bucketOf, daysBetween, daysOverdue, outstandingBills, outstandingByParty } from './outstanding';
import { trialBalance } from './trialBalance';

const newId = (n: string) => deterministicUuid(`b|${n}`);
const D = (s: string) => localDate(s);
const kinds = defaultVoucherKinds();

/** A small company's books, kept the way the backends keep them: vouchers with their posting plans. */
class Books {
  masters: Masters;
  vouchers: Voucher[] = [];
  private plans = new Map<string, PostingPlan>();
  private seq = 0;
  readonly bank = newId('bank');
  readonly sales = newId('sales');
  readonly purchases = newId('purchases');
  readonly rent = newId('rent');
  readonly capital = newId('capital');
  readonly acme = newId('acme');
  readonly beta = newId('beta');
  readonly vendor = newId('vendor');
  readonly bolt = newId('bolt');
  readonly main: string;

  constructor() {
    let masters = seedCompany({ name: 'T', fyStart: D('2024-04-01'), newId });
    const run = (kind: string, id: string, data: unknown) => {
      const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      masters = r.value.masters;
    };
    const g = (key: string) => newId(`group:${key}`);
    run('ledger', this.bank, { name: 'HDFC Bank', groupId: g('bank-accounts') });
    run('ledger', this.sales, { name: 'Sales', groupId: g('sales-accounts') });
    run('ledger', this.purchases, { name: 'Purchases', groupId: g('purchase-accounts') });
    run('ledger', this.rent, { name: 'Rent', groupId: g('indirect-expenses') });
    run('ledger', this.capital, { name: 'Capital', groupId: g('capital-account') });
    run('party', this.acme, { name: 'Acme Ltd', roles: ['customer'], creditDays: 30 });
    run('party', this.beta, { name: 'Beta Ltd', roles: ['customer'] });
    run('party', this.vendor, { name: 'Steel Co', roles: ['vendor'] });
    run('stockItem', this.bolt, { name: 'Bolt', unitId: masters.units.find((u) => u.symbol === 'Nos')?.id, itemType: 'finished' });
    this.masters = masters;
    this.main = masters.warehouses[0]?.id as string;
  }

  private type = (base: string) => this.masters.voucherTypes.find((t) => t.baseKind === base)?.id as string;

  post(input: Record<string, unknown>): Voucher {
    const r = prepareVoucher(input, this.masters, kinds, this.stock(), orderBookOf(this.vouchers, this.masters));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const v: Voucher = {
      id: r.value.draft.id,
      companyId: asCompanyId('c'),
      voucherTypeId: r.value.voucherType.id,
      financialYearId: r.value.financialYear.id,
      number: `${r.value.voucherType.baseKind.toUpperCase()}/${String(++this.seq).padStart(4, '0')}`,
      date: r.value.draft.date,
      status: 'posted',
      version: 1,
      revision: 0,
      content: r.value.draft,
    };
    this.vouchers.push(v);
    this.plans.set(v.id, r.value.plan);
    return v;
  }

  id = (n: string): VoucherId => newId(`v:${n}`) as VoucherId;
  lines = (): JournalLine[] => this.vouchers.filter((v) => v.status === 'posted').flatMap((v) => this.plans.get(v.id)?.journal ?? []);
  stock = (): StockBook => new StockBook(this.vouchers.filter((v) => v.status === 'posted').flatMap((v) => this.plans.get(v.id)?.stock ?? []));
  openingIds = (): Set<string> => new Set(this.vouchers.filter((v) => this.masters.voucherType(v.voucherTypeId)?.baseKind === 'stockOpening').map((v) => v.id));
  cancel(v: Voucher): void {
    this.vouchers[this.vouchers.indexOf(v)] = { ...v, status: 'cancelled', version: v.version + 1 };
  }

  receipt(name: string, date: string, from: string, amount: string, allocations?: unknown[]): Voucher {
    return this.post({ id: this.id(name), voucherTypeId: this.type('receipt'), date, accountLedgerId: this.bank, lines: [{ ledgerId: from, amount, ...(allocations ? { allocations } : {}) }] });
  }
  payment(name: string, date: string, to: string, amount: string): Voucher {
    return this.post({ id: this.id(name), voucherTypeId: this.type('payment'), date, accountLedgerId: this.bank, lines: [{ ledgerId: to, amount }] });
  }
  openingStock(qty: string, rate: string): Voucher {
    return this.post({ id: this.id('os'), voucherTypeId: this.type('stockOpening'), date: '2024-04-01', itemId: this.bolt, warehouseId: this.main, qty, rate });
  }
  invoice(name: string, date: string, party: string, qty: string, rate: string, dueDate: string): Voucher {
    return this.post({
      id: this.id(name),
      voucherTypeId: this.type('sales'),
      date,
      partyId: party,
      partyDetails: { partyId: party, mailingName: 'X' },
      salesLedgerId: this.sales,
      dueDate,
      lines: [{ itemId: this.bolt, warehouseId: this.main, qty, rate }],
    });
  }
  customerLedger = (party: string): LedgerId => partyLedgerId(party, 'customer') as LedgerId;
}

/** Capital 100,000 in the bank; 100 bolts at 10 brought forward; 5,000 of purchases; 20 bolts sold at 50 to Acme; rent 300; Acme pays 400 of it. */
function trading(): Books {
  const b = new Books();
  b.receipt('cap', '2024-04-01', b.capital, '100000');
  b.openingStock('100', '10');
  b.payment('buy', '2024-04-05', b.purchases, '5000');
  b.invoice('inv1', '2024-05-01', b.acme, '20', '50', '2024-05-31');
  b.payment('rent', '2024-05-10', b.rent, '300');
  b.receipt('pay1', '2024-05-20', b.customerLedger(b.acme), '400', [{ kind: 'against', ref: 'SALES/0004', amount: '400' }]);
  return b;
}

const range = { from: D('2024-04-01'), to: D('2025-03-31') };

describe('the trial balance by group', () => {
  it('lists the primary groups, closes Dr = Cr, and every group is the sum of the ledgers beneath it', () => {
    const b = trading();
    const rows = groupRows(b.masters, b.lines(), range);
    const t = groupTotals(rows);
    expect(t.closingDebit).toBe(t.closingCredit);
    expect(t.closingDebit).toBe(trialBalance(b.lines(), range).totalClosingDebit); // the same figure the ledger-level trial balance gives
    expect(rows.map((r) => r.name)).toEqual(['Capital Account', 'Current Assets', 'Indirect Expenses', 'Purchase Accounts', 'Sales Accounts']);
    for (const r of rows) {
      const sum = ledgersUnder(b.masters, r.id as never).reduce((s, id) => s + (trialBalance(b.lines(), range).rows.find((x) => x.ledgerId === id)?.closing ?? 0n), 0n);
      expect(r.closing, r.name).toBe(sum);
    }
  });

  it('drills: a group lists its sub-groups then its own ledgers, with the same columns; empty rows are left out unless asked for', () => {
    const b = trading();
    const current = groupRows(b.masters, b.lines(), range).find((r) => r.name === 'Current Assets');
    const inside = groupRows(b.masters, b.lines(), range, { parentIds: [current?.id as never] });
    expect(inside.map((r) => [r.kind, r.name])).toEqual([['group', 'Bank Accounts'], ['group', 'Sundry Debtors']]);
    const bankGroup = inside[0];
    const ledgers = groupRows(b.masters, b.lines(), range, { parentIds: [bankGroup?.id as never] });
    expect(ledgers.map((r) => [r.kind, r.name, formatMoney(r.closing)])).toEqual([['ledger', 'HDFC Bank', '95100.00']]); // 100000 − 5000 − 300 + 400
    const cashGroup = b.masters.groups.all.find((g) => g.reservedKey === 'cash-in-hand');
    expect(groupRows(b.masters, b.lines(), range, { parentIds: [cashGroup?.id as never] })).toEqual([]);
    expect(groupRows(b.masters, b.lines(), range, { parentIds: [cashGroup?.id as never], includeEmpty: true }).map((r) => r.name)).toEqual(['Cash']);
  });

  it('a period splits a ledger into opening, debit, credit and closing (opening = everything before it)', () => {
    const b = trading();
    const may = groupRows(b.masters, b.lines(), { from: D('2024-05-01'), to: D('2024-05-31') }).find((r) => r.name === 'Current Assets');
    // before May: bank +100000 −5000 = 95000; in May: −300 +400; the debtor: +1000 −400 in May
    expect([formatMoney(may?.opening ?? (0n as never)), formatMoney(may?.debit ?? (0n as never)), formatMoney(may?.credit ?? (0n as never))]).toEqual(['95000.00', '1400.00', '700.00']);
  });
});

describe('Profit & Loss', () => {
  it('trading and profit & loss, each two-sided and equal, the stock read from the stock book', () => {
    const b = trading();
    const s = profitAndLoss({ masters: b.masters, lines: b.lines(), stock: b.stock(), range, openingStockIds: b.openingIds() });
    expect(isBalanced(s)).toBe(true);
    const [tr, pl] = s.sections;
    // 100 bolts at 10 brought forward, 20 sold: 80 left, worth 800
    expect(tr?.left.map((l) => [l.label, formatMoney(l.amount)])).toEqual([['Opening Stock', '1000.00'], ['Purchase Accounts', '5000.00']]);
    expect(tr?.right.map((l) => [l.label, formatMoney(l.amount)])).toEqual([['Sales Accounts', '1000.00'], ['Closing Stock', '800.00'], ['Gross Loss c/d', '4200.00']]);
    expect([tr?.leftTotal, tr?.rightTotal]).toEqual([6_000_00n, 6_000_00n]);
    expect(pl?.left.map((l) => [l.label, formatMoney(l.amount)])).toEqual([['Gross Loss b/d', '4200.00'], ['Indirect Expenses', '300.00']]);
    expect(pl?.right.map((l) => [l.label, formatMoney(l.amount)])).toEqual([['Net Loss', '4500.00']]);
    expect(formatMoney(s.result)).toBe('-4500.00');
    expect(formatMoney(s.grossResult ?? (0n as never))).toBe('-4200.00');
  });

  it('a profit puts Gross Profit c/d and Net Profit on the LEFT, and still balances', () => {
    const b = new Books();
    b.receipt('cap', '2024-04-01', b.capital, '100000');
    b.openingStock('100', '10');
    b.invoice('inv1', '2024-05-01', b.acme, '90', '50', '2024-05-31'); // sells 4,500 of goods that cost 900
    b.payment('rent', '2024-05-10', b.rent, '300');
    const s = profitAndLoss({ masters: b.masters, lines: b.lines(), stock: b.stock(), range, openingStockIds: b.openingIds() });
    expect(isBalanced(s)).toBe(true);
    expect(s.sections[0]?.left.at(-1)).toMatchObject({ label: 'Gross Profit c/d' });
    expect(formatMoney(s.grossResult ?? (0n as never))).toBe('3600.00'); // 4500 + 100 closing − 1000 opening
    expect(s.sections[1]?.left.at(-1)).toMatchObject({ label: 'Net Profit' });
    expect(formatMoney(s.result)).toBe('3300.00');
  });

  it('a period counts only its own movement; the stock it opened with is what stood at its start', () => {
    const b = trading();
    const later = profitAndLoss({ masters: b.masters, lines: b.lines(), stock: b.stock(), range: { from: D('2024-05-15'), to: D('2025-03-31') }, openingStockIds: b.openingIds() });
    expect(later.sections[0]?.left.map((l) => [l.label, formatMoney(l.amount)])).toEqual([['Opening Stock', '800.00']]); // after the sale of 20
    expect(later.sections[0]?.right.map((l) => l.label)).toEqual(['Closing Stock']); // stock unchanged, nothing bought or sold: no gross profit or loss
    expect(isBalanced(later)).toBe(true);
  });

  it('a cancelled sale leaves no trace: the figures are what the journal and the stock say now', () => {
    const b = trading();
    b.cancel(b.vouchers.find((v) => v.id === b.id('inv1')) as Voucher);
    const s = profitAndLoss({ masters: b.masters, lines: b.lines(), stock: b.stock(), range, openingStockIds: b.openingIds() });
    expect(s.sections[0]?.right.map((l) => [l.label, formatMoney(l.amount)])).toEqual([['Closing Stock', '1000.00'], ['Gross Loss c/d', '5000.00']]);
    expect(isBalanced(s)).toBe(true);
  });
});

describe('the Balance Sheet', () => {
  it('has liabilities on the left and assets on the right, and they are equal — with the stock brought forward shown under Capital', () => {
    const b = trading();
    const s = balanceSheet({ masters: b.masters, lines: b.lines(), stock: b.stock(), asOn: D('2025-03-31'), openingStockIds: b.openingIds() });
    expect(isBalanced(s)).toBe(true);
    const sec = s.sections[0];
    expect(sec?.left.map((l) => [l.label, formatMoney(l.amount)])).toEqual([['Capital Account', '100000.00'], ['Opening Stock (brought forward)', '1000.00']]); // the loss is on the assets side, below
    expect(sec?.right.map((l) => [l.label, formatMoney(l.amount)])).toEqual([['Current Assets', '95700.00'], ['Closing Stock', '800.00'], ['Profit & Loss A/c', '4500.00']]); // bank 95,100 + Acme owes 600; the year's loss
    expect(formatMoney(sec?.leftTotal ?? (0n as never))).toBe('101000.00'); // 96,500 of liabilities + the 4,500 loss now sits on the assets side, so both sides carry it
    expect(formatMoney(s.result)).toBe('-4500.00');
  });

  it('is as on a date: nothing later counts, and it still balances at every date', () => {
    const b = trading();
    for (const asOn of ['2024-04-01', '2024-04-30', '2024-05-01', '2024-05-15', '2024-12-31']) {
      const s = balanceSheet({ masters: b.masters, lines: b.lines(), stock: b.stock(), asOn: D(asOn), openingStockIds: b.openingIds() });
      expect(isBalanced(s), asOn).toBe(true);
    }
    const early = balanceSheet({ masters: b.masters, lines: b.lines(), stock: b.stock(), asOn: D('2024-04-30'), openingStockIds: b.openingIds() });
    expect(early.sections[0]?.right.map((l) => l.label)).toEqual(['Current Assets', 'Closing Stock', 'Profit & Loss A/c']); // bank only; the debtor arrives on 1 May
    expect(formatMoney(early.sections[0]?.right[0]?.amount ?? (0n as never))).toBe('95000.00');
  });

  it('the Profit & Loss A/c of the sheet is the cumulative result the statements agree on: year 1 and year 2 together', () => {
    const b = trading();
    const y1 = profitAndLoss({ masters: b.masters, lines: b.lines(), stock: b.stock(), range, openingStockIds: b.openingIds() });
    // a second year: more rent; the year opens with year 1's closing stock
    b.masters = b.masters.with({ financialYears: [...b.masters.financialYears, { ...b.masters.financialYears[0], id: newId('fy2') as never, label: '25-26', start: D('2025-04-01'), end: D('2026-03-31') } as never] });
    b.payment('rent2', '2025-05-10', b.rent, '700');
    const y2range = { from: D('2025-04-01'), to: D('2026-03-31') };
    const y2 = profitAndLoss({ masters: b.masters, lines: b.lines(), stock: b.stock(), range: y2range, openingStockIds: b.openingIds() });
    expect(y2.sections[0]?.left[0]).toMatchObject({ label: 'Opening Stock' });
    expect(formatMoney(y2.sections[0]?.left[0]?.amount ?? (0n as never))).toBe('800.00'); // year 1's closing
    const sheet = balanceSheet({ masters: b.masters, lines: b.lines(), stock: b.stock(), asOn: D('2026-03-31'), openingStockIds: b.openingIds() });
    expect(isBalanced(sheet)).toBe(true);
    expect(sheet.result).toBe(y1.result + y2.result);
  });

  it('holds for any mix of sales, purchases, back-dated entries and cancellations (the books always balance)', () => {
    const b = new Books();
    b.receipt('cap', '2024-04-01', b.capital, '250000');
    b.openingStock('500', '12.5');
    const dates = ['2024-04-09', '2024-06-30', '2024-05-02', '2024-09-15', '2024-04-20', '2025-01-05'];
    dates.forEach((d, i) => {
      b.invoice(`i${i}`, d, i % 2 === 0 ? b.acme : b.beta, String(3 + i), String(20 + i * 5), d);
      b.payment(`p${i}`, d, i % 3 === 0 ? b.purchases : b.rent, String(100 + i * 37));
    });
    b.cancel(b.vouchers.find((v) => v.id === b.id('i2')) as Voucher);
    b.cancel(b.vouchers.find((v) => v.id === b.id('p4')) as Voucher);
    for (const asOn of ['2024-04-15', '2024-07-01', '2025-03-31', '2026-03-31']) {
      const s = balanceSheet({ masters: b.masters, lines: b.lines(), stock: b.stock(), asOn: D(asOn), openingStockIds: b.openingIds() });
      expect(isBalanced(s), asOn).toBe(true);
    }
    for (const r of [range, { from: D('2024-06-01'), to: D('2024-12-31') }]) {
      expect(isBalanced(profitAndLoss({ masters: b.masters, lines: b.lines(), stock: b.stock(), range: r, openingStockIds: b.openingIds() }))).toBe(true);
    }
    const t = groupTotals(groupRows(b.masters, b.lines(), range));
    expect(t.closingDebit).toBe(t.closingCredit);
  });

  it('works for a company with no stock and no sales at all', () => {
    const b = new Books();
    b.receipt('cap', '2024-04-01', b.capital, '1000');
    const s = balanceSheet({ masters: b.masters, lines: b.lines(), stock: StockBook.empty, asOn: D('2024-12-31'), openingStockIds: new Set() });
    expect(isBalanced(s)).toBe(true);
    expect(OrderBook.empty.orders).toEqual([]);
  });
});

describe('outstanding receivables and ageing', () => {
  it('ages a bill from its DUE date, in the same buckets on every day', () => {
    expect(daysBetween(D('2024-05-31'), D('2024-06-10'))).toBe(10);
    expect(daysOverdue(D('2024-05-31'), D('2024-05-31'))).toBe(0); // due today is not overdue
    expect(daysOverdue(D('2024-05-31'), D('2024-05-01'))).toBe(0);
    expect(daysOverdue(undefined, D('2024-05-01'))).toBe(0);
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(bucketOf)).toEqual(['notDue', 'd1to30', 'd1to30', 'd31to60', 'd31to60', 'd61to90', 'd61to90', 'over90']);
  });

  it('lists the bill an invoice raised (named by its number, due on its due date), less what a receipt settled against it', () => {
    const b = trading();
    const bills = outstandingBills({ vouchers: b.vouchers, masters: b.masters, side: 'receivable', asOn: D('2024-06-10') });
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ party: 'Acme Ltd', ref: 'SALES/0004', dueDate: '2024-05-31', daysOverdue: 10, bucket: 'd1to30' });
    expect(formatMoney(bills[0]?.pending ?? (0n as never))).toBe('600.00'); // 1,000 less the 400 received against it
    expect(bills[0]?.billDate).toBe('2024-05-01');
    // before it is due, and before anything was received
    expect(outstandingBills({ vouchers: b.vouchers, masters: b.masters, side: 'receivable', asOn: D('2024-05-15') })[0]).toMatchObject({ bucket: 'notDue', daysOverdue: 0 });
    expect(formatMoney(outstandingBills({ vouchers: b.vouchers, masters: b.masters, side: 'receivable', asOn: D('2024-05-15') })[0]?.pending ?? (0n as never))).toBe('1000.00');
    expect(outstandingBills({ vouchers: b.vouchers, masters: b.masters, side: 'payable', asOn: D('2024-06-10') })).toEqual([]);
  });

  it('rolls up per party with the buckets summing to the pending, and reconciles to the ledger', () => {
    const b = trading();
    b.invoice('inv2', '2024-04-10', b.acme, '2', '50', '2024-04-30'); // an older bill of 100, due earlier
    const rows = outstandingByParty({ vouchers: b.vouchers, lines: b.lines(), masters: b.masters, side: 'receivable', asOn: D('2024-08-15') });
    expect(rows).toHaveLength(1);
    const acme = rows[0];
    expect(acme).toMatchObject({ name: 'Acme Ltd', bills: 2, oldest: 107 });
    expect(formatMoney(acme?.pending ?? (0n as never))).toBe('700.00');
    expect(BUCKETS.reduce((s, k) => s + (acme?.buckets[k] ?? 0n), 0n)).toBe(acme?.pending);
    expect(acme?.buckets.over90).toBe(10_000n); // the 100 bill, due 30 April: 107 days
    expect(acme?.buckets.d61to90).toBe(60_000n); // the 600 left of the May bill, due 31 May: 76 days
    expect(acme?.balance).toBe((acme?.pending ?? 0n) - (acme?.advances ?? 0n) + (acme?.notInBills ?? 0n)); // balance = pending − advances + not in bills
    expect(acme?.notInBills).toBe(0n);
  });

  it('an advance received on account is not a bill: it shows as an advance and the ledger still reconciles', () => {
    const b = trading();
    b.receipt('adv', '2024-06-01', b.customerLedger(b.acme), '100', [{ kind: 'onAccount', amount: '100' }]);
    const acme = outstandingByParty({ vouchers: b.vouchers, lines: b.lines(), masters: b.masters, side: 'receivable', asOn: D('2024-06-10') })[0];
    expect([formatMoney(acme?.pending ?? (0n as never)), formatMoney(acme?.advances ?? (0n as never)), formatMoney(acme?.balance ?? (0n as never)), acme?.notInBills]).toEqual(['600.00', '100.00', '500.00', 0n]);
  });

  it('a party with nothing owing does not appear; a settled bill leaves; a cancelled invoice disappears', () => {
    const b = trading();
    b.receipt('pay2', '2024-06-01', b.customerLedger(b.acme), '600', [{ kind: 'against', ref: 'SALES/0004', amount: '600' }]);
    expect(outstandingByParty({ vouchers: b.vouchers, lines: b.lines(), masters: b.masters, side: 'receivable', asOn: D('2024-06-10') })).toEqual([]);
    const c = trading();
    c.cancel(c.vouchers.find((v) => v.id === c.id('inv1')) as Voucher);
    // the receipt against the cancelled invoice remains as money in Acme's favour, not a bill
    const rows = outstandingByParty({ vouchers: c.vouchers, lines: c.lines(), masters: c.masters, side: 'receivable', asOn: D('2024-06-10') });
    expect(rows.map((r) => [r.name, r.bills, formatMoney(r.balance)])).toEqual([['Acme Ltd', 0, '-400.00']]);
    expect(formatMoney(rows[0]?.notInBills ?? (0n as never))).toBe('-400.00');
  });
});

describe('the books balance for any books', () => {
  /** A small deterministic generator, so a failure names the seed that reproduces it. */
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const dateIn = (r: () => number, from: string, days: number): string => new Date(Date.parse(from) + Math.floor(r() * days) * 86_400_000).toISOString().slice(0, 10);

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))('seed %i: sales, purchases, rent, receipts on account and against bills, back-dating and cancellations', (seed) => {
    const r = rng(seed);
    const b = new Books();
    b.receipt('cap', '2024-04-01', b.capital, '100000');
    b.openingStock('100', '10');
    const cancellable: Voucher[] = [];
    const n = 4 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++) {
      const date = dateIn(r, '2024-04-01', 300);
      const pick = r();
      if (pick < 0.35) cancellable.push(b.invoice(`inv${i}`, date, r() < 0.5 ? b.acme : b.beta, String(1 + Math.floor(r() * 5)), String(20 + Math.floor(r() * 60)), dateIn(r, date, 60)));
      else if (pick < 0.55) cancellable.push(b.payment(`buy${i}`, date, b.purchases, String(100 + Math.floor(r() * 900))));
      else if (pick < 0.75) cancellable.push(b.payment(`rent${i}`, date, b.rent, String(50 + Math.floor(r() * 300))));
      else {
        const amount = String(10 + Math.floor(r() * 90));
        cancellable.push(b.receipt(`rc${i}`, date, b.customerLedger(r() < 0.5 ? b.acme : b.beta), amount, [{ kind: 'onAccount', amount }]));
      }
    }
    if (r() < 0.6 && cancellable.length > 0) b.cancel(cancellable[Math.floor(r() * cancellable.length)] as Voucher);

    const lines = b.lines();
    const whole = { from: D('2024-04-01'), to: D('2025-03-31') };
    const t = groupTotals(groupRows(b.masters, lines, whole));
    expect(t.closingDebit, 'trial balance').toBe(t.closingCredit);
    expect(t.debit, 'trial balance movement').toBe(t.credit);
    const pl = profitAndLoss({ masters: b.masters, lines, stock: b.stock(), range: whole, openingStockIds: b.openingIds() });
    expect(isBalanced(pl), 'profit and loss').toBe(true);
    for (let k = 0; k < 4; k++) {
      const asOn = D(dateIn(r, '2024-04-01', 365));
      const s = balanceSheet({ masters: b.masters, lines, stock: b.stock(), asOn, openingStockIds: b.openingIds() });
      expect(isBalanced(s), `balance sheet as on ${asOn}`).toBe(true);
      // the party report reconciles to the ledger: what is pending, less advances, plus what is in no bill, is the ledger balance
      for (const side of ['receivable', 'payable'] as const) {
        for (const row of outstandingByParty({ vouchers: b.vouchers, lines, masters: b.masters, side, asOn })) {
          expect(row.balance, `${row.name} ${side} as on ${asOn}`).toBe(row.pending - row.advances + row.notInBills);
          expect(Object.values(row.buckets).reduce((x, y) => x + y, 0n)).toBe(row.pending);
        }
      }
    }
  });
});
