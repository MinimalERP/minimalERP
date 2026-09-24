import { type LocalDate } from '../dates';
import type { LedgerId, VoucherId } from '../ids';
import type { Masters } from '../masters/masters';
import type { PartyRole } from '../masters/records';
import { canonicalPercent } from '../gst/tax';
import { type Money, formatMoney, money } from '../money';
import type { OrderBook } from '../orders/orderBook';
import { parseQty, parseRate, rateOf, rateText } from '../stock/quantity';
import { billRefTaken, openBills } from '../vouchers/allocations';
import { customerLedgerOf, invoiceTotal, vendorLedgerOf } from '../vouchers/kinds/documents';
import { deriveGstHeader, grandTotal } from '../vouchers/kinds/gstDoc';
import type { Voucher } from '../vouchers/voucher';
import { type Extraction, type IntakeKind, isItemKind } from './extraction';
import { matchItem, matchParty } from './match';
import type { Proposal, ProposalBill, ProposalLine, ProposalNote, ProposalNoteCode } from './proposal';

export interface ProposeContext {
  readonly masters: Masters;
  /** The company's vouchers, READABLE (content parsed by its kind's schema, as the books hold them): open bills and duplicates are read from them. */
  readonly vouchers: readonly Voucher[];
  readonly orders: OrderBook;
  /** The date a document without one is proposed on. */
  readonly today: LocalDate;
}

const ROLE: Record<IntakeKind, PartyRole> = { salesOrder: 'customer', sales: 'customer', receipt: 'customer', purchase: 'vendor', payment: 'vendor' };
const WHO: Record<PartyRole, string> = { customer: 'customer', vendor: 'supplier' };

/** A decimal of any precision → paise (rounded half up); undefined when it is not a number. */
function toMoney(s: string | undefined): Money | undefined {
  if (s === undefined) return undefined;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return undefined;
  const frac = (m[2] ?? '').padEnd(3, '0');
  const paise = BigInt(m[1] ?? '0') * 100n + BigInt(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1n : 0n);
  return money(paise);
}

