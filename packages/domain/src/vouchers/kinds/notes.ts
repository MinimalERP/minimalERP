import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { LedgerId, PartyId, WarehouseId } from '../../ids';
import type { BaseKind, Masters } from '../../masters/masters';
import { type Money, ZERO, formatMoney, money, parseMoney } from '../../money';
import type { PlannedLine } from '../../posting/plan';
import type { StockBook } from '../../stock/book';
import type { PlannedStock } from '../../stock/movement';
import { draftBaseShape, ledgerIdSchema, moneySchema } from '../drafts';
import { defineVoucherKind } from '../kind';
import {
  type DocSide,
  customerLedgerOf,
  documentShape,
  invoiceLineSchema,
  invoiceTotal,
  itemLinesOf,
  lineKindProblems,
  lineValueProblems,
  onInvoiceLines,
  partyProblems,
  stockLinesOf,
  vendorLedgerOf,
} from './documents';
import { type GstHeader, grandTotal, grandTotalParts, gstHeaderSchema, invoiceGst, roundOffPosting, roundOffProblems, taxPostings } from './gstDoc';
import { plannedStockOf, shortfallProblems, stockEntryProblems } from './stockJournal';

/**
 * Credit Note and Debit Note (ADR-0026): an invoice taken back, in whole or in part.
 *
 *   Credit Note — we credit a CUSTOMER (goods returned to us, or a price reduced): the exact reverse of a Sales Invoice. Dr the sales ledger
 *                 and the Output GST ledgers / Cr the customer; every stock line comes back IN to its godown, at the book's own cost (so a
 *                 return never moves the average cost).
 *   Debit Note  — we debit a SUPPLIER (goods sent back, or a price reduced): the exact reverse of a Purchase Invoice. Dr the supplier / Cr
 *                 the purchase ledger and the Input GST ledgers; every stock line goes OUT of its godown.
 *
 * A note is of the lines it names, like an invoice: a stock item (it moves), a service item or a written line (they do not — a rate
 * difference or a discount is a written line). It may name the invoice it is for (`invoiceRef`: our invoice number on a credit note, the
 * supplier's on a debit note) and say how much of it is SET AGAINST that invoice's bill (`against`); whatever is not stands as a bill of
 * its own on the other side of the party's ledger, named by the note's number — to be refunded or set against a later invoice.
 */

const noteShape = {
  ...draftBaseShape,
  ...documentShape,
  /** The invoice this note is for: our invoice number (credit note) or the supplier's (debit note). */
  invoiceRef: z.string().trim().min(1).max(60).optional(),
  /** How much of the note settles that invoice's bill. The rest is a bill of the note's own. */
  against: moneySchema.optional(),
  gst: gstHeaderSchema.optional(),
  lines: z.array(invoiceLineSchema),
};

export const creditNoteDraftSchema = z.object({ ...noteShape, salesLedgerId: ledgerIdSchema });
export type CreditNoteDraft = z.output<typeof creditNoteDraftSchema>;

export const debitNoteDraftSchema = z.object({ ...noteShape, purchaseLedgerId: ledgerIdSchema });
export type DebitNoteDraft = z.output<typeof debitNoteDraftSchema>;

type NoteDraft = Omit<CreditNoteDraft, 'salesLedgerId'>;

export const isNoteKind = (kind: string | undefined): kind is 'creditNote' | 'debitNote' => kind === 'creditNote' || kind === 'debitNote';

/** The side a note belongs to: a credit note is the sales side's, a debit note the purchase side's. */
export const noteSideOf = (kind: 'creditNote' | 'debitNote'): DocSide => (kind === 'creditNote' ? 'sales' : 'purchase');

const flipped = (lines: readonly PlannedLine[]): PlannedLine[] => lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' }));

/** A note's stock: back IN on a credit note (the rate only says it is an In; its value is the book's cost), OUT on a debit note. */
const asEntries = (lines: NoteDraft['lines'], masters: Masters, side: DocSide) =>
  stockLinesOf(lines, masters).map(({ line: l }) => ({
    itemId: l.itemId,
    warehouseId: l.warehouseId as WarehouseId,
    direction: side === 'sales' ? ('in' as const) : ('out' as const),
    qty: l.qty,
    ...(side === 'sales' ? { rate: l.rate } : {}),
  }));
