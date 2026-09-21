import type { LocalDate } from '../dates';
import { type Issue, IssueCode, issue } from '../errors';
import type { LedgerId, VoucherId } from '../ids';
import { MAX_MONEY, type Money, ZERO, addMoney, formatMoney } from '../money';
import type { OrderLink, PlannedLink } from '../orders/orderBook';
import type { PlannedStock, StockMovement } from '../stock/movement';
import { MAX_QTY } from '../stock/quantity';

export type Side = 'debit' | 'credit';

/** What a posting rule emits: identity-free, so rules cannot get voucher id / line numbers / dates wrong. */
export interface PlannedLine {
  readonly ledgerId: LedgerId;
  readonly side: Side;
  /** Always strictly positive. Direction is carried by `side`, never by sign. */
  readonly amount: Money;
  readonly narration?: string | undefined;
}

export interface JournalLine extends PlannedLine {
  readonly voucherId: VoucherId;
  /** 1-based, contiguous within the voucher. */
  readonly lineNo: number;
  readonly date: LocalDate;
}

/**
 * The only thing a posting rule produces: the journal (ledger lines), the stock movements and the document links. An accounting voucher has
 * a journal and no stock; a stock voucher (Stock Journal, opening stock) has stock and NO journal; a sales invoice has both, and a link
 * from each line that fills an order line; a document (a Sales Order) has none of the three — it records what was agreed, not what happened.
 */
export interface PostingPlan {
  readonly journal: readonly JournalLine[];
  readonly stock: readonly StockMovement[];
  readonly links: readonly OrderLink[];
}

export function stampPlan(
  voucherId: VoucherId,
  date: LocalDate,
  planned: readonly PlannedLine[],
  plannedStock: readonly PlannedStock[] = [],
  plannedLinks: readonly PlannedLink[] = [],
): PostingPlan {
  return {
    journal: planned.map((line, i) => ({ ...line, voucherId, lineNo: i + 1, date })),
    stock: plannedStock.map((line, i) => ({ ...line, voucherId, lineNo: i + 1, date })),
    links: plannedLinks.map((link) => ({ ...link, voucherId, date })),
  };
}

export function totalsOf(lines: readonly { side: Side; amount: Money }[]): { debit: Money; credit: Money } {
  let debit = ZERO;
  let credit = ZERO;
  for (const l of lines) {
    if (l.side === 'debit') debit = addMoney(debit, l.amount);
    else credit = addMoney(credit, l.amount);
  }
  return { debit, credit };
}

/**
 * Structural invariants every plan must satisfy no matter which voucher kind produced it.
 * Failing here means a posting rule is buggy — the voucher is refused, never posted.
 * (The database repeats the Dr = Cr check in a deferred constraint trigger.)
 */
export function checkPlanInvariants(plan: PostingPlan, opts: { readonly document?: boolean; readonly linkDirection?: 'in' | 'out' } = {}): Issue[] {
  const problems: Issue[] = [];
  const lines = plan.journal;
  const stockOnly = lines.length === 0 && plan.stock.length > 0;
  const document = opts.document === true;

  if (document && (lines.length > 0 || plan.stock.length > 0)) {
    problems.push(issue(IssueCode.PlanInconsistentLines, 'A document posts no journal or stock lines'));
  }
  if (lines.length < 2 && !stockOnly && !document) {
    problems.push(issue(IssueCode.PlanTooFewLines, `A posting needs at least two journal lines, got ${lines.length}`));
  }
  for (const l of lines) {
    if (l.amount <= 0n) {
      problems.push(
        issue(IssueCode.PlanNonPositiveAmount, `Journal line ${l.lineNo} has a non-positive amount`, `journal.${l.lineNo - 1}.amount`),
      );
    }
  }
  for (const l of lines) {
    if (l.amount > MAX_MONEY) {
      problems.push(
        issue(
          IssueCode.AmountTooLarge,
          `Amount ${formatMoney(l.amount)} exceeds the maximum the books can hold (${formatMoney(MAX_MONEY)})`,
          `journal.${l.lineNo - 1}.amount`,
        ),
      );
    }
  }
  const { debit, credit } = totalsOf(lines);
  if (debit !== credit) {
    problems.push(issue(IssueCode.PlanUnbalanced, `Total debit ${debit} ≠ total credit ${credit} (minor units)`));
  }
  const first = lines[0];
  if (first) {
    const consistent = lines.every(
      (l, i) => l.voucherId === first.voucherId && l.date === first.date && l.lineNo === i + 1,
    );
    if (!consistent) {
      problems.push(
        issue(IssueCode.PlanInconsistentLines, 'Journal lines must share one voucher id and date and be numbered 1..n'),
      );
    }
  }
  problems.push(...checkStockInvariants(plan.stock));
  problems.push(...checkLinkInvariants(plan.links, plan.stock, opts.linkDirection ?? 'out'));
  return problems;
}

/** What every order link must be: a positive quantity, on a real line of the same voucher's stock, once. */
function checkLinkInvariants(links: readonly OrderLink[], stock: readonly StockMovement[], direction: 'in' | 'out'): Issue[] {
  const problems: Issue[] = [];
  const seen = new Set<number>();
  links.forEach((l, i) => {
    const path = `links.${i}`;
    if (l.qty <= 0n) problems.push(issue(IssueCode.StockLineInvalid, 'A delivery must be for a quantity above zero', `${path}.qty`));
    if (l.lineNo < 1 || seen.has(l.lineNo)) problems.push(issue(IssueCode.PlanInconsistentLines, 'Each delivery must sit on its own invoice line', path));
    seen.add(l.lineNo);
    const m = stock.find((s) => s.lineNo === l.lineNo);
    if (!m || m.direction !== direction || m.itemId !== l.itemId || m.qty !== l.qty) {
      problems.push(
        issue(IssueCode.PlanInconsistentLines, `A ${direction === 'out' ? 'delivery' : 'receipt'} must match the stock going ${direction} on its invoice line`, path),
      );
    }
  });
  return problems;
}

/** What every stock movement must be, whichever kind produced it (the database repeats these as CHECK constraints). */
function checkStockInvariants(stock: readonly StockMovement[]): Issue[] {
  const problems: Issue[] = [];
  stock.forEach((m, i) => {
    const path = `stock.${i}`;
    if (m.lineNo !== i + 1) problems.push(issue(IssueCode.PlanInconsistentLines, 'Stock lines must be numbered 1..n', path));
    if (m.qty <= 0n) problems.push(issue(IssueCode.StockLineInvalid, 'A stock quantity must be above zero', `${path}.qty`));
    if (m.qty > MAX_QTY) problems.push(issue(IssueCode.AmountTooLarge, 'That quantity is more than the books can hold', `${path}.qty`));
    if (m.direction === 'in' && (m.value === undefined || m.value < 0n)) {
      problems.push(issue(IssueCode.StockLineInvalid, 'Stock coming in needs a value (quantity × rate, zero at the least)', `${path}.value`));
    }
    if (m.direction === 'out' && m.value !== undefined) {
      problems.push(issue(IssueCode.StockLineInvalid, 'Stock going out is valued by the book, not entered', `${path}.value`));
    }
    if (m.value !== undefined && m.value > MAX_MONEY) {
      problems.push(issue(IssueCode.AmountTooLarge, 'That value is more than the books can hold', `${path}.value`));
    }
  });
  return problems;
}
