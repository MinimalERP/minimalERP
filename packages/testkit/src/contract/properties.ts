/**
 * The accounting invariants as properties, run against whichever backend `makeWorld` builds.
 * Every property is checked against `expectedBalances` — plain arithmetic on the submitted vouchers —
 * so it verifies the posting rules and journal against an independent model, not against themselves.
 */
import {
  type LedgerId,
  IssueCode,
  ledgerMovements,
  localDate,
  trialBalance,
} from '@minimalerp/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KINDS, type Spec, arbSpec, arbSpecOfKind, scenarioFrom } from '../arbitraries';
import { allLines, codesOf, mustOk, post, postOk } from '../helpers';
import { type Scenario, expectedBalances, journal } from '../scenarios';
import type { MakeWorld } from '../world';
import type { AccountingKind } from '../kinds';

export interface PropertyRuns {
  /** Runs for the cheap properties. */
  readonly runs: number;
  /** Runs for the long-sequence (state machine) property. */
  readonly sequenceRuns: number;
}

const closings = (lines: Parameters<typeof ledgerMovements>[0]): Map<LedgerId, bigint> => {
  const m = new Map<LedgerId, bigint>();
  for (const [id, mv] of ledgerMovements(lines)) if (mv.closing !== 0n) m.set(id, mv.closing);
  return m;
};

