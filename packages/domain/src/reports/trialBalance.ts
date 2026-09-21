import type { DateRange } from '../dates';
import type { GroupId, LedgerId } from '../ids';
import type { Masters } from '../masters/masters';
import { type Money, ZERO, addMoney, money } from '../money';
import type { JournalLine } from '../posting/plan';

/**
 * Pure reference implementation of ledger balances and the trial balance, computed from journal
 * lines alone. It is the oracle the SQL reports are later checked against, and it makes the core
 * promise testable: balances are DERIVED from the journal, never stored.
 *
 * Sign convention: signed Money with debit positive, credit negative.
 */

export interface LedgerMovement {
  readonly ledgerId: LedgerId;
  /** Net balance before `range.from` (0 if no `from`). */
  readonly opening: Money;
  /** Sum of debits dated within the range. */
  readonly debit: Money;
  /** Sum of credits dated within the range. */
  readonly credit: Money;
  /** opening + debit − credit. */
  readonly closing: Money;
}

const signed = (l: JournalLine): bigint => (l.side === 'debit' ? l.amount : -l.amount);

export function ledgerMovements(
  lines: Iterable<JournalLine>,
  range: DateRange = {},
): Map<LedgerId, LedgerMovement> {
  const acc = new Map<LedgerId, { opening: bigint; debit: bigint; credit: bigint }>();

  for (const l of lines) {
    if (range.to !== undefined && l.date > range.to) continue;
    const entry = acc.get(l.ledgerId) ?? { opening: 0n, debit: 0n, credit: 0n };
    if (range.from !== undefined && l.date < range.from) {
      entry.opening += signed(l);
    } else if (l.side === 'debit') {
      entry.debit += l.amount;
    } else {
      entry.credit += l.amount;
    }
    acc.set(l.ledgerId, entry);
  }

  const out = new Map<LedgerId, LedgerMovement>();
  for (const [ledgerId, e] of acc) {
    out.set(ledgerId, {
      ledgerId,
      opening: money(e.opening),
      debit: money(e.debit),
      credit: money(e.credit),
      closing: money(e.opening + e.debit - e.credit),
    });
  }
  return out;
}

export interface TrialBalance {
  readonly rows: readonly LedgerMovement[];
  /** Σ of closing balances that are debit (positive). */
  readonly totalClosingDebit: Money;
  /** Σ of closing balances that are credit, as a positive number. */
  readonly totalClosingCredit: Money;
  /** The accounting invariant: total debit = total credit. */
  readonly isBalanced: boolean;
}

export function trialBalance(lines: Iterable<JournalLine>, range: DateRange = {}): TrialBalance {
  const rows = [...ledgerMovements(lines, range).values()]
    .filter((r) => r.opening !== 0n || r.debit !== 0n || r.credit !== 0n)
    .sort((a, b) => (a.ledgerId < b.ledgerId ? -1 : a.ledgerId > b.ledgerId ? 1 : 0));

  let dr = ZERO;
  let cr = ZERO;
  for (const r of rows) {
    if (r.closing > 0n) dr = addMoney(dr, r.closing);
    else if (r.closing < 0n) cr = addMoney(cr, money(-r.closing));
  }
  return { rows, totalClosingDebit: dr, totalClosingCredit: cr, isBalanced: dr === cr };
}

/**
 * Rolls ledger closing balances up the group tree: each group's total includes every ledger in it
 * and in all of its descendants. Signed, debit positive.
 */
export function closingByGroup(rows: readonly LedgerMovement[], masters: Masters): Map<GroupId, Money> {
  const totals = new Map<GroupId, bigint>();
  for (const r of rows) {
    const ledger = masters.ledger(r.ledgerId);
    if (!ledger) continue;
    for (const g of masters.groups.ancestorsOf(ledger.groupId)) {
      totals.set(g.id, (totals.get(g.id) ?? 0n) + r.closing);
    }
  }
  return new Map([...totals].map(([id, v]) => [id, money(v)]));
}