const placesOf = (lines: NoteDraft['lines'], masters: Masters) => stockLinesOf(lines, masters).map((x) => x.at);

function noteProblems(draft: NoteDraft, ledgerId: LedgerId, ledgerPath: string, side: DocSide, masters: Masters, stock: StockBook): Issue[] {
  const name = side === 'sales' ? 'credit note' : 'debit note';
  const problems: Issue[] = partyProblems(draft, masters, side === 'sales' ? 'customer' : 'vendor');
  const ledger = masters.ledger(ledgerId);
  if (!ledger || !masters.groups.isWithinReserved(ledger.groupId, side === 'sales' ? 'sales-accounts' : 'purchase-accounts')) {
    problems.push(
      issue(IssueCode.SalesDocInvalid, side === 'sales' ? 'A credit note reverses a ledger under Sales Accounts' : 'A debit note reverses a ledger under Purchase Accounts', ledgerPath),
    );
  }
  if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, `A ${name} needs at least one line`, 'lines'));
  problems.push(...invoiceGst(draft, masters, side).problems);
  const { rounded, roundOff } = grandTotalParts(draft.lines, draft.gst);
  problems.push(...roundOffProblems(masters, roundOff));
  if (draft.against !== undefined) {
    if (draft.invoiceRef === undefined) problems.push(issue(IssueCode.AllocationInvalid, 'Name the invoice this is set against', 'invoiceRef'));
    else if (draft.against <= 0n) problems.push(issue(IssueCode.AllocationInvalid, 'The amount set against the invoice must be above zero', 'against'));
    else if (draft.against > rounded) {
      problems.push(issue(IssueCode.AllocationInvalid, `${formatMoney(draft.against)} is set against ${draft.invoiceRef}, but the ${name} is ${formatMoney(rounded)}`, 'against'));
    }
  }
  const places = placesOf(draft.lines, masters);
  draft.lines.forEach((line, i) => {
    problems.push(...lineKindProblems(line, `lines.${i}`, masters));
    if (line.orderRef) problems.push(issue(IssueCode.OrderRefInvalid, `A ${name} line is not against an order`, `lines.${i}.orderRef`));
    if (line.challanRef) problems.push(issue(IssueCode.OrderRefInvalid, `A ${name} line is not against a challan`, `lines.${i}.challanRef`));
    problems.push(...lineValueProblems(line, `lines.${i}`));
  });
  if (problems.length === 0) {
    asEntries(draft.lines, masters, side).forEach((e, k) => problems.push(...onInvoiceLines(stockEntryProblems(e, masters, `lines.${k}`), places)));
  }
  if (problems.length === 0 && invoiceTotal(draft.lines) <= 0n) {
    problems.push(issue(IssueCode.AmountNotPositive, `The ${name} comes to nothing: enter the rates`, 'lines'));
  }
  if (problems.length > 0) return problems;
  // a debit note cannot send back more than there is; an alteration that brings less back can leave a later day short
  return onInvoiceLines(shortfallProblems(asEntries(draft.lines, masters, side), draft.id, draft.date, masters, stock, 'lines'), places);
}

export const creditNoteKind = defineVoucherKind<CreditNoteDraft>({
  base: 'creditNote',
  layout: 'item-invoice',
  schema: creditNoteDraftSchema,

  ledgerRefs: (draft) => [{ ledgerId: draft.salesLedgerId, path: 'salesLedgerId' }],
  validate: (draft, { masters, stock }) => noteProblems(draft, draft.salesLedgerId, 'salesLedgerId', 'sales', masters, stock),

  post(draft, { masters }): readonly PlannedLine[] {
    const { rounded, roundOff } = grandTotalParts(draft.lines, draft.gst);
    return flipped([
      { ledgerId: customerLedgerOf(draft.partyId), side: 'debit', amount: rounded },
      { ledgerId: draft.salesLedgerId, side: 'credit', amount: invoiceTotal(draft.lines) },
      ...taxPostings(masters, 'sales', draft.gst),
      ...roundOffPosting(masters, 'sales', roundOff),
    ]);
  },
  // back in at what the book holds the item at, not at what it was sold for
  postStock: (draft, { masters, stock }): PlannedStock[] =>
    plannedStockOf(asEntries(draft.lines, masters, 'sales')).map((m) => ({ ...m, value: stock.costOf(m.itemId, draft.date, m.qty) })),
  stockItems: (draft) => [...new Set(itemLinesOf(draft.lines).map((x) => x.line.itemId))],
});

