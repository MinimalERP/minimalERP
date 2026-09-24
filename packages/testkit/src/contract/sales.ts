import { IssueCode, type OrderLink, type Voucher, orderBookOf, partyLedgerId } from '@minimalerp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { codesOf, mustOk } from '../helpers';
import type { MakeMasterWorld, MasterWorld } from '../masterWorld';

/**
 * Phase 6b on every backend: a Sales Order is a document that posts nothing; a Sales Invoice posts Dr customer / Cr sales, takes the goods
 * out of stock and fills the order lines it names, all in one step; delivering more than is pending is refused — however many invoices
 * arrive at once — and alterations and cancellations are checked against what has been delivered. Same rules, same codes, memory and
 * PostgreSQL alike.
 */
export function salesContract(label: string, makeWorld: MakeMasterWorld): void {
  describe(`${label}: sales orders and invoices`, () => {
    let w: MasterWorld;
    beforeEach(async () => {
      w = await makeWorld();
      const create = async (kind: string, id: string, data: unknown) =>
        mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
      await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
      await create('stockItem', w.uuid('item:sheet'), { name: 'Sheet', unitId: w.uuid('unit:Kg'), itemType: 'raw' });
      await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
      await create('party', w.uuid('party:beta'), { name: 'Beta Ltd', roles: ['customer'] });
      await create('party', w.uuid('party:steel'), { name: 'Steel Supplier', roles: ['vendor'] });
      await create('ledger', w.uuid('ledger:sales'), { name: 'Domestic Sales', groupId: w.uuid('group:sales-accounts') });
      const main = (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
      mustOk(
        await w.backend.post({
          companyId: w.companyId,
          draft: { id: w.uuid('v:os-bolt'), voucherTypeId: w.uuid('type:stockOpening'), date: '2024-04-01', itemId: w.uuid('item:bolt'), warehouseId: main, qty: '100', rate: '10' },
        }),
      );
      mustOk(
        await w.backend.post({
          companyId: w.companyId,
          draft: { id: w.uuid('v:os-sheet'), voucherTypeId: w.uuid('type:stockOpening'), date: '2024-04-01', itemId: w.uuid('item:sheet'), warehouseId: main, qty: '50.5', rate: '80' },
        }),
      );
    });

    const bolt = () => w.uuid('item:bolt');
    const sheet = () => w.uuid('item:sheet');
    const acme = () => w.uuid('party:acme');
    const main = async () => (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
    const post = (draft: unknown) => w.backend.post({ companyId: w.companyId, draft });
    const details = (party: string) => ({ partyId: party, mailingName: 'X' });

    const order = (id: string, over: Record<string, unknown> = {}) =>
      post({
        id: w.uuid(`v:${id}`),
        voucherTypeId: w.uuid('type:salesOrder'),
        date: '2024-05-01',
        partyId: acme(),
        partyDetails: details(acme()),
        reference: 'PO-778',
        lines: [
          { id: 'a', itemId: bolt(), qty: '18', rate: '25', dueDate: '2024-05-20' },
          { id: 'b', itemId: sheet(), qty: '10.5', rate: '120', dueDate: '2024-06-10' },
        ],
        ...over,
      });

    const against = async (orderId: string, lineId: string, qty: string, item = bolt(), rate = '25') => ({
      itemId: item,
      warehouseId: await main(),
      qty,
      rate,
      orderRef: { orderId, lineId },
    });

    const invoiceDraft = (id: string, lines: unknown[], over: Record<string, unknown> = {}) => ({
      id: w.uuid(`v:${id}`),
      voucherTypeId: w.uuid('type:sales'),
      date: '2024-05-12',
      partyId: acme(),
      partyDetails: details(acme()),
      salesLedgerId: w.uuid('ledger:sales'),
      dueDate: '2024-06-11',
      lines,
      ...over,
    });
    const invoice = (id: string, lines: unknown[], over: Record<string, unknown> = {}) => post(invoiceDraft(id, lines, over));

    const links = () => w.backend.orderLinks({ companyId: w.companyId });
    const delivered = async (order: Voucher, lineId: string) =>
      (await links()).filter((l: OrderLink) => l.orderId === order.id && l.orderLineId === lineId).reduce((s, l) => s + l.qty, 0n);
    const stockOut = async () =>
      (await w.backend.stockMovements({ companyId: w.companyId })).filter((m) => m.direction === 'out').reduce((s, m) => s + m.qty, 0n);

    it('a sales order posts no journal lines, no stock and no links; posting it twice is a replay', async () => {
      const first = mustOk(await order('so1'));
      expect(first.replayed).toBe(false);
      expect(first.voucher.number).toMatch(/^SO\//);
      expect(first.plan).toMatchObject({ journal: [], stock: [], links: [] });
      expect(mustOk(await order('so1')).replayed).toBe(true);
      expect(await w.backend.lines({ companyId: w.companyId, voucherId: first.voucher.id })).toEqual([]);
      expect(await links()).toEqual([]);
    });

    it('an invoice posts Dr customer / Cr sales, takes the goods out of stock and fills the order line — in one step', async () => {
      const so = mustOk(await order('so1')).voucher;
      const stockBefore = await stockOut();
      const inv = mustOk(await invoice('inv1', [await against(so.id, 'a', '12')]));
      expect(inv.voucher.number).toMatch(/^SAL\//);
      const lines = await w.backend.lines({ companyId: w.companyId, voucherId: inv.voucher.id });
      expect(lines.map((l) => [l.ledgerId, l.side, l.amount])).toEqual([
        [partyLedgerId(acme(), 'customer'), 'debit', 30000n], // 12 × 25.00
        [w.uuid('ledger:sales'), 'credit', 30000n],
      ]);
      expect((await stockOut()) - stockBefore).toBe(120000n);
      expect(await links()).toMatchObject([{ voucherId: inv.voucher.id, lineNo: 1, orderId: so.id, orderLineId: 'a', qty: 120000n }]);
      expect(mustOk(await invoice('inv1', [await against(so.id, 'a', '12')])).replayed).toBe(true);
      expect(await delivered(so, 'a')).toBe(120000n);
      const book = orderBookOf(await w.backend.list(w.companyId), await w.backend.load(w.companyId));
      expect(book.state(so.id)).toMatchObject({ status: 'open' });
    });

    it('Round Off: a total that is not a whole rupee rounds the customer’s debit, and an extra line to the Round Off ledger balances it', async () => {
      // 1 × 100.01 = 100.01, rounded down to 100.00 (nearest rupee, half up): the customer owes 100.00, the sales ledger
      // still keeps the exact 100.01, and the 1-paisa gap is posted to Round Off.
      const inv = mustOk(await invoice('inv-round', [{ itemId: bolt(), warehouseId: await main(), qty: '1', rate: '100.01' }]));
      const roundOffLedgerId = (await w.backend.load(w.companyId)).systemLedger('round-off')?.id;
      const lines = await w.backend.lines({ companyId: w.companyId, voucherId: inv.voucher.id });
      expect(lines.map((l) => [l.ledgerId, l.side, l.amount])).toEqual([
        [partyLedgerId(acme(), 'customer'), 'debit', 10000n],
        [w.uuid('ledger:sales'), 'credit', 10001n],
        [roundOffLedgerId, 'debit', 1n],
      ]);
      expect(lines.reduce((sum, l) => sum + (l.side === 'debit' ? l.amount : -l.amount), 0n)).toBe(0n);
    });

    it('over-delivery is refused on that line with the same code everywhere, and nothing is written', async () => {
      const so = mustOk(await order('so1')).voucher;
      mustOk(await invoice('inv1', [await against(so.id, 'a', '10')]));
      const stockBefore = await stockOut();
      const r = await invoice('inv2', [await against(so.id, 'a', '10')]);
      expect(codesOf(r)).toEqual([IssueCode.OverDelivery]);
      if (!r.ok) expect(r.issues[0]).toMatchObject({ path: 'lines.0.qty', message: expect.stringContaining('8 Nos pending, you are delivering 10 Nos') });
      expect(await stockOut()).toBe(stockBefore);
      expect(await delivered(so, 'a')).toBe(100000n);
      expect(await w.backend.get(w.companyId, w.uuid('v:inv2') as never)).toBeUndefined();
      mustOk(await invoice('inv3', [await against(so.id, 'a', '8')])); // exactly what is pending
      expect(codesOf(await invoice('inv4', [await against(so.id, 'a', '1')]))).toEqual([IssueCode.OverDelivery]);
    });

    it('refuses an order line that cannot take the delivery: another customer, another item, no such line, a closed order', async () => {
      const so = mustOk(await order('so1')).voucher;
      const beta = mustOk(await order('so2', { partyId: w.uuid('party:beta'), partyDetails: details(w.uuid('party:beta')) })).voucher;
      const bad = async (lines: unknown[], over: Record<string, unknown> = {}, id = 'x') => codesOf(await invoice(id, lines, over));
      expect(await bad([await against(beta.id, 'a', '1')], {}, 'x1')).toEqual([IssueCode.OrderRefInvalid]);
      expect(await bad([await against(so.id, 'a', '1', sheet())], {}, 'x2')).toEqual([IssueCode.OrderRefInvalid]);
      expect(await bad([await against(so.id, 'nope', '1')], {}, 'x3')).toEqual([IssueCode.OrderRefInvalid]);
      expect(await bad([await against(w.uuid('v:missing'), 'a', '1')], {}, 'x4')).toEqual([IssueCode.OrderRefInvalid]);
      mustOk(await w.backend.alter({ companyId: w.companyId, voucherId: so.id, expectedVersion: 1, draft: { ...(so.content as object), closed: true } }));
      expect(await bad([await against(so.id, 'a', '1')], {}, 'x5')).toEqual([IssueCode.OrderRefInvalid]);
    });

    it('needs a customer with party details, a Sales Accounts ledger and stock in hand', async () => {
      const line = async () => ({ itemId: bolt(), warehouseId: await main(), qty: '1', rate: '5' });
      expect(codesOf(await invoice('c1', [await line()], { partyId: w.uuid('party:steel'), partyDetails: details(w.uuid('party:steel')) }))).toEqual([IssueCode.SalesDocInvalid]);
      expect(codesOf(await invoice('c2', [await line()], { partyDetails: undefined }))).toEqual([IssueCode.PartyDetailsInvalid]);
      expect(codesOf(await invoice('c3', [await line()], { salesLedgerId: w.uuid('ledger:cash') }))).toEqual([IssueCode.SalesDocInvalid]);
      const r = await invoice('c4', [{ ...(await line()), qty: '101' }]);
      expect(codesOf(r)).toEqual([IssueCode.StockNegative]);
      if (!r.ok) expect(r.issues[0]?.path).toBe('lines.0.qty');
    });

    it('cancelling an invoice frees what it filled and returns the goods; an order with deliveries cannot be cancelled', async () => {
      const so = mustOk(await order('so1')).voucher;
      const inv = mustOk(await invoice('inv1', [await against(so.id, 'a', '18'), await against(so.id, 'b', '10.5', sheet(), '120')])).voucher;
      expect(codesOf(await w.backend.cancel({ companyId: w.companyId, voucherId: so.id, expectedVersion: 1 }))).toEqual([IssueCode.OrderHasDeliveries]);
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: inv.id, expectedVersion: 1 }));
      expect(await links()).toEqual([]);
      expect(await stockOut()).toBe(0n);
      expect(await w.backend.lines({ companyId: w.companyId, voucherId: inv.id })).toEqual([]);
      mustOk(await invoice('inv2', [await against(so.id, 'a', '18')])); // the whole line is deliverable again
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: w.uuid('v:inv2') as never, expectedVersion: 1 }));
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: so.id, expectedVersion: 1 }));
    });

    it('altering an invoice replaces its deliveries: it can change its own quantity but not exceed what is pending', async () => {
      const so = mustOk(await order('so1')).voucher;
      const inv = mustOk(await invoice('inv1', [await against(so.id, 'a', '18')])).voucher;
      const alter = async (qty: string) =>
        w.backend.alter({ companyId: w.companyId, voucherId: inv.id, expectedVersion: (await w.backend.get(w.companyId, inv.id))?.version ?? 1, draft: invoiceDraft('inv1', [await against(so.id, 'a', qty)]) });
      expect(codesOf(await alter('19'))).toEqual([IssueCode.OverDelivery]);
      expect((await w.backend.get(w.companyId, inv.id))?.version).toBe(1);
      mustOk(await alter('10'));
      expect(await delivered(so, 'a')).toBe(100000n);
      expect(await stockOut()).toBe(100000n);
      const lines = await w.backend.lines({ companyId: w.companyId, voucherId: inv.id });
      expect(lines.map((l) => l.amount)).toEqual([25000n, 25000n]);
    });

    it('altering an order cannot shrink a line below what was delivered, drop it, or change its item; it can grow and be closed', async () => {
      const so = mustOk(await order('so1')).voucher;
      mustOk(await invoice('inv1', [await against(so.id, 'a', '10')]));
      const a = { id: 'a', itemId: bolt(), qty: '18', rate: '25', dueDate: '2024-05-20' };
      const b = { id: 'b', itemId: sheet(), qty: '10.5', rate: '120', dueDate: '2024-06-10' };
      const alter = async (lines: unknown[], over: Record<string, unknown> = {}) =>
        w.backend.alter({ companyId: w.companyId, voucherId: so.id, expectedVersion: (await w.backend.get(w.companyId, so.id))?.version ?? 1, draft: { ...(so.content as object), lines, ...over } });
      expect(codesOf(await alter([{ ...a, qty: '9' }, b]))).toEqual([IssueCode.OrderHasDeliveries]);
      expect(codesOf(await alter([b]))).toEqual([IssueCode.OrderHasDeliveries]);
      expect(codesOf(await alter([{ ...a, itemId: sheet(), qty: '18' }, b]))).toEqual([IssueCode.OrderHasDeliveries]);
      mustOk(await alter([{ ...a, qty: '25' }, b, { id: 'c', itemId: bolt(), qty: '3', rate: '25', dueDate: '2024-06-30' }]));
      mustOk(await alter([{ ...a, qty: '25' }, b], { closed: true }));
      expect(codesOf(await invoice('inv2', [await against(so.id, 'a', '1')]))).toEqual([IssueCode.OrderRefInvalid]);
    });

    it('several invoices at once: exactly the pending quantity is delivered in total, the rest are refused as over-delivery', async () => {
      const so = mustOk(await order('so1', { lines: [{ id: 'a', itemId: bolt(), qty: '10', rate: '25', dueDate: '2024-05-20' }] })).voucher;
      const results = await Promise.all(Array.from({ length: 6 }, async (_, i) => invoice(`race${i}`, [await against(so.id, 'a', '3')])));
      expect(results.filter((r) => r.ok)).toHaveLength(3); // 3 + 3 + 3 = 9 of 10
      for (const r of results.filter((x) => !x.ok)) expect(codesOf(r)).toEqual([IssueCode.OverDelivery]);
      expect(await delivered(so, 'a')).toBe(90000n);
      expect(await stockOut()).toBe(90000n);
    });

    it('refuses documents with no lines and an unknown customer', async () => {
      expect(codesOf(await order('so1', { lines: [] }))).toEqual([IssueCode.TooFewLines]);
      expect(codesOf(await order('so2', { partyId: w.uuid('party:nobody'), partyDetails: undefined }))).toContain(IssueCode.SalesDocInvalid);
      expect(codesOf(await invoice('i1', []))).toEqual([IssueCode.TooFewLines]);
    });
  });
}
