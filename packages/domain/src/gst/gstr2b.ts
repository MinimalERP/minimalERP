import type { LocalDate } from '../dates';
import { type Result, fail, issue, ok } from '../errors';
import { type Money, formatMoney, money } from '../money';
import type { GstInvoice } from '../reports/gst';

/**
 * GSTR-2B MATCHING: the statement the GST portal makes of what the company's suppliers filed (downloaded as JSON), set against the purchase
 * invoices in the books. Pure: the file is read into plain invoices, and each is found among the purchases by the supplier's GSTIN and
 * invoice number — so the books can say which purchases the portal agrees with, which differ, and which are missing on either side.
 * Only B2B invoices are matched; credit and debit notes, amendments and imports are counted, not matched (the books do not model them).
 */

export const GSTR2B_NOT_READ = 'GSTR2B_NOT_READ';

export interface Gstr2bInvoice {
  /** The supplier's GSTIN and trade name, as the portal has them. */
  readonly gstin: string;
  readonly supplier: string;
  /** The supplier's invoice number and date. */
  readonly number: string;
  readonly date: LocalDate | undefined;
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  /** The invoice value as the supplier filed it. */
  readonly value: Money;
  readonly reverseCharge: boolean;
  /** The portal's own verdict on the credit: false when it says the ITC is not available. */
  readonly itcAvailable: boolean;
}

export interface Gstr2bFile {
  /** Whose statement it is. */
  readonly gstin: string;
  /** The return period as the portal writes it: `MMYYYY` (a quarterly statement names the quarter's last month). */
  readonly period: string;
  readonly invoices: readonly Gstr2bInvoice[];
  /** What the file also holds and the matching leaves alone. */
  readonly skipped: { readonly creditNotes: number; readonly amendments: number; readonly imports: number };
}

const notRead = (message: string): Result<never> => fail(issue(GSTR2B_NOT_READ, message));

/** A rupee figure of the file (a JSON number, sometimes text) to the paisa. */
const paise = (v: unknown): Money => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  return money(BigInt(Math.round((Number.isFinite(n) ? n : 0) * 100)));
};

/** `29-04-2026` → `2026-04-29`. */
const dateOf = (v: unknown): LocalDate | undefined => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(typeof v === 'string' ? v.trim() : '');
  return m ? (`${m[3]}-${m[2]}-${m[1]}` as LocalDate) : undefined;
};

