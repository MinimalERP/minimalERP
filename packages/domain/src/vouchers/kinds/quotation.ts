import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import { draftBaseShape, localDateSchema } from '../drafts';
import { defineVoucherKind } from '../kind';
import { customerProblems, documentShape, lineValueProblems } from './documents';
import { grandTotalParts, gstHeaderSchema, invoiceGst, roundOffProblems } from './gstDoc';
import { itemQtyProblems } from './stockJournal';
import { percentSchema } from '../../gst/tax';
import { itemIdSchema, qtySchema, rateSchema } from './stockJournal';

const lineIdSchema = z.string().trim().min(1).max(40);

/** A line on a quotation: item, quantity and rate (and optional GST for what the customer reads). */
const quoteLineSchema = z.object({
  id: lineIdSchema,
  itemId: itemIdSchema,
  qty: qtySchema,
  rate: rateSchema,
  gstRate: percentSchema.optional(),
  hsn: z.string().trim().max(10).optional(),
});

/**
 * Quotation: what you offered a customer — items, quantities and rates — before they order or you invoice. It is a document: it posts
 * nothing to the accounts and nothing to the stock. GST may be stated on it when the company charges GST, for the printed quote only.
 */
export const quotationDraftSchema = z.object({
  ...draftBaseShape,
  ...documentShape,
  /** Until when the quote is meant to hold (optional). */
  validUntil: localDateSchema.optional(),
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
    if (draft.validUntil !== undefined && draft.validUntil < draft.date) {
      problems.push(issue(IssueCode.SalesDocInvalid, `Valid until is before the quotation date (${draft.date})`, 'validUntil'));
    }

    const ids = new Set<string>();
    draft.lines.forEach((l, i) => {
      const path = `lines.${i}`;
      if (ids.has(l.id)) problems.push(issue(IssueCode.SalesDocInvalid, 'Two lines carry the same id', `${path}.id`));
      ids.add(l.id);
      problems.push(...itemQtyProblems(l.itemId, l.qty, masters, path));
      problems.push(...lineValueProblems(l, path));
    });
    return problems;
  },

  post: () => [],
});
