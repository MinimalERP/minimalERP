import { localDate } from './dates';
import { asCompanyId, asFinancialYearId, asLedgerId, asStockItemId, asVoucherId, asVoucherTypeId, asWarehouseId } from './ids';
import { formatMoney, money, parseMoney } from './money';
import type { JournalLine, Side } from './posting/plan';
import type { OrderLink } from './orders/orderBook';
import type { StockMovement } from './stock/movement';
import { QTY_SCALE, parseQty, qty } from './stock/quantity';
import type { DraftBase } from './vouchers/drafts';
import type { Voucher, VoucherStatus } from './vouchers/voucher';

/**
 * JSON-safe forms of domain values, shared by every transport (Edge Function, browser adapter,
 * Postgres adapter). JSON has no bigint and JS numbers lose precision on large amounts, so
 * money travels as a decimal string with exactly two places ("1234.56") and is parsed back into
 * a bigint on the other side. Nothing about money ever passes through a JS number.
 */

/** Converts a draft to plain JSON: every bigint (always money) becomes a decimal string; undefined is dropped. */
export function draftToJson(value: unknown): unknown {
  if (typeof value === 'bigint') return formatMoney(money(value));
  if (Array.isArray(value)) return value.map(draftToJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = draftToJson(v);
    }
    return out;
  }
  return value;
}

/** Structural JSON equality, independent of key order (jsonb does not preserve it). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]))
    );
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

export interface JournalLineWire {
  readonly voucherId: string;
  readonly lineNo: number;
  readonly date: string;
  readonly ledgerId: string;
  readonly side: Side;
  readonly amount: string;
  readonly narration: string | null;
}

export function journalLineToWire(l: JournalLine): JournalLineWire {
  return {
    voucherId: l.voucherId,
    lineNo: l.lineNo,
    date: l.date,
    ledgerId: l.ledgerId,
    side: l.side,
    amount: formatMoney(l.amount),
    narration: l.narration ?? null,
  };
}

export function journalLineFromWire(w: JournalLineWire): JournalLine {
  const amount = parseMoney(w.amount);
  if (amount === undefined) throw new Error(`Malformed amount on the wire: ${JSON.stringify(w.amount)}`);
  return {
    voucherId: asVoucherId(w.voucherId),
    lineNo: w.lineNo,
    date: localDate(w.date),
    ledgerId: asLedgerId(w.ledgerId),
    side: w.side,
    amount,
    narration: w.narration ?? undefined,
  };
}

/** A stock movement on the wire: quantity and value as decimal strings (four places and two), never numbers. */
export interface StockMovementWire {
  readonly voucherId: string;
  readonly lineNo: number;
  readonly date: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly direction: 'in' | 'out';
  readonly qty: string;
  readonly value: string | null;
}

export function stockMovementToWire(m: StockMovement): StockMovementWire {
  return {
    voucherId: m.voucherId,
    lineNo: m.lineNo,
    date: m.date,
    itemId: m.itemId,
    warehouseId: m.warehouseId,
    direction: m.direction,
    qty: `${m.qty / QTY_SCALE}.${(m.qty % QTY_SCALE).toString().padStart(4, '0')}`,
    value: m.value === undefined ? null : formatMoney(m.value),
  };
}

export function stockMovementFromWire(w: StockMovementWire): StockMovement {
  const q = parseQty(w.qty);
  if (q === undefined) throw new Error(`Malformed quantity on the wire: ${JSON.stringify(w.qty)}`);
  const value = w.value === null ? undefined : parseMoney(w.value);
  return {
    voucherId: asVoucherId(w.voucherId),
    lineNo: w.lineNo,
    date: localDate(w.date),
    itemId: asStockItemId(w.itemId),
    warehouseId: asWarehouseId(w.warehouseId),
    direction: w.direction,
    qty: qty(q),
    ...(value === undefined ? {} : { value }),
  };
}

/** A delivery against a sales-order line on the wire: the quantity as a decimal string with four places. */
export interface OrderLinkWire {
  readonly voucherId: string;
  readonly lineNo: number;
  readonly date: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly itemId: string;
  readonly qty: string;
}

export function orderLinkToWire(l: OrderLink): OrderLinkWire {
  return {
    voucherId: l.voucherId,
    lineNo: l.lineNo,
    date: l.date,
    orderId: l.orderId,
    orderLineId: l.orderLineId,
    itemId: l.itemId,
    qty: `${l.qty / QTY_SCALE}.${(l.qty % QTY_SCALE).toString().padStart(4, '0')}`,
  };
}

export function orderLinkFromWire(w: OrderLinkWire): OrderLink {
  const q = parseQty(w.qty);
  if (q === undefined) throw new Error(`Malformed quantity on the wire: ${JSON.stringify(w.qty)}`);
  return {
    voucherId: asVoucherId(w.voucherId),
    lineNo: w.lineNo,
    date: localDate(w.date),
    orderId: asVoucherId(w.orderId),
    orderLineId: w.orderLineId,
    itemId: asStockItemId(w.itemId),
    qty: qty(q),
  };
}

export interface VoucherWire {
  readonly id: string;
  readonly companyId: string;
  readonly voucherTypeId: string;
  readonly financialYearId: string;
  readonly number: string;
  readonly date: string;
  readonly status: VoucherStatus;
  readonly version: number;
  readonly revision: number;
  /** The posted draft as JSON: ids, date and narration as-is, money as decimal strings. */
  readonly content: unknown;
}

export function voucherToWire(v: Voucher): VoucherWire {
  return {
    id: v.id,
    companyId: v.companyId,
    voucherTypeId: v.voucherTypeId,
    financialYearId: v.financialYearId,
    number: v.number,
    date: v.date,
    status: v.status,
    version: v.version,
    revision: v.revision,
    content: draftToJson(v.content),
  };
}

/**
 * `content` arrives as JSON (money as strings). Its base fields (id, type, date, narration) are
 * exactly a DraftBase; kind-specific fields ride along untouched for the layer that understands them.
 */
export function voucherFromWire(w: VoucherWire): Voucher {
  return {
    id: asVoucherId(w.id),
    companyId: asCompanyId(w.companyId),
    voucherTypeId: asVoucherTypeId(w.voucherTypeId),
    financialYearId: asFinancialYearId(w.financialYearId),
    number: w.number,
    date: localDate(w.date),
    status: w.status,
    version: w.version,
    revision: w.revision,
    content: w.content as DraftBase,
  };
}
