import type { LocalDate } from '../dates';
import type { Masters } from '../masters/masters';
import type { OrderBook, OrderSide } from '../orders/orderBook';
import type { Qty } from '../stock/quantity';

/**
 * The Sales (or Purchase) Order Register's rows: ONE ROW PER ORDER LINE — what was ordered, what has been delivered against it, what is
 * still pending, and the order's status. A pure function of the order book (itself read from the posted orders and invoices): nothing is
 * stored. Shared by the register on screen and the assistant's look-ups.
 */

export interface OrderRow {
  /** Unique per order line. */
  readonly key: string;
  readonly orderId: string;
  readonly lineId: string;
  readonly number: string;
  readonly date: LocalDate;
  /** The customer's own reference (their PO number). */
  readonly reference: string;
  readonly party: string;
  readonly itemId: string;
  readonly item: string;
  readonly unit: string;
  readonly decimals: number;
  readonly due: LocalDate;
  readonly ordered: Qty;
  readonly delivered: Qty;
  readonly pending: Qty;
  /** This line has nothing left to deliver. */
  readonly filled: boolean;
  readonly status: 'Open' | 'Closed';
  /** Open and past its due date with something still pending. */
  readonly overdue: boolean;
  /** The order is open AND this line still has something to deliver: the rows to act on. */
  readonly actionable: boolean;
}

export interface OrderRegisterOptions {
  /** Only this item's lines (the item's page: "all sales orders having this item"). */
  readonly itemId?: string | undefined;
  /** Whose orders: the customers' (default) or our own to suppliers. */
  readonly side?: OrderSide | undefined;
  /** Today, for what is overdue. */
  readonly asOf: LocalDate;
}

/** One row per line of every order dated in the period, oldest order first, its lines in the order they were entered. */
export function orderRegisterRows(orders: OrderBook, masters: Masters, from: LocalDate, to: LocalDate, options: OrderRegisterOptions): OrderRow[] {
  const rows: OrderRow[] = [];
  for (const state of orders.all()) {
    const o = state.order;
    if (o.side !== (options.side ?? 'sales') || o.date < from || o.date > to) continue;
    const party = masters.party(o.partyId)?.name ?? '';
    for (const l of state.lines) {
      if (options.itemId !== undefined && l.line.itemId !== options.itemId) continue;
      const item = masters.stockItem(l.line.itemId);
      const unit = item ? masters.unit(item.unitId) : undefined;
      const open = state.status === 'open';
      rows.push({
        key: `${o.voucherId}|${l.line.id}`,
        orderId: o.voucherId,
        lineId: l.line.id,
        number: o.number,
        date: o.date,
        reference: o.reference ?? '',
        party,
        itemId: l.line.itemId,
        item: item?.name ?? '',
        unit: unit?.symbol ?? '',
        decimals: unit?.decimals ?? 0,
        due: l.line.dueDate,
        ordered: l.ordered,
        delivered: l.delivered,
        pending: l.pending,
        filled: l.filled,
        status: open ? 'Open' : 'Closed',
        overdue: open && !l.filled && l.line.dueDate < options.asOf,
        actionable: open && !l.filled,
      });
    }
  }
  return rows;
}

