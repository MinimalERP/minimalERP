import type { LocalDate } from '../dates';
import type { StockItemId, VoucherId, WarehouseId } from '../ids';
import { type Money, ZERO, money } from '../money';
import type { StockMovement } from './movement';
import { type Qty, ZERO_QTY, qty } from './quantity';

/**
 * THE STOCK BOOK — the valuation module of ADR-0014. It holds a company's stock movements and answers every question about stock by
 * READING them in order; nothing it says is stored, so a back-dated entry, an alteration or a cancellation just changes what the next
 * question returns.
 *
 * Valuation is a MOVING WEIGHTED AVERAGE per item (across godowns, as Tally values an item): each In adds its quantity and value to the
 * running pair; an Out of q takes round(value × q / quantity) off the value — an exact fraction of the running value, so there is no rate
 * rounding to drift, and for every item and period
 *
 *     closing value = opening value + value in − value out       (exactly, to the paisa)
 *
 * Order of processing: date; then Ins before Outs within a day (so a same-day receipt can be issued the same day); then voucher id;
 * then line number. The order is total and deterministic, so the result never depends on the order the movements were entered.
 */

export interface Position {
  readonly qty: Qty;
  readonly value: Money;
}

const NOTHING: Position = { qty: ZERO_QTY, value: ZERO };

/** One processed movement: its value (an Out's is derived) and the item's position right after it. */
export interface StockStep {
  readonly movement: StockMovement;
  /** What this movement is worth: an In's entered value; an Out's share of the running value. */
  readonly value: Money;
  /** The item's position across all godowns after this movement. */
  readonly after: Position;
  /** The quantity in THIS movement's godown after it. */
  readonly warehouseQty: bigint;
}

export interface Shortfall {
  readonly itemId: StockItemId;
  readonly warehouseId: WarehouseId;
  /** The day the godown first goes below zero. */
  readonly date: LocalDate;
  /** The movement that takes it below zero. */
  readonly voucherId: VoucherId;
  readonly lineNo: number;
  /** How far below zero (positive). */
  readonly short: Qty;
}

export interface SummaryRow {
  readonly itemId: StockItemId;
  readonly opening: Position;
  readonly inward: Position;
  readonly outward: Position;
  readonly closing: Position;
}

export interface LedgerRow {
  readonly movement: StockMovement;
  readonly value: Money;
  /** The item's running position after this movement (the TRUE running position, whatever a view then filters). */
  readonly balance: Position;
}

export interface ItemLedger {
  readonly opening: Position;
  readonly rows: readonly LedgerRow[];
  readonly closing: Position;
}

const roundDiv = (numerator: bigint, denominator: bigint): bigint => (2n * numerator + denominator) / (2n * denominator);

const direction = (m: StockMovement): number => (m.direction === 'in' ? 0 : 1);

/** The book's total order. */
export function compareMovements(a: StockMovement, b: StockMovement): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.direction !== b.direction) return direction(a) - direction(b);
  if (a.voucherId !== b.voucherId) return a.voucherId < b.voucherId ? -1 : 1;
  return a.lineNo - b.lineNo;
}

export interface StockChange {
  /** Vouchers whose movements leave the book (the voucher being altered or cancelled). */
  readonly remove?: readonly VoucherId[] | undefined;
  readonly add?: readonly StockMovement[] | undefined;
}

export class StockBook {
  private readonly byItem: ReadonlyMap<StockItemId, readonly StockMovement[]>;
  private readonly stepCache = new Map<StockItemId, readonly StockStep[]>();

  constructor(readonly movements: readonly StockMovement[] = []) {
    const grouped = new Map<StockItemId, StockMovement[]>();
    for (const m of movements) {
      const list = grouped.get(m.itemId);
      if (list) list.push(m);
      else grouped.set(m.itemId, [m]);
    }
    for (const list of grouped.values()) list.sort(compareMovements);
    this.byItem = grouped;
  }

  static readonly empty = new StockBook();

  /** A new book with some vouchers' movements taken out and others added. This book is untouched. */
  withChange(change: StockChange): StockBook {
    const gone = new Set(change.remove ?? []);
    const kept = gone.size === 0 ? this.movements : this.movements.filter((m) => !gone.has(m.voucherId));
    return new StockBook([...kept, ...(change.add ?? [])]);
  }

  itemIds(): readonly StockItemId[] {
    return [...this.byItem.keys()].sort(); // sorted: the answer never depends on the order movements were entered in
  }

