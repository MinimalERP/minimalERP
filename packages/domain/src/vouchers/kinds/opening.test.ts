import { describe, expect, it } from 'vitest';
import { localDate } from '../../dates';
import { IssueCode } from '../../errors';
import { deterministicUuid } from '../../ids';
import { seedCompany } from '../../masters/seed';
import { trialBalance } from '../../reports/trialBalance';
import { prepareVoucher } from '../../posting/engine';
import type { JournalLine } from '../../posting/plan';
import { defaultVoucherKinds } from '../registry';

const newId = (n: string) => deterministicUuid(`o|${n}`);
const base = seedCompany({ name: 'Acme', fyStart: localDate('2024-04-01'), newId });
const registry = defaultVoucherKinds();
const openingType = newId('type:opening');
const diff = base.openingDifferenceLedger()!.id;
const cash = newId('ledger:cash');

const draft = (over: Record<string, unknown> = {}) => ({
  id: newId('v1'),
  voucherTypeId: openingType,
  date: '2024-04-01',
  ledgerId: cash,
  side: 'debit',
  amount: '5000.00',
  offsetLedgerId: diff,
  ...over,
});
const codes = (input: unknown) => {
  const r = prepareVoucher(input, base, registry);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe('opening balance voucher', () => {
  it('posts the ledger’s own side and the opposite side to Opening Balance Difference — debit first', () => {
    const r = prepareVoucher(draft(), base, registry);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plan.journal.map((l) => [l.ledgerId, l.side, l.amount])).toEqual([
      [cash, 'debit', 500000n],
      [diff, 'credit', 500000n],
    ]);
  });

  it('a credit opening (a liability) puts the difference on the debit side', () => {
    const r = prepareVoucher(draft({ side: 'credit' }), base, registry);
    expect(r.ok && r.value.plan.journal.map((l) => l.side)).toEqual(['debit', 'credit']);
    expect(r.ok && r.value.plan.journal[0]?.ledgerId).toBe(diff);
  });

  it('must be dated the first day of the financial year', () => {
    expect(codes(draft({ date: '2024-04-02' }))).toEqual([IssueCode.OpeningInvalid]);
    expect(codes(draft({ date: '2024-03-31' }))).toEqual([IssueCode.DateOutsideFinancialYear]);
  });

  it('needs a positive amount', () => {
    expect(codes(draft({ amount: '0.00' }))).toEqual([IssueCode.AmountNotPositive]);
  });

  it('must offset to the built-in difference ledger, never to an ordinary ledger', () => {
    expect(codes(draft({ offsetLedgerId: newId('ledger:cash') }))).toContain(IssueCode.OpeningInvalid);
  });

  it('the built-in ledger itself has no opening balance', () => {
    expect(codes(draft({ ledgerId: diff }))).toContain(IssueCode.OpeningInvalid);
  });

  it('refuses unknown ledgers and non-opening drafts shapes', () => {
    expect(codes(draft({ ledgerId: 'ghost' }))).toEqual([IssueCode.LedgerUnknown]);
    expect(codes(draft({ side: 'sideways' }))).toEqual([IssueCode.SchemaInvalid]);
    expect(codes({ ...draft(), offsetLedgerId: undefined })).toEqual([IssueCode.SchemaInvalid]);
  });

  it('for many random sets of openings the books balance, and the difference ledger holds exactly the gap', () => {
    // A small deterministic generator (LCG) keeps the domain package free of test-only dependencies.
    let seed = 12345;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;

    for (let run = 0; run < 200; run++) {
      const count = 1 + next(12);
      const journal: JournalLine[] = [];
      for (let i = 0; i < count; i++) {
        const side = next(2) === 0 ? 'debit' : 'credit';
        const paise = BigInt(1 + next(1_000_000_000));
        const r = prepareVoucher(draft({ id: newId(`p${run}-${i}`), side, amount: paise }), base, registry);
        if (!r.ok) throw new Error(JSON.stringify(r.issues));
        journal.push(...(r.value.plan.journal));
      }
      expect(trialBalance(journal).isBalanced).toBe(true);
      const net = (id: string) =>
        journal.filter((l) => l.ledgerId === id).reduce((sum, l) => sum + (l.side === 'debit' ? l.amount : -l.amount), 0n);
      // all openings hit Cash here, so the difference ledger mirrors it exactly
      expect(net(diff)).toBe(-net(cash));
    }
  });
});
