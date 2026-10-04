import { type ColumnSpec, type FinancialYear, type Gstr1Row, type Gstr3bRow, type HsnRow, type ItcFollowUpRow, type LocalDate, type Masters, gstr2bPeriodLabel, localDate, percentHundredths } from '@minimalerp/domain';
import { formatAmount, formatDate, formatQuantity } from '../vouchers/format';

/**
 * The GST reports on the one grid (ADR-0019): GSTR-1 (an invoice-and-rate row per sale, and an HSN summary), the purchase register behind GSTR-3B, and
 * GSTR-3B itself. The figures come from the pure functions in the domain; this file is the period a return is for (a financial year and a month)
 * and the columns.
 */

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface GstPeriod {
  readonly from: LocalDate;
  readonly to: LocalDate;
  /** `YYYY-MM`: the period's address. */
  readonly ym: string;
  /** "Apr 2026" — or, for a quarter, "Apr–Jun 2026 (Q1)". */
  readonly label: string;
  /** A quarterly return (QRMP): which quarter of the financial year, 1 (Apr–Jun) to 4 (Jan–Mar). Absent for a month. */
  readonly quarter?: number;
}

const two = (n: number): string => String(n).padStart(2, '0');

export function monthPeriod(year: number, month: number): GstPeriod {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: localDate(`${year}-${two(month)}-01`), to: localDate(`${year}-${two(month)}-${two(last)}`), ym: `${year}-${two(month)}`, label: `${MONTHS[month - 1]} ${year}` };
}

/**
 * A quarter of the GST year, which runs April to March: Q1 of 2026 is Apr–Jun 2026, Q4 is Jan–Mar 2027. Its address is `2026-Q1` (the year the
 * financial year starts in).
 */
export function quarterPeriod(startYear: number, quarter: number): GstPeriod {
  const first = 4 + 3 * (quarter - 1);
  const at = (month: number) => (month > 12 ? monthPeriod(startYear + 1, month - 12) : monthPeriod(startYear, month));
  const a = at(first);
  const c = at(first + 2);
  return { from: a.from, to: c.to, ym: `${startYear}-Q${quarter}`, label: `${a.label.slice(0, 3)}–${c.label} (Q${quarter})`, quarter };
}

/** "q1", "Q 3" → 1, 3; anything else → undefined. */
export function parseQuarter(text: string): number | undefined {
  const m = /^q\s*([1-4])$/i.exec(text.trim());
  return m ? Number(m[1]) : undefined;
}

/** A quarter INSIDE a financial year (one that starts in April). */
export function quarterInYear(fy: FinancialYear, quarter: number): GstPeriod | undefined {
  const p = quarterPeriod(Number(fy.start.slice(0, 4)), quarter);
  return p.from >= fy.start && p.to <= fy.end ? p : undefined;
}

/** The whole GST year that starts in April of `startYear`: its address is `2026-FY`. (The ITC follow-up list looks at a year at once.) */
export function yearPeriod(startYear: number): GstPeriod {
  return { from: localDate(`${startYear}-04-01`), to: localDate(`${startYear + 1}-03-31`), ym: `${startYear}-FY`, label: `Apr ${startYear}–Mar ${startYear + 1}` };
}

/** The GST year a day is in. */
export const yearPeriodOf = (day: string): GstPeriod => yearPeriod(Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) >= 4 ? 0 : 1));

/** `2026-04` → April 2026, `2026-Q1` → Apr–Jun 2026, `2026-FY` → Apr 2026–Mar 2027, or undefined when it is none of them. */
export function periodOfYm(ym: string | undefined): GstPeriod | undefined {
  const fy = /^(\d{4})-FY$/.exec(ym ?? '');
  if (fy) return yearPeriod(Number(fy[1]));
  const q = /^(\d{4})-Q([1-4])$/.exec(ym ?? '');
  if (q) return quarterPeriod(Number(q[1]), Number(q[2]));
  const m = /^(\d{4})-(\d{2})$/.exec(ym ?? '');
  if (!m) return undefined;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? monthPeriod(Number(m[1]), month) : undefined;
}

/**
 * The period a GSTR-2B statement covers, from the period the portal writes in it (`MMYYYY`): that month — or, for a quarterly statement
 * (which names its quarter's last month), the quarter of the GST year the month is in. Undefined when the text is not a period.
 */
