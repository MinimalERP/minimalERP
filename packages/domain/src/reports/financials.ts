import type { DateRange, LocalDate } from '../dates';
import type { GroupId } from '../ids';
import type { ReservedGroupKey } from '../masters/groups';
import type { Masters } from '../masters/masters';
import { type Money, money } from '../money';
import type { JournalLine } from '../posting/plan';
import type { StockBook } from '../stock/book';
import { type GroupRow, groupRows } from './groupSummary';

/**
 * Profit & Loss and the Balance Sheet, as the two-sided statements an accountant reads. Pure functions of the journal and the stock book — nothing
 * is stored, so a back-dated entry, an alteration or a cancellation is simply what the next read shows.
 *
 * Every line is a positive-when-normal amount for its side (an expense on the debit side, an income on the credit side…); a line that comes out the
 * other way round is negative and says so. Each section's two sides total the SAME figure: the balancing line (Gross Profit c/d, Net Profit…) is
 * added to whichever side is short.
 *
 * Stock follows the periodic method (ADR-0014): Trading = Opening stock + Purchases + Direct expenses against Sales + Direct incomes + Closing stock,
 * the stock figures read from the stock book (its values are derived, never stored).
 */

export interface StatementLine {
  readonly label: string;
  readonly amount: Money;
  /** The group this line rolls up — Enter opens it. Lines that are figures of their own (stock, profit) have none. */
  readonly groupId?: GroupId | undefined;
  /** Where the figure comes from when it is not a ledger group. */
  readonly source?: 'opening-stock' | 'closing-stock' | 'result' | 'carried' | undefined;
}

export interface StatementSection {
  readonly id: string;
  readonly title: string;
  readonly leftTitle: string;
  readonly rightTitle: string;
  readonly left: readonly StatementLine[];
  readonly right: readonly StatementLine[];
  readonly leftTotal: Money;
  readonly rightTotal: Money;
}

export interface Statement {
  readonly sections: readonly StatementSection[];
  /** Profit & Loss: the net profit (positive) or loss (negative). Balance Sheet: the cumulative result carried into "Profit & Loss A/c". */
  readonly result: Money;
  /** Profit & Loss only: the gross profit (positive) or loss (negative) of the Trading account. */
  readonly grossResult?: Money | undefined;
}

const FAR_PAST = '0001-01-01' as LocalDate;
const FAR_FUTURE = '9999-12-31' as LocalDate;

/**
 * What the stock brought forward when the books began is worth: the In values of the opening-stock vouchers (`openingIds`) dated up to `upTo`.
 * (Opening stock is entered as stock movements on the first day; the periodic method treats it as the stock the business STARTED with.)
 */
export function openingStockOf(stock: StockBook, openingIds: ReadonlySet<string>, upTo: LocalDate = FAR_FUTURE): Money {
  let total = 0n;
  for (const m of stock.movements) if (openingIds.has(m.voucherId) && m.direction === 'in' && m.date <= upTo) total += m.value ?? 0n;
  return money(total);
}

/**
 * What the stock is worth at the start and end of a period, from the stock book (every item, every godown). The opening figure is what stood
 * before the period PLUS any opening-stock vouchers dated inside it: those are stock the period started with, not stock it bought.
 */
export function stockValues(stock: StockBook, range: DateRange, openingIds: ReadonlySet<string> = new Set()): { opening: Money; closing: Money } {
  const from = range.from ?? FAR_PAST;
  const to = range.to ?? FAR_FUTURE;
  let opening = 0n;
  let closing = 0n;
  for (const r of stock.summary(from, to)) {
    opening += r.opening.value;
    closing += r.closing.value;
  }
  for (const m of stock.movements) if (openingIds.has(m.voucherId) && m.direction === 'in' && m.date >= from && m.date <= to) opening += m.value ?? 0n;
  return { opening: money(opening), closing: money(closing) };
}

const sum = (lines: readonly StatementLine[]): bigint => lines.reduce((s, l) => s + l.amount, 0n);

/** The order accountants read the primary groups in; anything else (a group someone added) follows, by name. */
const RANK: Readonly<Partial<Record<ReservedGroupKey, number>>> = {
  'capital-account': 1,
  'loans-liability': 2,
  'current-liabilities': 3,
  'branch-divisions': 4,
  suspense: 5,
  'fixed-assets': 1,
  investments: 2,
  'current-assets': 3,
  'misc-expenses-asset': 4,
};

