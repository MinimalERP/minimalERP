import type { ColumnSpec, LocalDate, Masters, OrderBook, OrderSide, Qty } from '@minimalerp/domain';
import { formatDate, formatQuantity } from '../vouchers/format';

/**
 * The Sales (or Purchase) Order Register, as a definition on the one grid: ONE ROW PER ORDER LINE — what was ordered, what has been delivered against it,
 * what is still pending, and the order's status — so a customer's PO can be read line by line and filled or overdue lines found at a glance.
 * It is a pure function of the order book (which is itself read from the posted sales orders and invoices): nothing here is stored, so
 * cancelling an invoice, closing an order or altering a line is simply what the next read shows.
 */

const num = (q: bigint): number => Number(q) / 10_000;

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

/** "12/18": what has been delivered over what was ordered — the way a person reads how far a line is filled. */
export const fillText = (r: Pick<OrderRow, 'delivered' | 'ordered' | 'decimals'>): string => `${formatQuantity(r.delivered, r.decimals)}/${formatQuantity(r.ordered, r.decimals)}`;

/** How far a line is filled, 0–1 (for sorting and range filters). */
export const fillRatio = (r: Pick<OrderRow, 'delivered' | 'ordered'>): number => (r.ordered === 0n ? 0 : Number(r.delivered) / Number(r.ordered));

const q = (r: OrderRow, value: Qty): string => formatQuantity(value, r.decimals);

export function orderRegisterColumns(side: OrderSide = 'sales'): ColumnSpec<OrderRow>[] {
  const purchase = side === 'purchase';
  return [
    { id: 'number', label: 'Order no.', type: 'text', value: (r) => r.number },
    { id: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => formatDate(r.date) },
    { id: 'reference', label: purchase ? 'Supplier ref' : 'Cust PO / ref', type: 'text', value: (r) => r.reference },
    { id: 'party', label: 'Party', type: 'text', value: (r) => r.party },
    { id: 'item', label: 'Item', type: 'text', value: (r) => r.item },
    {
      id: 'due',
      label: 'Due',
      type: 'date',
      value: (r) => r.due,
      text: (r) => (r.overdue ? `${formatDate(r.due)} · overdue` : formatDate(r.due)),
    },
    { id: 'ordered', label: 'Ordered', type: 'number', align: 'right', value: (r) => num(r.ordered), text: (r) => q(r, r.ordered) },
    { id: 'delivered', label: purchase ? 'Received' : 'Delivered', type: 'number', align: 'right', value: (r) => num(r.delivered), text: (r) => q(r, r.delivered) },
    { id: 'pending', label: 'Pending', type: 'number', align: 'right', value: (r) => num(r.pending), text: (r) => (r.pending === 0n ? '' : q(r, r.pending)) },
    { id: 'fill', label: 'Fill', type: 'number', align: 'right', value: (r) => fillRatio(r), text: (r) => fillText(r) },
    {
      id: 'status',
      label: 'Status',
      type: 'choice',
      value: (r) => r.status,
      choices: [
        { value: 'Open', label: 'Open' },
        { value: 'Closed', label: 'Closed' },
      ],
    },
  ];
}

/** The row's look: an open order's still-open line is bold; a fully delivered line is plain; a closed order's lines are muted. */
export const orderRowClass = (r: OrderRow): string => (r.actionable ? 'open-line' : r.status === 'Closed' ? 'closed-order' : '');

/** What the shown rows come to: how many lines, how many still open, how many orders. */
export function registerCounts(rows: readonly OrderRow[]): { lines: number; open: number; overdue: number; orders: number } {
  return {
    lines: rows.length,
    open: rows.filter((r) => r.actionable).length,
    overdue: rows.filter((r) => r.overdue).length,
    orders: new Set(rows.map((r) => r.orderId)).size,
  };
}

/** Newest order first, each order's lines still in the order they were entered (a plain reverse would turn every order upside down). */
export function newestOrdersFirst<R extends { readonly orderId: string }>(rows: readonly R[]): R[] {
  const groups: R[][] = [];
  for (const r of rows) {
    const last = groups.at(-1);
    if (last && last[0]?.orderId === r.orderId) last.push(r);
    else groups.push([r]);
  }
  return groups.reverse().flat();
}
