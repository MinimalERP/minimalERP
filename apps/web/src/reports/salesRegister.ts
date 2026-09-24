import { type ColumnSpec, type LocalDate, type Masters, type Money, type Qty, type Voucher, formatQty, gstInvoices, money } from '@minimalerp/domain';
import { formatDate } from '../vouchers/format';

/**
 * The Sales Register: ONE ROW PER SALES INVOICE LINE — item, quantity, rate and GST — so an invoice can be read item
 * by item instead of voucher by voucher. A thin flattening of `gstInvoices()` (the same posted-invoice reading the
 * GSTR-1 report already uses): nothing here re-derives GST math, it only reshapes what that function already computed.
 */

export interface SalesRegisterRow {
  /** Unique per invoice line. */
  readonly key: string;
  readonly voucherId: string;
  readonly number: string;
  readonly date: LocalDate;
  readonly party: string;
  readonly gstin: string;
  readonly itemId?: string | undefined;
  /** The item's name, or a one-time line's own description. */
  readonly item: string;
  readonly hsn: string;
  readonly unit: string;
  readonly qty: Qty;
  /** The line's GST rate, as a percentage (e.g. "18"), or "" when untaxed. */
  readonly ratePercent: string;
  readonly taxable: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  /** Taxable + CGST + SGST + IGST. */
  readonly value: Money;
}

/** One row per line of every posted Sales Invoice dated in the period, oldest invoice first. */
export function salesRegisterRows(vouchers: readonly Voucher[], masters: Masters, from: LocalDate, to: LocalDate): SalesRegisterRow[] {
  const invoices = gstInvoices({ vouchers, masters, side: 'sales', range: { from, to } });
  return invoices.flatMap((inv) =>
    inv.lines.map((l, i) => ({
      key: `${inv.voucherId}|${i}`,
      voucherId: inv.voucherId,
      number: inv.number,
      date: inv.date,
      party: inv.party,
      gstin: inv.gstin,
      itemId: l.itemId,
      item: l.description,
      hsn: l.hsn,
      unit: l.uqc,
      qty: l.qty,
      ratePercent: l.rate,
      taxable: l.taxable,
      cgst: l.cgst,
      sgst: l.sgst,
      igst: l.igst,
      value: money(l.taxable + l.cgst + l.sgst + l.igst),
    })),
  );
}

const num = (m: Money): number => Number(m) / 100;

export function salesRegisterColumns(): ColumnSpec<SalesRegisterRow>[] {
  return [
    { id: 'number', label: 'Invoice no.', type: 'text', value: (r) => r.number },
    { id: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => formatDate(r.date) },
    { id: 'party', label: 'Party', type: 'text', value: (r) => r.party },
    { id: 'item', label: 'Item', type: 'text', value: (r) => r.item },
    { id: 'hsn', label: 'HSN', type: 'text', value: (r) => r.hsn },
    { id: 'qty', label: 'Qty', type: 'number', align: 'right', value: (r) => Number(r.qty), text: (r) => `${formatQty(r.qty, 0)} ${r.unit === 'OTH' ? '' : r.unit}`.trim() },
    { id: 'rate', label: 'GST %', type: 'text', align: 'right', value: (r) => r.ratePercent },
    { id: 'taxable', label: 'Taxable', type: 'number', align: 'right', value: (r) => num(r.taxable), text: (r) => (num(r.taxable)).toFixed(2) },
    { id: 'cgst', label: 'CGST', type: 'number', align: 'right', value: (r) => num(r.cgst), text: (r) => (num(r.cgst)).toFixed(2) },
    { id: 'sgst', label: 'SGST', type: 'number', align: 'right', value: (r) => num(r.sgst), text: (r) => (num(r.sgst)).toFixed(2) },
    { id: 'igst', label: 'IGST', type: 'number', align: 'right', value: (r) => num(r.igst), text: (r) => (num(r.igst)).toFixed(2) },
    { id: 'value', label: 'Value', type: 'number', align: 'right', value: (r) => num(r.value), text: (r) => (num(r.value)).toFixed(2) },
  ];
}

/** Newest invoice first, each invoice's lines still in the order they were entered (a plain reverse would turn every invoice upside down). */
export function newestInvoicesFirst<R extends { readonly voucherId: string }>(rows: readonly R[]): R[] {
  const groups: R[][] = [];
  for (const r of rows) {
    const last = groups.at(-1);
    if (last && last[0]?.voucherId === r.voucherId) last.push(r);
    else groups.push([r]);
  }
  return groups.reverse().flat();
}
