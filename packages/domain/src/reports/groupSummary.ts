import type { DateRange } from '../dates';
import type { GroupId, LedgerId } from '../ids';
import type { Nature } from '../masters/groups';
import type { Masters } from '../masters/masters';
import { type Money, money } from '../money';
import type { JournalLine } from '../posting/plan';
import { ledgerMovements } from './trialBalance';

/**
 * A level of the chart of accounts as a report: the children of a group — its sub-groups (each rolled up over everything beneath it) and its own
 * ledgers — or, at the root, the primary groups. It is the Trial Balance, and with a chosen set of groups the Cash Book and the Bank Book. A pure
 * function of the journal, like every balance in the system: nothing here is stored.
 *
 * Signed money throughout, debit positive: closing = opening + debit − credit.
 */

export interface GroupRow {
  readonly kind: 'group' | 'ledger';
  /** The GroupId or LedgerId this row opens. */
  readonly id: string;
  readonly name: string;
  readonly nature: Nature;
  readonly opening: Money;
  readonly debit: Money;
  readonly credit: Money;
  readonly closing: Money;
}

export interface GroupRowsOptions {
  /** Whose children to list; omitted = the primary groups. A book (Cash, Bank) lists the children of several groups at once. */
  readonly parentIds?: readonly GroupId[] | undefined;
  /** Keep rows with no balance and no movement (a cash ledger nobody has used yet). Default: leave them out, as a trial balance does. */
  readonly includeEmpty?: boolean | undefined;
}

interface Totals {
  opening: bigint;
  debit: bigint;
  credit: bigint;
  closing: bigint;
}

const empty = (): Totals => ({ opening: 0n, debit: 0n, credit: 0n, closing: 0n });

export function groupRows(masters: Masters, lines: Iterable<JournalLine>, range: DateRange = {}, options: GroupRowsOptions = {}): GroupRow[] {
  const movements = ledgerMovements(lines, range);

  // every group's totals: the sum of every ledger in it and beneath it
  const rolled = new Map<GroupId, Totals>();
  for (const ledger of masters.ledgers) {
    const m = movements.get(ledger.id);
    if (!m) continue;
    for (const g of masters.groups.ancestorsOf(ledger.groupId)) {
      const t = rolled.get(g.id) ?? empty();
      t.opening += m.opening;
      t.debit += m.debit;
      t.credit += m.credit;
      t.closing += m.closing;
      rolled.set(g.id, t);
    }
  }

  const keep = (t: Totals): boolean => options.includeEmpty === true || t.opening !== 0n || t.debit !== 0n || t.credit !== 0n || t.closing !== 0n;
  const rows: GroupRow[] = [];
  for (const parent of options.parentIds ?? [null]) {
    const groups = masters.groups.all
      .filter((g) => (parent === null ? g.parentId === null : g.parentId === parent))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const g of groups) {
      const t = rolled.get(g.id) ?? empty();
      if (!keep(t)) continue;
      rows.push({ kind: 'group', id: g.id, name: g.name, nature: g.nature, opening: money(t.opening), debit: money(t.debit), credit: money(t.credit), closing: money(t.closing) });
    }
    if (parent === null) continue;
    const ledgers = masters.ledgers.filter((l) => l.groupId === parent).sort((a, b) => a.name.localeCompare(b.name));
    for (const l of ledgers) {
      const m = movements.get(l.id);
      const t: Totals = m ? { opening: m.opening, debit: m.debit, credit: m.credit, closing: m.closing } : empty();
      if (!keep(t)) continue;
      rows.push({
        kind: 'ledger',
        id: l.id,
        name: l.name,
        nature: masters.groups.natureOf(l.groupId) ?? 'asset',
        opening: money(t.opening),
        debit: money(t.debit),
        credit: money(t.credit),
        closing: money(t.closing),
      });
    }
  }
  return rows;
}

export interface GroupTotals {
  /** Net opening balance (debit positive). */
  readonly opening: Money;
  readonly debit: Money;
  readonly credit: Money;
  /** Σ of closing balances that are debit / credit (credit as a positive number). */
  readonly closingDebit: Money;
  readonly closingCredit: Money;
}

/** What the rows shown add up to. At the root of a whole company the two closing totals are equal: the books balance. */
export function groupTotals(rows: readonly GroupRow[]): GroupTotals {
  let opening = 0n;
  let debit = 0n;
  let credit = 0n;
  let closingDebit = 0n;
  let closingCredit = 0n;
  for (const r of rows) {
    opening += r.opening;
    debit += r.debit;
    credit += r.credit;
    if (r.closing > 0n) closingDebit += r.closing;
    else closingCredit -= r.closing;
  }
  return { opening: money(opening), debit: money(debit), credit: money(credit), closingDebit: money(closingDebit), closingCredit: money(closingCredit) };
}

/** The ledger ids beneath a group (any depth) — for "which ledgers make up this line". */
export function ledgersUnder(masters: Masters, groupId: GroupId): LedgerId[] {
  return masters.ledgers.filter((l) => masters.groups.isWithin(l.groupId, groupId)).map((l) => l.id);
}

