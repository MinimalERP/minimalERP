import { type Issue, IssueCode, issue } from '../../errors';
import { formatMoney } from '../../money';
import { totalsOf } from '../../posting/plan';
import { allocationProblems } from '../allocations';
import { type JournalDraft, journalDraftSchema } from '../drafts';
import { defineVoucherKind } from '../kind';

/**
 * Journal: adjustments between non-cash/bank ledgers. Debits and credits are entered explicitly
 * and must balance. Cash and bank ledgers are refused (the classic convention: money moving in
 * or out of cash/bank is a Payment, Receipt or Contra, so cash/bank books stay complete).
 */
export const journalKind = defineVoucherKind<JournalDraft>({
  base: 'journal',
  layout: 'double-entry',
  schema: journalDraftSchema,

  ledgerRefs: (draft) => draft.entries.map((e, i) => ({ ledgerId: e.ledgerId, path: `entries.${i}.ledgerId` })),

  validate(draft, { masters }) {
    const problems: Issue[] = [];

    if (draft.entries.length < 2) {
      problems.push(issue(IssueCode.TooFewLines, 'A journal needs at least two entries', 'entries'));
    }
    draft.entries.forEach((e, i) => {
      if (e.amount <= 0n) {
        problems.push(issue(IssueCode.AmountNotPositive, 'Amount must be greater than zero', `entries.${i}.amount`));
      }
      if (masters.isCashOrBank(e.ledgerId)) {
        problems.push(
          issue(
            IssueCode.CashBankInJournal,
            'Cash and bank ledgers cannot be used in a Journal — use Payment, Receipt or Contra',
            `entries.${i}.ledgerId`,
          ),
        );
      }
    });

    problems.push(...allocationProblems(draft.entries, 'entries', masters));

    const { debit, credit } = totalsOf(draft.entries);
    if (debit !== credit) {
      problems.push(
        issue(
          IssueCode.Unbalanced,
          `Debit total ${formatMoney(debit)} does not equal credit total ${formatMoney(credit)}`,
          'entries',
        ),
      );
    }
    return problems;
  },

  post: (draft) =>
    draft.entries.map((e) => ({
      ledgerId: e.ledgerId,
      side: e.side,
      amount: e.amount,
      narration: e.narration,
    })),
});
