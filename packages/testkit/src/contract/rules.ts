import { IssueCode, VoucherKindRegistry } from '@minimalerp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { brief, mustFail, post, postOk } from '../helpers';
import { contra, journal, payment, receipt } from '../scenarios';
import { type DemoWorld, type MakeWorld } from '../world';

/** What each voucher journals, what is refused, and where each problem is reported. */
export function postingRulesContract(label: string, makeWorld: MakeWorld): void {
  describe(`${label}: posting rules`, () => {
    let w: DemoWorld;
    beforeEach(async () => {
      w = await makeWorld();
    });

    const L = (name: keyof DemoWorld['ledgers']) => w.ledgers[name];
    const issuesOf = async (s: Parameters<typeof post>[1]) => mustFail(await post(w, s));
    const at = (issues: readonly { code: string; path?: string | undefined }[], code: string) =>
      issues.find((i) => i.code === code);

    describe('what each voucher journals', () => {
      it('Payment: Dr particulars, Cr the cash/bank account (total derived, not entered)', async () => {
        const out = await postOk(
          w,
          payment(w, { id: 'p1', date: '2024-05-10', account: L('bank'), lines: [[L('rent'), '10000.00'], [L('creditor'), '2500.50']] }),
        );
        expect(brief(out.plan.journal)).toEqual([
          [L('rent'), 'debit', 1_000_000n, 1],
          [L('creditor'), 'debit', 250_050n, 2],
          [L('bank'), 'credit', 1_250_050n, 3],
        ]);
        expect(out.voucher.number).toBe('PAY/24-25/0001');
        expect(out.plan.journal.every((l) => l.date === '2024-05-10' && l.voucherId === w.vid('p1'))).toBe(true);
      });

      it('Receipt: Dr the cash/bank account, Cr particulars', async () => {
        const out = await postOk(w, receipt(w, { id: 'r1', date: '2024-05-11', account: L('cash'), lines: [[L('debtor'), '5000']] }));
        expect(brief(out.plan.journal)).toEqual([
          [L('cash'), 'debit', 500_000n, 1],
          [L('debtor'), 'credit', 500_000n, 2],
        ]);
        expect(out.voucher.number).toBe('REC/24-25/0001');
      });

      it('Contra: cash/bank → cash/bank (source credited, destinations debited)', async () => {
        const out = await postOk(
          w,
          contra(w, { id: 'c1', date: '2024-05-12', account: L('bank'), lines: [[L('cash'), '1000'], [L('bank2'), '250.25']] }),
        );
        expect(brief(out.plan.journal)).toEqual([
          [L('cash'), 'debit', 100_000n, 1],
          [L('bank2'), 'debit', 25_025n, 2],
          [L('bank'), 'credit', 125_025n, 3],
        ]);
      });

      it('Journal: entries post exactly as entered', async () => {
        const out = await postOk(
          w,
          journal(w, { id: 'j1', date: '2024-05-13', entries: [[L('rent'), 'debit', '300'], [L('creditor'), 'credit', '100'], [L('salary'), 'credit', '200']] }),
        );
        expect(brief(out.plan.journal)).toEqual([
          [L('rent'), 'debit', 30_000n, 1],
          [L('creditor'), 'credit', 10_000n, 2],
          [L('salary'), 'credit', 20_000n, 3],
        ]);
      });

      it('carries line narration onto journal lines', async () => {
        const s = payment(w, { id: 'p2', date: '2024-05-10', account: L('cash'), lines: [[L('rent'), '10']] });
        (s.voucher['lines'] as { narration?: string }[])[0]!.narration = 'May rent';
        const out = await postOk(w, s);
        expect(out.plan.journal[0]?.narration).toBe('May rent');
      });

      it('accepts money as bigint or decimal string, interchangeably', async () => {
        const out = await postOk(
          w,
          payment(w, { id: 'p3', date: '2024-05-10', account: L('cash'), lines: [[L('rent'), 150_00n], [L('salary'), '20.5']] }),
        );
        expect(out.plan.journal.map((l) => l.amount)).toEqual([15_000n, 2_050n, 17_050n]);
      });

      it('ignores a client-supplied total: the account amount is always derived', async () => {
        const s = payment(w, { id: 'p4', date: '2024-05-10', account: L('cash'), lines: [[L('rent'), '10']] });
        s.voucher['total'] = '999999.00';
        s.voucher['accountAmount'] = '1.00';
        const out = await postOk(w, s);
        expect(out.plan.journal.at(-1)?.amount).toBe(1_000n);
      });
    });

    describe('what is refused, and where the problem is reported', () => {
      it('Payment account must be cash/bank', async () => {
        const issues = await issuesOf(payment(w, { id: 'x', date: '2024-05-10', account: L('debtor'), lines: [[L('rent'), '10']] }));
        expect(at(issues, IssueCode.AccountNotCashOrBank)?.path).toBe('accountLedgerId');
      });

      it('accepts a bank overdraft ledger as the account', async () => {
        await postOk(w, payment(w, { id: 'od', date: '2024-05-10', account: L('bankOd'), lines: [[L('rent'), '10']] }));
      });

      it.each(['0', '0.00', '-5.00'])('refuses amount %s', async (amount) => {
        const issues = await issuesOf(payment(w, { id: 'x', date: '2024-05-10', account: L('cash'), lines: [[L('rent'), amount]] }));
        expect(at(issues, IssueCode.AmountNotPositive)?.path).toBe('lines.0.amount');
      });

      it('refuses a payment with no particulars', async () => {
        const issues = await issuesOf(payment(w, { id: 'x', date: '2024-05-10', account: L('cash'), lines: [] }));
        expect(at(issues, IssueCode.TooFewLines)?.path).toBe('lines');
      });

      it('refuses a particular that is the account itself', async () => {
        const issues = await issuesOf(payment(w, { id: 'x', date: '2024-05-10', account: L('cash'), lines: [[L('cash'), '10']] }));
        expect(at(issues, IssueCode.SameLedgerBothSides)?.path).toBe('lines.0.ledgerId');
      });

      it('refuses an inactive ledger and an unknown ledger, with paths', async () => {
        const inactive = await issuesOf(payment(w, { id: 'x', date: '2024-05-10', account: L('cash'), lines: [[L('oldDebtor'), '10']] }));
        expect(at(inactive, IssueCode.LedgerInactive)?.path).toBe('lines.0.ledgerId');

        const s = payment(w, { id: 'y', date: '2024-05-10', account: L('cash'), lines: [[L('rent'), '10']] });
        (s.voucher['lines'] as { ledgerId: string }[])[0]!.ledgerId = w.uuid('ghost-ledger');
        expect(at(await issuesOf(s), IssueCode.LedgerUnknown)?.path).toBe('lines.0.ledgerId');
      });

      it('reports every problem at once, not just the first', async () => {
        const issues = await issuesOf(
          payment(w, { id: 'x', date: '2024-05-10', account: L('debtor'), lines: [[L('rent'), '0'], [L('salary'), '-1']] }),
        );
        expect(issues.map((i) => i.code).sort()).toEqual(
          [IssueCode.AccountNotCashOrBank, IssueCode.AmountNotPositive, IssueCode.AmountNotPositive].sort(),
        );
      });

      it.each(['2023-12-31', '2026-04-01'])('refuses date %s outside every financial year', async (date) => {
        const issues = await issuesOf(payment(w, { id: 'x', date, account: L('cash'), lines: [[L('rent'), '10']] }));
        expect(at(issues, IssueCode.DateOutsideFinancialYear)?.path).toBe('date');
      });

      it('refuses an amount beyond what the books can hold — but accepts exactly the maximum', async () => {
        const tooBig = await issuesOf(payment(w, { id: 'x', date: '2024-05-10', account: L('cash'), lines: [[L('rent'), '10000000000000000.00']] }));
        expect(at(tooBig, IssueCode.AmountTooLarge)).toBeDefined();

        // two particulars that are each fine but whose derived account total is not
        const sum = await issuesOf(payment(w, { id: 'y', date: '2024-05-10', account: L('cash'), lines: [[L('rent'), '6000000000000000.00'], [L('salary'), '6000000000000000.00']] }));
        expect(at(sum, IssueCode.AmountTooLarge)).toBeDefined();

        const out = await postOk(w, payment(w, { id: 'max', date: '2024-05-10', account: L('cash'), lines: [[L('rent'), '9999999999999999.99']] }));
        expect(out.plan.journal.map((l) => l.amount)).toEqual([999_999_999_999_999_999n, 999_999_999_999_999_999n]);
      });

      it('Contra particulars must also be cash/bank', async () => {
        const issues = await issuesOf(contra(w, { id: 'x', date: '2024-05-10', account: L('bank'), lines: [[L('debtor'), '10']] }));
        expect(at(issues, IssueCode.ParticularNotCashOrBank)?.path).toBe('lines.0.ledgerId');
      });

      it('Journal refuses cash and bank ledgers', async () => {
        const issues = await issuesOf(
          journal(w, { id: 'x', date: '2024-05-10', entries: [[L('cash'), 'debit', '10'], [L('rent'), 'credit', '10']] }),
        );
        expect(at(issues, IssueCode.CashBankInJournal)?.path).toBe('entries.0.ledgerId');
      });

      it('Journal must balance, and says by how much', async () => {
        const issues = await issuesOf(
          journal(w, { id: 'x', date: '2024-05-10', entries: [[L('rent'), 'debit', '300.00'], [L('creditor'), 'credit', '299.99']] }),
        );
        const unbalanced = at(issues, IssueCode.Unbalanced) as { message: string } | undefined;
        expect(unbalanced?.message).toContain('300.00');
        expect(unbalanced?.message).toContain('299.99');
      });

      it('Journal needs at least two entries', async () => {
        const issues = await issuesOf(journal(w, { id: 'x', date: '2024-05-10', entries: [[L('rent'), 'debit', '10']] }));
        expect(at(issues, IssueCode.TooFewLines)).toBeDefined();
      });
    });

    describe('draft parsing', () => {
      const base = () => payment(w, { id: 'x', date: '2024-05-10', account: L('cash'), lines: [[L('rent'), '10']] });
      const schemaPath = async (s: ReturnType<typeof base>) =>
        (await issuesOf(s)).find((i) => i.code === IssueCode.SchemaInvalid)?.path;

      it('rejects impossible calendar dates', async () => {
        const s = base();
        s.voucher['date'] = '2024-02-30';
        expect(await schemaPath(s)).toBe('date');
      });

      it.each(['1,000', '1.234', '', 'abc'])('rejects malformed money %j', async (amount) => {
        const s = base();
        (s.voucher['lines'] as { amount: unknown }[])[0]!.amount = amount;
        expect(await schemaPath(s)).toBe('lines.0.amount');
      });

      it('rejects a JS number for money — floats never enter the books', async () => {
        const s = base();
        (s.voucher['lines'] as { amount: unknown }[])[0]!.amount = 10.5;
        expect(await schemaPath(s)).toBe('lines.0.amount');
      });

      it('rejects a draft missing required fields', async () => {
        const s = base();
        delete s.voucher['lines'];
        expect((await issuesOf(s)).some((i) => i.code === IssueCode.SchemaInvalid && i.path === 'lines')).toBe(true);
      });

      it('rejects a non-object draft', async () => {
        const r = await w.backend.post({ companyId: w.companyId, draft: 'nonsense' });
        expect(mustFail(r)[0]?.code).toBe(IssueCode.SchemaInvalid);
      });

      it('rejects an unknown voucher type', async () => {
        const s = base();
        s.voucher['voucherTypeId'] = w.uuid('ghost-type');
        expect((await issuesOf(s))[0]?.code).toBe(IssueCode.VoucherTypeUnknown);
      });

      it('reports KIND_UNSUPPORTED when no kind is registered for the voucher type', async () => {
        const bare = await makeWorld({ registry: new VoucherKindRegistry() });
        const s = payment(bare, { id: 'x', date: '2024-05-10', account: bare.ledgers.cash, lines: [[bare.ledgers.rent, '10']] });
        const r = await bare.backend.post({ companyId: bare.companyId, draft: s.voucher });
        expect(mustFail(r)[0]?.code).toBe(IssueCode.KindUnsupported);
      });
    });
  });
}
