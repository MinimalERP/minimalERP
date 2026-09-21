import {
  type LedgerId,
  type LocalDate,
  type Side,
  localDate,
  parseMoney,
  type VoucherId,
} from '@minimalerp/domain';
import type { DemoWorld } from './world';
import type { AccountingKind } from './kinds';

/** Money as a test author writes it: minor units, or a decimal string like "1500.50". */
export type Amt = bigint | string;

export function minor(a: Amt): bigint {
  if (typeof a === 'bigint') return a;
  const m = parseMoney(a);
  if (m === undefined) throw new Error(`bad test amount: ${a}`);
  return m;
}

/**
 * A voucher submission plus the net effect it SHOULD have on each ledger (debit positive).
 * The effect is worked out here with plain arithmetic, deliberately NOT by calling the posting
 * rules — so comparing it with what the engine journals is a real cross-check, not a tautology.
 */
export interface Scenario {
  readonly kind: AccountingKind;
  readonly id: VoucherId;
  readonly voucher: Record<string, unknown>;
  readonly effects: ReadonlyArray<readonly [LedgerId, bigint]>;
}

export type LinePair = readonly [LedgerId, Amt];
export type EntryTriple = readonly [LedgerId, Side, Amt];

interface Common {
  readonly id: string;
  readonly date: string;
  readonly narration?: string;
}

interface SingleEntryInput extends Common {
  readonly account: LedgerId;
  readonly lines: readonly LinePair[];
}

function singleEntry(
  w: DemoWorld,
  kind: 'payment' | 'receipt' | 'contra',
  accountSign: 1n | -1n,
  input: SingleEntryInput,
): Scenario {
  const total = input.lines.reduce((s, [, a]) => s + minor(a), 0n);
  return {
    kind,
    id: w.vid(input.id),
    voucher: {
      id: w.vid(input.id),
      voucherTypeId: w.types[kind],
      date: input.date,
      ...(input.narration === undefined ? {} : { narration: input.narration }),
      accountLedgerId: input.account,
      lines: input.lines.map(([ledgerId, amount]) => ({ ledgerId, amount })),
    },
    effects: [
      [input.account, accountSign * total],
      ...input.lines.map(([ledgerId, a]) => [ledgerId, -accountSign * minor(a)] as const),
    ],
  };
}

/** Payment: cash/bank credited (−), particulars debited (+). */
export const payment = (w: DemoWorld, i: SingleEntryInput): Scenario => singleEntry(w, 'payment', -1n, i);
/** Receipt: cash/bank debited (+), particulars credited (−). */
export const receipt = (w: DemoWorld, i: SingleEntryInput): Scenario => singleEntry(w, 'receipt', 1n, i);
/** Contra: source cash/bank credited (−), destinations debited (+). */
export const contra = (w: DemoWorld, i: SingleEntryInput): Scenario => singleEntry(w, 'contra', -1n, i);

export function journal(
  w: DemoWorld,
  input: Common & { readonly entries: readonly EntryTriple[] },
): Scenario {
  return {
    kind: 'journal',
    id: w.vid(input.id),
    voucher: {
      id: w.vid(input.id),
      voucherTypeId: w.types.journal,
      date: input.date,
      ...(input.narration === undefined ? {} : { narration: input.narration }),
      entries: input.entries.map(([ledgerId, side, amount]) => ({ ledgerId, side, amount })),
    },
    effects: input.entries.map(([ledgerId, side, a]) => [ledgerId, side === 'debit' ? minor(a) : -minor(a)] as const),
  };
}

/** `days` after the start of FY 2024-25 (0 = 1 Apr 2024, 364 = 31 Mar 2025). */
export function dayOfFy2425(days: number): LocalDate {
  return localDate(new Date(Date.UTC(2024, 3, 1 + days)).toISOString().slice(0, 10));
}

/** Net effect per ledger across scenarios: the independent oracle for what the books should hold. */
export function expectedBalances(scenarios: Iterable<Scenario>): Map<LedgerId, bigint> {
  const out = new Map<LedgerId, bigint>();
  for (const s of scenarios) {
    for (const [ledger, delta] of s.effects) out.set(ledger, (out.get(ledger) ?? 0n) + delta);
  }
  for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
}
