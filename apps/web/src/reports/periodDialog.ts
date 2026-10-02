import type { FinancialYear, LocalDate, Masters } from '@minimalerp/domain';
import { type DateContext, formatDate, parseDateInput } from '../vouchers/format';
import { findFinancialYear } from './gstReports';

/** A screen's period: two YYYY-MM-DD dates (some screens keep them as plain strings). */
export interface Period {
  readonly from: string;
  readonly to: string;
}

export interface PeriodField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

/** The year a period IS (a whole year), or, for an "as on" report, the year its date falls in. */
function yearOf(masters: Masters, period: Period, asOn: boolean): FinancialYear | undefined {
  return masters.financialYears.find((y) => (asOn ? period.to >= y.start && period.to <= y.end : y.start === period.from && y.end === period.to));
}

/**
 * The fields of the Period dialog (F2): a Financial year first — typing one ("24-25") takes that whole year — then the dates, which
 * win when they are changed. The dialog opens on the first date (`initial`), so typing a date straight away works as it always has. An "as on" report (the Balance Sheet) has one date, and a year there means its last day.
 */
export function periodFields(masters: Masters, period: Period, asOn: boolean): PeriodField[] {
  const latest = masters.financialYears.at(-1)?.label ?? '26-27';
  return [
    { key: 'fy', label: 'Financial year', value: yearOf(masters, period, asOn)?.label ?? '', hint: `like ${latest}: the whole year; blank: the dates below` },
    ...(asOn
      ? [{ key: 'to', label: 'As on', value: formatDate(period.to), hint: 'a date like 30-6-24, or ↑ for a financial year' }]
      : [
          { key: 'from', label: 'From', value: formatDate(period.from), hint: 'a date like 1-4-24, or ↑ for a financial year' },
          { key: 'to', label: 'To', value: formatDate(period.to) },
        ]),
  ];
}

/**
 * What the dialog's values mean: the period, or what is wrong with them. A financial year with the dates left as they were gives that
 * year; dates that were changed are read inside the year given (so "1-10" is October of 24-25), or the current one when none is.
 */
export function readPeriod(
  masters: Masters,
  values: Record<string, string>,
  initial: readonly PeriodField[],
  period: Period,
  asOn: boolean,
  fallback: Pick<DateContext, 'start' | 'end'>,
): { readonly period?: { readonly from: LocalDate; readonly to: LocalDate }; readonly errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const was = (key: string) => initial.find((f) => f.key === key)?.value ?? '';
  const fyText = (values['fy'] ?? '').trim();
  const fy = fyText === '' ? undefined : findFinancialYear(masters, fyText);
  if (fyText !== '' && !fy) errors['fy'] = 'That is not one of this company’s financial years';
  const datesChanged = (values['to'] ?? '') !== was('to') || (!asOn && (values['from'] ?? '') !== was('from'));

  if (fy && (!datesChanged || fyText !== was('fy'))) {
    return { period: asOn ? { from: period.from as LocalDate, to: fy.end } : { from: fy.start, to: fy.end }, errors };
  }
  const ctx: DateContext = { start: fy?.start ?? fallback.start, end: fy?.end ?? fallback.end, base: fy?.start ?? period.from };
  const from = asOn ? (period.from as LocalDate) : parseDateInput(values['from'] ?? '', ctx);
  const to = parseDateInput(values['to'] ?? '', ctx);
  if (!from) errors['from'] = 'That is not a date';
  if (!to) errors['to'] = 'That is not a date';
  if (from && to && from > to) errors['to'] = 'The end is before the start';
  return Object.keys(errors).length > 0 || !from || !to ? { errors } : { period: { from, to }, errors };
}
