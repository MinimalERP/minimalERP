import { type Masters, type Money, type Qty, type Voucher, parseQty, qty } from '@minimalerp/domain';
import type { Books } from '../books/books';
import type { DocketDoc, InvoiceDoc } from '../ui/PrintView';
import { placeOfSupplyText } from '../ui/printing';
import { formatQuantity } from './format';
import { type ItemDocKind, docProfile, receivedAtOurs } from './kinds';
import { type SalesForm, type SalesLineForm, type SalesPreview, previewSales, salesFormFromVoucher, salesKindOf } from './salesModel';

const RETURNABLE_TITLE = 'Returnable Delivery Challan';

/** What a returnable challan prints in place of the company's invoice terms: the goods are lent, not sold. */
export const RETURNABLE_TERMS: readonly string[] = [
  'The goods are sent on a returnable basis for job work, repair or testing. This is not a sale: the goods remain our property.',
  'The value shown is declared for transport and insurance only. Nothing is payable against this challan.',
  'Return the goods in full and in good condition by the agreed date, quoting this challan number on your delivery document.',
  'The goods are at your risk while in your custody. Any loss, damage or shortage will be charged at the value stated.',
  'The goods are not to be used for any other purpose, or passed to a third party, without our written consent.',
  'Process scrap and rejected pieces are to be returned or accounted for along with the goods.',
  'Goods not returned within the time allowed under GST law will be treated as supplied and invoiced with tax.',
];

/** What a purchase order prints in place of the company's invoice terms: what we, the buyer, ask of the supplier. */
export const PURCHASE_ORDER_TERMS: readonly string[] = [
  'Quote this Purchase Order number on your invoice, delivery challan and all correspondence.',
  'Supply strictly as per the description, drawing, specification and quantity ordered. Excess or substitute supply will not be accepted without our written consent.',
  'Deliver on or before the due date stated. We may cancel the order, in full or in part, for goods not delivered in time.',
  'All goods are subject to our inspection on receipt. Rejected goods will be returned at your cost and risk, and debited to your account.',
  'The prices in this order are firm. No increase will be accepted without our written amendment to this order.',
  'Send a tax invoice showing our GSTIN and the HSN code along with the goods, and test certificates where applicable.',
  'Payment will be made as per the agreed credit terms, counted from the date the goods are received and accepted.',
];

/** What an issued Sales Order prints: confirmation that we accept the customer's purchase order, not invoice payment boilerplate. */
export const SALES_ORDER_TERMS: readonly string[] = [
  'This Sales Order confirms our acceptance of the customer purchase order or reference shown above.',
  'The items, specifications, quantities, rates and delivery dates stated in this Sales Order form the accepted order.',
  'Prices are in INR. GST and other statutory taxes are charged as shown or as applicable on the invoice.',
  'Packing, forwarding, freight and insurance are included only where expressly stated; otherwise they will be charged as agreed.',
  'Delivery will follow the dates stated against each line, subject to receipt of complete specifications, approvals and any agreed advance.',
  'Partial deliveries may be made unless the parties have agreed otherwise in writing.',
  'Payment is due as per the credit terms agreed between the parties and will be invoiced on dispatch or delivery, as applicable.',
  'Changes or cancellation after acceptance require our written agreement; costs already incurred for the order remain payable.',
  'Please quote both this Sales Order number and your purchase order number in correspondence and payment advice.',
];

/** What a debit note prints in place of the company's invoice terms: it goes to a supplier, for goods sent back or a price put right. */
export const DEBIT_NOTE_TERMS: readonly string[] = [
  'The amount of this note has been debited to your account, against your invoice quoted above.',
  'Please issue a credit note for this amount with GST, quoting this note number, so that the tax can be adjusted in the returns.',
  'The amount will be adjusted against our payments due to you. Where nothing is due, please refund it.',
  'Goods returned with this note are at your risk from the time of dispatch. Please acknowledge their receipt.',
  'Any discrepancy is to be reported in writing within 7 days of receipt. Otherwise this note will be taken as accepted.',
];

