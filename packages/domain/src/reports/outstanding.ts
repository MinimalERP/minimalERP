import type { LocalDate } from '../dates';
import type { LedgerId, PartyId, VoucherId } from '../ids';
import type { Masters } from '../masters/masters';
import { type Money, money } from '../money';
import type { JournalLine } from '../posting/plan';
import { allocatedLinesOf, openBills } from '../vouchers/allocations';
import type { Voucher } from '../vouchers/voucher';
import { ledgerMovements } from './trialBalance';

/**
 * Outstanding receivables and payables, bill by bill, aged from each bill's DUE DATE. A bill is what a "new reference" allocation raised — a sales
 * invoice raises one named by its own number — and what "against" allocations have settled since; `openBills` already knows that. Here it is dated,
 * aged and rolled up per party, and reconciled to the party's ledger so the report always agrees with the Trial Balance:
 *
 *     ledger balance  =  bills still pending  −  advances / on account  +  what was never put in a bill
 */

export type OutstandingSide = 'receivable' | 'payable';

export const BUCKETS = ['notDue', 'd1to30', 'd31to60', 'd61to90', 'over90'] as const;
export type Bucket = (typeof BUCKETS)[number];
export const BUCKET_LABELS: Readonly<Record<Bucket, string>> = {
  notDue: 'Not yet due',
  d1to30: '1–30 days',
  d31to60: '31–60 days',
  d61to90: '61–90 days',
  over90: 'Over 90 days',
};

const DAY = 86_400_000;

/** Whole days from one date to a later one (negative if it is earlier). Calendar arithmetic in UTC, so no time zone can move it. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / DAY);
}

/** How many days past its due date a bill is on `asOn` — 0 while it is not yet due (or falls due today). THE rule for "overdue", wherever it is shown. */
export const daysOverdue = (due: LocalDate | undefined, asOn: LocalDate): number => (due === undefined ? 0 : Math.max(0, daysBetween(due, asOn)));

export function bucketOf(days: number): Bucket {
  return days <= 0 ? 'notDue' : days <= 30 ? 'd1to30' : days <= 60 ? 'd31to60' : days <= 90 ? 'd61to90' : 'over90';
}

const inSide = (masters: Masters, side: OutstandingSide, ledgerId: LedgerId): boolean => {
  const ledger = masters.ledger(ledgerId);
  return ledger !== undefined && masters.groups.isWithinReserved(ledger.groupId, side === 'receivable' ? 'sundry-debtors' : 'sundry-creditors');
};

/** The party ledgers of a side: everything under Sundry Debtors (receivable) or Sundry Creditors (payable). */
export const partyLedgersOf = (masters: Masters, side: OutstandingSide): LedgerId[] => masters.ledgers.filter((l) => inSide(masters, side, l.id)).map((l) => l.id);

export interface BillRow {
  readonly ledgerId: LedgerId;
  readonly party: string;
  readonly ref: string;
  /** The voucher that raised the bill (Enter opens it). */
  readonly voucherId: VoucherId;
  readonly billDate: LocalDate;
  /** A bill with no due date falls due the day it was raised. */
  readonly dueDate: LocalDate;
  readonly pending: Money;
  /** What the bill was raised for; received (or paid) so far is `amount − pending`. */
  readonly amount: Money;
  readonly daysOverdue: number;
  readonly bucket: Bucket;
}

export interface OutstandingInput {
  readonly vouchers: readonly Voucher[];
  readonly masters: Masters;
  readonly side: OutstandingSide;
  /** Everything posted up to and including this date; ageing is counted to it. */
  readonly asOn: LocalDate;
}

