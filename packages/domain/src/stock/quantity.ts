import { type Money, money } from '../money';

/**
 * A quantity of stock, in ten-thousandths of the item's unit (what numeric(18,4) stores) — an integer in a bigint, never a float.
 * A unit says how many decimal places are meaningful (0 for pieces, 3 for kilograms; at most 4).
 */
export type Qty = bigint & { readonly __brand: 'Qty' };

export const QTY_SCALE = 10_000n;
export const qty = (raw: bigint): Qty => raw as Qty;
export const ZERO_QTY: Qty = qty(0n);

/** The largest quantity one movement can hold: what numeric(18,4) stores. */
export const MAX_QTY: Qty = qty(99_999_999_999_999_999n);

const QTY_TEXT = /^(\d+)(?:\.(\d{1,4}))?$/;

export const isQtyText = (text: string): boolean => QTY_TEXT.test(text);

/** Parses "10", "2.5", "0.0625" (at most four decimals, no sign, no separators). */
export function parseQty(text: string): Qty | undefined {
  const m = QTY_TEXT.exec(text.trim());
  if (!m) return undefined;
  const [, whole = '0', frac = ''] = m;
  return qty(BigInt(whole) * QTY_SCALE + BigInt(frac.padEnd(4, '0')));
}

/** How many decimal places the quantity really uses (0–4): 2.5 → 1, 3 → 0. */
export function decimalsUsed(q: Qty): number {
  const frac = (q < 0n ? -q : q) % QTY_SCALE;
  if (frac === 0n) return 0;
  return 4 - (frac.toString().padStart(4, '0').match(/0*$/)?.[0].length ?? 0);
}

/** "12.50" for a unit with two places; more places are shown only when the quantity really has them. */
export function formatQty(q: Qty, unitDecimals = 0): string {
  const negative = q < 0n;
  const abs = negative ? -q : q;
  const places = Math.max(unitDecimals, decimalsUsed(qty(abs)));
  const whole = abs / QTY_SCALE;
  const frac = (abs % QTY_SCALE).toString().padStart(4, '0').slice(0, places);
  return `${negative ? '-' : ''}${whole}${places > 0 ? `.${frac}` : ''}`;
}

/**
 * A rate — money per unit — in ten-thousandths of a rupee (four decimals, so 58.3333 is exact enough for a bulk price).
 * The VALUE of a movement is `qty × rate` rounded to the paisa, and is what the books keep.
 */
export type Rate = bigint & { readonly __brand: 'Rate' };

export const rate = (raw: bigint): Rate => raw as Rate;

const RATE_TEXT = /^(\d+)(?:\.(\d{1,4}))?$/;

export function parseRate(text: string): Rate | undefined {
  const m = RATE_TEXT.exec(text.trim());
  if (!m) return undefined;
  const [, whole = '0', frac = ''] = m;
  return rate(BigInt(whole) * 10_000n + BigInt(frac.padEnd(4, '0')));
}

/** "58.00", or more places when the rate has them: 58.3333. */
export function formatRate(r: Rate): string {
  const whole = r / 10_000n;
  const frac = (r % 10_000n).toString().padStart(4, '0');
  const trimmed = frac.replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${trimmed}`;
}

const roundDiv = (numerator: bigint, denominator: bigint): bigint => (2n * numerator + denominator) / (2n * denominator);

/** What `q` at `r` comes to, to the paisa (half up). */
export function valueOf(q: Qty, r: Rate): Money {
  return money(roundDiv(q * r, 1_000_000n));
}

/** The rate a value and quantity imply (for display: what the average cost is), or undefined with no quantity. */
export function rateOf(value: Money, q: Qty): Rate | undefined {
  if (q <= 0n) return undefined;
  return rate(roundDiv(value * 1_000_000n, q));
}

/** The canonical text of a quantity as drafts and the wire keep it: always four places, "10.0000" (so "10" and "10.0" are one voucher). */
export function qtyText(q: Qty): string {
  return `${q / QTY_SCALE}.${(q % QTY_SCALE).toString().padStart(4, '0')}`;
}

/** The canonical text of a rate, four places. */
export function rateText(r: Rate): string {
  return `${r / 10_000n}.${(r % 10_000n).toString().padStart(4, '0')}`;
}
