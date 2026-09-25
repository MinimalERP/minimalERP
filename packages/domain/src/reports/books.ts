import type { DateRange, LocalDate } from '../dates';
import type { LedgerId, VoucherId, VoucherTypeId } from '../ids';
import type { BaseKind, Masters } from '../masters/masters';
import { type Money, ZERO, money } from '../money';
import type { JournalLine } from '../posting/plan';
import type { Voucher, VoucherStatus } from '../vouchers/voucher';

/**
 * The two basic books, derived from vouchers and journal lines alone (never stored): the Day Book and a ledger's statement.
 * Both are pure; both reconcile with the trial-balance oracle (see the tests).
 */

// ---- helpers -------------------------------------------------------------------------------------------------

const inRange = (date: LocalDate, range: DateRange): boolean =>
  (range.from === undefined || date >= range.from) && (range.to === undefined || date <= range.to);

const signed = (l: JournalLine): bigint => (l.side === 'debit' ? l.amount : -l.amount);

function linesByVoucher(lines: readonly JournalLine[]): Map<VoucherId, JournalLine[]> {
  const out = new Map<VoucherId, JournalLine[]>();
  for (const l of lines) {
    const bucket = out.get(l.voucherId);
    if (bucket) bucket.push(l);
    else out.set(l.voucherId, [l]);
  }
  return out;
}

/** "Factory Rent", or "Factory Rent (+2 more)". */
export function summariseNames(names: readonly string[]): string {
  const distinct = [...new Set(names)];
  if (distinct.length === 0) return '';
  return distinct.length === 1 ? (distinct[0] as string) : `${distinct[0]} (+${distinct.length - 1} more)`;
}

/**
 * The ledgers a voucher is "about", in entry order: for Payment/Receipt/Contra the particulars (not the cash/bank account),
 * for a Journal its entries, otherwise every ledger it touches.
 */
function particularsOf(voucher: Voucher, journal: readonly JournalLine[], masters: Masters): string[] {
  // A sales or purchase invoice or order is about its party (the invoice's ledgers are the party's and the sales / purchase account).
  const base = masters.voucherType(voucher.voucherTypeId)?.baseKind;
  if (base === 'sales' || base === 'salesOrder' || base === 'quotation' || base === 'purchase' || base === 'purchaseOrder') {
    const partyId = (voucher.content as unknown as { partyId?: string }).partyId;
    const name = partyId === undefined ? undefined : masters.party(partyId as never)?.name;
    return name === undefined ? [] : [name];
  }
  // A Stock Journal is about stock items, not ledgers.
  if (masters.voucherType(voucher.voucherTypeId)?.baseKind === 'stockJournal') {
    const entries = (voucher.content as unknown as { entries?: { itemId: string }[] }).entries ?? [];
    return entries.map((e) => masters.stockItem(e.itemId as never)?.name ?? e.itemId);
  }
  const c = voucher.content as unknown as { accountLedgerId?: string; lines?: { ledgerId: string }[]; entries?: { ledgerId: string }[] };
  const ids = c.accountLedgerId !== undefined && c.lines ? c.lines.map((l) => l.ledgerId) : c.entries ? c.entries.map((e) => e.ledgerId) : journal.map((l) => l.ledgerId);
  return ids.map((id) => masters.ledger(id as LedgerId)?.name ?? id);
}

// ---- Day Book ------------------------------------------------------------------------------------------------

export interface DayBookRow {
  readonly voucherId: VoucherId;
  readonly date: LocalDate;
  readonly number: string;
  readonly voucherTypeId: VoucherTypeId;
  readonly voucherType: string;
  readonly baseKind: BaseKind | undefined;
  readonly particulars: string;
  readonly narration: string;
  readonly debit: Money;
  readonly credit: Money;
  readonly status: VoucherStatus;
}

export interface DayBookInput {
  /** In the order they were created (used to break ties between vouchers on the same day). */
  readonly vouchers: readonly Voucher[];
  readonly lines: readonly JournalLine[];
  readonly masters: Masters;
  readonly range?: DateRange | undefined;
}

/**
 * Every voucher dated in the range, oldest first, cancelled ones included (struck out, no amounts) so gaps in the numbering are
 * explained. Debit and credit are the voucher's totals — equal for every posted voucher.
 */
export function dayBookRows({ vouchers, lines, masters, range = {} }: DayBookInput): DayBookRow[] {
  const byVoucher = linesByVoucher(lines);
  const rows = vouchers
    .map((voucher, index) => ({ voucher, index }))
    .filter(({ voucher }) => inRange(voucher.date, range))
    // Opening stock is posted by the item form, not entered as a voucher: it is read in the stock reports, like the stock itself.
    .filter(({ voucher }) => masters.voucherType(voucher.voucherTypeId)?.baseKind !== 'stockOpening')
    .map(({ voucher, index }) => {
      const journal = byVoucher.get(voucher.id) ?? [];
      const type = masters.voucherType(voucher.voucherTypeId);
      let debit = 0n;
      let credit = 0n;
      for (const l of journal) {
        if (l.side === 'debit') debit += l.amount;
        else credit += l.amount;
      }
      const narration = (voucher.content as { narration?: string }).narration ?? '';
      return {
        index,
        row: {
          voucherId: voucher.id,
          date: voucher.date,
          number: voucher.number,
          voucherTypeId: voucher.voucherTypeId,
          voucherType: type?.name ?? '?',
          baseKind: type?.baseKind,
          particulars: summariseNames(particularsOf(voucher, journal, masters)),
          narration,
          debit: money(debit),
          credit: money(credit),
          status: voucher.status,
        } satisfies DayBookRow,
      };
    });
  rows.sort((a, b) => (a.row.date < b.row.date ? -1 : a.row.date > b.row.date ? 1 : a.index - b.index));
  return rows.map((r) => r.row);
}

