import { type Gstr2bRow, type Masters, type Money, type OrderBook, type StockBook, type Voucher, canonicalId, formatMoney, gstRateOfFigures } from '@minimalerp/domain';
import { type Option, type SalesForm, blankSalesForm, blankSalesLine, previewSales, withPurchasePrefill } from '../vouchers/salesModel';

/**
 * Posting every invoice GSTR-2B has of ONE supplier and the books do not, in one go — for suppliers whose invoices are always the same one
 * line (local transport, a subscription). Each becomes an ordinary Purchase invoice: its date and number from the file, one written line for
 * the file's taxable value. Nothing is guessed: the line is the supplier's last one (or typed once), the GST rate is the one the file's tax
 * implies and must come to the file's figures, and anything that does not fit is left out with the reason.
 */

/** What every invoice of the batch is entered with. */
export interface BulkEntry {
  /** The one written line: what was bought. */
  readonly text: string;
  readonly unit: string;
  readonly hsn: string;
  readonly ledgerId: string;
  readonly ledgerLabel: string;
}

export interface BulkTemplate extends BulkEntry {
  /** The purchase it was taken from. */
  readonly from: string;
}

/** The active vendor with this GSTIN. */
export const vendorOfGstin = (masters: Masters, gstin: string) => masters.parties.find((p) => p.isActive && (p.roles ?? []).includes('vendor') && canonicalId(p.gstin ?? '') === canonicalId(gstin));

/**
 * The line to repeat: the supplier's LATEST posted purchase, when it is one written (one-time) line — its text, unit, HSN / SAC and the
 * purchase ledger it was booked to. A purchase of stock items, or of several lines, is not something to repeat blindly: none.
 */
export function templateOf(vouchers: readonly Voucher[], masters: Masters, gstin: string): BulkTemplate | undefined {
  const party = vendorOfGstin(masters, gstin);
  if (!party) return undefined;
  let last: Voucher | undefined;
  for (const v of vouchers) {
    if (v.status !== 'posted' || masters.voucherType(v.voucherTypeId)?.baseKind !== 'purchase') continue;
    if ((v.content as { partyId?: string }).partyId !== party.id) continue;
    if (!last || v.date >= last.date) last = v;
  }
  const c = last?.content as { purchaseLedgerId?: string; lines?: { itemId?: string; description?: string; unit?: string; hsn?: string }[] } | undefined;
  const line = c?.lines?.length === 1 ? c.lines[0] : undefined;
  const ledger = c?.purchaseLedgerId ? masters.ledger(c.purchaseLedgerId as never) : undefined;
  if (!last || !line || line.itemId !== undefined || !line.description) return undefined;
  return { text: line.description, unit: line.unit ?? '', hsn: line.hsn ?? '', ledgerId: ledger?.isActive ? ledger.id : '', ledgerLabel: ledger?.isActive ? ledger.name : '', from: last.number };
}

/** The ledger a typed name means: the one called exactly that, else the only one that starts with it. */
export function optionByName(options: readonly Option[], text: string): Option | undefined {
  const t = text.trim().toLowerCase();
  if (t === '') return undefined;
  const exact = options.find((o) => o.name.toLowerCase() === t);
  if (exact) return exact;
  const starts = options.filter((o) => o.name.toLowerCase().startsWith(t));
  return starts.length === 1 ? starts[0] : undefined;
}

export interface BulkReady {
  readonly row: Gstr2bRow;
  readonly draft: Record<string, unknown>;
  readonly taxable: Money;
  /** The GST the voucher states (nothing under reverse charge). */
  readonly tax: Money;
  readonly total: Money;
}

export interface BulkLeftOut {
  readonly row: Gstr2bRow;
  readonly reason: string;
}

const rupees = (m: bigint): string => `${m / 100n}.${String(m % 100n).padStart(2, '0')}`;
const near = (a: bigint, b: bigint): boolean => (a > b ? a - b : b - a) <= 100n;

