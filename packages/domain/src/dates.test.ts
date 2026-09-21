import { describe, expect, it } from 'vitest';
import { asCompanyId, asFinancialYearId } from './ids';
import {
  type FinancialYear,
  compareDates,
  findFinancialYear,
  indianFinancialYearOf,
  isPeriodLocked,
  localDate,
  parseLocalDate,
} from './dates';

describe('parseLocalDate', () => {
  it.each(['2024-04-01', '2024-02-29', '2025-12-31', '0001-01-01'])('accepts %s', (s) => {
    expect(parseLocalDate(s)).toBe(s);
  });

  it.each(['2025-02-29', '2025-02-30', '2025-13-01', '2025-00-10', '2025-04-31', '2025-1-1', '25-01-01', '', '2025/01/01', '2025-01-01T00:00:00Z'])(
    'rejects %j',
    (s) => {
      expect(parseLocalDate(s)).toBeUndefined();
    },
  );

  it('localDate throws on an invalid date', () => {
    expect(() => localDate('2025-02-30')).toThrow(RangeError);
  });
});

describe('compareDates', () => {
  it('orders chronologically', () => {
    expect(compareDates(localDate('2024-04-01'), localDate('2024-04-02'))).toBe(-1);
    expect(compareDates(localDate('2025-01-01'), localDate('2024-12-31'))).toBe(1);
    expect(compareDates(localDate('2024-04-01'), localDate('2024-04-01'))).toBe(0);
  });
});

describe('indianFinancialYearOf', () => {
  it.each([
    ['2024-04-01', '2024-04-01', '2025-03-31', '2024-25'],
    ['2025-03-31', '2024-04-01', '2025-03-31', '2024-25'],
    ['2025-01-15', '2024-04-01', '2025-03-31', '2024-25'],
    ['2025-04-01', '2025-04-01', '2026-03-31', '2025-26'],
    ['2099-06-01', '2099-04-01', '2100-03-31', '2099-00'],
  ])('%s → %s..%s (%s)', (date, start, end, label) => {
    expect(indianFinancialYearOf(localDate(date))).toEqual({ start, end, label });
  });
});

describe('financial years', () => {
  const fy = (label: string, start: string, end: string, lockedThrough?: string): FinancialYear => ({
    id: asFinancialYearId(`fy-${label}`),
    companyId: asCompanyId('c'),
    label,
    start: localDate(start),
    end: localDate(end),
    lockedThrough: lockedThrough === undefined ? undefined : localDate(lockedThrough),
  });
  const years = [fy('24-25', '2024-04-01', '2025-03-31'), fy('25-26', '2025-04-01', '2026-03-31')];

  it('finds the year containing a date, boundaries inclusive', () => {
    expect(findFinancialYear(years, localDate('2024-04-01'))?.label).toBe('24-25');
    expect(findFinancialYear(years, localDate('2025-03-31'))?.label).toBe('24-25');
    expect(findFinancialYear(years, localDate('2025-04-01'))?.label).toBe('25-26');
    expect(findFinancialYear(years, localDate('2024-03-31'))).toBeUndefined();
  });

  it('treats lockedThrough as inclusive', () => {
    const locked = fy('24-25', '2024-04-01', '2025-03-31', '2024-06-30');
    expect(isPeriodLocked(locked, localDate('2024-06-30'))).toBe(true);
    expect(isPeriodLocked(locked, localDate('2024-06-29'))).toBe(true);
    expect(isPeriodLocked(locked, localDate('2024-07-01'))).toBe(false);
    expect(isPeriodLocked(years[0] as FinancialYear, localDate('2024-05-01'))).toBe(false);
  });
});
