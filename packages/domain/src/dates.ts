import type { CompanyId, FinancialYearId } from './ids';

/** A calendar date with no time zone: "YYYY-MM-DD". Lexicographic order == chronological order. */
export type LocalDate = string & { readonly __brand: 'LocalDate' };

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Returns the date if it is a real calendar date (rejects 2025-02-30), otherwise undefined. */
export function parseLocalDate(text: string): LocalDate | undefined {
  const m = LOCAL_DATE.exec(text);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Not Date.UTC(y, …): it maps years 0–99 to 1900–1999.
  const probe = new Date(0);
  probe.setUTCFullYear(y, mo - 1, d);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return undefined;
  }
  return text as LocalDate;
}

export function localDate(text: string): LocalDate {
  const parsed = parseLocalDate(text);
  if (!parsed) throw new RangeError(`Invalid calendar date: ${text}`);
  return parsed;
}

export const compareDates = (a: LocalDate, b: LocalDate): number => (a < b ? -1 : a > b ? 1 : 0);

export interface DateRange {
  readonly from?: LocalDate | undefined;
  readonly to?: LocalDate | undefined;
}

export interface FinancialYear {
  readonly id: FinancialYearId;
  readonly companyId: CompanyId;
  readonly label: string;
  readonly start: LocalDate;
  readonly end: LocalDate;
  /** Inclusive: nothing dated on or before this day may be posted, altered or cancelled. */
  readonly lockedThrough?: LocalDate | undefined;
}

/** Indian financial year (1 Apr – 31 Mar) containing `date`. */
export function indianFinancialYearOf(date: LocalDate): { start: LocalDate; end: LocalDate; label: string } {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return {
    start: localDate(`${startYear}-04-01`),
    end: localDate(`${startYear + 1}-03-31`),
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
  };
}

export function findFinancialYear(
  years: readonly FinancialYear[],
  date: LocalDate,
): FinancialYear | undefined {
  return years.find((fy) => date >= fy.start && date <= fy.end);
}

export const isPeriodLocked = (fy: FinancialYear, date: LocalDate): boolean =>
  fy.lockedThrough !== undefined && date <= fy.lockedThrough;
