import { IssueCode, type OrderLink, type Voucher, openBills, orderBookOf, partyLedgerId } from '@minimalerp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { codesOf, mustOk } from '../helpers';
import type { MakeMasterWorld, MasterWorld } from '../masterWorld';

/**
 * Phase 8 on every backend: a Purchase Order is a document that posts nothing; a Purchase Invoice posts Dr purchases / Cr supplier, brings the
 * goods IN to stock at the line's rate, raises a bill named by the supplier's invoice number (used once per supplier) and fills the purchase-order
 * lines it names, all in one step; receiving more than is pending is refused — however many invoices arrive at once — and cancelling or altering
 * is checked against what was received and what was since sold. Same rules, same codes, memory and PostgreSQL alike.
 */
export function purchaseContract(label: string, makeWorld: MakeMasterWorld): void {
  describe(`${label}: purchase orders and invoices`, () => {
    let w: MasterWorld;
    beforeEach(async () => {
      w = await makeWorld();
      const create = async (kind: string, id: string, data: unknown) =>
        mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
      await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
      await create('stockItem', w.uuid('item:sheet'), { name: 'Sheet', unitId: w.uuid('unit:Kg'), itemType: 'raw' });
      await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
      await create('party', w.uuid('party:steel'), { name: 'Steel Supplier', roles: ['vendor'], creditDays: 30 });
      await create('party', w.uuid('party:other'), { name: 'Other Supplier', roles: ['vendor'] });
      await create('ledger', w.uuid('ledger:sales'), { name: 'Domestic Sales', groupId: w.uuid('group:sales-accounts') });
      await create('ledger', w.uuid('ledger:purchases'), { name: 'Purchases', groupId: w.uuid('group:purchase-accounts') });
    });

    const bolt = () => w.uuid('item:bolt');
    const sheet = () => w.uuid('item:sheet');
    const steel = () => w.uuid('party:steel');
    const other = () => w.uuid('party:other');
    const main = async () => (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
    const post = (draft: unknown) => w.backend.post({ companyId: w.companyId, draft });
    const details = (party: string) => ({ partyId: party, mailingName: 'X' });
    const supplierLedger = (party = steel()) => partyLedgerId(party, 'vendor');

    const order = (id: string, over: Record<string, unknown> = {}) =>
      post({
        id: w.uuid(`v:${id}`),
        voucherTypeId: w.uuid('type:purchaseOrder'),
        date: '2024-05-01',
        partyId: steel(),
        partyDetails: details(steel()),
        reference: 'Q-55',
        lines: [
          { id: 'a', itemId: bolt(), qty: '100', rate: '10', dueDate: '2024-05-20' },
          { id: 'b', itemId: sheet(), qty: '50.5', rate: '80', dueDate: '2024-06-10' },
        ],
        ...over,
      });

    const receive = async (orderId: string, lineId: string, qty: string, item = bolt(), rate = '10') => ({
      itemId: item,
      warehouseId: await main(),
      qty,
      rate,
      orderRef: { orderId, lineId },
    });
    const own = async (qty: string, item = bolt(), rate = '10') => ({ itemId: item, warehouseId: await main(), qty, rate });

    const invoiceDraft = (id: string, lines: unknown[], over: Record<string, unknown> = {}) => ({
      id: w.uuid(`v:${id}`),
      voucherTypeId: w.uuid('type:purchase'),
      date: '2024-05-12',
      partyId: steel(),
      partyDetails: details(steel()),
      purchaseLedgerId: w.uuid('ledger:purchases'),
      billNo: `SS/${id}`,
      dueDate: '2024-06-11',
      lines,
      ...over,
    });
    const invoice = (id: string, lines: unknown[], over: Record<string, unknown> = {}) => post(invoiceDraft(id, lines, over));

    const links = () => w.backend.orderLinks({ companyId: w.companyId });
    const received = async (order: Voucher, lineId: string) =>
      (await links()).filter((l: OrderLink) => l.orderId === order.id && l.orderLineId === lineId).reduce((s, l) => s + l.qty, 0n);
    const stockIn = async () =>
      (await w.backend.stockMovements({ companyId: w.companyId })).filter((m) => m.direction === 'in').reduce((s, m) => s + m.qty, 0n);
    const bills = async (party = steel()) => openBills(await w.backend.list(w.companyId), await w.backend.load(w.companyId), supplierLedger(party) as never);

    it('a purchase order posts no journal lines, no stock and no links; posting it twice is a replay', async () => {
      const first = mustOk(await order('po1'));
      expect(first.replayed).toBe(false);
      expect(first.voucher.number).toMatch(/^PO\//);
      expect(first.plan).toMatchObject({ journal: [], stock: [], links: [] });
      expect(mustOk(await order('po1')).replayed).toBe(true);
      expect(await links()).toEqual([]);
      expect(await stockIn()).toBe(0n);
    });

    it('an invoice posts Dr purchases / Cr the supplier, brings the goods IN at the rate, raises the supplier’s bill and fills the order line — in one step', async () => {
      const po = mustOk(await order('po1')).voucher;
      const inv = mustOk(await invoice('inv1', [await receive(po.id, 'a', '60')]));
      expect(inv.voucher.number).toMatch(/^PUR\//);
      const lines = await w.backend.lines({ companyId: w.companyId, voucherId: inv.voucher.id });
      expect(lines.map((l) => [l.ledgerId, l.side, l.amount])).toEqual([
        [w.uuid('ledger:purchases'), 'debit', 60000n], // 60 × 10.00
        [supplierLedger(), 'credit', 60000n],
      ]);
      const moves = await w.backend.stockMovements({ companyId: w.companyId });
      expect(moves.map((m) => [m.direction, m.qty, m.value])).toEqual([['in', 600000n, 60000n]]);
      expect(await links()).toMatchObject([{ voucherId: inv.voucher.id, lineNo: 1, orderId: po.id, orderLineId: 'a', qty: 600000n }]);
      expect((await bills()).map((b) => [b.ref, b.side, b.pending, b.dueDate])).toEqual([['SS/inv1', 'credit', 60000n, '2024-06-11']]);
      expect(mustOk(await invoice('inv1', [await receive(po.id, 'a', '60')])).replayed).toBe(true);
      const book = orderBookOf(await w.backend.list(w.companyId), await w.backend.load(w.companyId));
      expect(book.state(po.id)).toMatchObject({ status: 'open' });
      expect(book.onOrderByItem().get(bolt() as never)).toBe(400000n);
      expect(book.committedByItem().size).toBe(0);
    });

    it('receiving more than is pending is refused on that line with the same code everywhere, and nothing is written', async () => {
      const po = mustOk(await order('po1')).voucher;
      mustOk(await invoice('inv1', [await receive(po.id, 'a', '60')]));
      const stockBefore = await stockIn();
      const r = await invoice('inv2', [await receive(po.id, 'a', '50')]);
      expect(codesOf(r)).toEqual([IssueCode.OverDelivery]);
      if (!r.ok) expect(r.issues[0]).toMatchObject({ path: 'lines.0.qty', message: expect.stringContaining('40 Nos pending, you are receiving 50 Nos') });
      expect(await stockIn()).toBe(stockBefore);
      expect(await received(po, 'a')).toBe(600000n);
      expect(await w.backend.get(w.companyId, w.uuid('v:inv2') as never)).toBeUndefined();
      mustOk(await invoice('inv3', [await receive(po.id, 'a', '40')])); // exactly what is pending
      expect(codesOf(await invoice('inv4', [await receive(po.id, 'a', '1')]))).toEqual([IssueCode.OverDelivery]);
    });

    it('refuses an order line that cannot take the receipt: another supplier, another item, no such line, a closed order, a sales order', async () => {
      const po = mustOk(await order('po1')).voucher;
      const bad = async (lines: unknown[], id: string, over: Record<string, unknown> = {}) => codesOf(await invoice(id, lines, over));
      expect(await bad([await receive(po.id, 'a', '1')], 'x1', { partyId: other(), partyDetails: details(other()) })).toEqual([IssueCode.OrderRefInvalid]);
      expect(await bad([await receive(po.id, 'a', '1', sheet(), '80')], 'x2')).toEqual([IssueCode.OrderRefInvalid]);
      expect(await bad([await receive(po.id, 'nope', '1')], 'x3')).toEqual([IssueCode.OrderRefInvalid]);
      expect(await bad([await receive(w.uuid('v:missing'), 'a', '1')], 'x4')).toEqual([IssueCode.OrderRefInvalid]);
      const so = mustOk(
        await post({
          id: w.uuid('v:so1'),
          voucherTypeId: w.uuid('type:salesOrder'),
          date: '2024-05-01',
          partyId: w.uuid('party:acme'),
          partyDetails: details(w.uuid('party:acme')),
          lines: [{ id: 'a', itemId: bolt(), qty: '5', rate: '25', dueDate: '2024-05-20' }],
        }),
      ).voucher;
      expect(await bad([await receive(so.id, 'a', '1')], 'x5')).toEqual([IssueCode.OrderRefInvalid]);
      mustOk(await w.backend.alter({ companyId: w.companyId, voucherId: po.id, expectedVersion: 1, draft: { ...(po.content as object), closed: true } }));
      expect(await bad([await receive(po.id, 'a', '1')], 'x6')).toEqual([IssueCode.OrderRefInvalid]);
    });

    it('needs a vendor with party details, a Purchase Accounts ledger and the supplier’s invoice number', async () => {
      expect(codesOf(await invoice('c1', [await own('1')], { partyId: w.uuid('party:acme'), partyDetails: details(w.uuid('party:acme')) }))).toEqual([IssueCode.SalesDocInvalid]);
      expect(codesOf(await invoice('c2', [await own('1')], { partyDetails: undefined }))).toEqual([IssueCode.PartyDetailsInvalid]);
      expect(codesOf(await invoice('c3', [await own('1')], { purchaseLedgerId: w.uuid('ledger:sales') }))).toEqual([IssueCode.SalesDocInvalid]);
      expect(codesOf(await invoice('c4', [await own('1')], { billNo: '  ' }))).toContain(IssueCode.SchemaInvalid);
      expect(codesOf(await invoice('c5', []))).toEqual([IssueCode.TooFewLines]);
      expect(codesOf(await order('po9', { partyId: w.uuid('party:acme'), partyDetails: details(w.uuid('party:acme')) }))).toEqual([IssueCode.SalesDocInvalid]);
    });

    it('a supplier’s invoice number is used once per supplier: the same number from another supplier is fine, a cancelled invoice frees its number', async () => {
      const first = mustOk(await invoice('inv1', [await own('10')], { billNo: 'SS/889' })).voucher;
      const again = await invoice('inv2', [await own('5')], { billNo: 'SS/889' });
      expect(codesOf(again)).toEqual([IssueCode.BillRefInUse]);
      expect(await w.backend.get(w.companyId, w.uuid('v:inv2') as never)).toBeUndefined();
      mustOk(await invoice('inv3', [await own('5')], { billNo: 'SS/889', partyId: other(), partyDetails: details(other()) }));
      // altering an invoice keeps its own number
      mustOk(await w.backend.alter({ companyId: w.companyId, voucherId: first.id, expectedVersion: 1, draft: invoiceDraft('inv1', [await own('12')], { billNo: 'SS/889' }) }));
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: first.id, expectedVersion: 2 }));
      mustOk(await invoice('inv4', [await own('5')], { billNo: 'SS/889' }));
    });

    it('several invoices with the same supplier invoice number at once: exactly one is posted, the rest are refused as BILL_REF_IN_USE', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, async (_, i) => invoice(`same${i}`, [await own('2')], { billNo: 'DUP-1' })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((x) => !x.ok)) expect(codesOf(r)).toEqual([IssueCode.BillRefInUse]);
      expect((await bills()).map((b) => b.ref)).toEqual(['DUP-1']);
    });

    it('several invoices at once: exactly the pending quantity is received in total, the rest are refused as over-delivery', async () => {
      const po = mustOk(await order('po1', { lines: [{ id: 'a', itemId: bolt(), qty: '10', rate: '10', dueDate: '2024-05-20' }] })).voucher;
      const results = await Promise.all(Array.from({ length: 6 }, async (_, i) => invoice(`race${i}`, [await receive(po.id, 'a', '3')])));
      expect(results.filter((r) => r.ok)).toHaveLength(3); // 3 + 3 + 3 = 9 of 10
      for (const r of results.filter((x) => !x.ok)) expect(codesOf(r)).toEqual([IssueCode.OverDelivery]);
      expect(await received(po, 'a')).toBe(90000n);
      expect(await stockIn()).toBe(90000n);
    });

    it('cancelling an invoice frees what it filled and takes the goods and the bill away; an order with receipts cannot be cancelled', async () => {
      const po = mustOk(await order('po1')).voucher;
      const inv = mustOk(await invoice('inv1', [await receive(po.id, 'a', '100'), await receive(po.id, 'b', '50.5', sheet(), '80')])).voucher;
      expect(codesOf(await w.backend.cancel({ companyId: w.companyId, voucherId: po.id, expectedVersion: 1 }))).toEqual([IssueCode.OrderHasDeliveries]);
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: inv.id, expectedVersion: 1 }));
      expect(await links()).toEqual([]);
      expect(await stockIn()).toBe(0n);
      expect(await bills()).toEqual([]);
      expect(await w.backend.lines({ companyId: w.companyId, voucherId: inv.id })).toEqual([]);
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: po.id, expectedVersion: 1 }));
    });

    it('goods that came in and were sold cannot be un-received: cancelling or shrinking the purchase is refused', async () => {
      const inv = mustOk(await invoice('inv1', [await own('100')])).voucher;
      mustOk(
        await post({
          id: w.uuid('v:sal1'),
          voucherTypeId: w.uuid('type:sales'),
          date: '2024-06-01',
          partyId: w.uuid('party:acme'),
          partyDetails: details(w.uuid('party:acme')),
          salesLedgerId: w.uuid('ledger:sales'),
          dueDate: '2024-07-01',
          lines: [{ itemId: bolt(), warehouseId: await main(), qty: '80', rate: '25' }],
        }),
      );
      expect(codesOf(await w.backend.cancel({ companyId: w.companyId, voucherId: inv.id, expectedVersion: 1 }))).toEqual([IssueCode.StockNegative]);
      const shrink = await w.backend.alter({ companyId: w.companyId, voucherId: inv.id, expectedVersion: 1, draft: invoiceDraft('inv1', [await own('50')]) });
      expect(codesOf(shrink)).toContain(IssueCode.StockNegative);
      mustOk(await w.backend.alter({ companyId: w.companyId, voucherId: inv.id, expectedVersion: 1, draft: invoiceDraft('inv1', [await own('90')]) }));
    });

    it('altering a purchase order cannot shrink a line below what was received, drop it, or change its item; it can grow and be closed', async () => {
      const po = mustOk(await order('po1')).voucher;
      mustOk(await invoice('inv1', [await receive(po.id, 'a', '60')]));
      const a = { id: 'a', itemId: bolt(), qty: '100', rate: '10', dueDate: '2024-05-20' };
      const b = { id: 'b', itemId: sheet(), qty: '50.5', rate: '80', dueDate: '2024-06-10' };
      const alter = async (lines: unknown[], over: Record<string, unknown> = {}) =>
        w.backend.alter({ companyId: w.companyId, voucherId: po.id, expectedVersion: (await w.backend.get(w.companyId, po.id))?.version ?? 1, draft: { ...(po.content as object), lines, ...over } });
      expect(codesOf(await alter([{ ...a, qty: '50' }, b]))).toEqual([IssueCode.OrderHasDeliveries]);
      expect(codesOf(await alter([b]))).toEqual([IssueCode.OrderHasDeliveries]);
      expect(codesOf(await alter([{ ...a, itemId: sheet() }, b]))).toEqual([IssueCode.OrderHasDeliveries]);
      mustOk(await alter([{ ...a, qty: '150' }, b]));
      mustOk(await alter([{ ...a, qty: '150' }, b], { closed: true }));
    });
  });
}
