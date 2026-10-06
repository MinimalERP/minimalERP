import { type Voucher, parseQty } from '@minimalerp/domain';
import type { Books } from '../books/books';
import { defaultDate, resolveTypeId } from '../vouchers/entryHelpers';
import { formatDate } from '../vouchers/format';
import { docProfile } from '../vouchers/kinds';
import {
  type SalesForm,
  type SalesFormIssue,
  type SalesLineForm,
  blankSalesForm,
  blankSalesLine,
  defaultSalesLedger,
  dueDateFor,
  godownWithStock,
  gstDefaults,
  invoiceFormFromChallan,
  invoiceFormFromOrder,
  orderOfQuotation,
  partyDetailsOfParty,
  salesFormFromVoucher,
  trimPlaces,
} from '../vouchers/salesModel';
import type { EntryKind } from './nav';

/**
 * Touch entry of the selling side's documents. The FORM is the desktop's own (`SalesForm`, vouchers/salesModel.ts): it is built into a
 * draft and judged by `previewSales` — the same engine the server runs — and posted through `Books`. What is here is only how a thumb
 * fills that form in: what a new document starts with, and what a line starts with when an item is tapped. No rule, total or tax is
 * worked out in this file.
 */

export const ENTRY_KINDS: readonly { readonly kind: EntryKind; readonly title: string; readonly hint: string }[] = [
  { kind: 'sales', title: 'Sales Invoice', hint: 'Bill a customer: the goods go out' },
  { kind: 'salesOrder', title: 'Sales Order', hint: 'What a customer has ordered' },
  { kind: 'quotation', title: 'Quotation', hint: 'Prices for a customer' },
  { kind: 'deliveryChallan', title: 'Delivery Challan', hint: 'Goods out now, billed later or free' },
];

export const entryTitle = (kind: EntryKind): string => ENTRY_KINDS.find((k) => k.kind === kind)?.title ?? 'Document';

export const isEntryKind = (kind: string | undefined): kind is EntryKind => ENTRY_KINDS.some((k) => k.kind === kind);

const newKey = (): string => crypto.randomUUID();

/** The main godown: the first active one — where a line starts unless the goods are elsewhere. */
export function mainGodown(books: Books): { id: string; label: string } | undefined {
  const w = books.masters.warehouses.find((x) => x.isActive);
  return w ? { id: w.id, label: w.name } : undefined;
}

/** A new document with nothing on it: today's date, the sales ledger a new invoice starts with, no lines. Undefined when the company has no such voucher type. */
export function newForm(books: Books, kind: EntryKind): SalesForm | undefined {
  const typeId = resolveTypeId(books.masters, kind);
  if (!typeId) return undefined;
  const form = blankSalesForm(newKey(), typeId, defaultDate(books.masters), newKey(), { salesLedger: defaultSalesLedger(books.masters, 'sales') });
  return { ...form, lines: [] };
}

/** The form a page starts with: a posted document being altered, an invoice for what an order or challan has pending, or a new one (for a party, if named). */
export function startForm(books: Books, start: { readonly kind: EntryKind; readonly voucherId?: string | undefined; readonly partyId?: string | undefined; readonly fromOrder?: string | undefined; readonly fromOrderLines?: readonly string[] | undefined }): SalesForm | undefined {
  const { masters } = books;
  if (start.voucherId) {
    const voucher = books.voucher(start.voucherId);
    return voucher && canAlter(books, voucher) ? salesFormFromVoucher(voucher, masters, books.orders) : undefined;
  }
  const blank = newForm(books, start.kind);
  if (!blank) return undefined;
  if (start.fromOrder && start.kind === 'sales') {
    const source = books.voucher(start.fromOrder);
    const args = { id: blank.id, typeId: blank.typeId, date: blank.date, newKey, salesLedger: defaultSalesLedger(masters, 'sales') };
    const base = source ? masters.voucherType(source.voucherTypeId)?.baseKind : undefined;
    const made =
      source && base === 'deliveryChallan'
        ? invoiceFormFromChallan(source, books.orders, masters, args)
        : source && base === 'salesOrder'
          ? invoiceFormFromOrder(source, books.orders, masters, { ...args, warehouse: mainGodown(books), stock: books.stock, onlyLines: start.fromOrderLines })
          : undefined;
    if (made) return made;
  }
  return start.partyId ? withParty(blank, start.kind, books, start.partyId) : blank;
}

/** Whether the phone may open this posted document for altering: one of its four kinds, still posted, and not a quotation already made into an order. */
export function canAlter(books: Books, voucher: Voucher): boolean {
  const kind = books.masters.voucherType(voucher.voucherTypeId)?.baseKind;
  if (voucher.status !== 'posted' || !isEntryKind(kind)) return false;
  return !(kind === 'quotation' && orderOfQuotation(voucher.id, books.vouchers) !== undefined);
}

/** What a posted order or challan can still be invoiced for, said as the button that does it — or nothing. */
export function invoiceFrom(books: Books, voucher: Voucher): string | undefined {
  if (voucher.status !== 'posted') return undefined;
  const kind = books.masters.voucherType(voucher.voucherTypeId)?.baseKind;
  if (kind === 'salesOrder') return books.orders.state(voucher.id)?.status === 'open' ? 'Invoice pending' : undefined;
  if (kind === 'deliveryChallan') {
    const status = books.orders.challans.state(voucher.id)?.status;
    return status === 'toInvoice' || status === 'partlyInvoiced' ? 'Invoice this' : undefined;
  }
  return undefined;
}

