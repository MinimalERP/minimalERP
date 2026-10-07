import { type Party, type PartyDetails, type Voucher, parseQty } from '@minimalerp/domain';
import type { InboxItem } from '@minimalerp/ports';
import type { Books } from '../books/books';
import { defaultDate, resolveTypeId } from '../vouchers/entryHelpers';
import { formatDate } from '../vouchers/format';
import { docProfile } from '../vouchers/kinds';
import { salesFormFromProposal } from '../vouchers/proposalForms';
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
  { kind: 'purchase', title: 'Purchase Bill', hint: "A supplier's invoice: the goods come in" },
];

/** The entry page a document read by Scan opens in — or none: a Receipt or Payment is completed on the desktop. */
export const entryKindOfProposal = (item: InboxItem): EntryKind | undefined => (item.kind === 'salesOrder' || item.kind === 'sales' || item.kind === 'purchase' ? item.kind : undefined);

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
  const form = blankSalesForm(newKey(), typeId, defaultDate(books.masters), newKey(), { salesLedger: defaultSalesLedger(books.masters, docProfile(kind).side) });
  return { ...form, lines: [] };
}

/** The form a page starts with: a posted document being altered, an invoice for what an order or challan has pending, or a new one (for a party, if named). */
export function startForm(books: Books, start: { readonly kind: EntryKind; readonly voucherId?: string | undefined; readonly partyId?: string | undefined; readonly fromOrder?: string | undefined; readonly fromOrderLines?: readonly string[] | undefined; readonly proposal?: InboxItem | undefined }): SalesForm | undefined {
  const { masters } = books;
  if (start.proposal) {
    // what the reader made of the document, as the desktop's inbox opens it: matched parties and items chosen, the rest in the document's words
    const typeId = resolveTypeId(masters, start.kind);
    if (!typeId) return undefined;
    const p = start.proposal.proposal;
    return salesFormFromProposal(start.proposal, masters, {
      typeId,
      newKey,
      warehouse: mainGodown(books),
      salesLedger: defaultSalesLedger(masters, docProfile(start.kind).side),
      orders: books.orders,
      stock: books.stock,
      order: p.fromOrderId ? books.voucher(p.fromOrderId) : undefined,
    });
  }
  if (start.voucherId) {
    const voucher = books.voucher(start.voucherId);
    return voucher && canAlter(books, voucher) ? salesFormFromVoucher(voucher, masters, books.orders) : undefined;
  }
  const blank = newForm(books, start.kind);
  if (!blank) return undefined;
  if (start.fromOrder && (start.kind === 'sales' || start.kind === 'purchase')) {
    const source = books.voucher(start.fromOrder);
    const args = { id: blank.id, typeId: blank.typeId, date: blank.date, newKey, salesLedger: defaultSalesLedger(masters, docProfile(start.kind).side) };
    const base = source ? masters.voucherType(source.voucherTypeId)?.baseKind : undefined;
    const made =
      source && base === 'deliveryChallan' && start.kind === 'sales'
        ? invoiceFormFromChallan(source, books.orders, masters, args)
        : source && base === (start.kind === 'sales' ? 'salesOrder' : 'purchaseOrder')
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

/** What a posted order or challan can still be invoiced (a purchase order: billed) for, said as the button that does it — or nothing. */
export function invoiceFrom(books: Books, voucher: Voucher): string | undefined {
  if (voucher.status !== 'posted') return undefined;
  const kind = books.masters.voucherType(voucher.voucherTypeId)?.baseKind;
  if (kind === 'salesOrder') return books.orders.state(voucher.id)?.status === 'open' ? 'Invoice pending' : undefined;
  if (kind === 'purchaseOrder') return books.orders.state(voucher.id)?.status === 'open' ? 'Bill received' : undefined;
  if (kind === 'deliveryChallan') {
    const status = books.orders.challans.state(voucher.id)?.status;
    return status === 'toInvoice' || status === 'partlyInvoiced' ? 'Invoice this' : undefined;
  }
  return undefined;
}

/** The lines of a posted Sales (or Purchase) Order that still have something pending (by line id): the ones that can be chosen for "Invoice selected". */
export function pendingOrderLines(books: Books, voucher: Voucher): ReadonlyMap<string, { readonly pending: bigint; readonly ordered: bigint }> {
  const out = new Map<string, { pending: bigint; ordered: bigint }>();
  const base = books.masters.voucherType(voucher.voucherTypeId)?.baseKind;
  if (voucher.status !== 'posted' || (base !== 'salesOrder' && base !== 'purchaseOrder')) return out;
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

// ---- where the goods are shipped: the party's own addresses ------------------------------------------------------------------

export interface ShipChoice {
  /** 'same' (the billing address), 'own' (the party's shipping address) or a saved address's id. */
  readonly id: string;
  readonly label: string;
  readonly lines: string;
}

/** Where a document for this party can be shipped: its billing address, its own shipping address, and every address saved on the party. */
export function shipChoices(party: Party): ShipChoice[] {
  return [
    { id: 'same', label: 'Same as billing', lines: party.address ?? '' },
    ...(party.shipping?.lines ? [{ id: 'own', label: 'Shipping address', lines: party.shipping.lines }] : []),
    ...(party.addresses ?? []).map((a) => ({ id: a.id, label: a.label, lines: a.lines })),
  ];
}

/** Which of the choices the document's party details hold now (by the address text; 'same' when it ships to the billing address). */
export function shipChosen(party: Party, details: PartyDetails | undefined): string {
  const lines = details?.shipTo?.lines;
  if (!lines) return 'same';
  return shipChoices(party).find((c) => c.id !== 'same' && c.lines === lines)?.id ?? 'other';
}

/**
 * The document's party details with another place to ship to. As in the desktop's Party Details: the consignee is the party, the address is
 * the one chosen, and the place of supply follows where the goods go (the shipping state when there is one, else the billing state) — the
 * engine then works the GST out from that, as it always does.
 */
export function withShipTo(form: SalesForm, party: Party, choiceId: string): SalesForm {
  const base = form.partyDetails ?? partyDetailsOfParty(party);
  const { shipTo: _was, placeOfSupply: _pos, ...rest } = base;
  const billState = base.billTo?.stateCode;
  const saved = (party.addresses ?? []).find((a) => a.id === choiceId);
  const to =
    choiceId === 'own' && party.shipping?.lines
      ? { lines: party.shipping.lines, stateCode: party.shipping.stateCode, pincode: party.shipping.pincode, country: party.country }
      : saved
        ? { lines: saved.lines, stateCode: saved.stateCode, pincode: saved.pincode, country: saved.country ?? party.country }
        : undefined;
  const place = to?.stateCode || billState;
  const clean = <T extends Record<string, string | undefined>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
  return {
    ...form,
    partyDetails: {
      ...rest,
      ...(to ? { shipTo: clean({ name: party.name, lines: to.lines, stateCode: to.stateCode, country: to.country ?? 'India', pincode: to.pincode }) } : {}),
      ...(place ? { placeOfSupply: place } : {}),
    },
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
 * usual case is one tap. On the buying side: what it was last bought (or ordered) at, from this supplier if ever. Empty when there is no
 * such voucher. A convenience read from the books, not a price list: the person can change it.
 */
export function lastRate(books: Books, itemId: string, partyId: string, side: 'sales' | 'purchase' = 'sales'): string {
  let anyone = '';
  for (let k = books.vouchers.length - 1; k >= 0; k--) {
    const v = books.vouchers[k] as Voucher;
    if (v.status !== 'posted') continue;
    const kind = books.masters.voucherType(v.voucherTypeId)?.baseKind;
    if (side === 'sales' ? kind !== 'sales' && kind !== 'salesOrder' && kind !== 'quotation' : kind !== 'purchase' && kind !== 'purchaseOrder') continue;
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
  // goods leaving start in the godown that holds them; goods arriving, in the main one
  const godown = p.moves && !service ? (p.goodsOut ? godownWithStock(masters, books.stock, itemId, form.date, mainGodown(books), 1n) : mainGodown(books)) : undefined;
  return {
    ...blankSalesLine(newKey(), godown, p.order ? form.date : undefined),
    itemId,
    itemLabel: item?.name ?? '',
    qty: '1',
    rate: lastRate(books, itemId, form.partyId, p.side),
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
export const isBlankEntry = (form: SalesForm): boolean => form.partyId === '' && form.lines.length === 0 && form.reference.trim() === '' && form.billNo.trim() === '' && form.narration.trim() === '';

/** A line the reader could not match to a stock item: it still says the document's words, and waits for an item to be chosen. */
export const needsItem = (line: SalesLineForm): boolean => line.itemId === '' && line.oneTime !== true;

/** The item chosen for a line that had only the document's words: the item and its godown; the quantity, rate and tax the document printed stay. */
export function withItem(books: Books, kind: EntryKind, form: SalesForm, line: SalesLineForm, itemId: string): SalesLineForm {
  const fresh = lineFor(books, kind, form, itemId);
  return {
    ...line,
    itemId,
    itemLabel: fresh.itemLabel,
    warehouseId: fresh.warehouseId,
    warehouseLabel: fresh.warehouseLabel,
    qty: line.qty.trim() === '' ? fresh.qty : line.qty,
    rate: line.rate.trim() === '' ? fresh.rate : line.rate,
    gstRate: line.gstRate || fresh.gstRate || '',
    hsn: line.hsn || fresh.hsn || '',
  };
}
