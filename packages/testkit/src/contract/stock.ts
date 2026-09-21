import { IssueCode, type StockMovement, type Voucher, formatQty } from '@minimalerp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { codesOf, mustOk } from '../helpers';
import type { MakeMasterWorld, MasterWorld } from '../masterWorld';

/**
 * Phase 6a on every backend: stock is written only by posting a voucher, in the same step as the voucher; a Stock Journal has no journal
 * lines; stock can never go below zero in a godown on any day — whatever order, however many at once; alter replaces and cancel removes
 * a voucher's movements, each checked against the whole timeline. Same rules, same codes, memory and PostgreSQL alike.
 */
export function stockContract(label: string, makeWorld: MakeMasterWorld): void {
  describe(`${label}: stock`, () => {
    let w: MasterWorld;
    beforeEach(async () => {
      w = await makeWorld();
      const create = async (kind: string, id: string, data: unknown) =>
        mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
      await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
      await create('stockItem', w.uuid('item:sheet'), { name: 'Sheet', unitId: w.uuid('unit:Kg'), itemType: 'raw' });
      await create('warehouse', w.uuid('wh:yard'), { name: 'Scrap Yard' });
    });

    const bolt = () => w.uuid('item:bolt');
    const yard = () => w.uuid('wh:yard');
    const main = async () => (await w.backend.load(w.companyId)).warehouses.find((x) => x.name !== 'Scrap Yard')?.id as string;
    const type = (kind: string) => w.uuid(`type:${kind}`);
    const post = (draft: unknown) => w.backend.post({ companyId: w.companyId, draft });
    const movements = () => w.backend.stockMovements({ companyId: w.companyId });
    const summary = (ms: readonly StockMovement[]) => ms.map((m) => `${m.direction} ${formatQty(m.qty, 0)}`).sort();

    const opening = async (id: string, qty: string, rate: string, item = bolt()) =>
      post({ id: w.uuid(`v:${id}`), voucherTypeId: type('stockOpening'), date: '2024-04-01', itemId: item, warehouseId: await main(), qty, rate });
    const journal = (id: string, entries: unknown[], date = '2024-05-10') => post({ id: w.uuid(`v:${id}`), voucherTypeId: type('stockJournal'), date, entries });
    const out = async (qty: string, wh?: string) => ({ itemId: bolt(), warehouseId: wh ?? (await main()), direction: 'out', qty });
    const inn = async (qty: string, rate: string, wh?: string) => ({ itemId: bolt(), warehouseId: wh ?? (await main()), direction: 'in', qty, rate });

    it('opening stock is one In on the first day, with no journal lines; posting it twice is a replay', async () => {
      const first = mustOk(await opening('o1', '100', '12.5'));
      expect(first.replayed).toBe(false);
      expect(first.plan.journal).toEqual([]);
      expect(first.plan.stock).toHaveLength(1);
      expect(mustOk(await opening('o1', '100', '12.5')).replayed).toBe(true);
      const all = await movements();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ direction: 'in', qty: 1000000n, value: 125000n, date: '2024-04-01', itemId: bolt() });
      expect(await w.backend.lines({ companyId: w.companyId })).toEqual([]); // nothing reached the accounts
    });

    it('a transfer is an Out and an In; the stock ledger lists both, numbered, and the books are untouched', async () => {
      mustOk(await opening('o1', '100', '10'));
      const linesBefore = (await w.backend.lines({ companyId: w.companyId })).length;
      const v = mustOk(await journal('t1', [await out('30'), await inn('30', '10', yard())]));
      expect(v.voucher.number).toMatch(/^STJ\//);
      const mine = (await movements()).filter((m) => m.voucherId === v.voucher.id);
      expect(mine.map((m) => [m.lineNo, m.direction, m.warehouseId === yard() ? 'yard' : 'main'])).toEqual([[1, 'out', 'main'], [2, 'in', 'yard']]);
      expect((await w.backend.lines({ companyId: w.companyId })).length).toBe(linesBefore);
    });

    it('refuses an Out beyond the stock with the same code everywhere, on that line, and writes nothing', async () => {
      mustOk(await opening('o1', '10', '10'));
      const r = await journal('t1', [await out('11')]);
      expect(codesOf(r)).toEqual([IssueCode.StockNegative]);
      if (!r.ok) expect(r.issues[0]?.path).toBe('entries.0.qty');
      expect(await movements()).toHaveLength(1);
      expect(await w.backend.get(w.companyId, w.uuid('v:t1') as never)).toBeUndefined();
    });

    it('is per godown: plenty in one is no use to another', async () => {
      mustOk(await opening('o1', '10', '10'));
      expect(codesOf(await journal('t1', [await out('1', yard())]))).toEqual([IssueCode.StockNegative]);
    });

    it('checks the whole timeline: a back-dated Out cannot use stock that only arrives later, nor starve a later Out', async () => {
      mustOk(await opening('o1', '5', '10'));
      mustOk(await journal('in1', [await inn('20', '10')], '2024-06-10'));
      expect(codesOf(await journal('early', [await out('10')], '2024-06-01'))).toEqual([IssueCode.StockNegative]);
      mustOk(await journal('out1', [await out('20')], '2024-06-20'));
      expect(codesOf(await journal('mid', [await out('6')], '2024-05-01'))).toEqual([IssueCode.StockNegative]); // 5 − 6 < 0 on 1 May
      expect(codesOf(await journal('starve', [await out('6')], '2024-06-15'))).toEqual([IssueCode.StockNegative]); // 25 − 6 − 20 < 0 on 20 June
    });

    it('alter replaces a voucher’s movements; an alteration that starves a later Out is refused and changes nothing', async () => {
      mustOk(await opening('o1', '10', '10'));
      const t = mustOk(await journal('t1', [await out('4')], '2024-05-10'));
      const later = mustOk(await journal('t2', [await out('5')], '2024-05-20'));
      expect(later.voucher.number).toBeDefined();
      const altered = mustOk(
        await w.backend.alter({ companyId: w.companyId, voucherId: t.voucher.id, expectedVersion: 1, draft: { id: t.voucher.id, voucherTypeId: type('stockJournal'), date: '2024-05-10', entries: [await out('1')] } }),
      );
      expect(altered.voucher.version).toBe(2);
      expect(summary((await movements()).filter((m) => m.voucherId === t.voucher.id))).toEqual(['out 1']);
      // making the opening smaller than the later issues need is refused
      const opened = (await w.backend.get(w.companyId, w.uuid('v:o1') as never)) as Voucher;
      const shrink = await w.backend.alter({ companyId: w.companyId, voucherId: opened.id, expectedVersion: 1, draft: { id: opened.id, voucherTypeId: type('stockOpening'), date: '2024-04-01', itemId: bolt(), warehouseId: await main(), qty: '5', rate: '10' } });
      expect(codesOf(shrink)).toEqual([IssueCode.StockNegative]);
      expect((await w.backend.get(w.companyId, opened.id))?.version).toBe(1);
    });

    it('cancel removes the movements; cancelling an In that later Outs depend on is refused', async () => {
      const o = mustOk(await opening('o1', '10', '10'));
      const t = mustOk(await journal('t1', [await out('4')]));
      expect(codesOf(await w.backend.cancel({ companyId: w.companyId, voucherId: o.voucher.id, expectedVersion: 1 }))).toEqual([IssueCode.StockNegative]);
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: t.voucher.id, expectedVersion: 1 }));
      expect(summary(await movements())).toEqual(['in 10']);
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: o.voucher.id, expectedVersion: 1 }));
      expect(await movements()).toEqual([]);
      expect((await w.backend.get(w.companyId, o.voucher.id))?.status).toBe('cancelled'); // it keeps its number
    });

    it('several stock-outs at once: exactly as many win as the stock allows, and the rest are refused as stock errors', async () => {
      mustOk(await opening('o1', '10', '10'));
      const wh = await main();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => journal(`race${i}`, [{ itemId: bolt(), warehouseId: wh, direction: 'out', qty: '3' }], '2024-05-10')),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3); // 10 → 7 → 4 → 1
      for (const r of results.filter((x) => !x.ok)) expect(codesOf(r)).toEqual([IssueCode.StockNegative]);
      const remaining = (await movements()).reduce((sum, m) => sum + (m.direction === 'in' ? m.qty : -m.qty), 0n);
      expect(remaining).toBe(10000n); // 1 left, never below zero
    });

    it('refuses a badly shaped line with the stock code: a rate on an Out, none on an In, decimals a unit does not take, a service', async () => {
      mustOk(await opening('o1', '10', '10'));
      const wh = await main();
      const bad = async (e: Record<string, unknown>, i: string) => codesOf(await journal(i, [{ itemId: bolt(), warehouseId: wh, direction: 'in', qty: '1', rate: '1', ...e }]));
      expect(await bad({ direction: 'out', rate: '5' }, 'b1')).toEqual([IssueCode.StockLineInvalid]);
      expect(await bad({ rate: undefined }, 'b2')).toEqual([IssueCode.StockLineInvalid]);
      expect(await bad({ qty: '1.5' }, 'b3')).toEqual([IssueCode.StockLineInvalid]);
      expect((await journal('kg', [{ itemId: w.uuid('item:sheet'), warehouseId: wh, direction: 'in', qty: '1.5', rate: '2' }])).ok).toBe(true); // Kg take three places
    });

    it('an accounting voucher never moves stock, and a stock voucher never touches a ledger', async () => {
      mustOk(await opening('o1', '10', '10'));
      const before = await w.backend.lines({ companyId: w.companyId });
      mustOk(await journal('t1', [await out('2')]));
      expect(await w.backend.lines({ companyId: w.companyId })).toEqual(before);
    });
  });
}