/** Every bill still to be settled on the side, oldest due first; `ledgerId` limits it to one party. */
export function outstandingBills({ vouchers, masters, side, asOn, ledgerId }: OutstandingInput & { readonly ledgerId?: LedgerId | undefined }): BillRow[] {
  const upTo = vouchers.filter((v) => v.date <= asOn);
  const byId = new Map(upTo.map((v) => [v.id, v]));
  const wanted = side === 'receivable' ? 'debit' : 'credit';
  const rows: BillRow[] = [];
  for (const id of ledgerId ? [ledgerId] : partyLedgersOf(masters, side)) {
    if (!inSide(masters, side, id)) continue;
    const party = masters.ledger(id)?.name ?? '';
    for (const b of openBills(upTo, masters, id)) {
      if (b.side !== wanted) continue;
      const billDate = byId.get(b.voucherId)?.date;
      if (billDate === undefined) continue;
      const dueDate = b.dueDate ?? billDate;
      const days = daysOverdue(dueDate, asOn);
      rows.push({ ledgerId: id, party, ref: b.ref, voucherId: b.voucherId, billDate, dueDate, pending: b.pending, amount: b.amount, daysOverdue: days, bucket: bucketOf(days) });
    }
  }
  return rows.sort((a, b) => (a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.ref.localeCompare(b.ref)));
}

export interface PartyOutstanding {
  readonly ledgerId: LedgerId;
  readonly partyId: PartyId | undefined;
  readonly name: string;
  /** How many bills are open. */
  readonly bills: number;
  /** Σ of the open bills. */
  readonly pending: Money;
  readonly buckets: Readonly<Record<Bucket, Money>>;
  /** Money received (paid) that is not against a bill: advances and on-account, and bills raised the other way. */
  readonly advances: Money;
  /** What is in the ledger but was never put in a bill (positive = more owed than the bills say). */
  readonly notInBills: Money;
  /** The ledger's balance in its natural direction: what is owed to us (receivable) or by us (payable). */
  readonly balance: Money;
  /** The oldest days-overdue among its bills. */
  readonly oldest: number;
}

/** One row per party with anything outstanding, reconciled to its ledger: balance = pending − advances + notInBills. */
export function outstandingByParty({ vouchers, lines, masters, side, asOn }: OutstandingInput & { readonly lines: Iterable<JournalLine> }): PartyOutstanding[] {
  const upTo = vouchers.filter((v) => v.status === 'posted' && v.date <= asOn);
  const movements = ledgerMovements(lines, { to: asOn });
  const bills = outstandingBills({ vouchers, masters, side, asOn });
  const natural = side === 'receivable' ? 'debit' : 'credit';

  // advances and on-account allocations sit on the side opposite the bills
  const advanceOf = new Map<LedgerId, bigint>();
  for (const v of upTo) {
    for (const l of allocatedLinesOf(v, masters)) {
      if (l.side === natural || !inSide(masters, side, l.ledgerId)) continue;
      for (const a of l.allocations) {
        if (a.kind === 'advance' || a.kind === 'onAccount') advanceOf.set(l.ledgerId, (advanceOf.get(l.ledgerId) ?? 0n) + a.amount);
      }
    }
  }
  // bills open on the other side of the ledger (a credit note raised against a customer) are money in its favour too
  for (const id of partyLedgersOf(masters, side)) {
    for (const b of openBills(upTo, masters, id)) if (b.side !== natural) advanceOf.set(id, (advanceOf.get(id) ?? 0n) + b.pending);
  }

  const out: PartyOutstanding[] = [];
  for (const id of partyLedgersOf(masters, side)) {
    const mine = bills.filter((b) => b.ledgerId === id);
    const closing = movements.get(id)?.closing ?? 0n;
    const balance = side === 'receivable' ? closing : -closing;
    const advances = advanceOf.get(id) ?? 0n;
    if (mine.length === 0 && balance === 0n && advances === 0n) continue;
    const buckets = { notDue: 0n, d1to30: 0n, d31to60: 0n, d61to90: 0n, over90: 0n };
    let pending = 0n;
    for (const b of mine) {
      buckets[b.bucket] += b.pending;
      pending += b.pending;
    }
    const ledger = masters.ledger(id);
    out.push({
      ledgerId: id,
      partyId: ledger?.partyId,
      name: ledger?.name ?? '',
      bills: mine.length,
      pending: money(pending),
      buckets: { notDue: money(buckets.notDue), d1to30: money(buckets.d1to30), d31to60: money(buckets.d31to60), d61to90: money(buckets.d61to90), over90: money(buckets.over90) },
      advances: money(advances),
      notInBills: money(balance - pending + advances),
      balance: money(balance),
      oldest: mine.reduce((m, b) => Math.max(m, b.daysOverdue), 0),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
