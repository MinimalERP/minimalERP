import {
  type Masters,
  type Money,
  type OrderBook,
  type Party,
  type PartyDetails,
  type Qty,
  type Rate,
  type StockBook,
  type Voucher,
  type VoucherKindRegistry,
  type ChallanPurpose,
  ZERO,
  type GstHeader,
  billRefProblems,
  canonicalId,
  canonicalPercent,
  deriveGstHeader,
  grandTotalParts,
  gstOfContent,
  partyLedgerId,
  isPercentText,
  defaultVoucherKinds,
  formatQty,
  formatRate,
  isQtyText,
  money,
  parseQty,
  parseRate,
  prepareVoucher,
  valueOf,
  orderBookOf,
} from '@minimalerp/domain';
import { addDays, formatDate } from './format';
import { type DocSide, type ItemDocKind, type SalesKind, docProfile, isItemDocKind } from './kinds';

/**
 * The Sales Order / Sales Invoice form as the screen holds it: plain strings, so it can live in the screen-stack frame and be saved as a
 * draft. Pure, like the accounting and stock form models — building the draft the engine takes, previewing it with the SAME engine the
 * server runs (against the company's stock AND its orders, so "not enough stock" and "8 pending, you are delivering 10" appear as you type),
 * and putting every problem on the exact cell. One form serves both documents: they differ in a few fields, not in kind.
 */

export interface SalesLineForm {
  /** A sales order's line id: chosen once, kept across alterations, so deliveries keep pointing at the same line. */
  key: string;
  itemId: string;
  itemLabel: string;
  /** Invoice: the godown the goods leave. */
  warehouseId: string;
  warehouseLabel: string;
  qty: string;
  rate: string;
  /** Order: when this line is wanted (ISO date and what the field shows). */
  due: string;
  dueText: string;
  /** Invoice: the order line this delivery fills (empty = over the counter). */
  orderId: string;
  orderLineId: string;
  /** What the order field shows: the order's number (or the challan's). */
  orderLabel: string;
  /** Sales invoice: the delivery-challan line this bills (the goods left on the challan, so the line moves no stock). */
  challanId?: string | undefined;
  challanLineId?: string | undefined;
  /** Invoice of a company that charges GST: the rate this line is charged at (a percentage) and the item's HSN as it is now. */
  gstRate?: string;
  hsn?: string;
  /** Invoice: a ONE-TIME line (Alt+T) — `itemLabel` is its written text, there is no stock item and no godown; it moves no stock. */
  oneTime?: boolean;
  /** A one-time line's unit (a unit master's symbol), chosen in its Alt+T form. */
  unit?: string;
}

export interface SalesForm {
  /** Generated once per form, so pressing accept twice cannot post twice (it is the voucher's idempotency key). */
  id: string;
  typeId: string;
  date: string;
  narration: string;
  partyId: string;
  partyLabel: string;
  /** The customer's own reference: their PO number. */
  reference: string;
  /** Sales Invoice: the E-way Bill number for this movement of goods, if one was generated. */
  ewayBillNo: string;
  /** Who it is billed and shipped to: filled from the party when it is chosen (Alt+P changes it for this voucher). */
  partyDetails: PartyDetails | undefined;
  /** Invoice: the ledger sales (or, on a purchase, purchases) are booked to. */
  salesLedgerId: string;
  salesLedgerLabel: string;
  /** Purchase invoice: the SUPPLIER'S invoice number — the name of the bill it raises. */
  billNo: string;
  /** Invoice: when the customer's bill falls due (the date plus the party's credit days until someone chooses otherwise). */
  due: string;
  dueText: string;
  dueTouched: boolean;
  /** Order: closed by hand — nothing more can be delivered against it. */
  closed: boolean;
  /** Sales order: the quotation it was made from (kept across alterations). */
  quotationId?: string;
  /** Delivery challan: why the goods go out — 'sale' (invoiced later) or 'foc' (free of cost, never invoiced). */
  purpose?: ChallanPurpose;
  /** Returnable challan: this is the return of that challan. */
  returnOf?: string;
  /** New purchase invoice: "Paid from" is asked for (the panel's button), and the cash or bank ledger it is paid from — a Payment is posted with it. */
  paidOn?: boolean;
  paidFromId?: string;
  paidFromLabel?: string;
  lines: SalesLineForm[];
}

/** An invoice GSTR-2B has and the books do not, as a new Purchase invoice starts with it: who, which invoice, when — the items are the person's to add. */
export interface PurchasePrefill {
  /** The supplier as the GST portal names it, and its GSTIN. */
  readonly supplier: string;
  readonly gstin: string;
  readonly billNo: string;
  readonly date?: string | undefined;
  /** Said on the window: what the invoice comes to on the GST site. */
  readonly note: string;
}

/** A blank purchase form filled from a GSTR-2B invoice: the party whose GSTIN it is (else the portal's name, typed, for Alt+C), the number and the date. */
export function withPurchasePrefill(form: SalesForm, prefill: PurchasePrefill, masters: Masters): SalesForm {
  const party = masters.parties.find((p) => p.isActive && (p.roles ?? []).includes('vendor') && canonicalId(p.gstin ?? '') === canonicalId(prefill.gstin));
  const date = prefill.date && masters.financialYears.some((fy) => (prefill.date as string) >= fy.start && (prefill.date as string) <= fy.end) ? prefill.date : form.date;
  const due = party ? dueDateFor(masters, party.id, date) : date;
  return {
    ...form,
    date,
    partyId: party?.id ?? '',
    partyLabel: party?.name ?? prefill.supplier,
    partyDetails: party ? partyDetailsOfParty(party) : undefined,
    billNo: prefill.billNo,
    due,
    dueText: formatDate(due),
  };
}

export const blankSalesLine =(key: string, warehouse?: { id: string; label: string }, due?: string): SalesLineForm => ({
  key,
  itemId: '',
  itemLabel: '',
  warehouseId: warehouse?.id ?? '',
  warehouseLabel: warehouse?.label ?? '',
  qty: '',
  rate: '',
  due: due ?? '',
  dueText: due ? formatDate(due) : '',
  orderId: '',
  orderLineId: '',
  orderLabel: '',
  gstRate: '',
  hsn: '',
});

