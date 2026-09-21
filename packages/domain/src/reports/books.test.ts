import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { deterministicUuid } from '../ids';
import type { LedgerId, VoucherId } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { seedCompany } from '../masters/seed';
import { prepareVoucher } from '../posting/engine';
import type { JournalLine } from '../posting/plan';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { dayBookRows, ledgerStatement, onlyVoucherTypes, statementView, summariseNames } from './books';
import { ledgerMovements, trialBalance } from './trialBalance';

const newId = (n: string) => deterministicUuid(`b|${n}`);
const registry = defaultVoucherKinds();

/** A tiny in-memory books: masters + posted vouchers + journal, built with the real engine. */
function books() {
  let masters: Masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
  const group = (key: string) => newId(`group:${key}`);
  const add = (name: string, groupKey: string) => {
    const r = prepareMasterCommand({ op: 'create', kind: 'ledger', id: newId(`l:${name}`), data: { name, groupId: group(groupKey) } }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
    return newId(`l:${name}`) as LedgerId;
  };
  const L = {
    bank: add('HDFC Bank', 'bank-accounts'),
    cash: newId('ledger:cash') as LedgerId,
    rent: add('Factory Rent', 'indirect-expenses'),
    power: add('Electricity', 'indirect-expenses'),
    abc: add('ABC Industries', 'sundry-debtors'),
    steel: add('Steel Supplies', 'sundry-creditors'),
  };
  const vouchers: Voucher[] = [];
  const lines: JournalLine[] = [];
  const counters = new Map<string, number>();
  let n = 0;

  const post = (kind: 'payment' | 'receipt' | 'contra' | 'journal', date: string, body: Record<string, unknown>, narration?: string) => {
    const type = masters.voucherTypes.find((t) => t.baseKind === kind)!;
    const id = newId(`v:${++n}`);
    const prepared = prepareVoucher({ id, voucherTypeId: type.id, date, ...(narration ? { narration } : {}), ...body }, masters, registry);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues));
    const seq = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, seq);
    const voucher: Voucher = {
      id: id as VoucherId,
      companyId: masters.company.id,
      voucherTypeId: type.id,
      financialYearId: prepared.value.financialYear.id,
      number: `${kind.slice(0, 3).toUpperCase()}/${String(seq).padStart(4, '0')}`,
      date: prepared.value.draft.date,
      status: 'posted',
      version: 1,
      revision: 0,
      content: prepared.value.draft,
    };
    vouchers.push(voucher);
    lines.push(...prepared.value.plan.journal);
    return voucher;
  };
  const cancel = (v: Voucher) => {
    const i = vouchers.findIndex((x) => x.id === v.id);
    vouchers[i] = { ...v, status: 'cancelled', version: 2 };
    for (let k = lines.length - 1; k >= 0; k--) if (lines[k]?.voucherId === v.id) lines.splice(k, 1);
  };
  const m = () => masters;
  return { L, post, cancel, vouchers, lines, m };
}

/** bank 100000 opening-ish receipt, payments, a journal, a contra. */
function sample() {
  const b = books();
  const { L } = b;
  b.post('receipt', '2024-04-05', { accountLedgerId: L.bank, lines: [{ ledgerId: L.abc, amount: '100000' }] }, 'Advance from ABC');
  b.post('payment', '2024-05-10', { accountLedgerId: L.bank, lines: [{ ledgerId: L.rent, amount: '12000' }, { ledgerId: L.power, amount: '3450' }] }, 'May bills');
  b.post('journal', '2024-05-12', { entries: [{ ledgerId: L.rent, side: 'debit', amount: '500' }, { ledgerId: L.steel, side: 'credit', amount: '500' }] });
  b.post('contra', '2024-05-20', { accountLedgerId: L.bank, lines: [{ ledgerId: L.cash, amount: '20000' }] });
  b.post('payment', '2024-06-03', { accountLedgerId: L.bank, lines: [{ ledgerId: L.rent, amount: '12000' }] });
  return b;
}

describe('summariseNames', () => {
  it('names one, or one plus a count', () => {
    expect(summariseNames([])).toBe('');
    expect(summariseNames(['Rent'])).toBe('Rent');
    expect(summariseNames(['Rent', 'Rent'])).toBe('Rent');
    expect(summariseNames(['Rent', 'Power', 'Wages'])).toBe('Rent (+2 more)');
  });
});

