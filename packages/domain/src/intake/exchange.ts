import { IssueCode, type Result, fail, issue, ok } from '../errors';
import type { PartyId, StockItemId } from '../ids';
import type { Masters } from '../masters/masters';
import type { Party } from '../masters/records';
import { type Money, formatMoney } from '../money';
import type { BillAllocation } from '../vouchers/drafts';
import { invoiceTotal, vendorLedgerOf } from '../vouchers/kinds/documents';
import type { Voucher } from '../vouchers/voucher';
import type { Extraction, ExtractionLine, IntakeKind } from './extraction';

/**
 * Sending a voucher to another of the owner's companies through the ERP (ADR-0025): "Send via ERP" on a Purchase Order, a Sales Invoice or
 * a Payment. The company it goes to is the one whose GSTIN is the voucher's party's GSTIN; there it arrives in the inbox as what it is to
 * THEM — our purchase order is their sales order, our invoice their purchase, our payment their receipt — to be accepted or rejected.
 *
 * What travels is a READING of our voucher, exactly as a document read from a mail would be (`Extraction`): our company's name and GSTIN as
 * the party, the items by code, name and HSN, the quantities, rates and numbers. The receiving company matches it against ITS OWN masters
 * with `proposeFromExtraction`, the same careful matching the AI Inbox uses: its party is the one with our GSTIN, an item is matched only
 * when certain, and anything else stays text for its person to choose. Nothing is ever created in the other company's books.
 */
export const EXCHANGE_KINDS = { purchaseOrder: 'salesOrder', sales: 'purchase', payment: 'receipt' } as const satisfies Record<string, IntakeKind>;
export type ExchangeKind = keyof typeof EXCHANGE_KINDS;
export const isExchangeKind = (kind: string | undefined): kind is ExchangeKind => kind !== undefined && Object.hasOwn(EXCHANGE_KINDS, kind);

/** What the receiving company gets, and how to find it. */
export interface Outgoing {
  /** What it is to the receiver (their inbox kind). */
  readonly toKind: IntakeKind;
  /** The party this voucher is with: the company to send to is the one with its GSTIN. */
  readonly party: { readonly id: PartyId; readonly name: string; readonly gstin: string };
  readonly extraction: Extraction;
}

const refuse = (message: string, path?: string): Result<Outgoing> => fail(issue(IssueCode.ExchangeNotPossible, message, path));
/** A GSTIN compared as printed or typed: no spaces, upper case. */
export const gstinKey = (s: string | undefined): string => (s ?? '').replace(/\s+/g, '').toUpperCase();
/** "10.0000" → "10", "58.2500" → "58.25": a decimal as a person would print it. */
const plain = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

interface ItemLine {
  readonly itemId?: string | undefined;
  readonly description?: string | undefined;
  readonly unit?: string | undefined;
  readonly qty: string;
  readonly rate: string;
  readonly gstRate?: string | undefined;
  readonly hsn?: string | undefined;
  readonly dueDate?: string | undefined;
}

/**
 * What our voucher becomes for the company it is sent to, or why it cannot be sent: only a posted Purchase Order, Sales Invoice or Payment
 * travels, it must be with ONE party that has a GSTIN, and our company must have a GSTIN of its own (the receiver finds us by it).
 */