/**
 * The purchase invoices for the supplier's missing rows, each checked by the same engine the purchase window uses (so a number the supplier
 * already has, or a date the books do not take, is found here) and against the file's GST. `newId` makes the ids the vouchers post under.
 */
export function bulkPurchases(a: {
  rows: readonly Gstr2bRow[];
  entry: BulkEntry;
  masters: Masters;
  stock: StockBook;
  orders: OrderBook;
  vouchers: readonly Voucher[];
  newId: () => string;
}): { ready: BulkReady[]; leftOut: BulkLeftOut[] } {
  const { masters } = a;
  const typeId = (masters.voucherTypes.find((t) => t.baseKind === 'purchase' && t.isSystem) ?? masters.voucherTypes.find((t) => t.baseKind === 'purchase'))?.id;
  const ready: BulkReady[] = [];
  const leftOut: BulkLeftOut[] = [];
  const seen = new Set<string>();
  for (const row of a.rows) {
    const out = (reason: string) => void leftOut.push({ row, reason });
    if (row.status !== 'not-in-books' || !row.file) continue;
    if (!typeId) {
      out('This company has no Purchase voucher type');
      continue;
    }
    if (!vendorOfGstin(masters, row.gstin)) {
      out(`No supplier with GSTIN ${row.gstin} in the books: create the party first (Enter on the row, then Alt+C)`);
      continue;
    }
    const date = row.fileDate;
    if (!date || !masters.financialYears.some((fy) => date >= fy.start && date <= fy.end)) {
      out(date ? 'Its date is outside this company’s financial years' : 'The file gives it no date');
      continue;
    }
    if (seen.has(row.number.trim().toLowerCase())) {
      out('The file has this number twice for the supplier');
      continue;
    }
    const fileTax = row.file.cgst + row.file.sgst + row.file.igst;
    // under reverse charge the supplier bills no tax: the voucher is for the taxable value alone
    const charged = !row.reverseCharge && fileTax > 0n;
    const rate = charged ? gstRateOfFigures(row.file) : undefined;
    if (charged && rate === undefined) {
      out('Its GST fits no single rate (an invoice at two rates?): enter it by hand');
      continue;
    }
    const blank = blankSalesForm(a.newId(), typeId, date, a.newId(), { salesLedger: { id: a.entry.ledgerId, label: a.entry.ledgerLabel } });
    const form: SalesForm = {
      ...withPurchasePrefill(blank, { supplier: row.supplier, gstin: row.gstin, billNo: row.number, date, note: '' }, masters),
      lines: [{ ...blankSalesLine(a.newId()), oneTime: true, itemLabel: a.entry.text.trim(), unit: a.entry.unit.trim(), hsn: a.entry.hsn.trim(), qty: '1', rate: rupees(row.file.taxable), gstRate: rate ?? '', due: '', dueText: '' }],
    };
    const preview = previewSales(form, 'purchase', masters, a.stock, a.orders, undefined, a.vouchers);
    if (!preview.ok) {
      out(preview.issues[0]?.message ?? 'The books refuse it');
      continue;
    }
    const g = preview.gst ?? { cgst: 0n, sgst: 0n, igst: 0n };
    if (charged && !(near(g.cgst, row.file.cgst) && near(g.sgst, row.file.sgst) && near(g.igst, row.file.igst))) {
      out(`Its GST would come to CGST ${formatMoney(g.cgst as Money)}, SGST ${formatMoney(g.sgst as Money)}, IGST ${formatMoney(g.igst as Money)} — not what the GST site has: check the supplier’s state`);
      continue;
    }
    seen.add(row.number.trim().toLowerCase());
    ready.push({ row, draft: preview.draft, taxable: row.file.taxable, tax: (g.cgst + g.sgst + g.igst) as Money, total: preview.grand });
  }
  return { ready, leftOut };
}
