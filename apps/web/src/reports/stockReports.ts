import {
  type ColumnSpec,
  type LocalDate,
  type Masters,
  type Position,
  type Qty,
  type StockBook,
  type StockItemId,
  type Voucher,
  type VoucherTypeId,
  OrderBook,
  formatRate,
  rateOf,
} from '@minimalerp/domain';
import { formatAmount, formatDate, formatQuantity } from '../vouchers/format';
import type { TypeChoice } from './definitions';

/**
 * The stock reports, as definitions on the one grid: Stock Summary (one row per item for the period) and the Item ledger (every movement of
 * one item with its running quantity and value). They are pure functions of the stock book — nothing here is stored — so an alteration, a
 * cancellation or a back-dated entry is simply what the next read shows.
 */

const num = (q: bigint): number => Number(q) / 10_000;
const money = (m: bigint): string => (m === 0n ? '' : formatAmount(m));

// ---- Stock Summary -----------------------------------------------------------------------------------------------

export interface StockSummaryRow {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly decimals: number;
  readonly group: string;
  readonly opening: Position;
  readonly inward: Position;
  readonly outward: Position;
  readonly closing: Position;
  /** Pending on every open sales order — spoken for, not yet gone (as of now, whatever the period). */
  readonly committed: Qty;
  /** Still to come on every open purchase order (as of now, whatever the period). */
  readonly onOrder: Qty;
}

/**
 * One row per item that has stock or movements in the period — or that open sales orders are waiting on — named by the stock-item master.
 * `committed` is the quantity still pending on all open sales orders; `available` (a column) is the closing quantity less that.
 */
