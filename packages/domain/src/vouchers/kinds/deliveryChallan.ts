import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { VoucherId, WarehouseId } from '../../ids';
import type { Masters } from '../../masters/masters';
import { formatQty, parseQty } from '../../stock/quantity';
import { draftBaseShape } from '../drafts';
import { defineVoucherKind } from '../kind';
import { customerProblems, documentShape, lineValueProblems, onInvoiceLines } from './documents';
import { grandTotalParts, gstHeaderSchema, invoiceGst, roundOffProblems } from './gstDoc';
import { percentSchema } from '../../gst/tax';
import { itemIdSchema, itemQtyProblems, plannedStockOf, qtySchema, rateSchema, shortfallProblems, stockEntryProblems, warehouseIdSchema } from './stockJournal';
import { CHALLAN_PURPOSES } from '../../orders/challanBook';

const lineIdSchema = z.string().trim().min(1).max(40);

/**
 * A challan line: a stock item — the godown it leaves, quantity and rate (its value, which the challan must state), and the GST rate and
 * HSN it prints — or a service item, or, written (Alt+T), a non-stock extra that goes out with the shipment (packing material, a free
 * sample, a printed note): no godown, no stock moved, and never billed against — it is for the printed challan alone. A service item is
 * the same, but a real item: job work on a part that was never our own stock (we never took it in, so nothing of ours leaves on it).
 */
const challanLineSchema = z.object({
  /** Chosen once and kept across alterations, so what is invoiced against this line keeps pointing at it. */
  id: lineIdSchema,
  itemId: itemIdSchema.optional(),
  /** A written line: text instead of a stock item. */
  description: z.string().trim().min(1).max(200).optional(),
  /** A written line's unit (a unit master's symbol), for the printed challan. */
  unit: z.string().trim().min(1).max(20).optional(),
  warehouseId: warehouseIdSchema.optional(),
  qty: qtySchema,
  rate: rateSchema,
  gstRate: percentSchema.optional(),
  hsn: z.string().trim().max(10).optional(),
});

/**
 * Delivery Challan: goods going out to a customer without a bill — to be invoiced later, or free of cost. It takes each line's quantity OUT
 * of its godown, like an invoice, and posts nothing to the accounts. Its value and GST are stated for the printed challan (Rule 55), not posted.
 */
export const deliveryChallanDraftSchema = z.object({
  ...draftBaseShape,
  ...documentShape,
  purpose: z.enum(CHALLAN_PURPOSES),
  gst: gstHeaderSchema.optional(),
  lines: z.array(challanLineSchema),
});
export type DeliveryChallanDraft = z.output<typeof deliveryChallanDraftSchema>;

/** A line whose item is a service: a real item, but it holds no stock, so it is treated like a written line for stock purposes. */
const isServiceLine = (l: { itemId?: string | undefined }, masters: Masters): boolean =>
  l.itemId !== undefined && masters.stockItem(l.itemId as never)?.itemType === 'service';
/** The stock lines of a challan — a written line, or a service item, moves nothing, so it has no entry. */
const asEntries = (lines: DeliveryChallanDraft['lines'], masters: Masters) =>
  lines.flatMap((l) => (l.itemId !== undefined && !isServiceLine(l, masters) ? [{ itemId: l.itemId, warehouseId: l.warehouseId as WarehouseId, direction: 'out' as const, qty: l.qty }] : []));
/** Where each stock entry sits on the challan (a written or service line has none). */
const placesOf = (lines: DeliveryChallanDraft['lines'], masters: Masters) => lines.flatMap((l, at) => (l.itemId !== undefined && !isServiceLine(l, masters) ? [at] : []));

