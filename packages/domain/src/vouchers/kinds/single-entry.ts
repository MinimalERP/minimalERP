import { type Issue, IssueCode, issue } from '../../errors';
import { type Money, money, sumMoney } from '../../money';
import type { BaseKind } from '../../masters/masters';
import type { PlannedLine, Side } from '../../posting/plan';
import { allocationProblems, tdsOfLines } from '../allocations';
import { type SingleEntryDraft, singleEntryDraftSchema } from '../drafts';
import { defineVoucherKind } from '../kind';

interface SingleEntryConfig {
  readonly base: BaseKind;
  /** Which side the account ledger (cash/bank) takes; the particulars take the opposite side. */
  readonly accountSide: Side;
  /** Contra moves money between cash/bank ledgers, so its particulars must be cash/bank too. */
  readonly particularsMustBeCashOrBank: boolean;
}

/**
 * Factory for the three "single-entry mode" kinds. They differ only in configuration, which is
 * exactly why voucher types are data-driven rather than one screen and service per voucher.
 */
function singleEntryKind(cfg: SingleEntryConfig) {
  const particularSide: Side = cfg.accountSide === 'debit' ? 'credit' : 'debit';

  return defineVoucherKind<SingleEntryDraft>({
    base: cfg.base,
    layout: 'single-entry',
    schema: singleEntryDraftSchema,

    ledgerRefs: (draft) => [
      { ledgerId: draft.accountLedgerId, path: 'accountLedgerId' },
      ...draft.lines.map((l, i) => ({ ledgerId: l.ledgerId, path: `lines.${i}.ledgerId` })),
    ],

    validate(draft, { masters }) {
      const tds = tdsOfLines(draft.lines);
      const problems: Issue[] = [];

      if (draft.lines.length < 1) {
        problems.push(issue(IssueCode.TooFewLines, 'Add at least one particular', 'lines'));
      }
      if (!masters.isCashOrBank(draft.accountLedgerId)) {
        problems.push(
          issue(
            IssueCode.AccountNotCashOrBank,
            'The account must be a cash, bank or bank-OD ledger',
            'accountLedgerId',
          ),
        );
      }
      draft.lines.forEach((line, i) => {
        if (line.amount <= 0n) {
          problems.push(issue(IssueCode.AmountNotPositive, 'Amount must be greater than zero', `lines.${i}.amount`));
        }
        if (line.ledgerId === draft.accountLedgerId) {
          problems.push(
            issue(IssueCode.SameLedgerBothSides, 'A particular cannot be the same ledger as the account', `lines.${i}.ledgerId`),
          );
        }
        if (cfg.particularsMustBeCashOrBank && !masters.isCashOrBank(line.ledgerId)) {
          problems.push(
            issue(
              IssueCode.ParticularNotCashOrBank,
              'Contra particulars must be cash, bank or bank-OD ledgers',
              `lines.${i}.ledgerId`,
            ),
          );
        }
      });
      problems.push(...allocationProblems(draft.lines, 'lines', masters, { allowTds: cfg.base === 'receipt' }));
      if (tds > 0n && cfg.base === 'receipt') {
        if (!masters.systemLedger('tds-receivable')) {
          problems.push(issue(IssueCode.TdsInvalid, 'The TDS Receivable ledger is missing from this company: reopen the company to add it', 'lines'));
        } else if (sumMoney(draft.lines.map((l) => l.amount)) <= tds) {
          problems.push(issue(IssueCode.TdsInvalid, 'The TDS is the whole receipt: something must reach the bank', 'lines'));
        }
      }
      return problems;
    },

    post(draft, { masters }) {
      const settled: Money = sumMoney(draft.lines.map((l) => l.amount));
      // TDS the customer deducted: the bill is settled in full, but that much never reaches the bank — it is a receivable from the tax department
      const tds = money(cfg.base === 'receipt' ? tdsOfLines(draft.lines) : 0n);
      const total: Money = money(settled - tds);
      const particulars: PlannedLine[] = draft.lines.map((l) => ({
        ledgerId: l.ledgerId,
        side: particularSide,
        amount: l.amount,
        narration: l.narration,
      }));
      const account: PlannedLine = {
        ledgerId: draft.accountLedgerId,
        side: cfg.accountSide,
        amount: total,
        narration: undefined,
      };
      const tdsLedger = tds > 0n ? masters.systemLedger('tds-receivable') : undefined;
      const tdsLine: PlannedLine[] = tdsLedger ? [{ ledgerId: tdsLedger.id, side: 'debit', amount: tds, narration: 'TDS deducted' }] : [];
      // Debit lines first, by convention.
      return cfg.accountSide === 'debit' ? [account, ...tdsLine, ...particulars] : [...particulars, account];
    },
  });
}

/** Payment: cash/bank is credited (money out); particulars are debited. */
export const paymentKind = singleEntryKind({ base: 'payment', accountSide: 'credit', particularsMustBeCashOrBank: false });

/** Receipt: cash/bank is debited (money in); particulars are credited. */
export const receiptKind = singleEntryKind({ base: 'receipt', accountSide: 'debit', particularsMustBeCashOrBank: false });

/** Contra: cash/bank → cash/bank transfer. The account is the source (credited); particulars are destinations (debited). */
export const contraKind = singleEntryKind({ base: 'contra', accountSide: 'credit', particularsMustBeCashOrBank: true });
