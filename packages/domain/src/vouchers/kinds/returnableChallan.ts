import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { VoucherId, WarehouseId } from '../../ids';
import type { ChallanBook } from '../../orders/challanBook';
import { parseQty } from '../../stock/quantity';
import { draftBaseShape, voucherIdSchema } from '../drafts';
import { defineVoucherKind } from '../kind';
import { documentShape, lineValueProblems, onInvoiceLines, partyProblems } from './documents';
import { grandTotalParts, gstHeaderSchema, invoiceGst, roundOffProblems } from './gstDoc';
import { percentSchema } from '../../gst/tax';
import { itemIdSchema, plannedStockOf, qtySchema, rateSchema, shortfallProblems, stockEntryProblems, warehouseIdSchema } from './stockJournal';

/**
 * A returnable challan line: a stock item and the godown it leaves — or, written (Alt+T), something that is not our stock (a customer's
 * part sent on for repair, a one-off tool): no godown, no stock moved, on the challan to be sent and to come back with the rest.
 */
const returnableLineSchema = z.object({
  id: z.string().trim().min(1).max(40),
  itemId: itemIdSchema.optional(),
  /** A written line: text instead of a stock item. */
  description: z.string().trim().min(1).max(1000).optional(),
  /** A written line's unit (a unit master's symbol), for the printed challan. */
  unit: z.string().trim().min(1).max(20).optional(),
  warehouseId: warehouseIdSchema.optional(),
  qty: qtySchema,
  rate: rateSchema,
  gstRate: percentSchema.optional(),
  hsn: z.string().trim().max(10).optional(),
});

/**
 * Returnable Challan: goods sent to a supplier that come back as they went (for repair, testing, a sample on approval). It takes each stock line
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

/** The stock lines of a challan — a written line moves nothing, so it has no entry. */
const asEntries = (draft: ReturnableChallanDraft) =>
  draft.lines.flatMap((l) =>
    l.itemId !== undefined ? [{ itemId: l.itemId, warehouseId: l.warehouseId as WarehouseId, direction: draft.returnOf ? ('in' as const) : ('out' as const), qty: l.qty, ...(draft.returnOf ? { rate: l.rate } : {}) }] : [],
  );
/** Where each stock entry sits on the challan (a written line has none). */
const placesOf = (draft: ReturnableChallanDraft) => draft.lines.flatMap((l, at) => (l.itemId !== undefined ? [at] : []));

export const returnableChallanKind = defineVoucherKind<ReturnableChallanDraft>({
  base: 'returnableChallan',
  layout: 'item-invoice',
  schema: returnableChallanDraftSchema,
  // it never posts a journal — so a challan of written lines alone (nothing of ours leaves) is not a missing posting rule
  noJournal: true,

  ledgerRefs: () => [],

  validate(draft, { masters, stock, orders }) {
    const problems: Issue[] = partyProblems(draft, masters, 'vendor');
    if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, 'A challan needs at least one line', 'lines'));
    problems.push(...invoiceGst(draft, masters, 'sales').problems);
    problems.push(...roundOffProblems(masters, grandTotalParts(draft.lines, draft.gst).roundOff));
    const places = placesOf(draft);
    draft.lines.forEach((l, i) => {
      const path = `lines.${i}`;
      if (l.itemId !== undefined && l.description !== undefined) {
        problems.push(issue(IssueCode.SalesDocInvalid, 'A line is either a stock item or written text, not both', `${path}.itemId`));
      } else if (l.itemId === undefined && l.description === undefined) {
        problems.push(issue(IssueCode.SalesDocInvalid, 'Choose a stock item — or write the line and press Alt+T', `${path}.itemId`));
      } else if (l.itemId === undefined) {
        if (l.warehouseId !== undefined) problems.push(issue(IssueCode.StockLineInvalid, 'A written line has no godown', `${path}.warehouseId`));
        if ((parseQty(l.qty) ?? 0n) <= 0n) problems.push(issue(IssueCode.StockLineInvalid, 'Enter a quantity above zero', `${path}.qty`));
      } else if (l.warehouseId === undefined) {
        problems.push(issue(IssueCode.StockLineInvalid, 'Choose the godown', `${path}.warehouseId`));
      }
      problems.push(...lineValueProblems(l, path));
    });
    asEntries(draft).forEach((e, i) => problems.push(...onInvoiceLines(stockEntryProblems(e, masters, `lines.${i}`), places)));
    problems.push(...(draft.returnOf ? returnProblems(draft, orders.challans) : returnedProblems(draft, orders.challans)));
    if (problems.length > 0) return problems;
    return onInvoiceLines(shortfallProblems(asEntries(draft), draft.id, draft.date, masters, stock, 'lines'), places);
  },

  post: () => [],
  postStock: (draft) => plannedStockOf(asEntries(draft)),
  stockItems: (draft) => [...new Set(draft.lines.flatMap((l) => (l.itemId !== undefined ? [l.itemId] : [])))],
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
      return d !== undefined && d.itemId === l.itemId && d.description === l.description && d.warehouseId === l.warehouseId && parseQty(d.qty) === l.qty;
    });
  return same ? [] : [issue(IssueCode.OrderRefInvalid, `A return brings back what went out on ${c.number}: the same lines, godowns and quantities`, 'lines')];
}

/** A challan that has come back stays as it went out (its return copies it). */
function returnedProblems(draft: ReturnableChallanDraft, book: ChallanBook): Issue[] {
  const back = book.returnOf(draft.id as VoucherId);
  return back ? [issue(IssueCode.OrderHasDeliveries, `This challan has come back (${back.number}): cancel the return first to change it`, 'lines')] : [];
}