/** Totals within a rupee of each other agree: documents round differently. */
const TOLERANCE = 100n;
const differ = (a: Money, b: Money): boolean => (a > b ? a - b : b - a) > TOLERANCE;
const same = (a: string | undefined, b: string | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase() && (a ?? '').trim() !== '';

/**
 * What the ERP makes of a document's reading: the party and items matched where that is certain, the rest kept as the document's own text,
 * and a note for everything a person should look at (unmatched names, a PO or bill already entered, totals that do not agree). Pure: it
 * posts nothing, creates nothing and never guesses — the person decides in the voucher window.
 */
export function proposeFromExtraction(kind: IntakeKind, x: Extraction, ctx: ProposeContext): Proposal {
  const { masters } = ctx;
  const notes: ProposalNote[] = [];
  const note = (code: ProposalNoteCode, message: string, path?: string) => notes.push({ code, message, ...(path ? { path } : {}) });
  const role = ROLE[kind];

  // ---- party ----
  const hit = matchParty(masters, { name: x.partyName, gstin: x.partyGstin }, role);
  const partyId = hit.kind === 'matched' ? hit.party.id : undefined;
  if (hit.kind === 'wrongRole') {
    note('PARTY_ROLE_MISSING', `"${hit.party.name}" is not a ${WHO[role]} yet: give the party the ${role === 'customer' ? 'Customer' : 'Vendor'} role, or pick another`, 'party');
  } else if (hit.kind === 'none') {
    note('PARTY_UNMATCHED', x.partyName ? `No ${WHO[role]} called "${x.partyName}"${x.partyGstin ? ` (${x.partyGstin})` : ''}: pick one or create it (Alt+C)` : `The document does not name the ${WHO[role]}: pick one`, 'party');
  }

  const date = x.date ?? ctx.today;
  if (!x.date) note('DATE_MISSING', 'The document has no date: today is proposed', 'date');

  const proposal: Proposal = {
    kind,
    date,
    party: {
      ...(partyId ? { partyId } : {}),
      ...(x.partyName ? { name: x.partyName } : {}),
      ...(x.partyGstin ? { gstin: x.partyGstin.replace(/\s+/g, '').toUpperCase().slice(0, 15) } : {}),
      ...(x.partyAddress ? { address: x.partyAddress } : {}),
    },
    ...(x.poNumber ? { reference: x.poNumber } : {}),
    ...(x.dueDate ? { dueDate: x.dueDate } : {}),
    lines: [],
    bills: [],
    notes,
  };

  if (isItemKind(kind)) proposeItems(kind, x, ctx, proposal, note, partyId);
  else proposeMoney(kind, x, ctx, proposal, note, partyId);
  return proposal;
}

type Note = (code: ProposalNoteCode, message: string, path?: string) => void;

function proposeItems(kind: 'salesOrder' | 'sales' | 'purchase', x: Extraction, ctx: ProposeContext, p: Proposal, note: Note, partyId: string | undefined): void {
  const { masters, orders } = ctx;
  const charges = masters.company.chargeGst === true;

  if (kind === 'purchase') {
    if (x.invoiceNumber) {
      p.billNo = x.invoiceNumber;
      if (partyId && billRefTaken(ctx.vouchers, masters, vendorLedgerOf(partyId as never), x.invoiceNumber)) {
        note('DUPLICATE_BILL', `Invoice ${x.invoiceNumber} is already a bill of this supplier: it may have been entered before`, 'billNo');
      }
    } else note('BILL_NO_MISSING', "The supplier's invoice number was not found: enter it", 'billNo');
  }

  // A customer's PO already entered as an order is the commonest duplicate; on an invoice the same PO names the order it delivers against.
  if (partyId && x.poNumber && kind !== 'purchase') {
    const theirs = orders.all().filter((s) => s.order.side === 'sales' && s.order.partyId === partyId && same(s.order.reference, x.poNumber));
    if (kind === 'salesOrder' && theirs[0]) {
      note('DUPLICATE_PO', `PO ${x.poNumber} is already order ${theirs[0].order.number}: it may have been entered before`, 'reference');
    }
    const open = theirs.find((s) => !s.order.closed && s.lines.some((l) => l.pending > 0n));
    if (kind === 'sales' && open) p.fromOrderId = open.order.voucherId as string;
  }

  x.lines.forEach((l, i) => {
    const path = `lines.${i}`;
    const item = matchItem(masters, { description: l.description, code: l.code, hsn: l.hsn });
    // "<part number> - <description>": how the company names its items, so the picker finds it and Alt+C creates it that way
    const code = l.code?.trim();
    const label = (code && l.description && !l.description.includes(code) ? `${code} - ${l.description}` : (l.description ?? code ?? `Line ${i + 1}`)).slice(0, 80);
    if (!item) note('ITEM_UNMATCHED', `"${label}" is not one of your items: pick one or create it (Alt+C)`, `${path}.item`);
    const qty = l.qty ?? '';
    if (qty === '' || parseQty(qty) === undefined) note('QTY_MISSING', `No quantity was read for "${label}"`, `${path}.qty`);
    let rate = l.rate ?? '';
    if (rate === '' && l.amount && qty !== '') {
      const q = parseQty(qty);
      const v = toMoney(l.amount);
      const r = q && v !== undefined ? rateOf(v, q) : undefined;
      if (r !== undefined) rate = rateText(r).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    }
    if (rate === '' || parseRate(rate) === undefined) note('RATE_MISSING', `No rate was read for "${label}"`, `${path}.rate`);
    const itemRate = item?.gstRateId ? masters.gstRate(item.gstRateId)?.ratePercent : undefined;
    const gstRate = kind === 'salesOrder' || !charges ? undefined : (l.gstRate ?? itemRate);
    const line: ProposalLine = {
      ...(item ? { itemId: item.id } : {}),
      text: label,
      qty,
      rate,
      ...(l.unit ? { unit: l.unit.slice(0, 20) } : {}),
      ...((l.hsn ?? item?.hsn) ? { hsn: (l.hsn ?? item?.hsn ?? '').slice(0, 10) } : {}),
      ...(gstRate !== undefined ? { gstRate: canonicalPercent(gstRate) } : {}),
      ...(kind === 'salesOrder' ? { dueDate: l.dueDate ?? x.dueDate ?? p.date } : {}),
    };
    p.lines.push(line);
  });
  if (p.lines.length === 0 && !p.fromOrderId) note('NO_LINES', 'No item lines were read from the document', 'lines');

  // ---- do the document's totals agree with its lines? ----
  const priced = p.lines.length > 0 && p.lines.every((l) => parseQty(l.qty) !== undefined && parseRate(l.rate) !== undefined);
  if (!priced) return;
  const subtotal = invoiceTotal(p.lines);
  const printedSub = toMoney(x.subtotal);
  if (printedSub !== undefined && differ(subtotal, printedSub)) {
    note('TOTAL_MISMATCH', `The lines come to ${formatMoney(subtotal)}, the document says ${formatMoney(printedSub)} before tax: check the quantities and rates`, 'lines');
  }
  const printedGrand = toMoney(x.grandTotal);
  if (printedGrand !== undefined && kind !== 'salesOrder' && partyId) {
    const header = deriveGstHeader(masters, kind === 'sales' ? 'sales' : 'purchase', { partyId, lines: p.lines });
    const total = grandTotal(p.lines, header);
    if (differ(total, printedGrand)) {
      note('TOTAL_MISMATCH', `With tax the lines come to ${formatMoney(total)}, the document says ${formatMoney(printedGrand)}: check the rates and GST %`, 'lines');
    }
  }
}

function proposeMoney(kind: 'receipt' | 'payment', x: Extraction, ctx: ProposeContext, p: Proposal, note: Note, partyId: string | undefined): void {
  const { masters } = ctx;

  // ---- the bank ----
  const banks = masters.ledgers.filter((l) => l.isActive && masters.groups.isWithinReserved(l.groupId, 'bank-accounts', 'bank-od'));
  const digits = (x.bankAccount ?? '').replace(/\D/g, '').slice(-4);
  const named = digits.length === 4 ? banks.filter((l) => [l.name, l.alias, l.code].some((s) => (s ?? '').replace(/\D/g, '').endsWith(digits))) : [];
  const bank = named.length === 1 ? named[0] : banks.length === 1 ? banks[0] : undefined;
  if (bank) p.accountLedgerId = bank.id;
  else note('BANK_UNMATCHED', digits ? `No bank ledger ends in ${digits}: pick the bank` : 'Pick the bank the money went through', 'account');

  // ---- the instrument: the same UTR twice is the same money twice ----
  if (x.instrument) {
    p.instrument = x.instrument;
    const utr = x.instrument.toLowerCase();
    const seen = ctx.vouchers.find(
      (v) =>
        v.status === 'posted' &&
        ['receipt', 'payment'].includes(masters.voucherType(v.voucherTypeId)?.baseKind ?? '') &&
        (v.content.narration ?? '').toLowerCase().includes(utr),
    );
    if (seen) note('DUPLICATE_UTR', `${x.instrument} is already in ${seen.number}: this payment may have been entered before`, 'instrument');
  }

  // ---- the bills it settles ----
  const ledger = partyId ? ((kind === 'receipt' ? customerLedgerOf : vendorLedgerOf)(partyId as never) as LedgerId) : undefined;
  const open = ledger ? openBills(ctx.vouchers, masters, ledger) : [];
  let settledCash = 0n;
  for (const b of x.bills) {
    if (!b.ref || !b.amount) continue;
    const amount = toMoney(b.amount);
    if (amount === undefined) continue;
    const tds = kind === 'receipt' ? toMoney(b.tds) : undefined;
    const isOpen = open.some((o) => same(o.ref, b.ref));
    if (!isOpen && partyId) note('BILL_NOT_OPEN', `${b.ref} is not an open bill of this party: it will go on account unless you choose a bill`, 'bills');
    const bill: ProposalBill = { ref: b.ref, amount: formatMoney(amount), ...(tds ? { tds: formatMoney(tds) } : {}), open: isOpen };
    p.bills.push(bill);
    settledCash += amount - (tds ?? 0n);
  }

  const amount = toMoney(x.amount) ?? (p.bills.length > 0 ? money(settledCash) : undefined);
  if (amount === undefined) {
    note('AMOUNT_MISSING', 'The amount paid was not found: enter it', 'amount');
    return;
  }
  p.amount = formatMoney(amount);
  if (amount > settledCash && p.bills.length > 0) {
    note('UNALLOCATED', `${formatMoney(money(amount - settledCash))} is not against any bill: it goes on account unless you choose one`, 'bills');
  } else if (amount < settledCash) {
    note('TOTAL_MISMATCH', `The bills come to ${formatMoney(money(settledCash))} but ${formatMoney(amount)} was paid: check the amounts`, 'bills');
  }
}

/** The voucher id an accepted proposal posts under: the inbox item's own id, so accepting twice can only ever post once. */
export const voucherIdOfInboxItem = (inboxId: string): VoucherId => inboxId as VoucherId;