const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x !== null && typeof x === 'object') as Record<string, unknown>[]) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** The portal's GSTR-2B JSON (parsed) as its B2B invoices. A GSTR-1 file, or anything else, is refused by name. */
export function gstr2bFromJson(json: unknown): Result<Gstr2bFile> {
  if (json === null || typeof json !== 'object') return notRead('That is not a GSTR-2B file: download the JSON from Returns › GSTR-2B on the GST portal');
  const root = json as Record<string, unknown>;
  const data = root['data'] as Record<string, unknown> | undefined;
  if (data === undefined || data === null || typeof data !== 'object' || typeof data['docdata'] !== 'object' || data['docdata'] === null) {
    // GSTR-1 (the company's own sales return) has its GSTIN, period and b2b at the top
    if ('fp' in root && 'gstin' in root) return notRead('That is a GSTR-1 file (your own sales return), not GSTR-2B: download the JSON from Returns › GSTR-2B on the GST portal');
    return notRead('That is not a GSTR-2B file: download the JSON from Returns › GSTR-2B on the GST portal');
  }
  const doc = data['docdata'] as Record<string, unknown>;
  const invoices: Gstr2bInvoice[] = [];
  for (const s of list(doc['b2b'])) {
    for (const inv of list(s['inv'])) {
      // the summary download carries the figures on the invoice; the detailed one, rate by rate under `items`
      const items = list(inv['items']);
      const sum = (key: string): Money => (items.length > 0 ? money(items.reduce((t, it) => t + paise(it[key]), 0n)) : paise(inv[key]));
      invoices.push({
        gstin: text(s['ctin']).toUpperCase(),
        supplier: text(s['trdnm']),
        number: text(inv['inum']),
        date: dateOf(inv['dt']),
        taxable: sum('txval'),
        cgst: sum('cgst'),
        sgst: sum('sgst'),
        igst: sum('igst'),
        value: paise(inv['val']),
        reverseCharge: text(inv['rev']).toUpperCase() === 'Y',
        itcAvailable: text(inv['itcavl']).toUpperCase() !== 'N',
      });
    }
  }
  const notes = (key: string): number => list(doc[key]).reduce((n, s) => n + list(s['nt']).length, 0);
  const docs = (key: string, of: string): number => list(doc[key]).reduce((n, s) => n + Math.max(1, list(s[of]).length), 0);
  return ok({
    gstin: text(data['gstin']).toUpperCase(),
    period: text(data['rtnprd']),
    invoices,
    skipped: {
      creditNotes: notes('cdnr') + notes('cdnra'),
      amendments: list(doc['b2ba']).reduce((n, s) => n + list(s['inv']).length, 0),
      imports: docs('impg', 'boe') + docs('impgsez', 'boe'),
    },
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `062026` → "Jun 2026" (anything else as it is). */
export function gstr2bPeriodLabel(period: string): string {
  const m = /^(\d{2})(\d{4})$/.exec(period);
  const name = m ? MONTHS[Number(m[1]) - 1] : undefined;
  return m && name ? `${name} ${m[2]}` : period;
}

/**
 * An invoice number the way two people writing the same one agree on: letters and digits only, upper case, and no zeros in front of a run of
 * digits — so "INV/001", "inv-1" and "INV 01" are one number.
 */
export function normaliseInvoiceNo(number: string): string {
  return number
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((part) => part.replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, '')))
    .join('');
}

export type Gstr2bStatus = 'matched' | 'mismatch' | 'not-on-portal' | 'not-in-books';

export const GSTR2B_STATUS_LABELS: Readonly<Record<Gstr2bStatus, string>> = {
  matched: 'Matched',
  mismatch: 'Mismatch',
  'not-on-portal': 'Not on GST site',
  'not-in-books': 'Not in books',
};

export interface Gstr2bFigures {
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
}

export interface Gstr2bRow {
  readonly key: string;
  readonly status: Gstr2bStatus;
  readonly gstin: string;
  readonly supplier: string;
  /** The supplier's invoice number (as the file writes it when the file has it, else as the books do). */
  readonly number: string;
  /** The purchase voucher in the books, when there is one. */
  readonly voucherId?: string | undefined;
  readonly voucherNumber?: string | undefined;
  readonly partyId?: string | undefined;
  readonly bookDate?: LocalDate | undefined;
  readonly fileDate?: LocalDate | undefined;
  readonly book?: Gstr2bFigures | undefined;
  readonly file?: Gstr2bFigures | undefined;
  /** The invoice value as the supplier filed it. */
  readonly fileValue?: Money | undefined;
  /** The input tax this row is about: the file's when the portal has the invoice, else the books'. */
  readonly tax: Money;
  /** The file says the supplier charged no tax: the buyer pays it (reverse charge). */
  readonly reverseCharge?: boolean | undefined;
  /** What differs, or what the portal says about the credit. */
  readonly note: string;
  /** The period this purchase was tagged "GST matched" in, when it already is. */
  readonly tagged?: string | undefined;
}

/** Within a rupee: suppliers round each tax head their own way. */
const TOLERANCE = 100n;
const near = (a: bigint, b: bigint): boolean => (a > b ? a - b : b - a) <= TOLERANCE;
const taxOf = (f: Gstr2bFigures): Money => money(f.cgst + f.sgst + f.igst);
const keyOf = (gstin: string, number: string): string => `${gstin.trim().toUpperCase()}|${normaliseInvoiceNo(number)}`;

/**
 * The file against the books. `purchases` are ALL the posted purchase invoices (a supplier often files in a later period than the purchase
 * was entered, so a file invoice is looked for whatever its date); `range` is the period being looked at — its purchases that the file does
 * not have, and that were not matched in an earlier period (`tagged`: voucher id → period), are "not on the GST site".
 */
export function matchGstr2b({
  file,
  purchases,
  range,
  tagged = new Map(),
}: {
  file: Gstr2bFile;
  purchases: readonly GstInvoice[];
  range: { readonly from: LocalDate; readonly to: LocalDate };
  tagged?: ReadonlyMap<string, string>;
}): Gstr2bRow[] {
  const byKey = new Map<string, GstInvoice[]>();
  for (const p of purchases) {
    if (p.gstin === '' || p.billNo === undefined) continue;
    const k = keyOf(p.gstin, p.billNo);
    const at = byKey.get(k);
    if (at) at.push(p);
    else byKey.set(k, [p]);
  }
  const used = new Set<string>();
  const rows: Gstr2bRow[] = [];
  file.invoices.forEach((inv, i) => {
    const fileFigures: Gstr2bFigures = { taxable: inv.taxable, cgst: inv.cgst, sgst: inv.sgst, igst: inv.igst };
    const flags = [inv.reverseCharge ? 'Reverse charge: the GST is paid by you, not on the voucher' : '', inv.itcAvailable ? '' : 'The portal says ITC is not available'].filter((s) => s !== '');
    const found = (byKey.get(keyOf(inv.gstin, inv.number)) ?? []).find((p) => !used.has(p.voucherId));
    if (!found) {
      rows.push({ key: `file:${i}`, status: 'not-in-books', gstin: inv.gstin, supplier: inv.supplier, number: inv.number, fileDate: inv.date, file: fileFigures, fileValue: inv.value, tax: taxOf(fileFigures), reverseCharge: inv.reverseCharge, note: flags.join(' · ') });
      return;
    }
    used.add(found.voucherId);
    const book: Gstr2bFigures = { taxable: found.taxable, cgst: found.cgst, sgst: found.sgst, igst: found.igst };
    // under reverse charge the supplier bills no tax (the buyer pays it), so the books' voucher holds none: the taxable value is what agrees
    const differs = (inv.reverseCharge ? (['taxable'] as const) : (['taxable', 'cgst', 'sgst', 'igst'] as const))
      .filter((k) => !near(book[k], fileFigures[k]))
      .map((k) => `${k === 'taxable' ? 'Taxable' : k.toUpperCase()} ${formatMoney(fileFigures[k])} on the GST site, ${formatMoney(book[k])} in the books`);
    rows.push({
      key: `file:${i}`,
      status: differs.length === 0 ? 'matched' : 'mismatch',
      gstin: inv.gstin,
      supplier: found.party || inv.supplier,
      number: inv.number,
      voucherId: found.voucherId,
      voucherNumber: found.number,
      partyId: found.partyId,
      bookDate: found.date,
      fileDate: inv.date,
      book,
      file: fileFigures,
      fileValue: inv.value,
      tax: taxOf(fileFigures),
      reverseCharge: inv.reverseCharge,
      note: [...differs, ...flags].join(' · '),
      tagged: tagged.get(found.voucherId),
    });
  });
  for (const p of purchases) {
    if (used.has(p.voucherId) || p.date < range.from || p.date > range.to) continue;
    // only what a credit is claimed on: a registered supplier's invoice with tax, not already matched in an earlier period
    if (p.gstin === '' || p.tax <= 0n || tagged.has(p.voucherId)) continue;
    const book: Gstr2bFigures = { taxable: p.taxable, cgst: p.cgst, sgst: p.sgst, igst: p.igst };
    rows.push({ key: `book:${p.voucherId}`, status: 'not-on-portal', gstin: p.gstin, supplier: p.party, number: p.billNo ?? '', voucherId: p.voucherId, voucherNumber: p.number, partyId: p.partyId, bookDate: p.date, book, tax: p.tax, note: '' });
  }
  const order: Readonly<Record<Gstr2bStatus, number>> = { mismatch: 0, 'not-in-books': 1, 'not-on-portal': 2, matched: 3 };
  return rows.sort((a, b) => order[a.status] - order[b.status] || a.supplier.localeCompare(b.supplier) || a.number.localeCompare(b.number));
}

/** The GST rates invoices are charged at. */
const GST_RATES = ['0.1', '0.25', '1', '1.5', '3', '5', '6', '7.5', '12', '18', '28'] as const;

/**
 * The one rate an invoice's tax implies: the GST rate whose tax on the taxable value is the file's, within a rupee. Undefined when no rate
 * fits (an invoice at two rates, say) or there is no tax.
 */
export function gstRateOfFigures(f: Gstr2bFigures): string | undefined {
  const tax = f.cgst + f.sgst + f.igst;
  if (f.taxable <= 0n || tax <= 0n) return undefined;
  // rates in thousandths of a percent, so 0.25 is exact
  return GST_RATES.find((r) => near((f.taxable * BigInt(Math.round(Number(r) * 1000))) / 100_000n, tax));
}

/** How many rows, and how much input tax, each status holds. */
export function gstr2bTotals(rows: readonly Gstr2bRow[]): Record<Gstr2bStatus, { count: number; tax: Money }> {
  const out: Record<Gstr2bStatus, { count: number; tax: Money }> = {
    matched: { count: 0, tax: money(0n) },
    mismatch: { count: 0, tax: money(0n) },
    'not-on-portal': { count: 0, tax: money(0n) },
    'not-in-books': { count: 0, tax: money(0n) },
  };
  for (const r of rows) out[r.status] = { count: out[r.status].count + 1, tax: money(out[r.status].tax + r.tax) };
  return out;
}