/** Report-level voucher-type filter. An empty selection means "all types". Never touches the books; it only chooses rows to show. */
export function onlyVoucherTypes<R extends { readonly voucherTypeId: VoucherTypeId }>(rows: readonly R[], types: readonly string[]): R[] {
  return types.length === 0 ? [...rows] : rows.filter((r) => types.includes(r.voucherTypeId));
}

// ---- Ledger statement ----------------------------------------------------------------------------------------

export interface StatementRow {
  readonly voucherId: VoucherId;
  readonly date: LocalDate;
  readonly number: string;
  readonly voucherTypeId: VoucherTypeId;
  readonly voucherType: string;
  /** The other side of the entry: the ledgers this ledger was posted against. */
  readonly particulars: string;
  readonly narration: string;
  readonly debit: Money;
  readonly credit: Money;
  /** The ledger's TRUE running balance after this voucher (debit positive) — never affected by report filters. */
  readonly balance: Money;
}

export interface LedgerStatement {
  readonly ledgerId: LedgerId;
  /** Balance brought forward from before the range (debit positive). */
  readonly opening: Money;
  readonly rows: readonly StatementRow[];
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  readonly closing: Money;
}

export interface LedgerStatementInput extends DayBookInput {
  readonly ledgerId: LedgerId;
}

/**
 * One row per voucher that touched the ledger within the range, oldest first, with a running balance. `lines` may hold every
 * ledger's lines; only this ledger's are used. Opening = everything dated before the range.
 */
export function ledgerStatement({ ledgerId, vouchers, lines, masters, range = {} }: LedgerStatementInput): LedgerStatement {
  const order = new Map(vouchers.map((v, i) => [v.id, i]));
  const byId = new Map(vouchers.map((v) => [v.id, v]));
  const byVoucher = linesByVoucher(lines);

  let opening = 0n;
  const touched = new Map<VoucherId, { debit: bigint; credit: bigint }>();
  for (const l of lines) {
    if (l.ledgerId !== ledgerId) continue;
    if (range.to !== undefined && l.date > range.to) continue;
    if (range.from !== undefined && l.date < range.from) {
      opening += signed(l);
      continue;
    }
    const t = touched.get(l.voucherId) ?? { debit: 0n, credit: 0n };
    if (l.side === 'debit') t.debit += l.amount;
    else t.credit += l.amount;
    touched.set(l.voucherId, t);
  }

  const ordered = [...touched.entries()]
    .map(([id, t]) => ({ id, t, voucher: byId.get(id) }))
    .filter((x): x is { id: VoucherId; t: { debit: bigint; credit: bigint }; voucher: Voucher } => x.voucher !== undefined)
    .sort((a, b) =>
      a.voucher.date < b.voucher.date ? -1 : a.voucher.date > b.voucher.date ? 1 : (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );

  let balance = opening;
  let totalDebit = 0n;
  let totalCredit = 0n;
  const rows: StatementRow[] = ordered.map(({ id, t, voucher }) => {
    balance += t.debit - t.credit;
    totalDebit += t.debit;
    totalCredit += t.credit;
    const others = (byVoucher.get(id) ?? []).filter((l) => l.ledgerId !== ledgerId).map((l) => masters.ledger(l.ledgerId)?.name ?? l.ledgerId);
    const type = masters.voucherType(voucher.voucherTypeId);
    return {
      voucherId: id,
      date: voucher.date,
      number: voucher.number,
      voucherTypeId: voucher.voucherTypeId,
      voucherType: type?.name ?? '?',
      particulars: summariseNames(others.length > 0 ? others : [masters.ledger(ledgerId)?.name ?? '']),
      narration: (voucher.content as { narration?: string }).narration ?? '',
      debit: money(t.debit),
      credit: money(t.credit),
      balance: money(balance),
    };
  });

  return { ledgerId, opening: money(opening), rows, totalDebit: money(totalDebit), totalCredit: money(totalCredit), closing: money(balance) };
}

export interface StatementView {
  readonly rows: readonly StatementRow[];
  /** Debit and credit of the rows shown (the filtered subtotal); the statement's own totals are unchanged. */
  readonly shownDebit: Money;
  readonly shownCredit: Money;
}

/**
 * The voucher-type filter for a statement: chooses which rows to SHOW. Balances are already computed on the full statement, so a filtered
 * row still carries the ledger's real balance, and opening/closing are untouched. Empty selection = all types.
 */
export function statementView(statement: LedgerStatement, types: readonly string[]): StatementView {
  const rows = onlyVoucherTypes(statement.rows, types);
  let d = ZERO as bigint;
  let c = ZERO as bigint;
  for (const r of rows) {
    d += r.debit;
    c += r.credit;
  }
  return { rows, shownDebit: money(d), shownCredit: money(c) };
}