export const deliveryChallanKind = defineVoucherKind<DeliveryChallanDraft>({
  base: 'deliveryChallan',
  layout: 'item-invoice',
  schema: deliveryChallanDraftSchema,
  // it never posts a journal — so a challan of service or written lines alone (nothing of ours leaves) is not the "missing posting rule"
  // the engine otherwise guards against: a job-work closing challan can be all text, with no stock movement at all.
  noJournal: true,

  ledgerRefs: () => [],

  validate(draft, { masters, stock, orders }) {
    const problems: Issue[] = customerProblems(draft, masters);
    if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, 'A challan needs at least one line', 'lines'));
    problems.push(...invoiceGst(draft, masters, 'sales').problems);
    problems.push(...roundOffProblems(masters, grandTotalParts(draft.lines, draft.gst).roundOff));

    const ids = new Set<string>();
    const places = placesOf(draft.lines, masters);
    draft.lines.forEach((l, i) => {
      const path = `lines.${i}`;
      if (ids.has(l.id)) problems.push(issue(IssueCode.SalesDocInvalid, 'Two lines carry the same id', `${path}.id`));
      ids.add(l.id);
      if (l.itemId !== undefined && l.description !== undefined) {
        problems.push(issue(IssueCode.SalesDocInvalid, 'A line is either a stock item or written text, not both', `${path}.itemId`));
      } else if (l.itemId === undefined && l.description === undefined) {
        problems.push(issue(IssueCode.SalesDocInvalid, 'Choose a stock item — or write the line and press Alt+T', `${path}.itemId`));
      } else if (l.itemId === undefined) {
        if (l.warehouseId !== undefined) problems.push(issue(IssueCode.StockLineInvalid, 'A written line has no godown', `${path}.warehouseId`));
        if ((parseQty(l.qty) ?? 0n) <= 0n) problems.push(issue(IssueCode.StockLineInvalid, 'Enter a quantity above zero', `${path}.qty`));
      } else if (isServiceLine(l, masters)) {
        // job work on a part that was never our own stock: nothing of ours leaves, so it needs no godown either
        if (l.warehouseId !== undefined) problems.push(issue(IssueCode.StockLineInvalid, 'A service item has no godown', `${path}.warehouseId`));
        problems.push(...itemQtyProblems(l.itemId, l.qty, masters, path, { allowService: true }));
      } else if (l.warehouseId === undefined) {
        problems.push(issue(IssueCode.StockLineInvalid, 'Choose the godown', `${path}.warehouseId`));
      }
      problems.push(...lineValueProblems(l, path));
    });
    asEntries(draft.lines, masters).forEach((e, i) => problems.push(...onInvoiceLines(stockEntryProblems(e, masters, `lines.${i}`), places)));
    problems.push(...invoicedProblems(draft, orders.challans.linksTo(draft.id as VoucherId)));
    if (problems.length > 0) return problems;
    return onInvoiceLines(shortfallProblems(asEntries(draft.lines, masters), draft.id, draft.date, masters, stock, 'lines'), places);
  },

  post: () => [],
  postStock: (draft, { masters }) => plannedStockOf(asEntries(draft.lines, masters)),
  stockItems: (draft) => [...new Set(draft.lines.flatMap((l) => (l.itemId !== undefined ? [l.itemId] : [])))],
  // an alteration is checked against what is already invoiced on it
  orderIds: (draft) => [draft.id as VoucherId],
});

/**
 * An altered challan must still hold what has been invoiced against it: it stays for sale, and every invoiced line stays, for the same
 * item, with at least the quantity billed.
 */
function invoicedProblems(draft: DeliveryChallanDraft, billed: readonly { challanLineId: string; itemId: string; qty: bigint }[]): Issue[] {
  if (billed.length === 0) return [];
  if (draft.purpose !== 'sale') return [issue(IssueCode.SalesDocInvalid, 'This challan has been invoiced: it stays a sale', 'purpose')];
  const byLine = new Map<string, { itemId: string; qty: bigint }>();
  for (const b of billed) {
    const had = byLine.get(b.challanLineId);
    byLine.set(b.challanLineId, { itemId: b.itemId, qty: (had?.qty ?? 0n) + b.qty });
  }
  const problems: Issue[] = [];
  for (const [lineId, b] of byLine) {
    const i = draft.lines.findIndex((l) => l.id === lineId);
    const line = draft.lines[i];
    if (!line) problems.push(issue(IssueCode.OrderHasDeliveries, `A line that has been invoiced (${formatQty(b.qty as never)}) cannot be removed`, 'lines'));
    else if (line.itemId !== b.itemId) problems.push(issue(IssueCode.OrderHasDeliveries, 'This line has been invoiced: its item cannot change', `lines.${i}.itemId`));
    else if ((parseQty(line.qty) ?? 0n) < b.qty) problems.push(issue(IssueCode.OrderHasDeliveries, `${formatQty(b.qty as never)} of this line has been invoiced: it cannot be less`, `lines.${i}.qty`));
  }
  return problems;
}