/** What a quotation prints in place of the company's invoice terms: the standard terms of an offer. */
export const QUOTATION_TERMS: readonly string[] = [
  'Valid for 7 days from the date of this quotation.',
  'Prices in INR, ex-works, for the quantities and specifications quoted. GST and other taxes extra, unless shown above.',
  'Packing, forwarding, freight and insurance extra, unless stated.',
  'Delivery as agreed, from receipt of your purchase order with complete technical details.',
  'Any change in drawing, specification or quantity may change price and delivery.',
  'Payment as per agreed credit terms, from the invoice date.',
  'Accepted orders cannot be cancelled without our written consent.',
  'Defects in material or workmanship, reported in writing within 7 days of receipt, will be repaired or replaced. No liability for consequential loss.',
  'Please quote this quotation number on your purchase order.',
  'Subject to the jurisdiction of the courts at our place of business.',
];

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
        // a quotation's item line prints its own description (Alt+W) under the item's name
        desc: l.itemId !== '' && (l.details ?? '').trim() !== '' ? `${l.itemLabel}\n${(l.details ?? '').trim()}` : l.itemLabel,
        // a line keeps the HSN / SAC only where GST is charged: elsewhere the item's own code still prints
        hsn: l.hsn || itemHsnOf(l, masters),
        qty: q !== undefined ? `${formatQuantity(q, unit?.decimals ?? 0)} ${unit?.symbol ?? l.unit ?? ''}`.trim() : l.qty,
        rate: l.rate,
        amount,
        gstRate: l.gstRate,
      };
    });
  const foc = kind === 'deliveryChallan' && form.purpose === 'foc';
  const returnable = kind === 'returnableChallan';
  const delivery = kind === 'deliveryChallan';
  const note = kind === 'creditNote' || kind === 'debitNote';
  // a note prints the invoice it is for where an invoice prints its PO
  const noteFor = note && form.billNo.trim() !== '' ? form.billNo.trim() : undefined;
  // a purchase or a purchase order comes to us: it is shipped to our address unless another was written on it. The supplier's own
  // shipping address (documents made before this kept it as the ship-to) is where they send from, never where we receive.
  const ours = receivedAtOurs(kind);
  const supplierOwn = ours && form.partyId !== '' ? masters.party(form.partyId as never)?.shipping?.lines?.trim() : undefined;
  const chosen = ours && details?.shipTo?.lines?.trim() === supplierOwn ? undefined : details?.shipTo;
  const shipTo = ours ? { ...(chosen ?? { lines: masters.company.address }), name: chosen?.name ?? masters.company.name } : details?.shipTo;
  return {
    kind: 'invoice',
    voucherKind: kind,
    // a delivery challan's title is its name alone, centred; that it is free of charge is said in the narration.
    // A returnable challan says what it is whatever its type was named: a delivery challan, to be returned.
    docTitle: kind === 'sales' && masters.company.chargeGst === true ? 'Tax Invoice' : returnable ? (form.returnOf ? `${RETURNABLE_TITLE} – Goods Returned` : RETURNABLE_TITLE) : type.name,
    ...(delivery ? { titleCentred: true, poLabel: 'PO / Ref.' } : {}),
    ...(returnable ? { titleCentred: true, poLabel: 'Reference', returnable: { terms: form.returnOf ? [] : RETURNABLE_TERMS, acknowledge: !form.returnOf } } : {}),
    ...(note ? { poLabel: noteFor ? 'Against Inv.' : 'Reference' } : {}),
    ...(kind === 'salesOrder'
      ? { ownTerms: SALES_ORDER_TERMS }
      : kind === 'purchaseOrder'
        ? { ownTerms: PURCHASE_ORDER_TERMS }
        : kind === 'debitNote'
          ? { ownTerms: DEBIT_NOTE_TERMS }
          : kind === 'quotation'
            ? { ownTerms: QUOTATION_TERMS }
            : {}),
    numberLabel: kind === 'sales' ? 'Invoice No.' : delivery || returnable ? 'Challan No.' : note ? 'Note No.' : undefined,
    number: voucher.number,
    date: voucher.date,
    poNo: noteFor ?? (form.reference || undefined),
    ewayBillNo: kind === 'sales' ? form.ewayBillNo || undefined : undefined,
    dcNo: [...new Set(form.lines.filter((l) => l.challanId).map((l) => l.orderLabel))].join(', ') || undefined,
    placeOfSupply: placeOfSupplyText(ours ? (chosen?.stateCode ?? masters.company.stateCode) : (details?.shipTo?.stateCode ?? details?.billTo?.stateCode ?? details?.placeOfSupply)),
    // nobody is billed on a returnable challan: the supplier is who the goods are consigned to (or, on the return, who sent them back)
    party: { name: details?.mailingName ?? form.partyLabel, ...(returnable ? { label: form.returnOf ? 'Returned By (Vendor)' : 'Consignee (Vendor)' } : docProfile(kind).side === 'purchase' ? { label: 'Vendor' } : {}), gstin: details?.gstin, billTo: details?.billTo, shipTo },
    lines,
    subtotal: preview.total,
    gst: preview.gst,
    roundOff: preview.roundOff,
    grandTotal: preview.grand,
    // a free-of-charge challan says so on its face: the value is stated, nothing is to be paid
    narration: [foc ? 'Free of charge (FOC) – not for sale.' : '', returnable && !form.returnOf ? 'Returnable – to be returned to us after the work.' : '', noteFor && form.reference.trim() !== '' ? `Ref: ${form.reference.trim()}.` : '', form.narration].filter(Boolean).join(' ') || undefined,
  };
}

/** The HSN / SAC of a line's stock (or service) item, from the item master. */
const itemHsnOf = (l: SalesLineForm, masters: Masters): string => (l.itemId !== '' ? (masters.stockItem(l.itemId as never)?.hsn ?? '') : '');

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
  /** Print the items on the same page as the consignment. */
  readonly onePage?: boolean | undefined;
}

/**
 * A dispatch docket for invoices of ONE customer: page one lists the invoices (number, date, PO) and the consignment; page two (or the same page) every
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
      else items.set(key, { desc: l.itemLabel, hsn: l.hsn || itemHsnOf(l, masters) || undefined, unit: unit?.symbol ?? l.unit ?? '', decimals: unit?.decimals ?? 0, qty: q });
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
    invoices: read.map(({ v, r }) => ({ number: v.number, date: v.date, poNo: r.form.reference || undefined })),
    packages: d.packages,
    transporter: d.transporter,
    lrNo: d.lrNo,
    items: [...items.values()].map((i) => ({ desc: i.desc, hsn: i.hsn, qty: `${formatQuantity(i.qty, i.decimals)} ${i.unit}`.trim() })),
    totalQty: [...perUnit.entries()].map(([unit, t]) => `${formatQuantity(t.qty, t.decimals)} ${unit}`.trim()).join(' + '),
    ...(d.onePage ? { onePage: true } : {}),
  };
}
