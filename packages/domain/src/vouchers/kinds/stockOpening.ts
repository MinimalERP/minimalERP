import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import { draftBaseShape } from '../drafts';
import { defineVoucherKind } from '../kind';
import { plannedStockOf, shortfallProblems, stockEntryProblems, stockEntrySchema } from './stockJournal';

/**
 * Opening stock: one item's stock brought forward into one godown at the start of the financial year, at a rate. A system kind, like the
 * accounting Opening Balance — the item form posts it — but with no accounting effect (under the periodic method the stock value reaches
 * the books through the closing-stock figure, not a ledger).
 */
export const stockOpeningDraftSchema = z.object({
  ...draftBaseShape,
  itemId: stockEntrySchema.shape.itemId,
  warehouseId: stockEntrySchema.shape.warehouseId,
  qty: stockEntrySchema.shape.qty,
  rate: stockEntrySchema.shape.rate.unwrap(),
});
export type StockOpeningDraft = z.output<typeof stockOpeningDraftSchema>;

const asEntry = (d: StockOpeningDraft) => ({ itemId: d.itemId, warehouseId: d.warehouseId, direction: 'in' as const, qty: d.qty, rate: d.rate });

export const stockOpeningKind = defineVoucherKind<StockOpeningDraft>({
  base: 'stockOpening',
  layout: 'stock',
  schema: stockOpeningDraftSchema,

  ledgerRefs: () => [],

  validate(draft, { masters, financialYear, stock }) {
    const problems: Issue[] = [];
    if (draft.date !== financialYear.start) {
      problems.push(
        issue(IssueCode.OpeningInvalid, `Opening stock is dated the first day of the financial year (${financialYear.start})`, 'date'),
      );
    }
    problems.push(...stockEntryProblems(asEntry(draft), masters, ''));
    if (problems.length > 0) return problems;
    // Altering opening stock downward can starve later issues: the whole timeline is checked, as for any stock voucher.
    return shortfallProblems([asEntry(draft)], draft.id, draft.date, masters, stock, '');
  },

  post: () => [],
  postStock: (draft) => plannedStockOf([asEntry(draft)]),
  stockItems: (draft) => [draft.itemId],
});
