import type { ColumnSpec, OrderRow, OrderSide, Qty } from '@minimalerp/domain';
import { formatDate, formatQuantity } from '../vouchers/format';

export { type OrderRegisterOptions, type OrderRow, orderRegisterRows } from '@minimalerp/domain';

/**
 * The Sales (or Purchase) Order Register, as a definition on the one grid: ONE ROW PER ORDER LINE — what was ordered, what has been delivered against it,
 * what is still pending, and the order's status — so a customer's PO can be read line by line and filled or overdue lines found at a glance.
 * It is a pure function of the order book (which is itself read from the posted sales orders and invoices): nothing here is stored, so
 * cancelling an invoice, closing an order or altering a line is simply what the next read shows.
 */

const num = (q: bigint): number => Number(q) / 10_000;

/** "12/18": what has been delivered over what was ordered — the way a person reads how far a line is filled. */
export const fillText = (r: Pick<OrderRow, 'delivered' | 'ordered' | 'decimals'>): string => `${formatQuantity(r.delivered, r.decimals)}/${formatQuantity(r.ordered, r.decimals)}`;

/** How far a line is filled, 0–1 (for sorting and range filters). */
export const fillRatio = (r: Pick<OrderRow, 'delivered' | 'ordered'>): number => (r.ordered === 0n ? 0 : Number(r.delivered) / Number(r.ordered));

const q = (r: OrderRow, value: Qty): string => formatQuantity(value, r.decimals);

/** What open sales orders are waiting for of an item, and what there is of it: the two figures the register's Stock column sets side by side. */
export interface ItemCover {
  /** Pending on every open sales order (all of them, whatever the register is narrowed to). */
  readonly committed: Qty;
  /** In stock now, in every godown. */
  readonly stock: Qty;
}

/** "3/80": three committed against orders, eighty in stock — read like Fill. */
export const coverText = (c: ItemCover, decimals: number): string => `${formatQuantity(c.committed, decimals)}/${formatQuantity(c.stock, decimals)}`;

/** More is committed than there is: some order for this item cannot be met from stock. */
export const isShort = (c: ItemCover): boolean => c.committed > c.stock;

/**
 * The register's columns. What was ordered and delivered is read from Fill ("2/21"), so only what is pending has a column of its own.
 * With `coverOf` (the sales register) a Stock column says committed / in stock for the line's item — empty where the line has no stock
 * item (a service, a written line).
 */
export function orderRegisterColumns(side: OrderSide = 'sales', coverOf?: (itemId: string) => ItemCover | undefined): ColumnSpec<OrderRow>[] {
  const purchase = side === 'purchase';
  const cover = (r: OrderRow): ItemCover | undefined => (r.itemId === '' ? undefined : coverOf?.(r.itemId));
  const stock: ColumnSpec<OrderRow>[] = coverOf
    ? [
        {
          id: 'stock',
          label: 'Stock',
          type: 'number',
          align: 'right',
          // sorts and ranges by what is free (in stock less committed): the worst shortage first
          value: (r) => {
            const c = cover(r);
            return c ? num(c.stock - c.committed) : null;
          },
          text: (r) => {
            const c = cover(r);
            return c ? coverText(c, r.decimals) : '';
          },
          cellClass: (r) => {
            const c = cover(r);
            return c && isShort(c) ? 'short' : '';
          },
        },
      ]
    : [];
  return [
    { id: 'number', label: 'Order no.', type: 'text', value: (r) => r.number },
    { id: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => formatDate(r.date) },
    { id: 'reference', label: purchase ? 'Supplier ref' : 'Cust PO / ref', type: 'text', value: (r) => r.reference },
    { id: 'party', label: 'Party', type: 'text', narrow: 12, value: (r) => r.party },
    { id: 'item', label: 'Item', type: 'text', narrow: 32, value: (r) => r.item },
    { id: 'fill', label: 'Fill', type: 'number', align: 'right', value: (r) => fillRatio(r), text: (r) => fillText(r) },
    {
      id: 'due',
      label: 'Due',
      type: 'date',
      value: (r) => r.due,
      text: (r) => (r.overdue ? `${formatDate(r.due)} · overdue` : formatDate(r.due)),
    },
    { id: 'pending', label: 'Pending', type: 'number', align: 'right', value: (r) => num(r.pending), text: (r) => (r.pending === 0n ? '' : q(r, r.pending)) },
    ...stock,
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

/** What the shown rows come to: how many lines, how many still open, how many orders — and what the open lines are worth at the orders' rates. */
export function registerCounts(rows: readonly OrderRow[]): { lines: number; open: number; overdue: number; orders: number; pendingValue: bigint } {
  return {
    lines: rows.length,
    open: rows.filter((r) => r.actionable).length,
    overdue: rows.filter((r) => r.overdue).length,
    orders: new Set(rows.map((r) => r.orderId)).size,
    pendingValue: rows.reduce((s, r) => s + r.pendingValue, 0n),
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
