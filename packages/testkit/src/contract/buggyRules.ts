/**
 * A wrong posting rule must be REFUSED by the engine — the books never absorb it. Runs against
 * any backend, because the refusal happens before anything is written.
 */
import {
  type JournalDraft,
  type VoucherKindSpec,
  IssueCode,
  VoucherKindRegistry,
  contraKind,
  defineVoucherKind,
  journalDraftSchema,
  money,
  paymentKind,
  receiptKind,
} from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { codesOf, mustOk } from '../helpers';
import { journal } from '../scenarios';
import type { MakeWorld } from '../world';

export function buggyRulesContract(label: string, makeWorld: MakeWorld): void {
  describe(`${label}: a buggy posting rule cannot corrupt the books`, () => {
    const registryWith = (post: VoucherKindSpec<JournalDraft>['post']) => {
      const buggy = defineVoucherKind<JournalDraft>({
        base: 'journal',
        layout: 'double-entry',
        schema: journalDraftSchema,
        ledgerRefs: (d) => d.entries.map((e, i) => ({ ledgerId: e.ledgerId, path: `entries.${i}.ledgerId` })),
        validate: () => [],
        post,
      });
      return new VoucherKindRegistry().register(paymentKind).register(receiptKind).register(contraKind).register(buggy);
    };

    const attempt = async (post: VoucherKindSpec<JournalDraft>['post']) => {
      const w = await makeWorld({ registry: registryWith(post) });
      const draft = journal(w, {
        id: 'j1',
        date: '2024-05-10',
        entries: [[w.ledgers.rent, 'debit', '100'], [w.ledgers.creditor, 'credit', '100']],
      }).voucher;
      const r = await w.backend.post({ companyId: w.companyId, draft });
      return { w, r };
    };

    it('a rule that drops a paisa is refused as PLAN_UNBALANCED', async () => {
      const { w, r } = await attempt((d) =>
        d.entries.map((e, i) => ({ ledgerId: e.ledgerId, side: e.side, amount: i === 0 ? money(e.amount - 1n) : e.amount })),
      );
      expect(codesOf(r)).toEqual([IssueCode.PlanUnbalanced]);
      expect(await w.backend.list(w.companyId)).toEqual([]);
      expect(await w.backend.lines({ companyId: w.companyId })).toEqual([]);
    });

    it('a rule that emits a zero-amount line is refused', async () => {
      const { w, r } = await attempt((d) => [
        ...d.entries.map((e) => ({ ledgerId: e.ledgerId, side: e.side, amount: e.amount })),
        { ledgerId: d.entries[0]!.ledgerId, side: 'debit' as const, amount: money(0n) },
      ]);
      expect(codesOf(r)).toContain(IssueCode.PlanNonPositiveAmount);
      expect(await w.backend.list(w.companyId)).toEqual([]);
    });

    it('a rule that emits a single line is refused', async () => {
      const { r } = await attempt((d) => [{ ledgerId: d.entries[0]!.ledgerId, side: 'debit' as const, amount: money(100n) }]);
      expect(codesOf(r)).toContain(IssueCode.PlanTooFewLines);
    });

    it('a correct rule through the same registry still posts (the harness itself works)', async () => {
      const { w, r } = await attempt((d) => d.entries.map((e) => ({ ledgerId: e.ledgerId, side: e.side, amount: e.amount })));
      mustOk(r);
      expect(await w.backend.list(w.companyId)).toHaveLength(1);
    });
  });
}
