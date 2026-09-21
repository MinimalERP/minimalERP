import type { LocalDate } from '../dates';
import type { PartyId, StockItemId, VoucherId } from '../ids';
import { type Qty, type Rate, ZERO_QTY, parseQty, parseRate, qty } from '../stock/quantity';
import type { Masters } from '../masters/masters';
import type { Voucher } from '../vouchers/voucher';

/**
 * THE ORDER BOOK — what has been ordered and what has been delivered against it (ADR-0015). Like the stock book it is DERIVED at read
 * time from posted vouchers and stores nothing of its own: a sales order says what was ordered, each posted sales invoice line that names
 * an order line is a delivery against it, and everything else — pending, filled, open, closed — is arithmetic over those. A cancelled
 * voucher is simply not in the book, so cancelling an invoice reopens the quantity it had filled.
 */

/** One line of a sales order. Its `id` is stable across alterations, so a delivery keeps pointing at the same line. */
export interface OrderLineDoc {
  readonly id: string;
  readonly itemId: StockItemId;
  readonly qty: Qty;
  readonly rate: Rate;
  readonly dueDate: LocalDate;
}

/** Whose order it is: a customer's (we deliver) or our own to a supplier (we receive). */
export type OrderSide = 'sales' | 'purchase';

export interface OrderDoc {
  readonly voucherId: VoucherId;
  readonly side: OrderSide;
  readonly number: string;
  readonly date: LocalDate;
  readonly partyId: PartyId;
  /** The customer's own reference (their PO number). */
  readonly reference?: string | undefined;
  /** Closed by hand: nothing more may be delivered against it. */
  readonly closed: boolean;
  readonly lines: readonly OrderLineDoc[];
}

/** A delivery: one line of a sales invoice filling (part of) one line of a sales order. */
export interface OrderLink {
  /** The sales invoice. */
  readonly voucherId: VoucherId;
  /** The invoice line (1-based; the same number as its stock movement). */
  readonly lineNo: number;
  /** The invoice's date. */
  readonly date: LocalDate;
  readonly orderId: VoucherId;
  readonly orderLineId: string;
  readonly itemId: StockItemId;
  readonly qty: Qty;
}

/** What an invoice line says about the order line it fills, before the engine stamps the voucher's id and date on it. */
export type PlannedLink = Omit<OrderLink, 'voucherId' | 'date'>;

export interface OrderLineStatus {
  readonly line: OrderLineDoc;
  readonly ordered: Qty;
  readonly delivered: Qty;
  readonly pending: Qty;
  /** Nothing left to deliver on this line. */
  readonly filled: boolean;
}

export type OrderStatus = 'open' | 'closed';

export interface OrderState {
  readonly order: OrderDoc;
  /** Open while any line has something pending and the order is not closed by hand. */
  readonly status: OrderStatus;
  /** Why a closed order is closed: every line delivered, or someone closed it. */
  readonly reason?: 'fulfilled' | 'manual' | undefined;
  readonly lines: readonly OrderLineStatus[];
}

export interface OrderChange {
  /** Invoices whose deliveries leave the book (an invoice being altered or cancelled frees what it had filled). */
  readonly removeLinksOf?: readonly VoucherId[] | undefined;
  /** Orders whose documents leave the book. */
  readonly removeOrders?: readonly VoucherId[] | undefined;
  readonly addOrders?: readonly OrderDoc[] | undefined;
  readonly addLinks?: readonly OrderLink[] | undefined;
}

const keyOf = (orderId: string, lineId: string): string => `${orderId}|${lineId}`;

export class OrderBook {
  private readonly byId: ReadonlyMap<VoucherId, OrderDoc>;
  private readonly delivered: ReadonlyMap<string, bigint>;
  private readonly byOrder: ReadonlyMap<VoucherId, readonly OrderLink[]>;

  constructor(
    readonly orders: readonly OrderDoc[] = [],
    readonly links: readonly OrderLink[] = [],
  ) {
    this.byId = new Map(orders.map((o) => [o.voucherId, o]));
    const totals = new Map<string, bigint>();
    const grouped = new Map<VoucherId, OrderLink[]>();
    for (const l of links) {
      const k = keyOf(l.orderId, l.orderLineId);
      totals.set(k, (totals.get(k) ?? 0n) + l.qty);
      const list = grouped.get(l.orderId);
      if (list) list.push(l);
      else grouped.set(l.orderId, [l]);
    }
    this.delivered = totals;
    this.byOrder = grouped;
  }

  static readonly empty = new OrderBook();

  /** A new book with some vouchers taken out and others added. This book is untouched. */
  withChange(change: OrderChange): OrderBook {
    const goneOrders = new Set(change.removeOrders ?? []);
    const goneLinks = new Set(change.removeLinksOf ?? []);
    const orders = goneOrders.size === 0 ? this.orders : this.orders.filter((o) => !goneOrders.has(o.voucherId));
    const links = goneLinks.size === 0 ? this.links : this.links.filter((l) => !goneLinks.has(l.voucherId));
    return new OrderBook([...orders, ...(change.addOrders ?? [])], [...links, ...(change.addLinks ?? [])]);
  }

  order(id: VoucherId): OrderDoc | undefined {
    return this.byId.get(id);
  }

  /** Every delivery against an order, whichever line it fills — also for an order that is not (or no longer) in this book. */
  linksTo(orderId: VoucherId): readonly OrderLink[] {
    return this.byOrder.get(orderId) ?? [];
  }

