import { z } from 'zod';
import { type Money, ZERO, money } from '../money';

/**
 * GST arithmetic (ADR-0019) — one pure function that the posting engine, the browser's preview and the GST reports all call, so the tax an invoice
 * shows, the tax it posts and the tax a report adds up are the same figures by construction.
 *
 * Rules: tax is worked out per RATE on the sum of the taxable values at that rate, half-up to the paisa. Within one state (supply state = place of
 * supply) it is CGST and SGST, each HALF the rate, each rounded on its own; between states it is IGST, the whole rate. There is no invoice round-off.
 * Cess is not modelled.
 */

/** A rate is a percentage with up to two decimals: "18", "5", "0.25", "2.5". */
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;

export const isPercentText = (text: string): boolean => PERCENT.test(text) && percentHundredths(text) <= 10_000n;

export const percentSchema = z.string().trim().refine(isPercentText, 'A GST rate is a percentage like 5, 18 or 2.5');

/** "18" → 1800n, "2.5" → 250n: hundredths of a percent (an integer, so nothing about a rate ever passes through a float). */
export function percentHundredths(text: string): bigint {
  const [whole = '0', frac = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2) || '0');
}

/** "18.00" → "18", "2.50" → "2.5", "" → "0": one spelling per rate, so rates group and compare as text. */
export function canonicalPercent(text: string | undefined): string {
  if (text === undefined || text.trim() === '') return '0';
  if (!isPercentText(text.trim())) return text.trim();
  const h = percentHundredths(text.trim());
  const whole = h / 100n;
  const frac = h % 100n;
  return frac === 0n ? `${whole}` : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** Supply within a state: the supplying state and the place of supply are the same. Either unknown → not known to be within the state. */
export const isIntraState = (supplyState: string | undefined, placeOfSupply: string | undefined): boolean =>
  supplyState !== undefined && supplyState !== '' && supplyState === placeOfSupply;

export interface TaxSlab {
  /** The rate as canonical text: "18", "5", "0" (nil-rated). */
  readonly rate: string;
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
}

export interface GstBreakdown {
  readonly intra: boolean;
  /** One entry per rate present, lowest rate first. */
  readonly slabs: readonly TaxSlab[];
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  /** CGST + SGST + IGST. */
  readonly tax: Money;
}

/** Half-up division of a non-negative bigint. */
const roundDiv = (numerator: bigint, denominator: bigint): bigint => (numerator * 2n + denominator) / (denominator * 2n);

export interface TaxableLine {
  readonly taxable: Money;
  /** The line's GST rate; absent means it is not taxed (nil). */
  readonly rate?: string | undefined;
}

export function computeGst(lines: readonly TaxableLine[], intra: boolean): GstBreakdown {
  const byRate = new Map<string, bigint>();
  for (const l of lines) {
    const rate = canonicalPercent(l.rate);
    byRate.set(rate, (byRate.get(rate) ?? 0n) + l.taxable);
  }
  const slabs: TaxSlab[] = [...byRate.entries()]
    .sort((a, b) => Number(percentHundredths(a[0])) - Number(percentHundredths(b[0])))
    .map(([rate, taxable]) => {
      const pct = isPercentText(rate) ? percentHundredths(rate) : 0n;
      if (intra) {
        const half = money(roundDiv(taxable * pct, 20_000n)); // taxable × rate% ÷ 2, each half rounded on its own
        return { rate, taxable: money(taxable), cgst: half, sgst: half, igst: ZERO };
      }
      return { rate, taxable: money(taxable), cgst: ZERO, sgst: ZERO, igst: money(roundDiv(taxable * pct, 10_000n)) };
    });
  const sum = (pick: (s: TaxSlab) => bigint): Money => money(slabs.reduce((t, s) => t + pick(s), 0n));
  const cgst = sum((s) => s.cgst);
  const sgst = sum((s) => s.sgst);
  const igst = sum((s) => s.igst);
  return { intra, slabs, taxable: sum((s) => s.taxable), cgst, sgst, igst, tax: money(cgst + sgst + igst) };
}
