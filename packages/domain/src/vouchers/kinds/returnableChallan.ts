import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { VoucherId, WarehouseId } from '../../ids';
import type { ChallanBook } from '../../orders/challanBook';
import { parseQty } from '../../stock/quantity';
import { draftBaseShape, voucherIdSchema } from '../drafts';
import { defineVoucherKind } from '../kind';
import { documentShape, lineValueProblems, partyProblems } from './documents';
import { grandTotalParts, gstHeaderSchema, invoiceGst, roundOffProblems } from './gstDoc';
import { percentSchema } from '../../gst/tax';
import { itemIdSchema, plannedStockOf, qtySchema, rateSchema, shortfallProblems, stockEntryProblems, warehouseIdSchema } from './stockJournal';

const returnableLineSchema = z.object({
  id: z.string().trim().min(1).max(40),
  itemId: itemIdSchema,
  warehouseId: warehouseIdSchema,
  qty: qtySchema,
  rate: rateSchema,
  gstRate: percentSchema.optional(),
  hsn: z.string().trim().max(10).optional(),
});

/**
 * Returnable Challan: goods sent to a supplier that come back as they went (for repair, testing, a sample on approval). It takes each line
 * OUT of its godown and posts nothing to the accounts. "Mark returned" posts its RETURN — a returnable challan of the same type that names it
 * (`returnOf`) and brings the same lines back IN to the same godowns, at their stated value. A challan comes back once.
 */
export const returnableChallanDraftSchema = z.object({
  ...draftBaseShape,
  ...documentShape,
  /** A return: the returnable challan whose goods came back. */
  returnOf: voucherIdSchema.optional(),
  gst: gstHeaderSchema.optional(),
  lines: z.array(returnableLineSchema),
});
export type ReturnableChallanDraft = z.output<typeof returnableChallanDraftSchema>;

const asEntries = (draft: ReturnableChallanDraft) =>
  draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId as WarehouseId, direction: draft.returnOf ? ('in' as const) : ('out' as const), qty: l.qty, ...(draft.returnOf ? { rate: l.rate } : {}) }));

export const returnableChallanKind = defineVoucherKind<ReturnableChallanDraft>({
  base: 'returnableChallan',
  layout: 'item-invoice',
  schema: returnableChallanDraftSchema,

  ledgerRefs: () => [],

  validate(draft, { masters, stock, orders }) {
    const problems: Issue[] = partyProblems(draft, masters, 'vendor');
    if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, 'A challan needs at least one line', 'lines'));
    problems.push(...invoiceGst(draft, masters, 'sales').problems);
    problems.push(...roundOffProblems(masters, grandTotalParts(draft.lines, draft.gst).roundOff));
    draft.lines.forEach((l, i) => problems.push(...lineValueProblems(l, `lines.${i}`)));
    asEntries(draft).forEach((e, i) => problems.push(...stockEntryProblems(e, masters, `lines.${i}`)));
    problems.push(...(draft.returnOf ? returnProblems(draft, orders.challans) : returnedProblems(draft, orders.challans)));
    if (problems.length > 0) return problems;
    return shortfallProblems(asEntries(draft), draft.id, draft.date, masters, stock, 'lines');
  },

  post: () => [],
  postStock: (draft) => plannedStockOf(asEntries(draft)),
  stockItems: (draft) => [...new Set(draft.lines.map((l) => l.itemId))],
  // a return is checked against its challan; a challan against its return
  orderIds: (draft) => [draft.returnOf ?? draft.id] as VoucherId[],
});

/** A return names a returnable challan of the same supplier, not dated after it, not already returned — and brings back exactly its lines. */
function returnProblems(draft: ReturnableChallanDraft, book: ChallanBook): Issue[] {
  const c = book.returnable(draft.returnOf as VoucherId);
  if (!c) return [issue(IssueCode.OrderRefInvalid, 'That returnable challan does not exist (or was cancelled)', 'returnOf')];
  if (c.partyId !== draft.partyId) return [issue(IssueCode.OrderRefInvalid, `${c.number} went to another supplier`, 'returnOf')];
  if (draft.date < c.date) return [issue(IssueCode.OrderRefInvalid, `The return is dated before ${c.number} (${c.date})`, 'date')];
  const other = book.returnOf(c.voucherId);
  if (other && other.voucherId !== draft.id) return [issue(IssueCode.OverDelivery, `${c.number} has already come back (${other.number})`, 'returnOf')];
  const same =
    c.lines.length === draft.lines.length &&
    c.lines.every((l, i) => {
      const d = draft.lines[i];
      return d !== undefined && d.itemId === l.itemId && d.warehouseId === l.warehouseId && parseQty(d.qty) === l.qty;
    });
  return same ? [] : [issue(IssueCode.OrderRefInvalid, `A return brings back what went out on ${c.number}: the same items, godowns and quantities`, 'lines')];
}

/** A challan that has come back stays as it went out (its return copies it). */
function returnedProblems(draft: ReturnableChallanDraft, book: ChallanBook): Issue[] {
  const back = book.returnOf(draft.id as VoucherId);
  return back ? [issue(IssueCode.OrderHasDeliveries, `This challan has come back (${back.number}): cancel the return first to change it`, 'lines')] : [];
}
