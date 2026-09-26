import { type Masters, type Money, type Qty, type Voucher, parseQty, qty } from '@minimalerp/domain';
import type { Books } from '../books/books';
import type { DocketDoc, InvoiceDoc } from '../ui/PrintView';
import { placeOfSupplyText } from '../ui/printing';
import { formatQuantity } from './format';
import type { ItemDocKind } from './kinds';
import { type SalesForm, type SalesLineForm, type SalesPreview, previewSales, salesFormFromVoucher, salesKindOf } from './salesModel';

/**
 * An item document (invoice / order / quotation) as it prints — the same figures the screen shows: every amount comes from
 * `preview.amounts`/`total`/`gst`/`grand`, indexed exactly as `previewSales` computed them, so a printed figure can never disagree with it.
 */
export function invoiceDocOf(voucher: Voucher, form: SalesForm, kind: ItemDocKind, preview: SalesPreview, masters: Masters): InvoiceDoc | undefined {
  const type = masters.voucherType(form.typeId as never);
  if (!type) return undefined;
  const details = form.partyDetails;
  const lines = form.lines
    .map((l, i) => ({ l, amount: preview.amounts.get(i) }))
    .filter((x): x is { l: SalesLineForm; amount: Money } => (x.l.itemId !== '' || x.l.oneTime === true) && x.amount !== undefined)
    .map(({ l, amount }) => {
      const unit = unitOfLine(l, masters);
      const q = parseQty(l.qty.trim());
      return {
        desc: l.itemLabel,
        hsn: l.hsn,
        qty: q !== undefined ? `${formatQuantity(q, unit?.decimals ?? 0)} ${unit?.symbol ?? l.unit ?? ''}`.trim() : l.qty,
        rate: l.rate,
        amount,
        gstRate: l.gstRate,
      };
    });
  return {
    kind: 'invoice',
    voucherKind: kind,
    docTitle: kind === 'sales' && masters.company.chargeGst === true ? 'Tax Invoice' : type.name,
    numberLabel: kind === 'sales' ? 'Invoice No.' : undefined,
    number: voucher.number,
    date: voucher.date,
    poNo: form.reference || undefined,
    ewayBillNo: kind === 'sales' ? form.ewayBillNo || undefined : undefined,
    placeOfSupply: placeOfSupplyText(details?.shipTo?.stateCode ?? details?.billTo?.stateCode ?? details?.placeOfSupply),
    party: { name: details?.mailingName ?? form.partyLabel, gstin: details?.gstin, billTo: details?.billTo, shipTo: details?.shipTo },
    lines,
    subtotal: preview.total,
    gst: preview.gst,
    roundOff: preview.roundOff,
    grandTotal: preview.grand,
    narration: form.narration || undefined,
  };
}

/** A one-time line prints with the unit chosen in its Alt+T form. */
const unitOfLine = (l: SalesLineForm, masters: Masters) => {
  const item = l.itemId !== '' ? masters.stockItem(l.itemId as never) : undefined;
  return item ? masters.unit(item.unitId) : masters.units.find((u) => u.symbol === l.unit);
};

/** A saved item document read back from the books (what a list prints for each chosen voucher). */
function readBack(voucher: Voucher, books: Books): { form: SalesForm; kind: ItemDocKind; preview: SalesPreview } | undefined {
  const kind = salesKindOf(books.masters, voucher.voucherTypeId) as ItemDocKind | undefined;
  if (!kind) return undefined;
  const form = salesFormFromVoucher(voucher, books.masters, books.orders);
  return { form, kind, preview: previewSales(form, kind, books.masters, books.stock, books.orders, undefined, books.vouchers) };
}

/** Whether a voucher is one of the item documents — the ones that print from a list. */
export const isItemDoc = (voucher: Voucher, books: Books): boolean => salesKindOf(books.masters, voucher.voucherTypeId) !== undefined;

export function invoiceDocFromBooks(voucher: Voucher, books: Books): InvoiceDoc | undefined {
  const r = readBack(voucher, books);
  return r ? invoiceDocOf(voucher, r.form, r.kind, r.preview, books.masters) : undefined;
}

/** Why these vouchers cannot make one docket (not sales invoices, or not of one customer) — undefined when they can. */
export function docketProblem(vouchers: readonly Voucher[], books: Books): string | undefined {
  const d = dispatchDocketOf(vouchers, books, { dispatchNo: '', date: '', packages: '', transporter: '', lrNo: '' });
  return typeof d === 'string' ? d : undefined;
}

/** What the person types for a docket (the rest comes from the invoices). */
export interface DocketDetails {
  readonly dispatchNo: string;
  readonly date: string;
  readonly packages: string;
  readonly transporter: string;
  readonly lrNo: string;
}

/**
 * A dispatch docket for invoices of ONE customer: page one lists the invoices (number, PO, amount) and the consignment; page two every
 * item on them, like items added together. Undefined with a reason when the invoices are not of one customer.
 */
export function dispatchDocketOf(vouchers: readonly Voucher[], books: Books, d: DocketDetails): DocketDoc | string {
  const read = vouchers.map((v) => ({ v, r: readBack(v, books) })).filter((x): x is { v: Voucher; r: NonNullable<ReturnType<typeof readBack>> } => x.r !== undefined);
  if (read.length === 0 || read.some((x) => x.r.kind !== 'sales')) return 'A dispatch docket is made from sales invoices.';
  const first = read[0]!.r.form;
  if (read.some((x) => x.r.form.partyId !== first.partyId)) return 'A dispatch docket is for one customer: choose invoices of the same customer.';
  const masters = books.masters;
  const items = new Map<string, { desc: string; hsn: string | undefined; unit: string; decimals: number; qty: Qty }>();
  for (const { r } of read) {
    for (const l of r.form.lines) {
      if (l.itemId === '' && l.oneTime !== true) continue;
      const q = parseQty(l.qty.trim());
      if (q === undefined) continue;
      const unit = unitOfLine(l, masters);
      const key = l.itemId !== '' ? l.itemId : `${l.itemLabel.trim().toLowerCase()}|${unit?.symbol ?? l.unit ?? ''}`;
      const had = items.get(key);
      if (had) had.qty = qty(had.qty + q);
      else items.set(key, { desc: l.itemLabel, hsn: l.hsn || undefined, unit: unit?.symbol ?? l.unit ?? '', decimals: unit?.decimals ?? 0, qty: q });
    }
  }
  // the total quantity, per unit (Nos and Kg are not added together)
  const perUnit = new Map<string, { decimals: number; qty: Qty }>();
  for (const i of items.values()) {
    const had = perUnit.get(i.unit);
    if (had) had.qty = qty(had.qty + i.qty);
    else perUnit.set(i.unit, { decimals: i.decimals, qty: i.qty });
  }
  const details = first.partyDetails;
  return {
    kind: 'docket',
    number: d.dispatchNo,
    date: d.date,
    party: { name: details?.mailingName ?? first.partyLabel, gstin: details?.gstin, billTo: details?.billTo, shipTo: details?.shipTo },
    invoices: read.map(({ v, r }) => ({ number: v.number, date: v.date, poNo: r.form.reference || undefined, amount: r.preview.grand })),
    packages: d.packages,
    transporter: d.transporter,
    lrNo: d.lrNo,
    items: [...items.values()].map((i) => ({ desc: i.desc, hsn: i.hsn, qty: `${formatQuantity(i.qty, i.decimals)} ${i.unit}`.trim() })),
    totalQty: [...perUnit.entries()].map(([unit, t]) => `${formatQuantity(t.qty, t.decimals)} ${unit}`.trim()).join(' + '),
  };
}
