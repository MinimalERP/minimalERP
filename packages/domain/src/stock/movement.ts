import type { LocalDate } from '../dates';
import type { StockItemId, VoucherId, WarehouseId } from '../ids';
import type { Money } from '../money';
import type { Qty } from './quantity';

export type StockDirection = 'in' | 'out';

/**
 * One line of the stock ledger: stock of an item arriving in, or leaving, a godown on a date, by a voucher.
 * An In carries its VALUE (what was paid or costed, quantity × rate); an Out carries none — it is valued by the book at the moving
 * weighted average of its day, so an earlier or later entry can never leave a stale figure behind.
 */
export interface StockMovement {
  readonly voucherId: VoucherId;
  /** 1-based, contiguous within the voucher. */
  readonly lineNo: number;
  readonly date: LocalDate;
  readonly itemId: StockItemId;
  readonly warehouseId: WarehouseId;
  readonly direction: StockDirection;
  /** Always strictly positive; direction is carried by `direction`, never by sign. */
  readonly qty: Qty;
  readonly value?: Money | undefined;
}

/** What a stock voucher kind emits: identity-free (the engine stamps voucher id, line number and date). */
export interface PlannedStock {
  readonly itemId: StockItemId;
  readonly warehouseId: WarehouseId;
  readonly direction: StockDirection;
  readonly qty: Qty;
  readonly value?: Money | undefined;
}