export function gstr2bFilePeriod(period: string, quarterly: boolean): GstPeriod | undefined {
  const m = /^(\d{2})(\d{4})$/.exec(period);
  const month = m ? Number(m[1]) : 0;
  if (!m || month < 1 || month > 12) return undefined;
  const year = Number(m[2]);
  if (!quarterly) return monthPeriod(year, month);
  return month >= 4 ? quarterPeriod(year, Math.ceil((month - 3) / 3)) : quarterPeriod(year - 1, 4);
}

/** The month a return is for when none is asked for: this month if it is inside a financial year of the company, otherwise the last month of the latest year. */
export function defaultPeriod(masters: Masters, today: string): GstPeriod {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const inside = masters.financialYears.some((fy) => today >= fy.start && today <= fy.end);
  if (inside) return monthPeriod(y, m);
  const last = masters.financialYears.at(-1);
  return last ? monthPeriod(Number(last.end.slice(0, 4)), Number(last.end.slice(5, 7))) : monthPeriod(y, m);
}

const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'] as const;

/** "apr", "April", "4", "04" → 4. */
export function parseMonth(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (/^\d{1,2}$/.test(t)) return Number(t) >= 1 && Number(t) <= 12 ? Number(t) : undefined;
  const i = t.length >= 3 ? FULL_MONTHS.findIndex((n) => n.startsWith(t)) : -1;
  return i >= 0 ? i + 1 : undefined;
}

const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

/** The financial year a person typed ("26-27", "2026-27", or the label as shown). */
export function findFinancialYear(masters: Masters, text: string): FinancialYear | undefined {
  const t = norm(text);
  if (t === '') return undefined;
  return masters.financialYears.find((y) => norm(y.label) === t || norm(y.label).endsWith(t) || t.endsWith(norm(y.label)) || y.label.replace(/^20/, '').replace('-20', '-') === t);
}

/** A month INSIDE a financial year: April in "2026-27" is April 2026, January is January 2027. */
export function periodInYear(fy: FinancialYear, month: number): GstPeriod | undefined {
  const startYear = Number(fy.start.slice(0, 4));
  const startMonth = Number(fy.start.slice(5, 7));
  const year = month >= startMonth ? startYear : startYear + 1;
  const p = monthPeriod(year, month);
  return p.from >= fy.start && p.to <= fy.end ? p : undefined;
}

/** The financial year a month belongs to. */
export const yearOf = (masters: Masters, p: GstPeriod): FinancialYear | undefined => masters.financialYears.find((y) => p.from >= y.start && p.to <= y.end);

// ---- columns -------------------------------------------------------------------------------------------------------------

const money0 = (m: bigint): string => (m === 0n ? '' : formatAmount(m));
const num = (rate: string): number => Number(percentHundredths(rate)) / 100;

export function gstr1Columns(side: 'sales' | 'purchase'): ColumnSpec<Gstr1Row>[] {
  const party = side === 'sales' ? 'Customer' : 'Supplier';
  return [
    { id: 'number', label: side === 'sales' ? 'Invoice no.' : 'Voucher no.', type: 'text', value: (r) => r.number },
    { id: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => formatDate(r.date) },
    { id: 'party', label: party, type: 'text', value: (r) => r.party },
    { id: 'gstin', label: 'GSTIN', type: 'text', value: (r) => r.gstin },
    { id: 'pos', label: 'Place of supply', type: 'text', value: (r) => r.placeOfSupply },
    ...(side === 'sales'
      ? ([
          {
            id: 'section',
            label: 'Type',
            type: 'choice',
            value: (r: Gstr1Row) => r.section,
            choices: ['B2B', 'B2CL', 'B2CS', 'Export'].map((v) => ({ value: v, label: v })),
          },
        ] as ColumnSpec<Gstr1Row>[])
      : []),
    { id: 'rate', label: 'Rate %', type: 'number', align: 'right', value: (r) => num(r.rate), text: (r) => r.rate },
    { id: 'taxable', label: 'Taxable value', type: 'money', align: 'right', value: (r) => r.taxable, text: (r) => formatAmount(r.taxable) },
    { id: 'cgst', label: 'CGST', type: 'money', align: 'right', value: (r) => r.cgst, text: (r) => money0(r.cgst) },
    { id: 'sgst', label: 'SGST', type: 'money', align: 'right', value: (r) => r.sgst, text: (r) => money0(r.sgst) },
    { id: 'igst', label: 'IGST', type: 'money', align: 'right', value: (r) => r.igst, text: (r) => money0(r.igst) },
    { id: 'value', label: 'Invoice value', type: 'money', align: 'right', value: (r) => r.value, text: (r) => formatAmount(r.value) },
    { id: 'hsns', label: 'HSN', type: 'text', value: (r) => r.hsns },
  ];
}

