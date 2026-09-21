import { closingByGroup, ledgerMovements, localDate, trialBalance } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { allLines, postOk } from '../helpers';
import { journal, payment, receipt } from '../scenarios';
import { type DemoWorld, type MakeWorld } from '../world';

/**
 * A small year of trading, worked out by hand:
 *   1 Apr  Receipt  bank  ← capital      1,00,000
 *  10 Apr  Payment  bank  → rent            20,000
 *   1 May  Journal  purchase Dr / creditor Cr  50,000
 *   5 May  Payment  bank  → creditor        30,000
 *   1 Jun  Receipt  cash  ← debtor           5,000
 */
async function trade(makeWorld: MakeWorld): Promise<DemoWorld> {
  const w = await makeWorld();
  const L = w.ledgers;
  await postOk(w, receipt(w, { id: 'r1', date: '2024-04-01', account: L.bank, lines: [[L.capital, '100000']] }));
  await postOk(w, payment(w, { id: 'p1', date: '2024-04-10', account: L.bank, lines: [[L.rent, '20000']] }));
  await postOk(w, journal(w, { id: 'j1', date: '2024-05-01', entries: [[L.purchase, 'debit', '50000'], [L.creditor, 'credit', '50000']] }));
  await postOk(w, payment(w, { id: 'p2', date: '2024-05-05', account: L.bank, lines: [[L.creditor, '30000']] }));
  await postOk(w, receipt(w, { id: 'r2', date: '2024-06-01', account: L.cash, lines: [[L.debtor, '5000']] }));
  return w;
}

const rupees = (n: number) => BigInt(n) * 100n;

/** The reference trial balance, fed from the backend's own journal reads. */
export function trialBalanceContract(label: string, makeWorld: MakeWorld): void {
  describe(`${label}: trial balance from the journal`, () => {
    it('whole year: closing balances per ledger, debit positive', async () => {
      const w = await trade(makeWorld);
      const mv = ledgerMovements(await allLines(w));
      const closing = (l: keyof DemoWorld['ledgers']) => mv.get(w.ledgers[l])?.closing;

      expect(closing('bank')).toBe(rupees(50_000)); // 100000 − 20000 − 30000
      expect(closing('capital')).toBe(-rupees(100_000));
      expect(closing('rent')).toBe(rupees(20_000));
      expect(closing('purchase')).toBe(rupees(50_000));
      expect(closing('creditor')).toBe(-rupees(20_000)); // Cr 50000, Dr 30000
      expect(closing('cash')).toBe(rupees(5_000));
      expect(closing('debtor')).toBe(-rupees(5_000));
      expect(closing('sales')).toBeUndefined(); // untouched ledgers do not appear
    });

    it('total debit equals total credit', async () => {
      const tb = trialBalance(await allLines(await trade(makeWorld)));
      expect(tb.totalClosingDebit).toBe(rupees(125_000)); // bank 50k + rent 20k + purchase 50k + cash 5k
      expect(tb.totalClosingCredit).toBe(rupees(125_000)); // capital 100k + creditor 20k + debtor 5k
      expect(tb.isBalanced).toBe(true);
    });

    it('for a period: opening before `from`, movement inside, nothing after `to`', async () => {
      const w = await trade(makeWorld);
      const tb = trialBalance(await allLines(w), { from: localDate('2024-05-01'), to: localDate('2024-05-31') });
      const row = (l: keyof DemoWorld['ledgers']) => tb.rows.find((r) => r.ledgerId === w.ledgers[l]);

      expect(row('bank')).toMatchObject({ opening: rupees(80_000), debit: 0n, credit: rupees(30_000), closing: rupees(50_000) });
      expect(row('creditor')).toMatchObject({ opening: 0n, debit: rupees(30_000), credit: rupees(50_000), closing: -rupees(20_000) });
      expect(row('rent')).toMatchObject({ opening: rupees(20_000), debit: 0n, credit: 0n, closing: rupees(20_000) });
      expect(row('cash')).toBeUndefined();
      expect(row('debtor')).toBeUndefined();
      expect(tb.isBalanced).toBe(true);
    });

    it('closing = opening + debit − credit for every ledger', async () => {
      const lines = await allLines(await trade(makeWorld));
      for (const mv of ledgerMovements(lines, { from: localDate('2024-04-15'), to: localDate('2024-05-31') }).values()) {
        expect(mv.closing).toBe(mv.opening + mv.debit - mv.credit);
      }
    });

    it('group roll-up sums each group with all of its descendants', async () => {
      const w = await trade(makeWorld);
      const masters = await w.backend.load(w.companyId);
      const byGroup = closingByGroup(trialBalance(await allLines(w)).rows, masters);
      const g = (key: Parameters<DemoWorld['group']>[0]) => byGroup.get(w.group(key));

      expect(g('bank-accounts')).toBe(rupees(50_000));
      expect(g('cash-in-hand')).toBe(rupees(5_000));
      expect(g('sundry-debtors')).toBe(-rupees(5_000));
      expect(g('current-assets')).toBe(rupees(50_000)); // bank 50,000 + cash 5,000 − debtor 5,000
      expect(g('capital-account')).toBe(-rupees(100_000));
      expect(g('current-liabilities')).toBe(-rupees(20_000));
      expect(g('indirect-expenses')).toBe(rupees(20_000));
      expect(g('purchase-accounts')).toBe(rupees(50_000));
      expect(g('sales-accounts')).toBeUndefined();

      let top = 0n;
      for (const group of masters.groups.all) if (group.parentId === null) top += byGroup.get(group.id) ?? 0n;
      expect(top).toBe(0n); // the books balance at the top of the tree
    });
  });
}
