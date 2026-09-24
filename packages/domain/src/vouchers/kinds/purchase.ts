import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { VoucherId, WarehouseId } from '../../ids';
import type { PlannedLine } from '../../posting/plan';
import { draftBaseShape, ledgerIdSchema, localDateSchema } from '../drafts';
import { defineVoucherKind } from '../kind';
import {
  deliveryProblems,
  documentShape,
  invoiceLineSchema,
  invoiceTotal,
  itemLinesOf,
  lineKindProblems,
  lineValueProblems,
  onInvoiceLines,
  partyProblems,
  plannedLinksOf,
  vendorLedgerOf,
} from './documents';
import { grandTotalParts, gstHeaderSchema, invoiceGst, roundOffPosting, roundOffProblems, taxPostings } from './gstDoc';
import { plannedStockOf, shortfallProblems, stockEntryProblems } from './stockJournal';

/**
 * Purchase Invoice: goods bought from a supplier. One posting, three effects (ADR-0018), the mirror of the Sales Invoice:
 *   accounts — Dr the purchase ledger / Cr the supplier's ledger for the total (quantity × rate of every line, each to the paisa), the
 *              supplier's line being a NEW BILL named by the SUPPLIER'S invoice number (`billNo`) and falling due on `dueDate`;
 *   stock    — every line takes its quantity IN to its godown at its rate (the stock book's average cost moves; periodic method);
 *   orders   — every line that names a purchase-order line fills it; receiving more than is pending on that line is refused.
 * GST (ADR-0019) is added to the same posting: each tax head debits its Input ledger and the supplier is owed the items plus the tax. The stock value stays
 * the items alone: the tax is not part of what the goods cost.
 */
export const purchaseDraftSchema = z.object({
  ...draftBaseShape,
  ...documentShape,
  purchaseLedgerId: ledgerIdSchema,
  /** The supplier's own invoice number: the name of the bill this raises, and what a payment is matched against. */
  billNo: z.string().trim().min(1, 'Enter the supplier’s invoice number').max(60),
  /** When the supplier's bill falls due (the date plus the supplier's credit days, unless someone chose otherwise). */
  dueDate: localDateSchema,
  /** The GST of the invoice (only when the company charges GST and a line has a rate): where the supply is from and to, and the tax the lines come to. */
  gst: gstHeaderSchema.optional(),
  lines: z.array(invoiceLineSchema),
});
export type PurchaseDraft = z.output<typeof purchaseDraftSchema>;

/** A purchase brings goods IN, valued at the line's rate. */
const asEntries = (lines: PurchaseDraft['lines']) =>
  itemLinesOf(lines).map(({ line: l }) => ({ itemId: l.itemId, warehouseId: l.warehouseId as WarehouseId, direction: 'in' as const, qty: l.qty, rate: l.rate }));
/** Where each stock entry sits on the invoice (one-time lines have none). */
const placesOf = (lines: PurchaseDraft['lines']) => itemLinesOf(lines).map((x) => x.at);

export const purchaseKind = defineVoucherKind<PurchaseDraft>({
  base: 'purchase',
  layout: 'item-invoice',
  schema: purchaseDraftSchema,

  ledgerRefs: (draft) => [{ ledgerId: draft.purchaseLedgerId, path: 'purchaseLedgerId' }],

  validate(draft, { masters, stock, orders }) {
    const problems: Issue[] = partyProblems(draft, masters, 'vendor');
    const ledger = masters.ledger(draft.purchaseLedgerId);
    if (!ledger || !masters.groups.isWithinReserved(ledger.groupId, 'purchase-accounts')) {
      problems.push(issue(IssueCode.SalesDocInvalid, 'Purchases are booked to a ledger under Purchase Accounts', 'purchaseLedgerId'));
    }
    if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, 'A purchase invoice needs at least one line', 'lines'));
    problems.push(...invoiceGst(draft, masters, 'purchase').problems);
    problems.push(...roundOffProblems(masters, grandTotalParts(draft.lines, draft.gst).roundOff));
    if (draft.dueDate < draft.date) {
      problems.push(issue(IssueCode.SalesDocInvalid, `The due date is before the invoice date (${draft.date})`, 'dueDate'));
    }
    const places = placesOf(draft.lines);
    draft.lines.forEach((line, i) => {
      problems.push(...lineKindProblems(line, `lines.${i}`));
      problems.push(...lineValueProblems(line, `lines.${i}`));
    });
    if (problems.length === 0) {
      asEntries(draft.lines).forEach((e, k) => problems.push(...onInvoiceLines(stockEntryProblems(e, masters, `lines.${k}`), places)));
    }
    if (problems.length === 0 && invoiceTotal(draft.lines) <= 0n) {
      problems.push(issue(IssueCode.AmountNotPositive, 'The invoice comes to nothing: enter the rates', 'lines'));
    }
    if (problems.length > 0) return problems;
    return [
      ...deliveryProblems(draft, masters, orders, 'purchase'),
      // an alteration that lowers what came in can leave a later day short
      ...onInvoiceLines(shortfallProblems(asEntries(draft.lines), draft.id, draft.date, masters, stock, 'lines'), placesOf(draft.lines)),
    ];
  },

  post(draft, { masters }): readonly PlannedLine[] {
    const { rounded, roundOff } = grandTotalParts(draft.lines, draft.gst);
    return [
      { ledgerId: draft.purchaseLedgerId, side: 'debit', amount: invoiceTotal(draft.lines) },
      ...taxPostings(masters, 'purchase', draft.gst),
      { ledgerId: vendorLedgerOf(draft.partyId), side: 'credit', amount: rounded },
      ...roundOffPosting(masters, 'purchase', roundOff),
    ];
  },
  postStock: (draft) => plannedStockOf(asEntries(draft.lines)),
  stockItems: (draft) => [...new Set(itemLinesOf(draft.lines).map((x) => x.line.itemId))],
  postLinks: (draft) => plannedLinksOf(draft.lines),
  orderIds: (draft) => [...new Set(draft.lines.flatMap((l) => (l.orderRef ? [l.orderRef.orderId as VoucherId] : [])))],
});