  /** Every movement of the item in the book's order, each with its value and the running position. */
  steps(itemId: StockItemId): readonly StockStep[] {
    const cached = this.stepCache.get(itemId);
    if (cached) return cached;
    const list = this.byItem.get(itemId) ?? [];
    const steps: StockStep[] = [];
    let q = 0n;
    let v = 0n;
    const perWarehouse = new Map<WarehouseId, bigint>();
    for (const m of list) {
      let value: bigint;
      if (m.direction === 'in') {
        value = m.value ?? 0n;
        q += m.qty;
        v += value;
      } else {
        // The whole running value if this empties the item (or there is nothing to price it from); otherwise its exact share.
        value = q <= 0n ? 0n : m.qty >= q ? v : roundDiv(v * m.qty, q);
        q -= m.qty;
        v -= value;
      }
      const w = (perWarehouse.get(m.warehouseId) ?? 0n) + (m.direction === 'in' ? m.qty : -m.qty);
      perWarehouse.set(m.warehouseId, w);
      steps.push({ movement: m, value: money(value), after: { qty: qty(q), value: money(v) }, warehouseQty: w });
    }
    this.stepCache.set(itemId, steps);
    return steps;
  }

  /** The item's position (all godowns) after everything dated on or before `date`. */
  positionAt(itemId: StockItemId, date: LocalDate): Position {
    let last: Position = NOTHING;
    for (const s of this.steps(itemId)) {
      if (s.movement.date > date) break;
      last = s.after;
    }
    return last;
  }

  /** The item's position before anything dated on or after `date`. */
  positionBefore(itemId: StockItemId, date: LocalDate): Position {
    let last: Position = NOTHING;
    for (const s of this.steps(itemId)) {
      if (s.movement.date >= date) break;
      last = s.after;
    }
    return last;
  }

  /** The quantity in one godown after everything dated on or before `date`. */
  qtyAt(itemId: StockItemId, warehouseId: WarehouseId, date: LocalDate): Qty {
    let last = 0n;
    for (const s of this.steps(itemId)) {
      if (s.movement.date > date) break;
      if (s.movement.warehouseId === warehouseId) last = s.warehouseQty;
    }
    return qty(last);
  }

  /**
   * Where stock would go below zero: for each item and godown, the first movement that takes it under — or nothing if the book is sound.
   * `only` limits the check to some items (the ones a change touches).
   */
  shortfalls(only?: readonly StockItemId[]): readonly Shortfall[] {
    const out: Shortfall[] = [];
    for (const itemId of only ?? this.itemIds()) {
      const seen = new Set<WarehouseId>();
      for (const s of this.steps(itemId)) {
        const m = s.movement;
        if (s.warehouseQty < 0n && !seen.has(m.warehouseId)) {
          seen.add(m.warehouseId);
          out.push({ itemId, warehouseId: m.warehouseId, date: m.date, voucherId: m.voucherId, lineNo: m.lineNo, short: qty(-s.warehouseQty) });
        }
      }
    }
    return out;
  }

  /** Opening, inward, outward and closing of every item that has movements up to `to`, for the period `from`–`to`. */
  summary(from: LocalDate, to: LocalDate): readonly SummaryRow[] {
    const rows: SummaryRow[] = [];
    for (const itemId of this.itemIds()) {
      const opening = this.positionBefore(itemId, from);
      let inQty = 0n;
      let inValue = 0n;
      let outQty = 0n;
      let outValue = 0n;
      let closing = opening;
      let any = opening.qty !== 0n || opening.value !== 0n;
      for (const s of this.steps(itemId)) {
        const m = s.movement;
        if (m.date < from) continue;
        if (m.date > to) break;
        any = true;
        if (m.direction === 'in') {
          inQty += m.qty;
          inValue += s.value;
        } else {
          outQty += m.qty;
          outValue += s.value;
        }
        closing = s.after;
      }
      if (any) {
        rows.push({
          itemId,
          opening,
          inward: { qty: qty(inQty), value: money(inValue) },
          outward: { qty: qty(outQty), value: money(outValue) },
          closing,
        });
      }
    }
    return rows;
  }

  /** One item's movements in `from`–`to`, each with the running position; the opening and closing are the item's own. */
  ledger(itemId: StockItemId, from: LocalDate, to: LocalDate): ItemLedger {
    const opening = this.positionBefore(itemId, from);
    const rows: LedgerRow[] = [];
    let closing = opening;
    for (const s of this.steps(itemId)) {
      if (s.movement.date < from) continue;
      if (s.movement.date > to) break;
      rows.push({ movement: s.movement, value: s.value, balance: s.after });
      closing = s.after;
    }
    return { opening, rows, closing };
  }
}
