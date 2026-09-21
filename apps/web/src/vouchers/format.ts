import { type LocalDate, type Qty, formatQty, parseLocalDate } from '@minimalerp/domain';

/** Indian digit grouping: 1234567.5 → "12,34,567.50". `minor` is paise. */
export function formatAmount(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, '0');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${negative ? '-' : ''}${grouped}.${frac}`;
}

/** A stock quantity with the unit's decimals and Indian digit grouping: 2500 with three places → "2,500.000". */
export function formatQuantity(q: Qty, unitDecimals = 0): string {
  const plain = formatQty(q, unitDecimals);
  const negative = plain.startsWith('-');
  const [whole = '0', frac] = (negative ? plain.slice(1) : plain).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${negative ? '-' : ''}${grouped}${frac === undefined ? '' : `.${frac}`}`;
}

/** A signed balance (debit positive) as Tally shows it: "8,50,000.00 Dr", "1,200.00 Cr", "0.00". */
export function formatBalance(signed: bigint): string {
  if (signed === 0n) return '0.00';
  return `${formatAmount(signed < 0n ? -signed : signed)} ${signed > 0n ? 'Dr' : 'Cr'}`;
}

/**
 * A cash or bank balance read the way a person thinks of money in hand: "+₹600.00 Dr" is money available, "−₹600.00 Cr" is overdrawn.
 * The sign is only a clarification — the Dr/Cr that accounting uses is still there, and the ledger's balance is unchanged.
 */
export function formatCashBalance(signed: bigint): string {
  if (signed === 0n) return '₹0.00';
  const amount = formatAmount(signed < 0n ? -signed : signed);
  return signed > 0n ? `+₹${amount} Dr` : `−₹${amount} Cr`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2024-05-10" → "10-May-2024". */
export function formatDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${Number(m[3])}-${MONTHS[Number(m[2]) - 1]}-${m[1]}` : date;
}

/** "2024-05-10" → "Fri". */
export function weekday(date: string): string {
  const d = parseLocalDate(date);
  if (!d) return '';
  const probe = new Date(0);
  probe.setUTCFullYear(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return DAYS[probe.getUTCDay()] ?? '';
}

export interface DateContext {
  /** The financial year the voucher belongs to (a bare "10-5" means 10 May of THIS year). */
  readonly start: string;
  readonly end: string;
  /** What "10" alone is relative to: the date already on the form. */
  readonly base: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * What a person types for a date: `10`, `10-5`, `10/5/24`, `10.05.2024`, `2024-05-10` — or the way the window shows it, `10-May-2024` (the month may be a name). A missing month is the current form date's month; a
 * missing year is whichever year puts that day inside the financial year. Returns undefined for anything that is not a real date.
 */
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseDateInput(text: string, ctx: DateContext): LocalDate | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const iso = parseLocalDate(t);
  if (iso) return iso;

  const parts = t.split(/[-/. ]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return undefined;
  const [dayText, monthText, yearText] = parts as [string, string?, string?];
  // Only the month may be a name ("May", "september"); the day and the year are digits.
  const nameIndex = monthText !== undefined && /^[A-Za-z]{3,9}$/.test(monthText) ? MONTH_NAMES.indexOf(monthText.slice(0, 3).toLowerCase()) + 1 : 0;
  const digits = (p: string | undefined) => p === undefined || /^\d+$/.test(p);
  if (!digits(dayText) || !digits(yearText) || (nameIndex === 0 && !digits(monthText))) return undefined;
  const day = Number(dayText);
  const baseMonth = Number(ctx.base.slice(5, 7));
  const month = monthText === undefined ? baseMonth : nameIndex > 0 ? nameIndex : Number(monthText);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  const tryYear = (year: number) => parseLocalDate(`${year}-${pad(month)}-${pad(day)}`);
  if (yearText !== undefined) {
    const y = Number(yearText);
    return tryYear(yearText.length <= 2 ? 2000 + y : y);
  }
  const startYear = Number(ctx.start.slice(0, 4));
  for (const year of [startYear, startYear + 1]) {
    const candidate = tryYear(year);
    if (candidate && candidate >= ctx.start && candidate <= ctx.end) return candidate;
  }
  return tryYear(startYear);
}

/** Tolerant money typing: "12,000", " 1 200.5 " → "12000", "1200.50". Returns undefined if it is not an amount. */
export function normalizeAmount(text: string): string | undefined {
  const t = text.replace(/[,\s₹]/g, '');
  if (t === '') return undefined;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  return m ? `${m[1]}.${(m[2] ?? '').padEnd(2, '0')}` : undefined;
}

/** `date` plus `days` calendar days, as an ISO date (used for bill due dates: bill date + the party's credit days). */
export function addDays(date: string, days: number): string {
  const d = parseLocalDate(date);
  if (!d) return date;
  const probe = new Date(0);
  probe.setUTCFullYear(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) + days);
  return probe.toISOString().slice(0, 10);
}
