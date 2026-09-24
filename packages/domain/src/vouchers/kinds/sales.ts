import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { VoucherId, WarehouseId } from '../../ids';
import type { PlannedLine } from '../../posting/plan';
import { draftBaseShape, ledgerIdSchema, localDateSchema } from '../drafts';
import { defineVoucherKind } from '../kind';
import {
  customerLedgerOf,
  customerProblems,
  deliveryProblems,
  documentShape,
  invoiceLineSchema,
  invoiceTotal,
  itemLinesOf,
  lineKindProblems,
  lineValueProblems,
  onInvoiceLines,
  plannedLinksOf,
} from './documents';
import { grandTotal, gstHeaderSchema, invoiceGst, taxPostings } from './gstDoc';
import { plannedStockOf, shortfallProblems, stockEntryProblems } from './stockJournal';

/**
 * Sales Invoice: goods sold to a customer. One posting, three effects (ADR-0015):
 *   accounts — Dr the customer's ledger / Cr the sales ledger for the total (quantity × rate of every line, each to the paisa), the
 *              customer's line being a NEW BILL whose reference is this invoice's number and which falls due on `dueDate`;
 *   stock    — every line takes its quantity OUT of its godown, valued by the stock book (no cost-of-sales entry: periodic method);
 *   orders   — every line that names an order line fills it; more than is pending on that line is refused.
 * GST (ADR-0019) is added to the same posting: the customer owes the items plus the tax, the sales ledger gets the items, and each tax head credits its Output ledger.
 */
export const salesDraftSchema = z.object({
  ...draftBaseShape,
  ...documentShape,
  salesLedgerId: ledgerIdSchema,
  /** When the customer's bill falls due (the date plus the party's credit days, unless someone chose otherwise). */
  dueDate: localDateSchema,
  /** The E-way Bill number for this invoice's movement of goods, if one was generated. Sales-Invoice-only: not part of `documentShape`. */
  ewayBillNo: z.string().trim().max(30).optional(),
  /** The GST of the invoice (only when the company charges GST and a line has a rate): where the supply is from and to, and the tax the lines come to. */
  gst: gstHeaderSchema.optional(),
  lines: z.array(invoiceLineSchema),
});
export type SalesDraft = z.output<typeof salesDraftSchema>;

const asEntries = (lines: SalesDraft['lines']) =>
  itemLinesOf(lines).map(({ line: l }) => ({ itemId: l.itemId, warehouseId: l.warehouseId as WarehouseId, direction: 'out' as const, qty: l.qty }));
/** Where each stock entry sits on the invoice (one-time lines have none). */
const placesOf = (lines: SalesDraft['lines']) => itemLinesOf(lines).map((x) => x.at);

export const salesKind = defineVoucherKind<SalesDraft>({
  base: 'sales',
  layout: 'item-invoice',
  schema: salesDraftSchema,

  ledgerRefs: (draft) => [{ ledgerId: draft.salesLedgerId, path: 'salesLedgerId' }],

  validate(draft, { masters, stock, orders }) {
    const problems: Issue[] = customerProblems(draft, masters);
    const salesLedger = masters.ledger(draft.salesLedgerId);
    if (!salesLedger || !masters.groups.isWithinReserved(salesLedger.groupId, 'sales-accounts')) {
      problems.push(issue(IssueCode.SalesDocInvalid, 'Sales are booked to a ledger under Sales Accounts', 'salesLedgerId'));
    }
    if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, 'An invoice needs at least one line', 'lines'));
    problems.push(...invoiceGst(draft, masters, 'sales').problems);
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
      ...deliveryProblems(draft, masters, orders),
      ...onInvoiceLines(shortfallProblems(asEntries(draft.lines), draft.id, draft.date, masters, stock, 'lines'), placesOf(draft.lines)),
    ];
  },

  post(draft, { masters }): readonly PlannedLine[] {
    return [
      { ledgerId: customerLedgerOf(draft.partyId), side: 'debit', amount: grandTotal(draft.lines, draft.gst) },
      { ledgerId: draft.salesLedgerId, side: 'credit', amount: invoiceTotal(draft.lines) },
      ...taxPostings(masters, 'sales', draft.gst),
    ];
  },
  postStock: (draft) => plannedStockOf(asEntries(draft.lines)),
  stockItems: (draft) => [...new Set(itemLinesOf(draft.lines).map((x) => x.line.itemId))],
  postLinks: (draft) => plannedLinksOf(draft.lines),
  orderIds: (draft) => [...new Set(draft.lines.flatMap((l) => (l.orderRef ? [l.orderRef.orderId as VoucherId] : [])))],
});