/** What an item brings to an invoice line of a company that charges GST: its rate (from its GST rate master) and its HSN. Nothing when GST is off. */
export function gstDefaults(masters: Masters, itemId: string): { gstRate?: string; hsn?: string } {
  if (masters.company.chargeGst !== true) return {};
  const item = masters.stockItem(itemId as never);
  if (!item) return {};
  const rate = item.gstRateId ? masters.gstRate(item.gstRateId)?.ratePercent : undefined;
  return { gstRate: rate === undefined ? '' : canonicalPercent(rate), hsn: item.hsn ?? '' };
}

export const blankSalesForm = (
  id: string,
  typeId: string,
  date: string,
  lineKey: string,
  extra: { warehouse?: { id: string; label: string } | undefined; salesLedger?: { id: string; label: string } | undefined } = {},
): SalesForm => ({
  id,
  typeId,
  date,
  narration: '',
  partyId: '',
  partyLabel: '',
  reference: '',
  ewayBillNo: '',
  partyDetails: undefined,
  salesLedgerId: extra.salesLedger?.id ?? '',
  salesLedgerLabel: extra.salesLedger?.label ?? '',
  billNo: '',
  due: date,
  dueText: formatDate(date),
  dueTouched: false,
  closed: false,
  purpose: 'sale',
  lines: [blankSalesLine(lineKey, extra.warehouse, date)],
});

export const salesKindOf = (masters: Masters, typeId: string): ItemDocKind | undefined => {
  const base = masters.voucherType(typeId as never)?.baseKind;
  return base !== undefined && isItemDocKind(base) ? base : undefined;
};

const isEmptyLine = (l: SalesLineForm): boolean => l.itemId === '' && l.itemLabel.trim() === '' && l.qty.trim() === '' && l.rate.trim() === '';

/**
 * True when nothing has been entered: no party, reference, item, quantity or rate, and no narration. (A default godown, date or sales ledger
 * is not "entered".)
 */
export const isBlankSales = (form: SalesForm): boolean =>
  form.partyId === '' &&
  form.partyLabel.trim() === '' &&
  form.reference.trim() === '' &&
  form.ewayBillNo.trim() === '' &&
  form.billNo.trim() === '' &&
  form.narration.trim() === '' &&
  form.lines.every(isEmptyLine);

// ---- dates -------------------------------------------------------------------------------------------------------

/** When a bill raised on `date` falls due for this customer: the date plus the party's credit days (none = the same day). */
export const dueDateFor = (masters: Masters, partyId: string, date: string): string => addDays(date, masters.party(partyId as never)?.creditDays ?? 0);

// ---- the party ---------------------------------------------------------------------------------------------------

/**
 * The party details a customer starts a document with: exactly what the Party Details window offers by default (billing address, its GST
 * facts, and the party's own shipping address when it has one). Changing them there is for this voucher only.
 */
export function partyDetailsOfParty(party: Party): PartyDetails {
  const clean = (s: string | undefined): string | undefined => (s === undefined || s.trim() === '' ? undefined : s.trim());
  const shipping = party.shipping?.lines ? party.shipping : undefined;
  const place = shipping ? (shipping.stateCode ?? party.stateCode) : party.stateCode;
  const registration = party.gstRegistration ?? (party.gstin ? 'regular' : undefined);
  return {
    partyId: party.id,
    mailingName: party.name,
    billTo: { lines: clean(party.address), stateCode: clean(party.stateCode), country: clean(party.country) ?? 'India', pincode: clean(party.pincode) },
    ...(shipping
      ? { shipTo: { name: party.name, lines: clean(shipping.lines), stateCode: clean(shipping.stateCode), country: clean(party.country) ?? 'India', pincode: clean(shipping.pincode) } }
      : {}),
    ...(registration ? { gstRegistration: registration } : {}),
    ...(clean(party.gstin) ? { gstin: canonicalId(party.gstin as string) } : {}),
    ...(clean(place) ? { placeOfSupply: clean(place) } : {}),
  };
}

export interface Option {
  readonly id: string;
  readonly name: string;
  readonly sub: string;
}