/** The lines of a posted Sales Order that still have something to invoice (by line id): the ones that can be chosen for "Invoice selected". */
export function pendingOrderLines(books: Books, voucher: Voucher): ReadonlyMap<string, { readonly pending: bigint; readonly ordered: bigint }> {
  const out = new Map<string, { pending: bigint; ordered: bigint }>();
  if (voucher.status !== 'posted' || books.masters.voucherType(voucher.voucherTypeId)?.baseKind !== 'salesOrder') return out;
  const state = books.orders.state(voucher.id);
  if (!state || state.status !== 'open') return out;
  for (const l of state.lines) if (l.pending > 0n) out.set(l.line.id, { pending: l.pending, ordered: l.ordered });
  return out;
}

/** The customer chosen: its details as the desktop fills them, and (an invoice) the bill's due date from its credit days. */
export function withParty(form: SalesForm, kind: EntryKind, books: Books, partyId: string): SalesForm {
  const party = books.masters.party(partyId as never);
  if (!party) return form;
  const due = dueDateFor(books.masters, party.id, form.date);
  return {
    ...form,
    partyId: party.id,
    partyLabel: party.name,
    partyDetails: partyDetailsOfParty(party),
    ...(docProfile(kind).invoice && !form.dueTouched ? { due, dueText: formatDate(due) } : {}),
    // another customer's order lines cannot stay
    lines: form.partyId !== '' && form.partyId !== party.id ? form.lines.map((l) => ({ ...l, orderId: '', orderLineId: '', orderLabel: '', challanId: undefined, challanLineId: undefined })) : form.lines,
  };
}

/** The date changed: the bill's due date follows (until someone has set it), and an order's lines that were due on the old date move with it. */
export function withDate(form: SalesForm, kind: EntryKind, books: Books, date: string): SalesForm {
  const p = docProfile(kind);
  const due = form.partyId ? dueDateFor(books.masters, form.partyId, date) : date;
  return {
    ...form,
    date,
    ...(p.invoice && !form.dueTouched ? { due, dueText: formatDate(due) } : {}),
    lines: p.order ? form.lines.map((l) => (l.due === form.date ? { ...l, due: date, dueText: formatDate(date) } : l)) : form.lines,
  };
}

/**
 * The rate an item was last sold (or ordered, or quoted) at — to this customer if ever, else to anyone: where a line's rate starts, so the
 * usual case is one tap. Empty when it was never sold. A convenience read from the books, not a price list: the person can change it.
 */
export function lastRate(books: Books, itemId: string, partyId: string): string {
  let anyone = '';
  for (let k = books.vouchers.length - 1; k >= 0; k--) {
    const v = books.vouchers[k] as Voucher;
    if (v.status !== 'posted') continue;
    const kind = books.masters.voucherType(v.voucherTypeId)?.baseKind;
    if (kind !== 'sales' && kind !== 'salesOrder' && kind !== 'quotation') continue;
    const c = v.content as unknown as { partyId?: string; lines?: { itemId?: string; rate?: string }[] };
    const line = (c.lines ?? []).find((l) => l.itemId === itemId && typeof l.rate === 'string');
    if (!line?.rate) continue;
    if (c.partyId === partyId) return trimPlaces(line.rate);
    if (anyone === '') anyone = trimPlaces(line.rate);
  }
  return anyone;
}

/** The line an item starts as when it is tapped: one of it, at its last rate, with its GST, from the godown that holds it (due with the order). */
export function lineFor(books: Books, kind: EntryKind, form: SalesForm, itemId: string): SalesLineForm {
  const { masters } = books;
  const p = docProfile(kind);
  const item = masters.stockItem(itemId as never);
  const service = item?.itemType === 'service';
  const godown = p.moves && !service ? godownWithStock(masters, books.stock, itemId, form.date, mainGodown(books), 1n) : undefined;
  return {
    ...blankSalesLine(newKey(), godown, p.order ? form.date : undefined),
    itemId,
    itemLabel: item?.name ?? '',
    qty: '1',
    rate: lastRate(books, itemId, form.partyId),
    ...(p.invoice || p.quote || p.challan ? gstDefaults(masters, itemId) : {}),
  };
}

/** One more or one fewer of a line, never below one (a line is removed with its own button, not by counting down). */
export function stepQty(qty: string, by: 1 | -1): string {
  const q = parseQty(qty.trim());
  if (q === undefined) return by > 0 ? '1' : qty;
  const next = q + BigInt(by) * 10_000n;
  if (next < 10_000n) return trimPlaces(`${q / 10_000n}.${String(q % 10_000n).padStart(4, '0')}`);
  return trimPlaces(`${next / 10_000n}.${String(next % 10_000n).padStart(4, '0')}`);
}

/** The problems that sit on line `i`, and the ones that sit on no line (the customer, the date, the document as a whole). */
export const lineIssues = (issues: readonly SalesFormIssue[], i: number): SalesFormIssue[] => issues.filter((x) => x.field.startsWith(`line.${i}.`));
export const headIssues = (issues: readonly SalesFormIssue[]): SalesFormIssue[] => issues.filter((x) => !x.field.startsWith('line.'));

/** Nothing entered yet: nothing worth keeping as a draft. */
export const isBlankEntry = (form: SalesForm): boolean => form.partyId === '' && form.lines.length === 0 && form.reference.trim() === '' && form.narration.trim() === '';