export const debitNoteKind = defineVoucherKind<DebitNoteDraft>({
  base: 'debitNote',
  layout: 'item-invoice',
  schema: debitNoteDraftSchema,

  ledgerRefs: (draft) => [{ ledgerId: draft.purchaseLedgerId, path: 'purchaseLedgerId' }],
  validate: (draft, { masters, stock }) => noteProblems(draft, draft.purchaseLedgerId, 'purchaseLedgerId', 'purchase', masters, stock),

  post(draft, { masters }): readonly PlannedLine[] {
    const { rounded, roundOff } = grandTotalParts(draft.lines, draft.gst);
    return flipped([
      { ledgerId: draft.purchaseLedgerId, side: 'debit', amount: invoiceTotal(draft.lines) },
      ...taxPostings(masters, 'purchase', draft.gst),
      { ledgerId: vendorLedgerOf(draft.partyId), side: 'credit', amount: rounded },
      ...roundOffPosting(masters, 'purchase', roundOff),
    ]);
  },
  postStock: (draft, { masters }) => plannedStockOf(asEntries(draft.lines, masters, 'purchase')),
  stockItems: (draft) => [...new Set(itemLinesOf(draft.lines).map((x) => x.line.itemId))],
});

// ---- reading a posted note back -----------------------------------------------------------------------------------------

export interface NoteSettlement {
  /** The party ledger the note is on, and the side it is posted to: a credit note credits the customer, a debit note debits the supplier. */
  readonly ledgerId: LedgerId;
  readonly side: 'debit' | 'credit';
  /** What the note comes to with its GST, rounded as it was posted. */
  readonly total: Money;
  readonly invoiceRef: string | undefined;
  /** The part set against `invoiceRef`'s bill, and the part that stands as the note's own bill. */
  readonly against: Money;
  readonly open: Money;
}

const moneyOf = (v: unknown): Money => (typeof v === 'bigint' ? money(v) : (parseMoney(String(v ?? '0')) ?? ZERO));

/** How a stored note's amount is split between the invoice it is set against and a bill of its own (money as a bigint or as decimal text). */
export function noteSettlementOf(kind: BaseKind | undefined, content: unknown): NoteSettlement | undefined {
  if (!isNoteKind(kind)) return undefined;
  const c = content as { partyId?: string; invoiceRef?: string; against?: unknown; gst?: GstHeader; lines?: { qty: string; rate: string }[] };
  if (typeof c.partyId !== 'string' || !Array.isArray(c.lines)) return undefined;
  const header = c.gst === undefined ? undefined : { cgst: moneyOf(c.gst.cgst), sgst: moneyOf(c.gst.sgst), igst: moneyOf(c.gst.igst) };
  const total = grandTotal(c.lines, header);
  const invoiceRef = typeof c.invoiceRef === 'string' && c.invoiceRef.trim() !== '' ? c.invoiceRef.trim() : undefined;
  const stated = invoiceRef === undefined ? ZERO : moneyOf(c.against);
  const against = stated < 0n ? ZERO : stated > total ? total : stated;
  return {
    ledgerId: kind === 'creditNote' ? customerLedgerOf(c.partyId as PartyId) : vendorLedgerOf(c.partyId as PartyId),
    side: kind === 'creditNote' ? 'credit' : 'debit',
    total,
    invoiceRef,
    against,
    open: money(total - against),
  };
}