export function stockSummaryRows(masters: Masters, book: StockBook, from: LocalDate, to: LocalDate, orders: OrderBook = OrderBook.empty): StockSummaryRow[] {
  const rows: StockSummaryRow[] = [];
  const committed = orders.committedByItem();
  const onOrder = orders.onOrderByItem();
  const seen = new Set<string>();
  const none: Position = { qty: 0n as Qty, value: 0n as never };
  const summary = [
    ...book.summary(from, to),
    // an item ordered but never stocked still shows: it is committed with nothing to meet it
    ...[...committed.keys(), ...onOrder.keys()].filter((id) => book.summary(from, to).every((r) => r.itemId !== id)).map((itemId) => ({ itemId, opening: none, inward: none, outward: none, closing: none })),
  ];
  for (const r of summary) {
    if (seen.has(r.itemId)) continue;
    seen.add(r.itemId);
    const item = masters.stockItem(r.itemId);
    if (!item) continue;
    const unit = masters.unit(item.unitId);
    rows.push({
      itemId: item.id,
      name: item.name,
      unit: unit?.symbol ?? '',
      decimals: unit?.decimals ?? 0,
      group: item.groupId ? (masters.stockGroup(item.groupId)?.name ?? '') : '',
      opening: r.opening,
      inward: r.inward,
      outward: r.outward,
      closing: r.closing,
      committed: committed.get(r.itemId) ?? (0n as Qty),
      onOrder: onOrder.get(r.itemId) ?? (0n as Qty),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** What is free to promise: the closing quantity less what open sales orders are waiting for (negative when they want more than there is). */
export const availableOf = (r: Pick<StockSummaryRow, 'closing' | 'committed'>): bigint => r.closing.qty - r.committed;

const q = (r: StockSummaryRow, p: Position): string => (p.qty === 0n ? '' : formatQuantity(p.qty, r.decimals));

export function stockSummaryColumns(): ColumnSpec<StockSummaryRow>[] {
  return [
    { id: 'name', label: 'Particulars', type: 'text', value: (r) => r.name },
    { id: 'group', label: 'Group', type: 'text', value: (r) => r.group },
    { id: 'unit', label: 'Unit', type: 'text', value: (r) => r.unit },
    { id: 'openQty', label: 'Opening qty', type: 'number', align: 'right', value: (r) => num(r.opening.qty), text: (r) => q(r, r.opening) },
    { id: 'inQty', label: 'Inward qty', type: 'number', align: 'right', value: (r) => num(r.inward.qty), text: (r) => q(r, r.inward) },
    { id: 'outQty', label: 'Outward qty', type: 'number', align: 'right', value: (r) => num(r.outward.qty), text: (r) => q(r, r.outward) },
    { id: 'closeQty', label: 'Closing qty', type: 'number', align: 'right', value: (r) => num(r.closing.qty), text: (r) => q(r, r.closing) },
    {
      id: 'closeRate',
      label: 'Rate',
      type: 'number',
      align: 'right',
      value: (r) => {
        const rate = rateOf(r.closing.value, r.closing.qty);
        return rate === undefined ? null : Number(rate) / 10_000;
      },
      text: (r) => {
        const rate = rateOf(r.closing.value, r.closing.qty);
        return rate === undefined ? '' : formatRate(rate);
      },
    },
    { id: 'closeValue', label: 'Closing value', type: 'money', align: 'right', value: (r) => r.closing.value, text: (r) => money(r.closing.value) },
    { id: 'onOrder', label: 'On order', type: 'number', align: 'right', value: (r) => num(r.onOrder), text: (r) => (r.onOrder === 0n ? '' : formatQuantity(r.onOrder as never, r.decimals)) },
    { id: 'committed', label: 'Committed', type: 'number', align: 'right', value: (r) => num(r.committed), text: (r) => q(r, { qty: r.committed, value: 0n as never }) },
    { id: 'available', label: 'Available', type: 'number', align: 'right', value: (r) => num(availableOf(r)), text: (r) => (r.closing.qty === 0n && r.committed === 0n ? '' : formatQuantity(availableOf(r) as never, r.decimals)) },
  ];
}

/** What the shown rows add up to: the value of the stock they hold, and how much of it came and went. */
export function summaryTotals(rows: readonly StockSummaryRow[]): { opening: bigint; inward: bigint; outward: bigint; closing: bigint } {
  let opening = 0n;
  let inward = 0n;
  let outward = 0n;
  let closing = 0n;
  for (const r of rows) {
    opening += r.opening.value;
    inward += r.inward.value;
    outward += r.outward.value;
    closing += r.closing.value;
  }
  return { opening, inward, outward, closing };
}

// ---- Item ledger -------------------------------------------------------------------------------------------------

export interface StockLedgerRow {
  /** Unique per movement (a voucher may move one item twice). */
  readonly key: string;
  readonly voucherId: string;
  readonly voucherTypeId: VoucherTypeId;
  readonly date: string;
  readonly number: string;
  readonly voucherType: string;
  readonly particulars: string;
  readonly decimals: number;
  readonly inQty: bigint;
  readonly inValue: bigint;
  readonly outQty: bigint;
  readonly outValue: bigint;
  readonly balance: Position;
  readonly status: 'posted' | 'cancelled';
  /** A sales order line (a document: it moves no stock) rather than a movement. */
  readonly isOrder?: boolean;
  /** Orders: delivered / ordered, and whether the order is open. */
  readonly fill?: string;
  readonly fillRatio?: number;
  readonly orderStatus?: 'Open' | 'Closed';
  /** The order is open and this line still has something to deliver. */
  readonly actionable?: boolean;
}

export interface StockLedger {
  readonly opening: Position;
  readonly closing: Position;
  readonly rows: readonly StockLedgerRow[];
  /** The item's stock now (all godowns, everything posted), what open sales orders have pending on it, and what is left to promise. */
  readonly current: Position;
  readonly committed: Qty;
  /** Still to come on open purchase orders. */
  readonly onOrder: Qty;
  readonly available: bigint;
}

/** The movements of one item in the period, oldest first, each with the item's TRUE running position after it. */
export function stockLedgerOf(
  masters: Masters,
  book: StockBook,
  vouchers: readonly Voucher[],
  itemId: StockItemId,
  from: LocalDate,
  to: LocalDate,
  orders: OrderBook = OrderBook.empty,
): StockLedger {
  const item = masters.stockItem(itemId);
  const decimals = (item ? masters.unit(item.unitId)?.decimals : 0) ?? 0;
  const byId = new Map(vouchers.map((v) => [v.id as string, v]));
  const ledger = book.ledger(itemId, from, to);
  const rows = ledger.rows.map((r): StockLedgerRow => {
    const v = byId.get(r.movement.voucherId);
    const godown = masters.warehouse(r.movement.warehouseId)?.name ?? '';
    const narration = (v?.content as { narration?: string } | undefined)?.narration;
    const inn = r.movement.direction === 'in';
    return {
      key: `${r.movement.voucherId}:${r.movement.lineNo}`,
      voucherId: r.movement.voucherId,
      voucherTypeId: (v?.voucherTypeId ?? '') as VoucherTypeId,
      date: r.movement.date,
      number: v?.number ?? '',
      voucherType: masters.voucherType(v?.voucherTypeId as never)?.name ?? '',
      particulars: narration ? `${godown} — ${narration}` : godown,
      decimals,
      inQty: inn ? r.movement.qty : 0n,
      inValue: inn ? r.value : 0n,
      outQty: inn ? 0n : r.movement.qty,
      outValue: inn ? 0n : r.value,
      balance: r.balance,
      status: v?.status ?? 'posted',
    };
  });
  // The orders (sales and purchase) that have this item: documents, so they move nothing — each line shows how far it is filled, and where it falls in time.
  const orderRows: StockLedgerRow[] = [];
  for (const state of orders.all()) {
    const o = state.order;
    if (o.date < from || o.date > to) continue;
    for (const l of state.lines) {
      if (l.line.itemId !== itemId) continue;
      orderRows.push({
        key: `order:${o.voucherId}|${l.line.id}`,
        voucherId: o.voucherId,
        voucherTypeId: (byId.get(o.voucherId)?.voucherTypeId ?? '') as VoucherTypeId,
        date: o.date,
        number: o.number,
        voucherType: masters.voucherType(byId.get(o.voucherId)?.voucherTypeId as never)?.name ?? 'Sales Order',
        particulars: [masters.party(o.partyId)?.name ?? '', o.reference].filter(Boolean).join(' · '),
        decimals,
        inQty: 0n,
        inValue: 0n,
        outQty: 0n,
        outValue: 0n,
        balance: { qty: 0n as Qty, value: 0n as never },
        status: 'posted',
        isOrder: true,
        fill: `${formatQuantity(l.delivered, decimals)}/${formatQuantity(l.ordered, decimals)}`,
        fillRatio: l.ordered === 0n ? 0 : Number(l.delivered) / Number(l.ordered),
        orderStatus: state.status === 'open' ? 'Open' : 'Closed',
        actionable: state.status === 'open' && !l.filled,
      });
    }
  }
  const all = [...rows, ...orderRows].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.isOrder === b.isOrder ? 0 : a.isOrder ? 1 : -1));
  const current = book.positionAt(itemId, '9999-12-31' as LocalDate);
  const committed = orders.committedByItem().get(itemId) ?? (0n as Qty);
  const onOrder = orders.onOrderByItem().get(itemId) ?? (0n as Qty);
  return { opening: ledger.opening, closing: ledger.closing, rows: all, current, committed, onOrder, available: current.qty - committed };
}

const qty = (r: StockLedgerRow, v: bigint): string => (v === 0n ? '' : formatQuantity(v as never, r.decimals));

export function stockLedgerColumns(types: readonly TypeChoice[]): ColumnSpec<StockLedgerRow>[] {
  return [
    { id: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => formatDate(r.date) },
    { id: 'particulars', label: 'Particulars (godown)', type: 'text', value: (r) => r.particulars },
    { id: 'type', label: 'Type', type: 'choice', value: (r) => r.voucherType, choices: types },
    { id: 'number', label: 'Voucher no.', type: 'text', value: (r) => r.number },
    { id: 'inQty', label: 'Inward qty', type: 'number', align: 'right', value: (r) => num(r.inQty), text: (r) => qty(r, r.inQty) },
    { id: 'inValue', label: 'Inward value', type: 'money', align: 'right', value: (r) => r.inValue, text: (r) => money(r.inValue) },
    { id: 'outQty', label: 'Outward qty', type: 'number', align: 'right', value: (r) => num(r.outQty), text: (r) => qty(r, r.outQty) },
    { id: 'outValue', label: 'Outward value', type: 'money', align: 'right', value: (r) => r.outValue, text: (r) => money(r.outValue) },
    { id: 'balanceQty', label: 'Balance qty', type: 'number', align: 'right', value: (r) => (r.isOrder ? null : num(r.balance.qty)), text: (r) => (r.isOrder ? '' : formatQuantity(r.balance.qty, r.decimals)) },
    { id: 'balanceValue', label: 'Balance value', type: 'money', align: 'right', value: (r) => (r.isOrder ? 0n : r.balance.value), text: (r) => (r.isOrder ? '' : formatAmount(r.balance.value)) },
    // sales orders only: how far the line is filled (delivered / ordered) and whether its order is open
    { id: 'fill', label: 'Fill', type: 'number', align: 'right', value: (r) => r.fillRatio ?? null, text: (r) => r.fill ?? '' },
    { id: 'orderStatus', label: 'Order status', type: 'choice', value: (r) => r.orderStatus ?? '', choices: [{ value: 'Open', label: 'Open' }, { value: 'Closed', label: 'Closed' }] },
  ];
}
