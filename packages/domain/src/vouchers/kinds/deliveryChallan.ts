import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { VoucherId, WarehouseId } from '../../ids';
import { formatQty, parseQty } from '../../stock/quantity';
import { draftBaseShape } from '../drafts';
import { defineVoucherKind } from '../kind';
import { customerProblems, documentShape, lineValueProblems } from './documents';
import { grandTotalParts, gstHeaderSchema, invoiceGst, roundOffProblems } from './gstDoc';
import { percentSchema } from '../../gst/tax';
import { itemIdSchema, plannedStockOf, qtySchema, rateSchema, shortfallProblems, stockEntryProblems, warehouseIdSchema } from './stockJournal';
import { CHALLAN_PURPOSES } from '../../orders/challanBook';

const lineIdSchema = z.string().trim().min(1).max(40);

/** A challan line: the item, the godown it leaves, quantity and rate (its value, which the challan must state), and the GST rate and HSN it prints. */
const challanLineSchema = z.object({
  /** Chosen once and kept across alterations, so what is invoiced against this line keeps pointing at it. */
  id: lineIdSchema,
  itemId: itemIdSchema,
  warehouseId: warehouseIdSchema,
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

const asEntries = (lines: DeliveryChallanDraft['lines']) =>
  lines.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId as WarehouseId, direction: 'out' as const, qty: l.qty }));

export const deliveryChallanKind = defineVoucherKind<DeliveryChallanDraft>({
  base: 'deliveryChallan',
  layout: 'item-invoice',
  schema: deliveryChallanDraftSchema,

  ledgerRefs: () => [],

  validate(draft, { masters, stock, orders }) {
    const problems: Issue[] = customerProblems(draft, masters);
    if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, 'A challan needs at least one line', 'lines'));
    problems.push(...invoiceGst(draft, masters, 'sales').problems);
    problems.push(...roundOffProblems(masters, grandTotalParts(draft.lines, draft.gst).roundOff));

    const ids = new Set<string>();
    draft.lines.forEach((l, i) => {
      const path = `lines.${i}`;
      if (ids.has(l.id)) problems.push(issue(IssueCode.SalesDocInvalid, 'Two lines carry the same id', `${path}.id`));
      ids.add(l.id);
      problems.push(...lineValueProblems(l, path));
    });
    asEntries(draft.lines).forEach((e, i) => problems.push(...stockEntryProblems(e, masters, `lines.${i}`)));
    problems.push(...invoicedProblems(draft, orders.challans.linksTo(draft.id as VoucherId)));
    if (problems.length > 0) return problems;
    return shortfallProblems(asEntries(draft.lines), draft.id, draft.date, masters, stock, 'lines');
  },

  post: () => [],
  postStock: (draft) => plannedStockOf(asEntries(draft.lines)),
  stockItems: (draft) => [...new Set(draft.lines.map((l) => l.itemId))],
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
