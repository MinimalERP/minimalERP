import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import { draftBaseShape } from '../drafts';
import { defineVoucherKind } from '../kind';
import { customerProblems, documentShape, lineValueProblems } from './documents';
import { grandTotalParts, gstHeaderSchema, invoiceGst, roundOffProblems } from './gstDoc';
import { itemQtyProblems } from './stockJournal';
import { percentSchema } from '../../gst/tax';
import { parseQty } from '../../stock/quantity';
import { itemIdSchema, qtySchema, rateSchema } from './stockJournal';

const lineIdSchema = z.string().trim().min(1).max(40);

/**
 * A line on a quotation: a stock item — or, written (Alt+T), free text with no stock item, for what is offered once and is not worth an
 * item master — a quantity and a rate (and optional GST for what the customer reads).
 */
const quoteLineSchema = z.object({
  id: lineIdSchema,
  itemId: itemIdSchema.optional(),
  /** A ONE-TIME line: written text instead of a stock item. */
  description: z.string().trim().min(1).max(200).optional(),
  /** A one-time line's unit (a unit master's symbol: "Nos", "Kg"…), for the printed quote and GST's unit code. */
  unit: z.string().trim().min(1).max(20).optional(),
  qty: qtySchema,
  rate: rateSchema,
  gstRate: percentSchema.optional(),
  hsn: z.string().trim().max(10).optional(),
});

/**
 * Quotation: what you offered a customer — items, quantities and rates, no dates — before they order. It is a document: it posts
 * nothing to the accounts and nothing to the stock. Once a sales order is made from it, the quote is kept as it was (see salesOrder.quotationId). GST may be stated on it when the company charges GST, for the printed quote only.
 */
export const quotationDraftSchema = z.object({
  ...draftBaseShape,
  ...documentShape,
  gst: gstHeaderSchema.optional(),
  lines: z.array(quoteLineSchema),
});
export type QuotationDraft = z.output<typeof quotationDraftSchema>;

export const quotationKind = defineVoucherKind<QuotationDraft>({
  base: 'quotation',
  layout: 'item-invoice',
  schema: quotationDraftSchema,
  document: true,

  ledgerRefs: () => [],

  validate(draft, { masters }) {
    const problems: Issue[] = customerProblems(draft, masters);
    if (draft.lines.length === 0) problems.push(issue(IssueCode.TooFewLines, 'A quotation needs at least one line', 'lines'));
    problems.push(...invoiceGst(draft, masters, 'sales').problems);
    problems.push(...roundOffProblems(masters, grandTotalParts(draft.lines, draft.gst).roundOff));

    const ids = new Set<string>();
    draft.lines.forEach((l, i) => {
      const path = `lines.${i}`;
      if (ids.has(l.id)) problems.push(issue(IssueCode.SalesDocInvalid, 'Two lines carry the same id', `${path}.id`));
      ids.add(l.id);
      if (l.itemId !== undefined && l.description !== undefined) {
        problems.push(issue(IssueCode.SalesDocInvalid, 'A line is either a stock item or written text, not both', `${path}.itemId`));
      } else if (l.itemId === undefined && l.description === undefined) {
        problems.push(issue(IssueCode.SalesDocInvalid, 'Choose a stock item — or write the line and press Alt+T', `${path}.itemId`));
      } else if (l.itemId !== undefined) {
        problems.push(...itemQtyProblems(l.itemId, l.qty, masters, path));
        if (l.unit !== undefined) problems.push(issue(IssueCode.SalesDocInvalid, 'A stock item line takes the unit of its item', `${path}.unit`));
      } else if ((parseQty(l.qty) ?? 0n) <= 0n) {
        problems.push(issue(IssueCode.StockLineInvalid, 'Enter a quantity above zero', `${path}.qty`));
      }
      problems.push(...lineValueProblems(l, path));
    });
    return problems;
  },

  post: () => [],
});