export function hsnColumns(): ColumnSpec<HsnRow>[] {
  return [
    { id: 'hsn', label: 'HSN', type: 'text', value: (r) => (r.hsn === '' ? '(none)' : r.hsn) },
    { id: 'uqc', label: 'UQC', type: 'text', value: (r) => r.uqc },
    { id: 'rate', label: 'Rate %', type: 'number', align: 'right', value: (r) => num(r.rate), text: (r) => r.rate },
    { id: 'qty', label: 'Quantity', type: 'number', align: 'right', value: (r) => Number(r.qty) / 10_000, text: (r) => formatQuantity(r.qty, 3) },
    { id: 'taxable', label: 'Taxable value', type: 'money', align: 'right', value: (r) => r.taxable, text: (r) => formatAmount(r.taxable) },
    { id: 'cgst', label: 'CGST', type: 'money', align: 'right', value: (r) => r.cgst, text: (r) => money0(r.cgst) },
    { id: 'sgst', label: 'SGST', type: 'money', align: 'right', value: (r) => r.sgst, text: (r) => money0(r.sgst) },
    { id: 'igst', label: 'IGST', type: 'money', align: 'right', value: (r) => r.igst, text: (r) => money0(r.igst) },
    { id: 'value', label: 'Total value', type: 'money', align: 'right', value: (r) => r.value, text: (r) => formatAmount(r.value) },
    { id: 'invoices', label: 'Invoices', type: 'number', align: 'right', value: (r) => r.invoices },
  ];
}

export type ItcGridRow = ItcFollowUpRow & { readonly rowType: 'itc' };

/** What the Status column says of a purchase no GSTR-2B has confirmed. */
export const itcStatusText = (r: Pick<ItcFollowUpRow, 'status'>): string => (r.status === 'missing' ? 'ITC missing' : 'Not checked');

/** ITC not matched: a purchase per row, with the supplier to follow up and the GST that waits on them. */
export function itcColumns(): ColumnSpec<ItcGridRow>[] {
  return [
    { id: 'supplier', label: 'Supplier', type: 'text', value: (r) => r.supplier },
    { id: 'gstin', label: 'GSTIN', type: 'text', value: (r) => r.gstin },
    { id: 'billNo', label: 'Supplier inv no.', type: 'text', value: (r) => r.billNo },
    { id: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => formatDate(r.date) },
    { id: 'number', label: 'Voucher no.', type: 'text', value: (r) => r.number },
    { id: 'taxable', label: 'Taxable value', type: 'money', align: 'right', value: (r) => r.taxable, text: (r) => formatAmount(r.taxable) },
    { id: 'tax', label: 'GST', type: 'money', align: 'right', value: (r) => r.tax, text: (r) => formatAmount(r.tax) },
    { id: 'status', label: 'Status', type: 'choice', value: (r) => itcStatusText(r), choices: ['ITC missing', 'Not checked'].map((v) => ({ value: v, label: v })) },
    { id: 'period', label: 'GSTR-2B', type: 'text', value: (r) => (r.period ? gstr2bPeriodLabel(r.period) : '') },
  ];
}

const fig = (m: bigint | undefined): string => (m === undefined ? '' : formatAmount(m));

export function gstr3bColumns(): ColumnSpec<Gstr3bRow>[] {
  const figure = (id: string, label: string, pick: (r: Gstr3bRow) => bigint | undefined): ColumnSpec<Gstr3bRow> => ({
    id,
    label,
    type: 'money',
    align: 'right',
    sortable: false,
    filterable: false,
    value: (r) => pick(r) ?? 0n,
    text: (r) => (r.heading ? '' : fig(pick(r))),
  });
  return [
    { id: 'label', label: 'Particulars', type: 'text', sortable: false, filterable: false, value: (r) => r.label, text: (r) => (r.heading ? r.label.toUpperCase() : r.label) },
    figure('taxable', 'Taxable value', (r) => r.taxable),
    figure('cgst', 'CGST', (r) => r.cgst),
    figure('sgst', 'SGST', (r) => r.sgst),
    figure('igst', 'IGST', (r) => r.igst),
    figure('total', 'Total tax', (r) => r.total),
  ];
}