describe('Day Book', () => {
  it('lists every voucher oldest first, with type, number, particulars and totals', () => {
    const b = sample();
    const rows = dayBookRows({ vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    expect(rows.map((r) => [r.date, r.number, r.voucherType])).toEqual([
      ['2024-04-05', 'REC/0001', 'Receipt'],
      ['2024-05-10', 'PAY/0001', 'Payment'],
      ['2024-05-12', 'JOU/0001', 'Journal'],
      ['2024-05-20', 'CON/0001', 'Contra'],
      ['2024-06-03', 'PAY/0002', 'Payment'],
    ]);
    const pay = rows[1]!;
    expect(pay).toMatchObject({ particulars: 'Factory Rent (+1 more)', narration: 'May bills', debit: 1545000n, credit: 1545000n, status: 'posted' });
    expect(rows[0]?.particulars).toBe('ABC Industries');
  });

  it('every posted voucher balances, so total debit = total credit', () => {
    const b = sample();
    const rows = dayBookRows({ vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    expect(rows.reduce((s, r) => s + r.debit, 0n)).toBe(rows.reduce((s, r) => s + r.credit, 0n));
  });

  it('shows a cancelled voucher with its number but no amounts', () => {
    const b = sample();
    b.cancel(b.vouchers[1]!);
    const row = dayBookRows({ vouchers: b.vouchers, lines: b.lines, masters: b.m() }).find((r) => r.number === 'PAY/0001')!;
    expect(row).toMatchObject({ status: 'cancelled', debit: 0n, credit: 0n });
  });

  it('honours the date range, inclusive at both ends', () => {
    const b = sample();
    const rows = dayBookRows({ vouchers: b.vouchers, lines: b.lines, masters: b.m(), range: { from: localDate('2024-05-10'), to: localDate('2024-05-20') } });
    expect(rows.map((r) => r.number)).toEqual(['PAY/0001', 'JOU/0001', 'CON/0001']);
  });

  it('keeps creation order for vouchers on the same day', () => {
    const b = sample();
    b.post('payment', '2024-06-03', { accountLedgerId: b.L.bank, lines: [{ ledgerId: b.L.power, amount: '1' }] });
    const same = dayBookRows({ vouchers: b.vouchers, lines: b.lines, masters: b.m() }).filter((r) => r.date === '2024-06-03');
    expect(same.map((r) => r.number)).toEqual(['PAY/0002', 'PAY/0003']);
  });

  it('onlyVoucherTypes picks types, and an empty pick is everything', () => {
    const b = sample();
    const rows = dayBookRows({ vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    const payment = b.m().voucherTypes.find((t) => t.baseKind === 'payment')!.id;
    expect(onlyVoucherTypes(rows, [payment]).map((r) => r.number)).toEqual(['PAY/0001', 'PAY/0002']);
    expect(onlyVoucherTypes(rows, [])).toHaveLength(5);
  });
});

describe('Ledger statement', () => {
  it('shows opening, a running balance per voucher, and the closing balance (debit positive)', () => {
    const b = sample();
    const s = ledgerStatement({ ledgerId: b.L.bank, vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    expect(s.opening).toBe(0n);
    expect(s.rows.map((r) => [r.number, r.debit, r.credit, r.balance])).toEqual([
      ['REC/0001', 10000000n, 0n, 10000000n],
      ['PAY/0001', 0n, 1545000n, 8455000n],
      ['CON/0001', 0n, 2000000n, 6455000n],
      ['PAY/0002', 0n, 1200000n, 5255000n],
    ]);
    expect(s.closing).toBe(5255000n);
    expect(s.totalDebit - s.totalCredit).toBe(s.closing - s.opening);
  });

  it('names the other side of each entry', () => {
    const b = sample();
    const s = ledgerStatement({ ledgerId: b.L.bank, vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    expect(s.rows.map((r) => r.particulars)).toEqual(['ABC Industries', 'Factory Rent (+1 more)', 'Cash', 'Factory Rent']);
  });

  it('brings forward the balance from before the period as opening', () => {
    const b = sample();
    const s = ledgerStatement({ ledgerId: b.L.bank, vouchers: b.vouchers, lines: b.lines, masters: b.m(), range: { from: localDate('2024-05-15') } });
    expect(s.opening).toBe(8455000n);
    expect(s.rows.map((r) => r.number)).toEqual(['CON/0001', 'PAY/0002']);
    expect(s.rows[0]?.balance).toBe(6455000n);
    expect(s.closing).toBe(5255000n);
  });

  it('a cancelled voucher leaves the statement (it is out of the books)', () => {
    const b = sample();
    b.cancel(b.vouchers[1]!);
    const s = ledgerStatement({ ledgerId: b.L.bank, vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    expect(s.rows.map((r) => r.number)).toEqual(['REC/0001', 'CON/0001', 'PAY/0002']);
    expect(s.closing).toBe(10000000n - 2000000n - 1200000n);
  });

  it('reconciles with the trial balance for EVERY ledger, over the whole year and over a sub-period', () => {
    const b = sample();
    for (const range of [{}, { from: localDate('2024-05-01'), to: localDate('2024-05-31') }]) {
      const tb = ledgerMovements(b.lines, range);
      for (const ledger of b.m().ledgers) {
        const s = ledgerStatement({ ledgerId: ledger.id, vouchers: b.vouchers, lines: b.lines, masters: b.m(), range });
        const mv = tb.get(ledger.id);
        expect(s.opening, ledger.name).toBe(mv?.opening ?? 0n);
        expect(s.closing, ledger.name).toBe(mv?.closing ?? 0n);
        expect(s.totalDebit, ledger.name).toBe(mv?.debit ?? 0n);
        expect(s.totalCredit, ledger.name).toBe(mv?.credit ?? 0n);
      }
    }
    expect(trialBalance(b.lines).isBalanced).toBe(true);
  });

  it('a ledger with nothing has an empty statement and zero balances', () => {
    const b = sample();
    const s = ledgerStatement({ ledgerId: newId('nobody') as LedgerId, vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    expect(s).toMatchObject({ opening: 0n, closing: 0n, rows: [] });
  });
});

describe('voucher-type filter on a statement (display only)', () => {
  const typeId = (b: ReturnType<typeof sample>, kind: string) => b.m().voucherTypes.find((t) => t.baseKind === kind)!.id;

  it('shows exactly the chosen types and totals only those rows', () => {
    const b = sample();
    const s = ledgerStatement({ ledgerId: b.L.bank, vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    const v = statementView(s, [typeId(b, 'payment'), typeId(b, 'receipt')]);
    expect(v.rows.map((r) => r.number)).toEqual(['REC/0001', 'PAY/0001', 'PAY/0002']);
    expect(v.shownDebit).toBe(10000000n);
    expect(v.shownCredit).toBe(1545000n + 1200000n);
  });

  it('a filtered row keeps the ledger’s TRUE running balance, and opening/closing are untouched', () => {
    const b = sample();
    const s = ledgerStatement({ ledgerId: b.L.bank, vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    const v = statementView(s, [typeId(b, 'payment')]);
    expect(v.rows.map((r) => r.balance)).toEqual([8455000n, 5255000n]); // after the receipt and the contra too, not just the payments
    expect(s.closing).toBe(5255000n);
    expect(s.opening).toBe(0n);
  });

  it('an empty selection is all types; unknown types show nothing', () => {
    const b = sample();
    const s = ledgerStatement({ ledgerId: b.L.bank, vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    expect(statementView(s, []).rows).toEqual(s.rows);
    expect(statementView(s, ['no-such-type']).rows).toEqual([]);
  });

  it('the types partition the ledger: filtered totals of every type add up to the unfiltered totals', () => {
    const b = sample();
    const s = ledgerStatement({ ledgerId: b.L.bank, vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    let d = 0n;
    let c = 0n;
    for (const t of b.m().voucherTypes) {
      const v = statementView(s, [t.id]);
      d += v.shownDebit;
      c += v.shownCredit;
    }
    expect(d).toBe(s.totalDebit);
    expect(c).toBe(s.totalCredit);
  });

  it('is the same for any random selection of types over a random history', () => {
    const b = books();
    let seed = 7;
    const next = (k: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % k;
    const others = [b.L.rent, b.L.power, b.L.abc, b.L.steel];
    for (let i = 0; i < 60; i++) {
      const date = `2024-0${4 + next(6)}-${String(1 + next(27)).padStart(2, '0')}`;
      const amount = String(1 + next(9000));
      const pick = next(3);
      if (pick === 0) b.post('payment', date, { accountLedgerId: b.L.bank, lines: [{ ledgerId: others[next(4)]!, amount }] });
      else if (pick === 1) b.post('receipt', date, { accountLedgerId: b.L.bank, lines: [{ ledgerId: others[next(4)]!, amount }] });
      else b.post('contra', date, { accountLedgerId: b.L.bank, lines: [{ ledgerId: b.L.cash, amount }] });
    }
    const s = ledgerStatement({ ledgerId: b.L.bank, vouchers: b.vouchers, lines: b.lines, masters: b.m() });
    const types = b.m().voucherTypes.map((t) => t.id);
    for (let n = 0; n < 40; n++) {
      const chosen = types.filter(() => next(2) === 0);
      const v = statementView(s, chosen);
      const all = new Map(s.rows.map((r) => [r.voucherId, r]));
      for (const r of v.rows) expect(all.get(r.voucherId)?.balance).toBe(r.balance); // real balance, always
      expect(v.rows.every((r) => chosen.length === 0 || chosen.includes(r.voucherTypeId))).toBe(true);
    }
    expect(s.closing).toBe(ledgerMovements(b.lines).get(b.L.bank)?.closing ?? 0n);
  });
});