  /** How much of one order line has been delivered. */
  deliveredOn(orderId: VoucherId, lineId: string): Qty {
    return qty(this.delivered.get(keyOf(orderId, lineId)) ?? 0n);
  }

  /** The order's lines with what is ordered, delivered and pending on each, and whether the order as a whole is open. */
  state(orderId: VoucherId): OrderState | undefined {
    const order = this.byId.get(orderId);
    if (!order) return undefined;
    const lines = order.lines.map((line): OrderLineStatus => {
      const delivered = this.deliveredOn(orderId, line.id);
      const pending = line.qty > delivered ? qty(line.qty - delivered) : ZERO_QTY;
      return { line, ordered: line.qty, delivered, pending, filled: pending === 0n };
    });
    const fulfilled = lines.length > 0 && lines.every((l) => l.filled);
    const status: OrderStatus = order.closed || fulfilled ? 'closed' : 'open';
    return { order, status, reason: status === 'open' ? undefined : order.closed ? 'manual' : 'fulfilled', lines };
  }

  /**
   * What is COMMITTED per item: the quantity still pending on the lines of every OPEN order (one closed by hand, or delivered in full, commits
   * nothing). Stock that is spoken for but has not left yet.
   */
  committedByItem(): ReadonlyMap<StockItemId, Qty> {
    return this.pendingByItem('sales');
  }

  /** What is ON ORDER per item: the quantity still to come on the lines of every OPEN purchase order. */
  onOrderByItem(): ReadonlyMap<StockItemId, Qty> {
    return this.pendingByItem('purchase');
  }

  private pendingByItem(side: OrderSide): ReadonlyMap<StockItemId, Qty> {
    const totals = new Map<StockItemId, bigint>();
    for (const s of this.all()) {
      if (s.status !== 'open' || s.order.side !== side) continue;
      for (const l of s.lines) if (l.pending > 0n) totals.set(l.line.itemId, (totals.get(l.line.itemId) ?? 0n) + l.pending);
    }
    return new Map([...totals].map(([id, q]) => [id, qty(q)]));
  }

  /** Every order, oldest first (date, then id) — a total order, so the answer never depends on how the book was assembled. */
  all(): readonly OrderState[] {
    return [...this.orders]
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.voucherId < b.voucherId ? -1 : a.voucherId > b.voucherId ? 1 : 0))
      .map((o) => this.state(o.voucherId) as OrderState);
  }
}

// ---- reading the book out of posted vouchers --------------------------------------------------------------------------

interface OrderContent {
  partyId?: string;
  reference?: string;
  closed?: boolean;
  lines?: { id?: string; itemId?: string; qty?: string; rate?: string; dueDate?: string; orderRef?: { orderId?: string; lineId?: string } }[];
}

/** A posted sales or purchase order as the book sees it (or undefined if what is stored is not one). */
export function orderDocOf(voucher: Voucher, side: OrderSide = 'sales'): OrderDoc | undefined {
  const c = voucher.content as unknown as OrderContent;
  if (typeof c.partyId !== 'string' || !Array.isArray(c.lines)) return undefined;
  const lines: OrderLineDoc[] = [];
  for (const l of c.lines) {
    const q = typeof l.qty === 'string' ? parseQty(l.qty) : undefined;
    const r = typeof l.rate === 'string' ? parseRate(l.rate) : undefined;
    if (typeof l.id !== 'string' || typeof l.itemId !== 'string' || q === undefined || r === undefined || typeof l.dueDate !== 'string') return undefined;
    lines.push({ id: l.id, itemId: l.itemId as StockItemId, qty: q, rate: r, dueDate: l.dueDate as LocalDate });
  }
  return {
    voucherId: voucher.id,
    side,
    number: voucher.number,
    date: voucher.date,
    partyId: c.partyId as PartyId,
    reference: c.reference === undefined || c.reference === '' ? undefined : c.reference,
    closed: c.closed === true,
    lines,
  };
}

/** The deliveries a posted sales invoice (or receipts a purchase invoice) makes: one per line that names an order line. */
export function orderLinksOf(voucher: Voucher): OrderLink[] {
  const c = voucher.content as unknown as OrderContent;
  const out: OrderLink[] = [];
  (c.lines ?? []).forEach((l, i) => {
    const q = typeof l.qty === 'string' ? parseQty(l.qty) : undefined;
    if (!l.orderRef || typeof l.orderRef.orderId !== 'string' || typeof l.orderRef.lineId !== 'string') return;
    if (typeof l.itemId !== 'string' || q === undefined) return;
    out.push({
      voucherId: voucher.id,
      lineNo: i + 1,
      date: voucher.date,
      orderId: l.orderRef.orderId as VoucherId,
      orderLineId: l.orderRef.lineId,
      itemId: l.itemId as StockItemId,
      qty: q,
    });
  });
  return out;
}

/** The company's order book, read out of its vouchers: posted sales and purchase orders and the deliveries / receipts of posted invoices. */
export function orderBookOf(vouchers: readonly Voucher[], masters: Masters): OrderBook {
  const orders: OrderDoc[] = [];
  const links: OrderLink[] = [];
  for (const v of vouchers) {
    if (v.status !== 'posted') continue;
    const kind = masters.voucherType(v.voucherTypeId)?.baseKind;
    if (kind === 'salesOrder' || kind === 'purchaseOrder') {
      const doc = orderDocOf(v, kind === 'salesOrder' ? 'sales' : 'purchase');
      if (doc) orders.push(doc);
    } else if (kind === 'sales' || kind === 'purchase') {
      links.push(...orderLinksOf(v));
    }
  }
  return new OrderBook(orders, links);
}
