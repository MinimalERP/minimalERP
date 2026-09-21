/**
 * Money is an integer count of minor units (paise) held in a bigint — never a float.
 * Signed: journal amounts are always positive, balances are signed (debit positive).
 * Wire/DB format is a decimal string with exactly two places ("1234.56").
 */
export type Money = bigint & { readonly __brand: 'Money' };

export const MINOR_UNITS_PER_MAJOR = 100n;

export const money = (minor: bigint): Money => minor as Money;

export const ZERO: Money = money(0n);

/** The largest amount one journal line can hold: 9,999,999,999,999,999.99 — what numeric(18,2) stores. */
export const MAX_MONEY: Money = money(999_999_999_999_999_999n);

const MONEY_TEXT = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export const isMoneyText = (text: string): boolean => MONEY_TEXT.test(text);

/** Parses "1234", "1234.5", "1234.56", "-0.05". Returns undefined for anything else (no thousands separators, no exponents). */
export function parseMoney(text: string): Money | undefined {
  const m = MONEY_TEXT.exec(text);
  if (!m) return undefined;
  const [, sign, whole = '0', frac = ''] = m;
  const minor = BigInt(whole) * MINOR_UNITS_PER_MAJOR + BigInt(frac.padEnd(2, '0') || '0');
  return money(sign ? -minor : minor);
}

/** Always two decimal places, e.g. 5n → "0.05", -12345n → "-123.45". */
export function formatMoney(amount: Money): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / MINOR_UNITS_PER_MAJOR;
  const frac = (abs % MINOR_UNITS_PER_MAJOR).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export const addMoney = (a: Money, b: Money): Money => money(a + b);
export const subMoney = (a: Money, b: Money): Money => money(a - b);
export const negateMoney = (a: Money): Money => money(-a);
export const absMoney = (a: Money): Money => (a < 0n ? money(-a) : a);
export const isZeroMoney = (a: Money): boolean => a === 0n;

export function sumMoney(amounts: Iterable<Money>): Money {
  let total = 0n;
  for (const a of amounts) total += a;
  return money(total);
}

/**
 * Splits `total` proportionally to `weights` so the parts sum EXACTLY to `total`
 * (largest-remainder method; ties go to the earlier index). Used for discounts, tax
 * apportionment and round-off — anywhere a float would silently lose a paisa.
 */
export function allocateMoney(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new RangeError('allocateMoney: weights must not be empty');
  let weightSum = 0n;
  for (const w of weights) {
    if (w < 0n) throw new RangeError('allocateMoney: weights must be non-negative');
    weightSum += w;
  }
  if (weightSum === 0n) throw new RangeError('allocateMoney: weights must not all be zero');

  const negative = total < 0n;
  const abs = negative ? -total : total;

  const parts = weights.map((w) => (abs * w) / weightSum);
  const remainders = weights.map((w, i) => ({ i, r: (abs * w) % weightSum }));
  let leftover = abs - parts.reduce((s, p) => s + p, 0n);

  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    parts[i] = (parts[i] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return parts.map((p) => money(negative ? -p : p));
}
