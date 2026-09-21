import fc from 'fast-check';
import type { Side } from '@minimalerp/domain';
import type { AccountingKind } from './kinds';
import { type Scenario, contra, dayOfFy2425, journal, payment, receipt } from './scenarios';
import { ALL_ACTIVE_LEDGERS, CASH_BANK_LEDGERS, type DemoWorld, type LedgerName, OTHER_LEDGERS } from './world';

/** 0.01 up to 10,00,00,000.00 — spans a single paisa to a hundred crore. */
export const arbAmount: fc.Arbitrary<bigint> = fc.bigInt({ min: 1n, max: 100_00_00_000_00n });

const arbDayOffset = fc.integer({ min: 0, max: 364 });
const arbNarration = fc.option(fc.string({ maxLength: 40 }), { nil: undefined });

type SingleKind = 'payment' | 'receipt' | 'contra';

/**
 * A shrinkable description of a voucher, independent of any particular company: ledgers are named
 * ("bank"), not identified. `scenarioFrom` resolves the names inside a concrete world, so the same
 * generated voucher runs against the in-memory backend and against PostgreSQL alike.
 */
export type Spec =
  | {
      readonly kind: SingleKind;
      readonly day: number;
      readonly narration: string | undefined;
      readonly account: LedgerName;
      readonly lines: readonly (readonly [LedgerName, bigint])[];
    }
  | {
      readonly kind: 'journal';
      readonly day: number;
      readonly narration: string | undefined;
      readonly entries: readonly (readonly [LedgerName, Side, bigint])[];
    };

function arbSingleEntry(kind: SingleKind): fc.Arbitrary<Spec> {
  return fc.constantFrom(...CASH_BANK_LEDGERS).chain((account) => {
    // Particulars: any active ledger for payment/receipt; cash/bank only for contra. Never the account itself.
    const pool = (kind === 'contra' ? CASH_BANK_LEDGERS : ALL_ACTIVE_LEDGERS).filter((l) => l !== account);
    return fc.record({
      kind: fc.constant(kind),
      day: arbDayOffset,
      narration: arbNarration,
      account: fc.constant(account),
      lines: fc.array(fc.tuple(fc.constantFrom(...pool), arbAmount), { minLength: 1, maxLength: 5 }),
    });
  });
}

/** Balanced by construction: random debits and credits, then one balancing entry on the short side. */
function arbJournal(): fc.Arbitrary<Spec> {
  const ledger = fc.constantFrom(...OTHER_LEDGERS);
  const entry = fc.tuple(ledger, arbAmount);
  return fc
    .record({
      day: arbDayOffset,
      narration: arbNarration,
      debits: fc.array(entry, { minLength: 1, maxLength: 3 }),
      credits: fc.array(entry, { minLength: 1, maxLength: 3 }),
      balancer: ledger,
    })
    .map(({ day, narration, debits, credits, balancer }): Spec => {
      const dr = debits.reduce((s, [, a]) => s + a, 0n);
      const cr = credits.reduce((s, [, a]) => s + a, 0n);
      const entries: (readonly [LedgerName, Side, bigint])[] = [
        ...debits.map(([l, a]) => [l, 'debit', a] as const),
        ...credits.map(([l, a]) => [l, 'credit', a] as const),
      ];
      if (dr > cr) entries.push([balancer, 'credit', dr - cr] as const);
      if (cr > dr) entries.push([balancer, 'debit', cr - dr] as const);
      return { kind: 'journal', day, narration, entries };
    });
}

export function arbSpecOfKind(kind: AccountingKind): fc.Arbitrary<Spec> {
  return kind === 'journal' ? arbJournal() : arbSingleEntry(kind);
}

export const KINDS: readonly AccountingKind[] = ['contra', 'payment', 'receipt', 'journal'];

export const arbSpec = (): fc.Arbitrary<Spec> => fc.oneof(...KINDS.map((k) => arbSpecOfKind(k)));

/** Resolves a Spec's ledger names inside `w` and builds the concrete voucher + its expected effect. */
export function scenarioFrom(w: DemoWorld, spec: Spec, id: string): Scenario {
  const date = dayOfFy2425(spec.day);
  const base = { id, date, ...(spec.narration === undefined ? {} : { narration: spec.narration }) };
  const L = w.ledgers;
  switch (spec.kind) {
    case 'journal':
      return journal(w, { ...base, entries: spec.entries.map(([l, side, a]) => [L[l], side, a] as const) });
    case 'payment':
      return payment(w, { ...base, account: L[spec.account], lines: spec.lines.map(([l, a]) => [L[l], a] as const) });
    case 'receipt':
      return receipt(w, { ...base, account: L[spec.account], lines: spec.lines.map(([l, a]) => [L[l], a] as const) });
    case 'contra':
      return contra(w, { ...base, account: L[spec.account], lines: spec.lines.map(([l, a]) => [L[l], a] as const) });
  }
}
