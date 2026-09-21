import { z } from 'zod';
import { type Issue, IssueCode, issue } from '../../errors';
import type { PlannedLine } from '../../posting/plan';
import { allocationsSchema, draftBaseShape, ledgerIdSchema, moneySchema, sideSchema } from '../drafts';
import { allocationProblems } from '../allocations';
import { defineVoucherKind } from '../kind';

/**
 * Opening balance: one ledger's balance brought forward at the start of the financial year.
 *
 * A single ledger's opening balance is one-sided, but every voucher must balance. So the other side goes to
 * the built-in "Opening Balance Difference" ledger — the classic "difference in opening balances" suspense
 * account. Once every ledger's opening is entered, that ledger nets to zero if the opening balances agree
 * (assets = liabilities), and shows the gap if they do not.
 *
 * The draft carries the difference ledger explicitly (`offsetLedgerId`), so the posting service can load
 * exactly the two ledgers it references.
 */
export const openingDraftSchema = z.object({
  ...draftBaseShape,
  ledgerId: ledgerIdSchema,
  side: sideSchema,
  amount: moneySchema,
  offsetLedgerId: ledgerIdSchema,
  /** Bill-by-bill breakdown of a party ledger's opening balance. */
  allocations: allocationsSchema,
});
export type OpeningDraft = z.output<typeof openingDraftSchema>;

export const openingKind = defineVoucherKind<OpeningDraft>({
  base: 'opening',
  layout: 'opening',
  schema: openingDraftSchema,

  ledgerRefs: (draft) => [
    { ledgerId: draft.ledgerId, path: 'ledgerId' },
    { ledgerId: draft.offsetLedgerId, path: 'offsetLedgerId' },
  ],

  validate(draft, { masters, financialYear }) {
    const problems: Issue[] = [];
    if (draft.amount <= 0n) {
      problems.push(issue(IssueCode.AmountNotPositive, 'Enter an opening balance above zero', 'amount'));
    }
    if (draft.date !== financialYear.start) {
      problems.push(
        issue(IssueCode.OpeningInvalid, `Opening balances are dated the first day of the financial year (${financialYear.start})`, 'date'),
      );
    }
    if (masters.ledger(draft.offsetLedgerId)?.reservedKey !== 'opening-difference') {
      problems.push(issue(IssueCode.OpeningInvalid, 'The balancing ledger must be "Opening Balance Difference"', 'offsetLedgerId'));
    }
    if (masters.ledger(draft.ledgerId)?.reservedKey !== undefined) {
      problems.push(issue(IssueCode.OpeningInvalid, 'A built-in ledger has no opening balance of its own', 'ledgerId'));
    }
    problems.push(...allocationProblems([{ ledgerId: draft.ledgerId, amount: draft.amount, allocations: draft.allocations }], 'allocations', masters));
    return problems;
  },

  post(draft): readonly PlannedLine[] {
    const opposite = draft.side === 'debit' ? 'credit' : 'debit';
    const own: PlannedLine = { ledgerId: draft.ledgerId, side: draft.side, amount: draft.amount, narration: 'Opening balance' };
    const balancing: PlannedLine = { ledgerId: draft.offsetLedgerId, side: opposite, amount: draft.amount, narration: 'Opening balance' };
    // Debit first, by convention.
    return draft.side === 'debit' ? [own, balancing] : [balancing, own];
  },
});