export function outgoingOf(voucher: Voucher, masters: Masters): Result<Outgoing> {
  const kind = masters.voucherType(voucher.voucherTypeId)?.baseKind;
  if (!isExchangeKind(kind)) return refuse('Only a Purchase Order, a Sales Invoice or a Payment can be sent to another company');
  if (voucher.status !== 'posted') return refuse('A cancelled voucher cannot be sent');
  const ours = gstinKey(masters.company.gstin);
  if (!ours) return refuse(`${masters.company.name} has no GSTIN: set it in Company Settings (the other company finds you by it)`);

  const content = voucher.content as unknown as Record<string, unknown>;
  const party = kind === 'payment' ? paidParty(content, masters) : partyOf(content['partyId'], masters);
  if ('problem' in party) return refuse(party.problem, 'partyId');
  const theirs = gstinKey(party.gstin);
  if (!theirs) return refuse(`${party.name} has no GSTIN: the ERP finds the company to send to by it`, 'partyId');
  if (theirs === ours) return refuse(`${party.name} has this company’s own GSTIN`, 'partyId');

  const base: Extraction = {
    partyName: masters.company.name,
    partyGstin: ours,
    ...(masters.company.address ? { partyAddress: masters.company.address.slice(0, 400) } : {}),
    date: voucher.date,
    lines: [],
    bills: [],
  };
  const who = { id: party.id, name: party.name, gstin: theirs };

  if (kind === 'payment') {
    const lines = ((content['lines'] as { ledgerId: string; amount: Money; allocations?: BillAllocation[] }[] | undefined) ?? []).filter(
      (l) => l.ledgerId === vendorLedgerOf(party.id),
    );
    const amount = lines.reduce((sum, l) => sum + l.amount, 0n) as Money;
    // Our bills from them are named by THEIR invoice numbers: to them, those are the invoices this money settles.
    const bills = lines
      .flatMap((l) => l.allocations ?? [])
      .filter((a) => a.kind === 'against' && a.ref)
      .map((a) => ({ ref: a.ref, amount: formatMoney(a.amount) }));
    return ok({ toKind: EXCHANGE_KINDS.payment, party: who, extraction: { ...base, amount: formatMoney(amount), bills } });
  }

  const docLines = (content['lines'] as ItemLine[] | undefined) ?? [];
  const lines: ExtractionLine[] = docLines.map((l) => {
    const item = l.itemId ? masters.stockItem(l.itemId as StockItemId) : undefined;
    const unit = item ? masters.unit(item.unitId)?.symbol : l.unit;
    const hsn = l.hsn ?? item?.hsn;
    const description = (item?.name ?? l.description ?? '').slice(0, 200);
    return {
      ...(description ? { description } : {}),
      ...(item?.code ? { code: item.code.slice(0, 40) } : {}),
      ...(hsn ? { hsn: hsn.slice(0, 10) } : {}),
      qty: plain(l.qty),
      rate: plain(l.rate),
      ...(unit ? { unit: unit.slice(0, 20) } : {}),
      ...(l.gstRate ? { gstRate: l.gstRate } : {}),
      ...(l.dueDate ? { dueDate: l.dueDate } : {}),
    };
  });
  const subtotal = formatMoney(invoiceTotal(docLines));
  if (kind === 'purchaseOrder') {
    // Our PO number is their customer's PO.
    return ok({ toKind: EXCHANGE_KINDS.purchaseOrder, party: who, extraction: { ...base, poNumber: voucher.number, lines, subtotal } });
  }
  // Our invoice number is their supplier's invoice number.
  const due = typeof content['dueDate'] === 'string' ? content['dueDate'] : undefined;
  return ok({
    toKind: EXCHANGE_KINDS.sales,
    party: who,
    extraction: { ...base, invoiceNumber: voucher.number, ...(due ? { dueDate: due } : {}), lines, subtotal },
  });
}

function partyOf(id: unknown, masters: Masters): Party | { problem: string } {
  const party = typeof id === 'string' ? masters.party(id as PartyId) : undefined;
  return party ?? { problem: 'The voucher has no party to send it to' };
}

/** A payment is sent to the one supplier it pays; a payment to several parties (or to none) cannot be sent. */
function paidParty(content: Record<string, unknown>, masters: Masters): Party | { problem: string } {
  const lines = (content['lines'] as { ledgerId: string }[] | undefined) ?? [];
  const paid = new Map<string, Party>();
  for (const l of lines) {
    const party = masters.parties.find((p) => vendorLedgerOf(p.id) === l.ledgerId);
    if (party) paid.set(party.id, party);
  }
  if (paid.size === 0) return { problem: 'The payment is not to a supplier: nothing to send' };
  if (paid.size > 1) return { problem: 'The payment is to several suppliers: send a payment to one supplier at a time' };
  return [...paid.values()][0]!;
}