function primaryGroups(masters: Masters, rows: readonly GroupRow[]): (GroupRow & { rank: number })[] {
  return rows
    .map((r) => ({ ...r, rank: RANK[masters.groups.get(r.id as GroupId)?.reservedKey as ReservedGroupKey] ?? 50 }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

const groupLine = (r: GroupRow, amount: bigint): StatementLine => ({ label: r.name, amount: money(amount), groupId: r.id as GroupId });

// ---- Profit & Loss ---------------------------------------------------------------------------------------------------

export interface ProfitAndLossInput {
  readonly masters: Masters;
  readonly lines: Iterable<JournalLine>;
  readonly stock: StockBook;
  readonly range: DateRange;
  /** The opening-stock vouchers: stock dated inside the period counts as brought forward, not bought. */
  readonly openingStockIds?: ReadonlySet<string> | undefined;
}

/** Trading account (gross profit) and Profit & Loss account (net profit) for the period, each two-sided and balanced. */
export function profitAndLoss({ masters, lines, stock, range, openingStockIds }: ProfitAndLossInput): Statement {
  const roots = primaryGroups(masters, groupRows(masters, lines, range));
  const { opening, closing } = stockValues(stock, range, openingStockIds);
  // the period's own movement (debit − credit): an expense is a debit, an income a credit
  const net = (r: GroupRow): bigint => r.debit - r.credit;
  const trading = (r: GroupRow): boolean => masters.groups.get(r.id as GroupId)?.affectsGrossProfit === true;

  const tradingLeft: StatementLine[] = [];
  if (opening !== 0n) tradingLeft.push({ label: 'Opening Stock', amount: opening, source: 'opening-stock' });
  const tradingRight: StatementLine[] = [];
  const plLeft: StatementLine[] = [];
  const plRight: StatementLine[] = [];
  for (const r of roots) {
    const n = net(r);
    if (n === 0n) continue;
    if (r.nature === 'expense') (trading(r) ? tradingLeft : plLeft).push(groupLine(r, n));
    else if (r.nature === 'income') (trading(r) ? tradingRight : plRight).push(groupLine(r, -n));
  }
  if (closing !== 0n) tradingRight.push({ label: 'Closing Stock', amount: closing, source: 'closing-stock' });

  // Trading account
  const gross = sum(tradingRight) - sum(tradingLeft);
  const tl = [...tradingLeft];
  const tr = [...tradingRight];
  if (gross > 0n) tl.push({ label: 'Gross Profit c/d', amount: money(gross), source: 'carried' });
  else if (gross < 0n) tr.push({ label: 'Gross Loss c/d', amount: money(-gross), source: 'carried' });
  const tradingSection: StatementSection = {
    id: 'trading',
    title: 'Trading Account',
    leftTitle: 'Particulars',
    rightTitle: 'Particulars',
    left: tl,
    right: tr,
    leftTotal: money(sum(tl)),
    rightTotal: money(sum(tr)),
  };

  // Profit & Loss account
  const pl = [...plLeft];
  const pr = [...plRight];
  if (gross < 0n) pl.unshift({ label: 'Gross Loss b/d', amount: money(-gross), source: 'carried' });
  else if (gross > 0n) pr.unshift({ label: 'Gross Profit b/d', amount: money(gross), source: 'carried' });
  const netResult = sum(pr) - sum(pl);
  if (netResult > 0n) pl.push({ label: 'Net Profit', amount: money(netResult), source: 'result' });
  else if (netResult < 0n) pr.push({ label: 'Net Loss', amount: money(-netResult), source: 'result' });
  const plSection: StatementSection = {
    id: 'profit-loss',
    title: 'Profit & Loss Account',
    leftTitle: 'Particulars',
    rightTitle: 'Particulars',
    left: pl,
    right: pr,
    leftTotal: money(sum(pl)),
    rightTotal: money(sum(pr)),
  };

  return { sections: [tradingSection, plSection], result: money(netResult), grossResult: money(gross) };
}

// ---- Balance Sheet ---------------------------------------------------------------------------------------------------

export interface BalanceSheetInput {
  readonly masters: Masters;
  readonly lines: Iterable<JournalLine>;
  readonly stock: StockBook;
  /** Everything posted up to and including this date. */
  readonly asOn: LocalDate;
  /**
   * The opening-stock vouchers. The stock they brought forward (by ADR-0014 it does not reach a ledger) is shown under Capital, and the cumulative
   * profit is stated net of it, so the sheet balances: stock that is among the assets was put there by someone.
   */
  readonly openingStockIds: ReadonlySet<string>;
}

/** The Balance Sheet as on a date: liabilities on the left, assets on the right, equal. */
export function balanceSheet({ masters, lines, stock, asOn, openingStockIds }: BalanceSheetInput): Statement {
  const openingStock = openingStockOf(stock, openingStockIds, asOn);
  const roots = primaryGroups(masters, groupRows(masters, lines, { to: asOn }));
  const { closing } = stockValues(stock, { to: asOn });

  const left: StatementLine[] = [];
  const right: StatementLine[] = [];
  let income = 0n;
  let expense = 0n;
  for (const r of roots) {
    if (r.closing === 0n) continue;
    if (r.nature === 'liability') left.push(groupLine(r, -r.closing));
    else if (r.nature === 'asset') right.push(groupLine(r, r.closing));
    else if (r.nature === 'income') income += -r.closing;
    else expense += r.closing;
  }
  // The profit the books have made since they began (income − expenses, and the stock left over, less the stock they started with).
  const result = money(income - expense + closing - openingStock);
  if (openingStock !== 0n) left.push({ label: 'Opening Stock (brought forward)', amount: openingStock, source: 'opening-stock' });
  // a profit is owed to the owners (a liability); a loss is what they are yet to make good (shown among the assets, as Tally does)
  if (result > 0n) left.push({ label: 'Profit & Loss A/c', amount: result, source: 'result' });
  if (closing !== 0n) right.push({ label: 'Closing Stock', amount: closing, source: 'closing-stock' });
  if (result < 0n) right.push({ label: 'Profit & Loss A/c', amount: money(-result), source: 'result' });

  const section: StatementSection = {
    id: 'balance-sheet',
    title: 'Balance Sheet',
    leftTitle: 'Liabilities',
    rightTitle: 'Assets',
    left,
    right,
    leftTotal: money(sum(left)),
    rightTotal: money(sum(right)),
  };
  return { sections: [section], result };
}

/** Both sides of every section total the same. */
export const isBalanced = (s: Statement): boolean => s.sections.every((x) => x.leftTotal === x.rightTotal);