/** The parties a document may be made out to: the active customers (sales) or vendors (purchase). */
export const customerOptions = (masters: Masters, side: DocSide = 'sales'): Option[] =>
  masters.parties
    .filter((p) => p.isActive && (p.roles ?? []).includes(side === 'sales' ? 'customer' : 'vendor'))
    .map((p) => ({ id: p.id, name: p.name, sub: [p.gstin, p.creditDays ? `${p.creditDays} days` : undefined].filter(Boolean).join(' · ') }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** The ledgers sales (or purchases) may be booked to: the active ones under Sales Accounts (or Purchase Accounts). */
export const salesLedgerOptions = (masters: Masters, side: DocSide = 'sales'): Option[] =>
  masters.ledgers
    .filter((l) => l.isActive && l.reservedKey === undefined && masters.groups.isWithinReserved(l.groupId, side === 'sales' ? 'sales-accounts' : 'purchase-accounts'))
    .map((l) => ({ id: l.id, name: l.name, sub: masters.groups.get(l.groupId)?.name ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** The sales (or purchase) ledger a new invoice starts with: the only one, or the one called Sales. Otherwise none — the person chooses. */
export function defaultSalesLedger(masters: Masters, side: DocSide = 'sales'): { id: string; label: string } | undefined {
  const all = salesLedgerOptions(masters, side);
  const pick = all.length === 1 ? all[0] : all.find((o) => (side === 'sales' ? /^sales( account)?$/i : /^purchases?( account)?$/i).test(o.name));
  return pick ? { id: pick.id, label: pick.name } : undefined;
}

/** What a purchase paid on the spot may be paid from: the active cash and bank ledgers. */
export const paidFromOptions = (masters: Masters): Option[] =>
  masters.ledgers
    .filter((l) => l.isActive && masters.isCashOrBank(l.id))
    .map((l) => ({ id: l.id, name: l.name, sub: masters.groups.get(l.groupId)?.name ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * The Payment that pays a posted purchase invoice in full, on its own date: the cash or bank ledger is credited, the supplier debited for the
 * invoice's total (rounded, with its GST) against the bill the invoice raised. Nothing when there is no Payment voucher type.
 */
export function paymentForPurchase(masters: Masters, purchase: Voucher, paidFromId: string, id: string): Record<string, unknown> | undefined {
  const type = masters.voucherTypes.find((t) => t.baseKind === 'payment' && t.isSystem) ?? masters.voucherTypes.find((t) => t.baseKind === 'payment');
  if (!type) return undefined;
  const c = purchase.content as unknown as { partyId: string; billNo: string; lines: { qty: string; rate: string }[] };
  const total = grandTotalParts(c.lines, gstOfContent(purchase.content)).rounded;
  const amount = `${total / 100n}.${String(total % 100n).padStart(2, '0')}`;
  return {
    id,
    voucherTypeId: type.id,
    date: purchase.date,
    narration: `Paid on purchase ${purchase.number}`,
    accountLedgerId: paidFromId,
    lines: [{ ledgerId: partyLedgerId(c.partyId as never, 'vendor'), amount, allocations: [{ kind: 'against', ref: c.billNo, amount }] }],
  };
}

/**
 * What a sales (or purchase) line may name: active items that hold stock — and, on an invoice, active service items too (an invoice is the
 * one document that bills a service: an order, quotation or challan is of stock items, since none of them move stock on their own).
 */
export const itemOptions = (masters: Masters, allowService = false): Option[] =>
  masters.stockItems
    .filter((i) => i.isActive && (allowService || i.itemType !== 'service'))
    .map((i) => ({ id: i.id, name: i.name, sub: [masters.unit(i.unitId)?.symbol, i.code].filter(Boolean).join(' · ') }))
    .sort((a, b) => a.name.localeCompare(b.name));

// ---- what an invoice line can fill -------------------------------------------------------------------------------

export interface OrderOption {
  readonly orderId: string;
  readonly lineId: string;
  readonly number: string;
  readonly reference: string | undefined;
  readonly itemId: string;
  readonly ordered: Qty;
  readonly delivered: Qty;
  readonly pending: Qty;
  readonly rate: Rate;
  readonly due: string;
}

/**
 * The order lines a customer's invoice can fill: the open orders of THAT customer, each line that still has something pending (for one
 * item, if given), the one due soonest first. `ownId` is the invoice being entered or altered: what it had delivered counts as pending again.
 */
export function openOrderLines(orders: OrderBook, partyId: string, itemId: string | undefined, ownId: string, side: DocSide = 'sales'): OrderOption[] {
  const book = orders.withChange({ removeLinksOf: [ownId as never] });
  const out: OrderOption[] = [];
  for (const state of book.all()) {
    if (state.order.side !== side || state.order.partyId !== partyId || state.order.closed) continue;
    for (const l of state.lines) {
      if (l.pending <= 0n || (itemId !== undefined && itemId !== '' && l.line.itemId !== itemId)) continue;
      out.push({
        orderId: state.order.voucherId,
        lineId: l.line.id,
        number: state.order.number,
        reference: state.order.reference,
        itemId: l.line.itemId,
        ordered: l.ordered,
        delivered: l.delivered,
        pending: l.pending,
        rate: l.line.rate,
        due: l.line.dueDate,
      });
    }
  }
  return out.sort((a, b) => (a.due !== b.due ? (a.due < b.due ? -1 : 1) : a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
}

// ---- form → draft ------------------------------------------------------------------------------------------------

export interface BuiltSalesDraft {
  readonly draft: Record<string, unknown>;
  /** kept[i] = the form line index of draft line i (empty lines are left out, so indexes shift). */
  readonly kept: readonly number[];
}

export function formToSalesDraft(form: SalesForm, kind: ItemDocKind, masters?: Masters): BuiltSalesDraft {
  const kept: number[] = [];
  form.lines.forEach((l, i) => {
    if (!isEmptyLine(l)) kept.push(i);
  });
  const lines = kept.map((i) => {
    const l = form.lines[i] as SalesLineForm;
    const common = { itemId: l.itemId, qty: l.qty.trim(), rate: l.rate.trim() };
    const p = docProfile(kind);
    if (l.oneTime && (p.invoice || p.quote || (p.challan && !p.returnable))) {
      return {
        // a quote or challan line carries its own id (there is no godown or order reference to key off instead); an invoice line does not
        ...(p.quote || p.challan ? { id: l.key } : {}),
        description: l.itemLabel.trim(),
        ...((l.unit ?? '').trim() !== '' ? { unit: (l.unit ?? '').trim() } : {}),
        qty: l.qty.trim(),
        rate: l.rate.trim(),
        ...((l.gstRate ?? '').trim() !== '' ? { gstRate: (l.gstRate ?? '').trim() } : {}),
        ...((l.hsn ?? '').trim() !== '' ? { hsn: (l.hsn ?? '').trim() } : {}),
      };
    }
    const taxed = {
      ...((l.gstRate ?? '').trim() !== '' ? { gstRate: (l.gstRate ?? '').trim() } : {}),
      ...((l.hsn ?? '').trim() !== '' ? { hsn: (l.hsn ?? '').trim() } : {}),
    };
    if (p.challan) return { id: l.key, ...common, warehouseId: l.warehouseId, ...taxed };
    return p.order
      ? { id: l.key, ...common, dueDate: l.due }
      : p.quote
        ? { id: l.key, ...common, ...taxed }
        : l.challanId
          ? { ...common, challanRef: { challanId: l.challanId, lineId: l.challanLineId ?? '' }, ...taxed }
          : {
            ...common,
            // a service item has no godown: left out, rather than sent as an empty string
            ...(l.warehouseId !== '' ? { warehouseId: l.warehouseId } : {}),
            ...(l.orderId !== '' && l.orderLineId !== '' ? { orderRef: { orderId: l.orderId, lineId: l.orderLineId } } : {}),
            ...taxed,
          };
  });
  const base = {
    id: form.id,
    voucherTypeId: form.typeId,
    date: form.date,
    ...(form.narration.trim() !== '' ? { narration: form.narration.trim() } : {}),
    partyId: form.partyId,
    ...(form.reference.trim() !== '' ? { reference: form.reference.trim() } : {}),
    ...(form.partyDetails ? { partyDetails: form.partyDetails } : {}),
    lines,
  };
  const p = docProfile(kind);
  // the GST the invoice states: derived with the same function the engine re-checks it with (nothing when GST is off or no line has a rate)
  const gst = masters && (p.invoice || p.quote || p.challan) ? deriveGstHeader(masters, p.side, { partyId: form.partyId, partyDetails: form.partyDetails, lines: lines as unknown as { qty: string; rate: string; gstRate?: string }[] }) : undefined;
  return {
    draft: p.returnable
      ? { ...base, ...(form.returnOf ? { returnOf: form.returnOf } : {}), ...(gst ? { gst } : {}) }
      : p.challan
      ? { ...base, purpose: form.purpose ?? 'sale', ...(gst ? { gst } : {}) }
      : p.quote
      ? { ...base, ...(gst ? { gst } : {}), lines }
      : p.order
      ? { ...base, ...(form.closed ? { closed: true } : {}), ...(form.quotationId ? { quotationId: form.quotationId } : {}) }
      : p.side === 'sales'
        ? { ...base, salesLedgerId: form.salesLedgerId, dueDate: form.due, ...(gst ? { gst } : {}), ...(form.ewayBillNo.trim() !== '' ? { ewayBillNo: form.ewayBillNo.trim() } : {}) }
        : { ...base, purchaseLedgerId: form.salesLedgerId, billNo: form.billNo.trim(), dueDate: form.due, ...(gst ? { gst } : {}) },
    kept,
  };
}

// ---- preview -----------------------------------------------------------------------------------------------------

export type SalesFieldKey =
  | 'date'
  | 'party'
  | 'ref'
  | 'purpose'
  | 'eway'
  | 'sledger'
  | 'billno'
  | 'due'
  | 'narration'
  | 'general'
  | `line.${number}.${'item' | 'wh' | 'ldue' | 'ord' | 'qty' | 'rate' | 'gst' | 'hsn'}`;

export interface SalesFormIssue {
  readonly field: SalesFieldKey;
  readonly message: string;
  readonly code?: string | undefined;
}

export interface SalesPreview {
  readonly ok: boolean;
  readonly issues: readonly SalesFormIssue[];
  readonly draft: Record<string, unknown>;
  /** What each line comes to, by form line index — as typed, whether or not the engine accepts the document yet. */
  readonly amounts: ReadonlyMap<number, Money>;
  readonly total: Money;
  /** The GST the invoice comes to (undefined when it states none) and what the invoice comes to with it. */
  readonly gst: { readonly cgst: Money; readonly sgst: Money; readonly igst: Money; readonly placeOfSupply: string; readonly supplyState: string } | undefined;
  /** The Round Off adjustment (Round Off ledger): raw total + roundOff = grand. Zero when the total is already a whole rupee. */
  readonly roundOff: Money;
  readonly grand: Money;
}

const LEAF: Readonly<Record<string, 'item' | 'wh' | 'ldue' | 'ord' | 'qty' | 'rate' | 'gst' | 'hsn'>> = {
  id: 'item',
  itemId: 'item',
  description: 'item',
  hsn: 'hsn',
  warehouseId: 'wh',
  dueDate: 'ldue',
  orderRef: 'ord',
  challanRef: 'ord',
  qty: 'qty',
  rate: 'rate',
  gstRate: 'gst',
};
const HEADER: Readonly<Record<string, SalesFieldKey>> = {
  date: 'date',
  partyId: 'party',
  partyDetails: 'party',
  reference: 'ref',
  purpose: 'purpose',
  ewayBillNo: 'eway',
  salesLedgerId: 'sledger',
  purchaseLedgerId: 'sledger',
  billNo: 'billno',
  dueDate: 'due',
  narration: 'narration',
};

/** `lines.2.qty` → line 2's quantity cell; `partyId` → the party field; anything unrecognised → the whole voucher. */
export function fieldOfSalesPath(path: string | undefined, kept: readonly number[]): SalesFieldKey {
  if (path === undefined || path === '') return 'general';
  const parts = path.split('.');
  if (parts[0] === 'lines' && parts[1] !== undefined && /^\d+$/.test(parts[1])) {
    const formIndex = kept[Number(parts[1])];
    const leaf = LEAF[parts[2] ?? ''];
    return formIndex !== undefined && leaf ? `line.${formIndex}.${leaf}` : 'general';
  }
  return HEADER[parts[0] ?? ''] ?? 'general';
}

/** What a line comes to as typed (quantity × rate, to the paisa), or nothing while either is missing or malformed. */
export function lineAmount(l: Pick<SalesLineForm, 'qty' | 'rate'>): Money | undefined {
  const q = parseQty(l.qty.trim());
  const r = parseRate(l.rate.trim());
  return q === undefined || r === undefined ? undefined : valueOf(q, r);
}

/** Problems a person can see without asking the engine — said kindly, on the right cell. */
function localIssues(form: SalesForm, kind: ItemDocKind, kept: readonly number[], masters: Masters): SalesFormIssue[] {
  const out: SalesFormIssue[] = [];
  const p = docProfile(kind);
  if (form.partyId === '') out.push({ field: 'party', message: `Choose the ${p.noun}` });
  if (p.invoice) {
    if (form.salesLedgerId === '') out.push({ field: 'sledger', message: `Choose the ${p.ledgerLabel.toLowerCase()}` });
    if (p.side === 'purchase' && form.billNo.trim() === '') out.push({ field: 'billno', message: 'Enter the supplier’s invoice number' });
    if (form.due === '') out.push({ field: 'due', message: 'Enter the due date' });
  }
  for (const i of kept) {
    const l = form.lines[i] as SalesLineForm;
    // only an invoice line may name a service item: the check is skipped for every other kind, so it never needs masters for them
    const isService = p.invoice && l.itemId !== '' && masters.stockItem(l.itemId as never)?.itemType === 'service';
    const oneTimeHere = p.invoice || p.quote || (p.challan && !p.returnable);
    if (l.oneTime && oneTimeHere) {
      if (l.itemLabel.trim() === '') out.push({ field: `line.${i}.item`, message: 'Write what this line is' });
    } else {
      if (l.itemId === '') out.push({ field: `line.${i}.item`, message: oneTimeHere ? 'Choose a stock item — or press Alt+T to write it as a one-time line' : 'Choose a stock item' });
      if (p.moves && !l.challanId && !isService && l.warehouseId === '') out.push({ field: `line.${i}.wh`, message: 'Choose a godown' });
    }
    if (p.order && l.due === '') out.push({ field: `line.${i}.ldue`, message: 'Enter the due date' });
    if (l.qty.trim() === '') out.push({ field: `line.${i}.qty`, message: 'Enter a quantity' });
    else if (!isQtyText(l.qty.trim())) out.push({ field: `line.${i}.qty`, message: 'That is not a quantity (like 10 or 2.5)' });
    if ((l.gstRate ?? '').trim() !== '' && !isPercentText((l.gstRate ?? '').trim())) out.push({ field: `line.${i}.gst`, message: 'That is not a GST rate (like 5, 18 or 2.5)' });
    if (l.rate.trim() === '') out.push({ field: `line.${i}.rate`, message: 'Enter the rate' });
    else if (parseRate(l.rate.trim()) === undefined) out.push({ field: `line.${i}.rate`, message: 'That is not a rate (like 58 or 58.25)' });
  }
  if (kept.length === 0) out.push({ field: 'general', message: 'Enter at least one line' });
  return out;
}

/**
 * The engine's verdict on the form as it stands, with each problem placed on its cell. `stock` and `orders` are the company's INCLUDING this
 * voucher if it is being altered (its own stock movements and deliveries are taken out first, as the server does).
 */
export function previewSales(
  form: SalesForm,
  kind: ItemDocKind,
  masters: Masters,
  stock: StockBook,
  orders: OrderBook,
  registry: VoucherKindRegistry = defaultVoucherKinds(),
  /** The company's vouchers: a purchase invoice's supplier invoice number is checked against the bills already there. */
  vouchers: readonly Voucher[] = [],
): SalesPreview {
  const { draft, kept } = formToSalesDraft(form, kind, masters);
  const header = draft['gst'] as GstHeader | undefined;
  const gst = header ? { cgst: header.cgst, sgst: header.sgst, igst: header.igst, placeOfSupply: header.placeOfSupply, supplyState: header.supplyState } : undefined;
  const amounts = new Map<number, Money>();
  let total: Money = ZERO;
  for (const i of kept) {
    const a = lineAmount(form.lines[i] as SalesLineForm);
    if (a !== undefined) {
      amounts.set(i, a);
      total = money(total + a);
    }
  }

  const { roundOff, rounded: grand } = grandTotalParts(
    kept.map((i) => form.lines[i] as SalesLineForm),
    gst,
  );
  const local = localIssues(form, kind, kept, masters);
  if (local.length > 0) return { ok: false, issues: local, draft, amounts, total, gst, roundOff, grand };

  const result = prepareVoucher(
    draft,
    masters,
    registry,
    stock.withChange({ remove: [form.id as never] }),
    orders.withChange({ removeLinksOf: [form.id as never] }),
  );
  if (result.ok) {
    const duplicate = billRefProblems(result.value.voucherType.baseKind, result.value.draft, masters, vouchers, form.id as never);
    if (duplicate.length === 0) return { ok: true, issues: [], draft, amounts, total, gst, roundOff, grand };
    return { ok: false, issues: duplicate.map((i) => ({ field: fieldOfSalesPath(i.path, kept), message: i.message, code: i.code })), draft, amounts, total, gst, roundOff, grand };
  }
  return {
    ok: false,
    issues: result.issues.map((i) => ({ field: fieldOfSalesPath(i.path, kept), message: i.message, code: i.code })),
    draft,
    amounts,
    total,
    gst,
    roundOff,
    grand,
  };
}

// ---- voucher → form (display / alter) ---------------------------------------------------------------------------

/** "10.0000" → "10", "2.5000" → "2.5", "58.2500" → "58.25": the way a person would have typed it. */
export function trimPlaces(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

export function salesFormFromVoucher(voucher: Voucher, masters: Masters, orders: OrderBook): SalesForm {
  const c = voucher.content as unknown as {
    narration?: string;
    partyId?: string;
    reference?: string;
    ewayBillNo?: string;
    partyDetails?: PartyDetails;
    salesLedgerId?: string;
    purchaseLedgerId?: string;
    billNo?: string;
    dueDate?: string;
    closed?: boolean;
    quotationId?: string;
    purpose?: ChallanPurpose;
    returnOf?: string;
    lines?: { id?: string; itemId?: string; description?: string; unit?: string; warehouseId?: string; qty: string; rate: string; dueDate?: string; gstRate?: string; hsn?: string; orderRef?: { orderId: string; lineId: string }; challanRef?: { challanId: string; lineId: string } }[];
  };
  const item = (id: string | undefined) => (id === undefined ? '' : (masters.stockItem(id as never)?.name ?? ''));
  const godown = (id: string | undefined) => (id === undefined ? '' : (masters.warehouse(id as never)?.name ?? ''));
  const lines: SalesLineForm[] = (c.lines ?? []).map((l, i) => ({
    key: l.id ?? `l${i + 1}`,
    itemId: l.itemId ?? '',
    itemLabel: l.itemId === undefined ? (l.description ?? '') : item(l.itemId),
    ...(l.itemId === undefined ? { oneTime: true, ...(l.unit ? { unit: l.unit } : {}) } : {}),
    warehouseId: l.warehouseId ?? '',
    warehouseLabel: godown(l.warehouseId),
    qty: trimPlaces(l.qty),
    rate: trimPlaces(l.rate),
    due: l.dueDate ?? '',
    dueText: l.dueDate ? formatDate(l.dueDate) : '',
    orderId: l.orderRef?.orderId ?? '',
    orderLineId: l.orderRef?.lineId ?? '',
    orderLabel: l.orderRef ? (orders.order(l.orderRef.orderId as never)?.number ?? '') : l.challanRef ? (orders.challans.challan(l.challanRef.challanId as never)?.number ?? '') : '',
    ...(l.challanRef ? { challanId: l.challanRef.challanId, challanLineId: l.challanRef.lineId } : {}),
    gstRate: l.gstRate ?? '',
    hsn: l.hsn ?? '',
  }));
  return {
    id: voucher.id,
    typeId: voucher.voucherTypeId,
    date: voucher.date,
    narration: c.narration ?? '',
    partyId: c.partyId ?? '',
    partyLabel: c.partyId ? (masters.party(c.partyId as never)?.name ?? '') : '',
    reference: c.reference ?? '',
    ewayBillNo: c.ewayBillNo ?? '',
    partyDetails: c.partyDetails,
    salesLedgerId: c.salesLedgerId ?? c.purchaseLedgerId ?? '',
    salesLedgerLabel: (c.salesLedgerId ?? c.purchaseLedgerId) ? (masters.ledger((c.salesLedgerId ?? c.purchaseLedgerId) as never)?.name ?? '') : '',
    billNo: c.billNo ?? '',
    due: c.dueDate ?? voucher.date,
    dueText: formatDate(c.dueDate ?? voucher.date),
    dueTouched: true,
    closed: c.closed === true,
    ...(c.quotationId ? { quotationId: c.quotationId } : {}),
    ...(c.purpose ? { purpose: c.purpose } : {}),
    ...(c.returnOf ? { returnOf: c.returnOf } : {}),
    lines: lines.length > 0 ? lines : [blankSalesLine('l1')],
  };
}

// ---- switching between the two documents -------------------------------------------------------------------------

export interface SwitchedSales {
  readonly form: SalesForm;
  /** Said to the user when something could not be carried over. */
  readonly note?: string | undefined;
}

/**
 * Moving between Sales Order and Sales Invoice keeps the date, customer, reference, party details, narration and every line's item,
 * quantity and rate. What belongs to only one of them cannot come along — an order's due dates, an invoice's godowns and order
 * references — and the user is told.
 */
export function switchSales(
  form: SalesForm,
  from: SalesKind,
  to: SalesKind,
  typeId: string,
  masters: Masters,
  extra: { warehouse?: { id: string; label: string } | undefined; salesLedger?: { id: string; label: string } | undefined } = {},
): SwitchedSales {
  const next: SalesForm = { ...form, typeId };
  if (from === to) return { form: next };
  const p = docProfile(to);
  if (p.invoice) {
    const filled = form.lines.some((l) => l.due !== '' && !isEmptyLine(l));
    return {
      form: {
        ...next,
        salesLedgerId: form.salesLedgerId || (extra.salesLedger?.id ?? ''),
        salesLedgerLabel: form.salesLedgerLabel || (extra.salesLedger?.label ?? ''),
        due: dueDateFor(masters, form.partyId, form.date),
        dueText: formatDate(dueDateFor(masters, form.partyId, form.date)),
        dueTouched: false,
        closed: false,
        lines: form.lines.map((l) => ({ ...l, due: '', dueText: '', warehouseId: extra.warehouse?.id ?? '', warehouseLabel: extra.warehouse?.label ?? '', ...(l.itemId !== '' ? gstDefaults(masters, l.itemId) : {}) })),
      },
      ...(filled ? { note: 'The lines’ due dates were cleared: an invoice has godowns instead, and its own due date for the bill.' } : {}),
    };
  }
  const hadRefs = form.lines.some((l) => l.orderId !== '' || !!l.challanId);
  const isService = (l: SalesLineForm) => !l.oneTime && l.itemId !== '' && masters.stockItem(l.itemId as never)?.itemType === 'service';
  // an order is of stock items: a one-time (written) line, or a service line, cannot come along
  const written = form.lines.filter((l) => l.oneTime && !isEmptyLine(l)).length;
  const serviced = form.lines.filter((l) => isService(l) && !isEmptyLine(l)).length;
  const kept = form.lines.filter((l) => !l.oneTime && !isService(l));
  const notes = [
    ...(hadRefs ? [`The order references were cleared: an order is what ${p.side === 'sales' ? 'a customer asks for' : 'we ask a supplier for'}, so it is not against another order.`] : []),
    ...(written > 0 ? [`${written} one-time line${written === 1 ? ' was' : 's were'} left out: an order is of stock items.`] : []),
    ...(serviced > 0 ? [`${serviced} service line${serviced === 1 ? ' was' : 's were'} left out: an order is of stock items.`] : []),
  ];
  return {
    form: {
      ...next,
      closed: false,
      lines: (kept.length > 0 ? kept : [blankSalesLine(crypto.randomUUID(), undefined, form.date)]).map(({ challanId: _c, challanLineId: _cl, ...l }) => ({ ...l, warehouseId: '', warehouseLabel: '', orderId: '', orderLineId: '', orderLabel: '', due: form.date, dueText: formatDate(form.date) })),
    },
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

// ---- from an order to an invoice ---------------------------------------------------------------------------------

export interface OpenOrder {
  readonly orderId: string;
  readonly number: string;
  /** The customer's PO number, or empty. */
  readonly reference: string;
  /** The soonest due date among the lines still pending. */
  readonly due: string;
  /** How many lines still have something to deliver. */
  readonly lines: number;
}

/** A party's open orders, one entry each (soonest due first): what the Cust PO / ref (PO / ref) field offers on an invoice. */
export function openOrdersOf(orders: OrderBook, partyId: string, ownId: string, side: DocSide = 'sales'): OpenOrder[] {
  const byOrder = new Map<string, OpenOrder>();
  for (const l of openOrderLines(orders, partyId, undefined, ownId, side)) {
    const seen = byOrder.get(l.orderId);
    byOrder.set(
      l.orderId,
      seen
        ? { ...seen, lines: seen.lines + 1, due: seen.due < l.due ? seen.due : l.due }
        : { orderId: l.orderId, number: l.number, reference: l.reference ?? '', due: l.due, lines: 1 },
    );
  }
  return [...byOrder.values()].sort((a, b) => (a.due !== b.due ? (a.due < b.due ? -1 : 1) : a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
}

/** What the order is called where a person reads it: the customer's PO number, or ours when they gave none — and on the purchase side always ours. */
export const orderCallName = (o: Pick<OpenOrder, 'reference' | 'number'>, side: DocSide = 'sales'): string => (side === 'sales' && o.reference !== '' ? o.reference : o.number);

/** True while no line has anything on it (an invoice that can be filled from an order without losing what was typed). */
export const hasNoLines = (form: SalesForm): boolean => form.lines.every(isEmptyLine);

/**
 * The godown an invoice line should leave from: the fallback (the main godown) if it holds at least the quantity needed of the item on that
 * date, otherwise the godown that holds the most — so a line for goods kept in another store starts where the goods are. Nothing anywhere:
 * the fallback.
 */
export function godownWithStock(
  masters: Masters,
  stock: StockBook,
  itemId: string,
  date: string,
  fallback?: { id: string; label: string },
  needed: bigint = 1n,
): { id: string; label: string } | undefined {
  const held = (id: string): bigint => stock.qtyAt(itemId as never, id as never, date as never);
  if (fallback && held(fallback.id) >= (needed > 0n ? needed : 1n)) return fallback;
  let best: { id: string; label: string } | undefined;
  let most = 0n;
  for (const w of masters.warehouses) {
    if (!w.isActive) continue;
    const q = held(w.id);
    if (q > most) {
      most = q;
      best = { id: w.id, label: w.name };
    }
  }
  return best ?? fallback;
}

/** Invoice lines for order lines (a delivery, or on the purchase side a receipt): each carries the order line's item, what is pending, the agreed rate, and the reference to it. */
function linesFromOrder(
  options: readonly OrderOption[],
  masters: Masters,
  newKey: () => string,
  warehouseFor: (itemId: string, qty: bigint) => { id: string; label: string } | undefined,
): SalesLineForm[] {
  return options.map((o) => ({
    ...blankSalesLine(newKey(), warehouseFor(o.itemId, o.pending)),
    itemId: o.itemId,
    ...gstDefaults(masters, o.itemId),
    itemLabel: masters.stockItem(o.itemId as never)?.name ?? '',
    qty: trimPlaces(formatQty(o.pending, 4)),
    rate: trimPlaces(formatRate(o.rate)),
    orderId: o.orderId,
    orderLineId: o.lineId,
    orderLabel: o.number,
  }));
}

/**
 * Puts an order's pending lines on an invoice: the ones not already on it are added after what is there (empty lines are dropped, lines
 * for other things are left alone). Choosing a PO is "invoice what is remaining on it", not "start again".
 */
export function withOrderLines(
  form: SalesForm,
  pending: readonly OrderOption[],
  masters: Masters,
  newKey: () => string,
  warehouseFor: (itemId: string, qty: bigint) => { id: string; label: string } | undefined,
): { form: SalesForm; added: number } {
  const have = new Set(form.lines.filter((l) => l.orderId !== '').map((l) => `${l.orderId}|${l.orderLineId}`));
  const missing = pending.filter((o) => !have.has(`${o.orderId}|${o.lineId}`));
  if (missing.length === 0) return { form, added: 0 };
  const kept = form.lines.filter((l) => !isEmptyLine(l));
  return { form: { ...form, lines: [...kept, ...linesFromOrder(missing, masters, newKey, warehouseFor)] }, added: missing.length };
}

/**
 * A new invoice for what an order still has to deliver: its customer, PO reference and party details, and a line for every order line with
 * something pending — quantity = what is pending, rate = what was agreed, each against its order line. Undefined if there is nothing to
 * invoice (the order is closed, or delivered in full). The date is today's, but never before the order's.
 */
export function invoiceFormFromOrder(
  order: Voucher,
  orders: OrderBook,
  masters: Masters,
  args: {
    id: string;
    typeId: string;
    date: string;
    newKey: () => string;
    warehouse?: { id: string; label: string } | undefined;
    salesLedger?: { id: string; label: string } | undefined;
    /** With the company's stock, each line starts in the godown that holds the goods. */
    stock?: StockBook | undefined;
  },
): SalesForm | undefined {
  const state = orders.state(order.id);
  if (!state || state.status !== 'open') return undefined;
  const party = masters.party(state.order.partyId);
  if (!party) return undefined;
  const date = args.date < state.order.date ? state.order.date : args.date;
  const side = state.order.side;
  const pending = openOrderLines(orders, state.order.partyId, undefined, args.id, side).filter((o) => o.orderId === order.id);
  if (pending.length === 0) return undefined;
  const blank = blankSalesForm(args.id, args.typeId, date, args.newKey(), { warehouse: args.warehouse, salesLedger: args.salesLedger });
  const snapshot = (order.content as unknown as { partyDetails?: PartyDetails }).partyDetails;
  const due = dueDateFor(masters, party.id, date);
  return {
    ...blank,
    partyId: party.id,
    partyLabel: party.name,
    reference: side === 'purchase' ? state.order.number : (state.order.reference ?? ''),
    partyDetails: snapshot ?? partyDetailsOfParty(party),
    due,
    dueText: formatDate(due),
    lines: linesFromOrder(pending, masters, args.newKey, (itemId, qty) => (args.stock ? godownWithStock(masters, args.stock, itemId, date, args.warehouse, qty) : args.warehouse)),
  };
}

/**
 * A new sales order from a posted quotation: the customer, reference and party details carry over; each quoted line becomes an order line
 * with a fresh line id, due on the order date (the person sets the real dates on the order). The quote number fills an empty reference
 * and is noted in the narration; the order remembers the quote (`quotationId`), which keeps the quote as it was from then on.
 */
export function orderFormFromQuotation(
  quote: Voucher,
  masters: Masters,
  args: { id: string; typeId: string; date: string; newKey: () => string },
): SalesForm | undefined {
  if (masters.voucherType(quote.voucherTypeId)?.baseKind !== 'quotation') return undefined;
  if (quote.status !== 'posted') return undefined;
  const src = salesFormFromVoucher(quote, masters, orderBookOf([], masters));
  // an order is of stock items: a one-time (written) line on the quote does not come along
  const kept = src.lines.filter((l) => !isEmptyLine(l) && !l.oneTime);
  if (kept.length === 0) return undefined;
  const date = args.date < quote.date ? quote.date : args.date;
  const blank = blankSalesForm(args.id, args.typeId, date, args.newKey());
  const note = `From quotation ${quote.number}`;
  return {
    ...blank,
    partyId: src.partyId,
    partyLabel: src.partyLabel,
    reference: src.reference.trim() !== '' ? src.reference : quote.number,
    partyDetails: src.partyDetails,
    narration: src.narration.trim() !== '' ? `${src.narration.trim()} · ${note}` : note,
    quotationId: quote.id,
    lines: kept.map((l) => ({
      ...blankSalesLine(args.newKey(), undefined, date),
      itemId: l.itemId,
      itemLabel: l.itemLabel,
      qty: l.qty,
      rate: l.rate,
    })),
  };
}

/** The posted sales order made from this quotation, if any (a cancelled order frees the quote again). */
export function orderOfQuotation(quoteId: string, vouchers: readonly Voucher[]): Voucher | undefined {
  return vouchers.find((v) => v.status === 'posted' && (v.content as unknown as { quotationId?: string }).quotationId === quoteId);
}

// ---- a returnable challan comes back ----------------------------------------------------------------------------

/**
 * The return of a returnable challan, ready to post: the same supplier, party details and lines (items, godowns, quantities, values) coming
 * back, dated `date` — never before the challan.
 */
export function returnDraftOf(challan: Voucher, args: { id: string; date: string }): Record<string, unknown> {
  const c = challan.content as unknown as Record<string, unknown>;
  const date = args.date < challan.date ? challan.date : args.date;
  return {
    id: args.id,
    voucherTypeId: challan.voucherTypeId,
    date,
    partyId: c['partyId'],
    ...(c['partyDetails'] ? { partyDetails: c['partyDetails'] } : {}),
    ...(c['reference'] ? { reference: c['reference'] } : {}),
    narration: `Return of ${challan.number}`,
    returnOf: challan.id,
    ...(c['gst'] ? { gst: c['gst'] } : {}),
    lines: c['lines'],
  };
}

// ---- from a delivery challan to an invoice -------------------------------------------------------------------------

export interface ChallanOption {
  readonly challanId: string;
  readonly lineId: string;
  readonly number: string;
  readonly reference: string | undefined;
  readonly date: string;
  readonly itemId: string;
  readonly sent: Qty;
  readonly pending: Qty;
  readonly rate: Rate;
  readonly gstRate: string | undefined;
  readonly hsn: string | undefined;
}

/**
 * The challan lines a customer's invoice can bill: the customer's sale challans, each line with something still to invoice (for one item, if
 * given), oldest first. `ownId` is the invoice being entered or altered: what it had billed counts as pending again.
 */
export function openChallanLines(orders: OrderBook, partyId: string, itemId: string | undefined, ownId: string): ChallanOption[] {
  const book = orders.challans.withChange({ removeLinksOf: [ownId as never] });
  const out: ChallanOption[] = [];
  for (const state of book.all()) {
    if (state.challan.purpose !== 'sale' || state.challan.partyId !== partyId) continue;
    for (const l of state.lines) {
      if (l.pending <= 0n || (itemId !== undefined && itemId !== '' && l.line.itemId !== itemId)) continue;
      out.push({
        challanId: state.challan.voucherId,
        lineId: l.line.id,
        number: state.challan.number,
        reference: state.challan.reference,
        date: state.challan.date,
        itemId: l.line.itemId,
        sent: l.sent,
        pending: l.pending,
        rate: l.line.rate,
        gstRate: l.line.gstRate,
        hsn: l.line.hsn,
      });
    }
  }
  return out;
}

/** A customer's challans with something still to invoice, one entry each (oldest first): what the Cust PO / ref field offers beside the orders. */
export function openChallansOf(orders: OrderBook, partyId: string, ownId: string): { challanId: string; number: string; reference: string; date: string; lines: number }[] {
  const byChallan = new Map<string, { challanId: string; number: string; reference: string; date: string; lines: number }>();
  for (const l of openChallanLines(orders, partyId, undefined, ownId)) {
    const seen = byChallan.get(l.challanId);
    byChallan.set(l.challanId, seen ? { ...seen, lines: seen.lines + 1 } : { challanId: l.challanId, number: l.number, reference: l.reference ?? '', date: l.date, lines: 1 });
  }
  return [...byChallan.values()];
}

/** Invoice lines for challan lines: the item, what is still to invoice, the challan's rate and GST, no godown (the goods have left). */
export function linesFromChallan(options: readonly ChallanOption[], masters: Masters, newKey: () => string): SalesLineForm[] {
  return options.map((o) => ({
    ...blankSalesLine(newKey()),
    itemId: o.itemId,
    ...gstDefaults(masters, o.itemId),
    ...(o.gstRate !== undefined ? { gstRate: o.gstRate } : {}),
    ...(o.hsn !== undefined ? { hsn: o.hsn } : {}),
    itemLabel: masters.stockItem(o.itemId as never)?.name ?? '',
    qty: trimPlaces(formatQty(o.pending, 4)),
    rate: trimPlaces(formatRate(o.rate)),
    orderLabel: o.number,
    challanId: o.challanId,
    challanLineId: o.lineId,
  }));
}

/** Puts a challan's lines still to invoice on an invoice, after what is there (empty lines are dropped, lines already billing them kept). */
export function withChallanLines(form: SalesForm, pending: readonly ChallanOption[], masters: Masters, newKey: () => string): { form: SalesForm; added: number } {
  const have = new Set(form.lines.filter((l) => l.challanId).map((l) => `${l.challanId}|${l.challanLineId}`));
  const missing = pending.filter((o) => !have.has(`${o.challanId}|${o.lineId}`));
  if (missing.length === 0) return { form, added: 0 };
  const kept = form.lines.filter((l) => !isEmptyLine(l));
  return { form: { ...form, lines: [...kept, ...linesFromChallan(missing, masters, newKey)] }, added: missing.length };
}

/**
 * A new sales invoice for what a challan still has to be billed for: its customer, PO and party details, and a line for every challan line
 * with something pending. Undefined when there is nothing to invoice (free of cost, or invoiced in full). Never dated before the challan.
 */
export function invoiceFormFromChallan(
  challan: Voucher,
  orders: OrderBook,
  masters: Masters,
  args: { id: string; typeId: string; date: string; newKey: () => string; salesLedger?: { id: string; label: string } | undefined },
): SalesForm | undefined {
  const state = orders.challans.state(challan.id);
  if (!state || state.challan.purpose !== 'sale') return undefined;
  const party = masters.party(state.challan.partyId);
  if (!party) return undefined;
  const pending = openChallanLines(orders, party.id, undefined, args.id).filter((o) => o.challanId === challan.id);
  if (pending.length === 0) return undefined;
  const date = args.date < state.challan.date ? state.challan.date : args.date;
  const blank = blankSalesForm(args.id, args.typeId, date, args.newKey(), { salesLedger: args.salesLedger });
  const snapshot = (challan.content as unknown as { partyDetails?: PartyDetails }).partyDetails;
  const due = dueDateFor(masters, party.id, date);
  return {
    ...blank,
    partyId: party.id,
    partyLabel: party.name,
    reference: state.challan.reference ?? '',
    partyDetails: snapshot ?? partyDetailsOfParty(party),
    due,
    dueText: formatDate(due),
    lines: linesFromChallan(pending, masters, args.newKey),
  };
}

/**
 * Why an item the person typed is not offered: it exists but is inactive, or (outside an invoice) is a service — services hold no stock,
 * so an order, quotation or challan does not offer them, only an invoice does. Undefined when nothing hidden matches — so "No match" is
 * honest, and "it's there, but…" is said when it is.
 */
export function hiddenItemReason(masters: Masters, typed: string, allowService = false): string | undefined {
  const t = typed.trim().toLowerCase();
  if (t.length < 2) return undefined;
  const hit = masters.stockItems.find((i) => (!i.isActive || (!allowService && i.itemType === 'service')) && (i.name.toLowerCase().includes(t) || (i.code ?? '').toLowerCase() === t));
  if (!hit) return undefined;
  return hit.isActive ? `“${hit.name}” exists but is a service — services hold no stock, so they are not offered here. Choose it on an invoice instead.` : `“${hit.name}” exists but is inactive — reactivate it in its item form to offer it.`;
}
