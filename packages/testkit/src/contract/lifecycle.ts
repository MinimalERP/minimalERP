import { IssueCode, Masters, asCompanyId, localDate, trialBalance } from '@minimalerp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { allLines, brief, codesOf, mustOk, post, postOk } from '../helpers';
import { journal, payment, receipt } from '../scenarios';
import { type DemoWorld, type MakeWorld } from '../world';

/** Alter, cancel, period lock, numbering, idempotency, company boundary and journal reads. */
export function lifecycleContract(label: string, makeWorld: MakeWorld): void {
  describe(`${label}: voucher lifecycle`, () => {
    let w: DemoWorld;
    beforeEach(async () => {
      w = await makeWorld();
    });

    const L = (name: keyof DemoWorld['ledgers']) => w.ledgers[name];
    const vid = (name: string) => w.vid(name);

    const rentPayment = (id: string, amount = '1000', date = '2024-05-10') =>
      payment(w, { id, date, account: L('bank'), lines: [[L('rent'), amount]] });

    const alter = (id: string, expectedVersion: number, draft: unknown) =>
      w.backend.alter({ companyId: w.companyId, voucherId: vid(id), expectedVersion, draft });
    const cancel = (id: string, expectedVersion: number) =>
      w.backend.cancel({ companyId: w.companyId, voucherId: vid(id), expectedVersion });

    describe('alter', () => {
      it('replaces the journal, keeps id and number, bumps version and revision, and records history', async () => {
        const original = await postOk(w, rentPayment('p1', '1000'));
        expect(original.voucher).toMatchObject({ version: 1, revision: 0, number: 'PAY/24-25/0001' });

        const altered = mustOk(
          await alter(
            'p1',
            1,
            payment(w, { id: 'p1', date: '2024-05-12', account: L('bank'), lines: [[L('rent'), '1500'], [L('salary'), '200']] }).voucher,
          ),
        );

        expect(altered.voucher).toMatchObject({ version: 2, revision: 1, number: 'PAY/24-25/0001', date: '2024-05-12' });
        // exactly the new lines, none of the old ones left behind
        expect(brief(await allLines(w))).toEqual([
          [L('rent'), 'debit', 150_000n, 1],
          [L('salary'), 'debit', 20_000n, 2],
          [L('bank'), 'credit', 170_000n, 3],
        ]);
        expect(trialBalance(await allLines(w)).isBalanced).toBe(true);

        const history = await w.backend.history(vid('p1'));
        expect(history).toHaveLength(1);
        expect(history[0]?.voucher.version).toBe(1);
        expect(brief(history[0]?.journal ?? [])).toEqual([
          [L('rent'), 'debit', 100_000n, 1],
          [L('bank'), 'credit', 100_000n, 2],
        ]);
      });

      it('refuses a stale version and leaves the books untouched', async () => {
        await postOk(w, rentPayment('p1'));
        const before = brief(await allLines(w));
        expect(codesOf(await alter('p1', 7, rentPayment('p1', '9999').voucher))).toEqual([IssueCode.VersionConflict]);
        expect(brief(await allLines(w))).toEqual(before);
      });

      it('refuses an invalid alteration atomically: the original stays exactly as posted', async () => {
        await postOk(w, journal(w, { id: 'j1', date: '2024-05-10', entries: [[L('rent'), 'debit', '100'], [L('creditor'), 'credit', '100']] }));
        const before = brief(await allLines(w));

        const bad = journal(w, { id: 'j1', date: '2024-05-10', entries: [[L('rent'), 'debit', '100'], [L('creditor'), 'credit', '99']] });
        expect(codesOf(await alter('j1', 1, bad.voucher))).toContain(IssueCode.Unbalanced);

        expect(brief(await allLines(w))).toEqual(before);
        expect(await w.backend.get(w.companyId, vid('j1'))).toMatchObject({ version: 1, revision: 0 });
        expect(await w.backend.history(vid('j1'))).toHaveLength(0);
      });

      it('cannot change the voucher id, type or financial year', async () => {
        await postOk(w, rentPayment('p1'));
        expect(codesOf(await alter('p1', 1, rentPayment('other').voucher))).toEqual([IssueCode.VoucherIdMismatch]);
        expect(
          codesOf(await alter('p1', 1, receipt(w, { id: 'p1', date: '2024-05-10', account: L('bank'), lines: [[L('rent'), '10']] }).voucher)),
        ).toEqual([IssueCode.VoucherTypeChanged]);
        expect(codesOf(await alter('p1', 1, rentPayment('p1', '10', '2025-04-05').voucher))).toEqual([IssueCode.FinancialYearChanged]);
      });

      it('cannot alter a cancelled voucher or one that does not exist', async () => {
        await postOk(w, rentPayment('p1'));
        mustOk(await cancel('p1', 1));
        expect(codesOf(await alter('p1', 2, rentPayment('p1').voucher))).toEqual([IssueCode.VoucherNotPosted]);
        expect(codesOf(await alter('nope', 1, rentPayment('nope').voucher))).toEqual([IssueCode.VoucherNotFound]);
      });
    });

    describe('cancel', () => {
      it('removes the voucher from the books but keeps it, and its number, on record', async () => {
        await postOk(w, rentPayment('p1'));
        const cancelled = mustOk(await cancel('p1', 1));

        expect(cancelled).toMatchObject({ status: 'cancelled', number: 'PAY/24-25/0001', version: 2 });
        expect(await allLines(w)).toEqual([]);
        expect(trialBalance(await allLines(w)).rows).toEqual([]);
        expect(await w.backend.history(vid('p1'))).toHaveLength(1);
      });

      it('never reuses a cancelled voucher’s number (numbering stays gapless)', async () => {
        await postOk(w, rentPayment('p1'));
        mustOk(await cancel('p1', 1));
        expect((await postOk(w, rentPayment('p2'))).voucher.number).toBe('PAY/24-25/0002');
      });

      it('refuses a stale version, a double cancel and an unknown voucher', async () => {
        await postOk(w, rentPayment('p1'));
        expect(codesOf(await cancel('p1', 9))).toEqual([IssueCode.VersionConflict]);
        mustOk(await cancel('p1', 1));
        expect(codesOf(await cancel('p1', 2))).toEqual([IssueCode.VoucherNotPosted]);
        expect(codesOf(await cancel('zzz', 1))).toEqual([IssueCode.VoucherNotFound]);
      });
    });

    describe('period lock', () => {
      beforeEach(async () => {
        await postOk(w, rentPayment('early', '100', '2024-05-10'));
        await postOk(w, rentPayment('late', '100', '2024-08-01'));
        await w.backend.lockThrough(w.fy2425.id, localDate('2024-06-30'));
      });

      it('blocks posting on or before the lock date, allows the day after', async () => {
        expect(codesOf(await post(w, rentPayment('n1', '1', '2024-06-30')))).toEqual([IssueCode.PeriodLocked]);
        expect(codesOf(await post(w, rentPayment('n2', '1', '2024-05-01')))).toEqual([IssueCode.PeriodLocked]);
        await postOk(w, rentPayment('n3', '1', '2024-07-01'));
      });

      it('blocks altering and cancelling a locked voucher', async () => {
        expect(codesOf(await alter('early', 1, rentPayment('early', '5', '2024-05-10').voucher))).toEqual([IssueCode.PeriodLocked]);
        expect(codesOf(await cancel('early', 1))).toEqual([IssueCode.PeriodLocked]);
      });

      it('blocks moving an open voucher into the locked period', async () => {
        expect(codesOf(await alter('late', 1, rentPayment('late', '100', '2024-05-20').voucher))).toEqual([IssueCode.PeriodLocked]);
      });

      it('still allows altering a voucher that is after the lock', async () => {
        expect((await alter('late', 1, rentPayment('late', '250', '2024-08-02').voucher)).ok).toBe(true);
      });

      it('answers a retry of an already-posted voucher idempotently even after the lock', async () => {
        expect(mustOk(await post(w, rentPayment('early', '100', '2024-05-10'))).replayed).toBe(true);
      });

      it('unlocking restores the ability to post', async () => {
        await w.backend.lockThrough(w.fy2425.id, undefined);
        await postOk(w, rentPayment('n4', '1', '2024-05-01'));
      });
    });

    describe('numbering', () => {
      it('runs one sequence per voucher type per financial year', async () => {
        expect((await postOk(w, rentPayment('p1'))).voucher.number).toBe('PAY/24-25/0001');
        expect((await postOk(w, rentPayment('p2'))).voucher.number).toBe('PAY/24-25/0002');
        expect((await postOk(w, receipt(w, { id: 'r1', date: '2024-05-10', account: L('cash'), lines: [[L('debtor'), '5']] }))).voucher.number).toBe('REC/24-25/0001');
        expect((await postOk(w, rentPayment('p3', '1', '2025-04-05'))).voucher.number).toBe('PAY/25-26/0001');
      });

      it('does not burn a number when a posting is refused', async () => {
        codesOf(await post(w, payment(w, { id: 'bad', date: '2024-05-10', account: L('debtor'), lines: [[L('rent'), '10']] })));
        codesOf(await post(w, rentPayment('bad2', '0')));
        expect((await postOk(w, rentPayment('good'))).voucher.number).toBe('PAY/24-25/0001');
      });

      it('refuses to post when no numbering series exists, without changing anything', async () => {
        const bare = await makeWorld({ withSeries: false });
        const s = payment(bare, { id: 'p1', date: '2024-05-10', account: bare.ledgers.bank, lines: [[bare.ledgers.rent, '1000']] });
        expect(codesOf(await bare.backend.post({ companyId: bare.companyId, draft: s.voucher }))).toEqual([IssueCode.NumberingSeriesMissing]);
        expect(await bare.backend.list(bare.companyId)).toEqual([]);
        expect(await bare.backend.lines({ companyId: bare.companyId })).toEqual([]);
      });
    });

    describe('idempotency', () => {
      it('replays a repeated post of the same voucher: one voucher, same number, no extra lines', async () => {
        const s = rentPayment('p1');
        const first = await postOk(w, s);
        const second = await postOk(w, s);

        expect(first.replayed).toBe(false);
        expect(second.replayed).toBe(true);
        expect(second.voucher).toEqual(first.voucher);
        expect(brief(second.plan.journal)).toEqual(brief(first.plan.journal));
        expect(await w.backend.list(w.companyId)).toHaveLength(1);
        expect(await allLines(w)).toHaveLength(2);
        expect((await postOk(w, rentPayment('p2'))).voucher.number).toBe('PAY/24-25/0002');
      });

      it('treats the same content in a different wire form (bigint vs string) as the same voucher', async () => {
        await postOk(w, payment(w, { id: 'p1', date: '2024-05-10', account: L('bank'), lines: [[L('rent'), '10.00']] }));
        const again = await postOk(w, payment(w, { id: 'p1', date: '2024-05-10', account: L('bank'), lines: [[L('rent'), 1000n]] }));
        expect(again.replayed).toBe(true);
      });

      it('refuses reuse of a voucher id for different content', async () => {
        await postOk(w, rentPayment('p1', '1000'));
        expect(codesOf(await post(w, rentPayment('p1', '2000')))).toEqual([IssueCode.IdempotencyConflict]);
        expect(await allLines(w)).toHaveLength(2);
      });
    });

    describe('company boundary and reads', () => {
      it('refuses a request addressed to another company', async () => {
        const r = await w.backend.post({ companyId: asCompanyId(w.uuid('someone-else')), draft: rentPayment('p1').voucher });
        expect(codesOf(r)).toEqual([IssueCode.CompanyMismatch]);
      });

      it('serves journal reads filtered by ledger, voucher and date, in date order', async () => {
        await postOk(w, rentPayment('b', '10', '2024-06-01'));
        await postOk(w, rentPayment('a', '20', '2024-05-01'));

        const rent = await w.backend.lines({ companyId: w.companyId, ledgerId: L('rent') });
        expect(rent.map((l) => l.voucherId)).toEqual([vid('a'), vid('b')]);

        expect(await w.backend.lines({ companyId: w.companyId, voucherId: vid('b') })).toHaveLength(2);
        const june = await w.backend.lines({ companyId: w.companyId, from: localDate('2024-06-01') });
        expect(june.every((l) => l.voucherId === vid('b'))).toBe(true);
        const may = await w.backend.lines({ companyId: w.companyId, to: localDate('2024-05-31') });
        expect(may.every((l) => l.voucherId === vid('a'))).toBe(true);

        await expect(w.backend.load(w.companyId)).resolves.toBeInstanceOf(Masters);
        await expect(w.backend.load(asCompanyId(w.uuid('unknown-company')))).rejects.toThrow();
      });

      it('gets a stored voucher back, and nothing for an unknown id', async () => {
        const out = await postOk(w, rentPayment('p1'));
        expect(await w.backend.get(w.companyId, vid('p1'))).toEqual(out.voucher);
        expect(await w.backend.get(w.companyId, vid('missing'))).toBeUndefined();
      });
    });
  });
}
