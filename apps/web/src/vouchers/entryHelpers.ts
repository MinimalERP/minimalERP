import type { Masters } from '@minimalerp/domain';

/** A voucher type from what a screen address says: a base kind ("payment") or a voucher type's id. */
export function resolveTypeId(masters: Masters, key: string): string | undefined {
  if (masters.voucherType(key as never)) return key;
  const matches = masters.voucherTypes.filter((t) => t.baseKind === key && t.isActive !== false);
  return (matches.find((t) => t.isSystem) ?? matches[0])?.id;
}

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Today if it lies in a financial year of the company, otherwise the nearest year's edge. */
export function defaultDate(masters: Masters): string {
  const t = today();
  const years = masters.financialYears;
  if (years.some((y) => t >= y.start && t <= y.end)) return t;
  const last = years.at(-1);
  if (last && t > last.end) return last.end;
  return years[0]?.start ?? t;
}

export const fyOf = (masters: Masters, date: string) => masters.financialYearOn(date as never) ?? masters.financialYears.at(-1);
