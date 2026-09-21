import { isPeriodLocked } from '../dates';
import { type Result, IssueCode, fail, ok, issue } from '../errors';
import type { Masters } from '../masters/masters';
import { OrderBook } from '../orders/orderBook';
import { StockBook } from '../stock/book';
import { formatQty } from '../stock/quantity';
import type { Voucher } from '../vouchers/voucher';
import type { VoucherKindRegistry } from '../vouchers/registry';
import { type PreparedVoucher, prepareVoucher } from './engine';

/** Preconditions shared by alter and cancel: still posted, not stale, and its period is open. */
function checkMutable(existing: Voucher, expectedVersion: number, masters: Masters): Result<void> {
  if (existing.status !== 'posted') {
    return fail(issue(IssueCode.VoucherNotPosted, `Voucher ${existing.number} is ${existing.status}`));
  }
  if (existing.version !== expectedVersion) {
    return fail(
      issue(
        IssueCode.VersionConflict,
        `Voucher ${existing.number} was changed by someone else (version ${existing.version}, you had ${expectedVersion})`,
      ),
    );
  }
  const fy = masters.financialYear(existing.financialYearId);
  if (fy && isPeriodLocked(fy, existing.date)) {
    return fail(issue(IssueCode.PeriodLocked, `Books are locked through ${fy.lockedThrough}`, 'date'));
  }
  return ok(undefined);
}

export interface AlterArgs {
  readonly existing: Voucher;
  readonly input: unknown;
  readonly expectedVersion: number;
  readonly masters: Masters;
  readonly registry: VoucherKindRegistry;
  /** The company's stock as it stands INCLUDING this voucher's own movements; they are taken out before the new ones are checked. */
  readonly stock?: StockBook | undefined;
  /** The company's orders and deliveries as they stand INCLUDING this voucher's own deliveries (an invoice's); those are taken out before the new ones are checked. */
  readonly orders?: OrderBook | undefined;
}

/**
 * Validates an alteration of a posted voucher and produces its replacement plan.
 * An alteration keeps the voucher's id, type, number and financial year; everything else may change.
 */
export function prepareAlteration(args: AlterArgs): Result<PreparedVoucher> {
  const { existing, input, expectedVersion, masters, registry, stock = StockBook.empty, orders = OrderBook.empty } = args;

  const mutable = checkMutable(existing, expectedVersion, masters);
  if (!mutable.ok) return mutable;

  const prepared = prepareVoucher(input, masters, registry, stock.withChange({ remove: [existing.id] }), orders.withChange({ removeLinksOf: [existing.id] }));
  if (!prepared.ok) return prepared;

  const { draft, financialYear } = prepared.value;
  if (draft.id !== existing.id) {
    return fail(issue(IssueCode.VoucherIdMismatch, 'The altered draft must carry the same voucher id', 'id'));
  }
  if (draft.voucherTypeId !== existing.voucherTypeId) {
    return fail(issue(IssueCode.VoucherTypeChanged, 'A posted voucher cannot change its voucher type', 'voucherTypeId'));
  }
  if (financialYear.id !== existing.financialYearId) {
    return fail(issue(IssueCode.FinancialYearChanged, 'An alteration cannot move a voucher into another financial year', 'date'));
  }
  return prepared;
}

/** Validates cancelling a posted voucher. Cancelling keeps the number and removes the voucher from the books. */
export function prepareCancellation(
  existing: Voucher,
  expectedVersion: number,
  masters: Masters,
  stock: StockBook = StockBook.empty,
  orders: OrderBook = OrderBook.empty,
): Result<void> {
  const mutable = checkMutable(existing, expectedVersion, masters);
  if (!mutable.ok) return mutable;
  // A sales order that something has been delivered against cannot go: the invoices would point at nothing. (Cancelling an invoice
  // is always fine — it only frees the quantity it had filled.)
  if (orders.linksTo(existing.id).length > 0) {
    return fail(
      issue(IssueCode.OrderHasDeliveries, `${existing.number} has goods delivered against it: cancel those invoices first`),
    );
  }
  // Taking a voucher's stock out of the books must not leave a later day short (cancelling a receipt that later issues depend on).
  const touched = [...new Set(stock.movements.filter((m) => m.voucherId === existing.id).map((m) => m.itemId))];
  if (touched.length > 0) {
    const short = stock.withChange({ remove: [existing.id] }).shortfalls(touched)[0];
    if (short) {
      return fail(
        issue(
          IssueCode.StockNegative,
          `Cancelling ${existing.number} would leave stock ${formatQty(short.short)} short on ${short.date}: later entries depend on it`,
        ),
      );
    }
  }
  return ok(undefined);
}