export function propertiesContract(label: string, makeWorld: MakeWorld, { runs, sequenceRuns }: PropertyRuns): void {
  const RUNS = { numRuns: runs };

  describe(`${label}: properties`, () => {
    describe('the books built from any sequence of postings', () => {
      it('always balance, and every ledger equals the independent model', async () => {
        await fc.assert(
          fc.asyncProperty(fc.array(arbSpec(), { minLength: 1, maxLength: 25 }), async (specs) => {
            const w = await makeWorld();
            const scenarios = specs.map((s, i) => scenarioFrom(w, s, `v${i}`));
            for (const sc of scenarios) await postOk(w, sc);

            const lines = await allLines(w);
            const tb = trialBalance(lines);
            expect(tb.isBalanced).toBe(true);
            expect(tb.totalClosingDebit).toBe(tb.totalClosingCredit);
            expect(closings(lines)).toEqual(expectedBalances(scenarios));
          }),
          RUNS,
        );
      });

      it('stay balanced when cut off at any date (a voucher never straddles two dates)', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(arbSpec(), { minLength: 1, maxLength: 15 }),
            fc.integer({ min: 0, max: 364 }),
            async (specs, cutoff) => {
              const w = await makeWorld();
              for (const [i, s] of specs.entries()) await postOk(w, scenarioFrom(w, s, `v${i}`));
              const to = localDate(new Date(Date.UTC(2024, 3, 1 + cutoff)).toISOString().slice(0, 10));
              expect(trialBalance(await allLines(w), { to }).isBalanced).toBe(true);
            },
          ),
          RUNS,
        );
      });

      it('number every voucher gaplessly per voucher type, with no duplicates', async () => {
        await fc.assert(
          fc.asyncProperty(fc.array(arbSpec(), { minLength: 1, maxLength: 25 }), async (specs) => {
            const w = await makeWorld();
            const perKind = new Map<AccountingKind, string[]>();
            for (const [i, s] of specs.entries()) {
              const sc = scenarioFrom(w, s, `v${i}`);
              const out = await postOk(w, sc);
              perKind.set(sc.kind, [...(perKind.get(sc.kind) ?? []), out.voucher.number]);
            }
            for (const numbers of perKind.values()) {
              const seq = numbers.map((n) => Number(n.slice(-4)));
              expect(seq).toEqual(seq.map((_, i) => i + 1));
            }
          }),
          RUNS,
        );
      });
    });

    describe('post then cancel nets to zero', () => {
      it('leaves empty books, keeps every voucher on record, and never reuses a number', async () => {
        await fc.assert(
          fc.asyncProperty(fc.array(arbSpec(), { minLength: 1, maxLength: 20 }), async (specs) => {
            const w = await makeWorld();
            const posted = [];
            for (const [i, s] of specs.entries()) posted.push((await postOk(w, scenarioFrom(w, s, `v${i}`))).voucher);

            for (const v of posted) {
              mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: v.id, expectedVersion: v.version }));
            }

            expect(await allLines(w)).toEqual([]);
            expect(trialBalance(await allLines(w)).rows).toEqual([]);
            const stored = await w.backend.list(w.companyId);
            expect(stored).toHaveLength(specs.length);
            expect(stored.every((v) => v.status === 'cancelled')).toBe(true);

            // numbers already issued are never handed out again
            const next = await postOk(w, scenarioFrom(w, specs[0] as Spec, 'fresh'));
            const usedByKind = posted.filter((v) => v.voucherTypeId === next.voucher.voucherTypeId).length;
            expect(Number(next.voucher.number.slice(-4))).toBe(usedByKind + 1);
          }),
          RUNS,
        );
      });
    });

    describe('any interleaving of post / alter / cancel', () => {
      type Op =
        | { t: 'post'; spec: Spec }
        | { t: 'cancel'; pick: number }
        | { t: 'alter'; pick: number; specs: Record<AccountingKind, Spec> };

      const arbOp: fc.Arbitrary<Op> = fc.oneof(
        { weight: 5, arbitrary: arbSpec().map((spec): Op => ({ t: 'post', spec })) },
        { weight: 2, arbitrary: fc.nat({ max: 1000 }).map((pick): Op => ({ t: 'cancel', pick })) },
        {
          weight: 3,
          arbitrary: fc
            .record({
              pick: fc.nat({ max: 1000 }),
              specs: fc.record({
                contra: arbSpecOfKind('contra'),
                payment: arbSpecOfKind('payment'),
                receipt: arbSpecOfKind('receipt'),
                journal: arbSpecOfKind('journal'),
              }),
            })
            .map((x): Op => ({ t: 'alter', ...x })),
        },
      );

      it('keeps the books balanced and equal to the model after EVERY step', async () => {
        await fc.assert(
          fc.asyncProperty(fc.array(arbOp, { minLength: 1, maxLength: 40 }), async (ops) => {
            const w = await makeWorld();
            // model: what SHOULD be live, tracked independently of the backend
            const live = new Map<string, { scenario: Scenario; version: number }>();
            let counter = 0;

            for (const op of ops) {
              if (op.t === 'post') {
                const sc = scenarioFrom(w, op.spec, `v${counter++}`);
                const out = await postOk(w, sc);
                live.set(sc.id, { scenario: sc, version: out.voucher.version });
              } else {
                const targets = [...live.entries()];
                const picked = targets[op.pick % Math.max(targets.length, 1)];
                if (!picked) continue;
                const [id, m] = picked;
                if (op.t === 'cancel') {
                  const v = mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: m.scenario.id, expectedVersion: m.version }));
                  live.delete(id);
                  expect(v.status).toBe('cancelled');
                } else {
                  const friendly = `alt${counter++}`;
                  // Same voucher id, new content: build the replacement under the ORIGINAL id.
                  const next = scenarioFrom(w, op.specs[m.scenario.kind], friendly);
                  const draft = { ...next.voucher, id: m.scenario.id };
                  const out = mustOk(await w.backend.alter({ companyId: w.companyId, voucherId: m.scenario.id, expectedVersion: m.version, draft }));
                  live.set(id, { scenario: { ...next, id: m.scenario.id, voucher: draft }, version: out.voucher.version });
                }
              }

              const lines = await allLines(w);
              expect(trialBalance(lines).isBalanced).toBe(true);
              expect(closings(lines)).toEqual(expectedBalances([...live.values()].map((m) => m.scenario)));
            }
          }),
          { numRuns: sequenceRuns },
        );
      });
    });

    describe('a refused voucher leaves no trace', () => {
      const corruptions = ['unbalance', 'zero-amount', 'cash-in-journal', 'inactive-ledger', 'outside-fy'] as const;
      const expectedCode: Record<(typeof corruptions)[number], string> = {
        unbalance: IssueCode.Unbalanced,
        'zero-amount': IssueCode.AmountNotPositive,
        'cash-in-journal': IssueCode.CashBankInJournal,
        'inactive-ledger': IssueCode.LedgerInactive,
        'outside-fy': IssueCode.DateOutsideFinancialYear,
      };

      it('does not change the journal, the vouchers or the next number', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(arbSpecOfKind('journal'), { minLength: 0, maxLength: 4 }),
            arbSpecOfKind('journal'),
            fc.constantFrom(...corruptions),
            async (goodSpecs, badSpec, corruption) => {
              const w = await makeWorld();
              for (const [i, s] of goodSpecs.entries()) await postOk(w, scenarioFrom(w, s, `g${i}`));
              const linesBefore = await allLines(w);
              const vouchersBefore = await w.backend.list(w.companyId);

              const bad = scenarioFrom(w, badSpec, 'bad');
              const entries = bad.voucher['entries'] as { ledgerId: LedgerId; amount: bigint }[];
              const first = entries[0] as { ledgerId: LedgerId; amount: bigint };
              if (corruption === 'unbalance') first.amount = first.amount + 1n;
              if (corruption === 'zero-amount') first.amount = 0n;
              if (corruption === 'cash-in-journal') first.ledgerId = w.ledgers.cash;
              if (corruption === 'inactive-ledger') first.ledgerId = w.ledgers.oldDebtor;
              if (corruption === 'outside-fy') bad.voucher['date'] = '2030-01-01';

              expect(codesOf(await post(w, bad))).toContain(expectedCode[corruption]);

              expect(await allLines(w)).toEqual(linesBefore);
              expect(await w.backend.list(w.companyId)).toEqual(vouchersBefore);

              const next = await postOk(
                w,
                journal(w, { id: 'after', date: '2024-05-01', entries: [[w.ledgers.rent, 'debit', '1'], [w.ledgers.salary, 'credit', '1']] }),
              );
              expect(Number(next.voucher.number.slice(-4))).toBe(goodSpecs.length + 1);
            },
          ),
          RUNS,
        );
      });
    });

    describe('idempotent posting', () => {
      it('re-posting the same voucher any number of times changes nothing', async () => {
        await fc.assert(
          fc.asyncProperty(arbSpec(), fc.integer({ min: 1, max: 4 }), async (spec, repeats) => {
            const w = await makeWorld();
            const sc = scenarioFrom(w, spec, 'once');
            const first = await postOk(w, sc);
            const linesAfterFirst = await allLines(w);

            for (let i = 0; i < repeats; i++) {
              const again = await postOk(w, sc);
              expect(again.replayed).toBe(true);
              expect(again.voucher).toEqual(first.voucher);
            }
            expect(await allLines(w)).toEqual(linesAfterFirst);
            expect(await w.backend.list(w.companyId)).toHaveLength(1);
          }),
          RUNS,
        );
      });
    });

    it('sanity: the generators cover every kind', () => {
      const seen = new Set<string>();
      fc.assert(
        fc.property(arbSpec(), (s) => {
          seen.add(s.kind);
        }),
        { numRuns: 300 },
      );
      expect([...seen].sort()).toEqual([...KINDS].sort());
    });
  });
}
