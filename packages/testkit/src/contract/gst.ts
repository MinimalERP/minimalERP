import { IssueCode, deriveGstHeader, gstinCheckChar, openBills, partyLedgerId } from '@minimalerp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { codesOf, mustOk } from '../helpers';
import type { MakeMasterWorld, MasterWorld } from '../masterWorld';

/**
 * Phase 9 on every backend: GST on Sales and Purchase invoices (intra-state CGST + SGST, inter-state IGST, posted to the system ledgers found by
 * reserved key), a bill that is the invoice total WITH tax, GST refused while the company does not charge it, and invoice-wise TDS on a Receipt
 * (Dr Bank, Dr TDS Receivable, Cr Customer; the bill settled in full; reversed by cancelling). Same rules, same figures, memory and PostgreSQL alike.
 */
export function gstContract(label: string, makeWorld: MakeMasterWorld): void {
  describe(`${label}: GST and TDS`, () => {
    let w: MasterWorld;
    beforeEach(async () => {
      w = await makeWorld();
      const create = async (kind: string, id: string, data: unknown) =>
        mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
      await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished', hsn: '7318' });
      await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'], stateCode: '27' });
      await create('party', w.uuid('party:delhi'), { name: 'Delhi Traders', roles: ['customer'], stateCode: '07' });
      await create('party', w.uuid('party:steel'), { name: 'Steel Co', roles: ['vendor'], stateCode: '27' });
      await create('ledger', w.uuid('ledger:sales'), { name: 'Domestic Sales', groupId: w.uuid('group:sales-accounts') });
      await create('ledger', w.uuid('ledger:purchases'), { name: 'Purchases', groupId: w.uuid('group:purchase-accounts') });
      const main = (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
      mustOk(
        await w.backend.post({
          companyId: w.companyId,
          draft: { id: w.uuid('v:open'), voucherTypeId: w.uuid('type:stockOpening'), date: '2024-04-01', itemId: w.uuid('item:bolt'), warehouseId: main, qty: '1000', rate: '40' },
        }),
      );
    });

    const company = async () => (await w.backend.load(w.companyId)).company;
    const chargeGst = async () => {
      const c = await company();
      const id = `27AABCD1234E1Z`.slice(0, 14);
      const full = id + gstinCheckChar(id);
      mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'alter', kind: 'company', id: w.companyId, data: { name: c.name, gstin: full, chargeGst: 'yes' } } }));
    };
    const main = async () => (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
    const post = (draft: unknown) => w.backend.post({ companyId: w.companyId, draft });
    const details = (p: string) => ({ partyId: w.uuid(`party:${p}`), mailingName: 'X' });
    const lines = async (id: string) =>
      (await w.backend.lines({ companyId: w.companyId, voucherId: id as never })).map((l) => [l.ledgerId, l.side, l.amount] as const);

    const sale = async (id: string, party: string, qty = '10', rate = '100', gstRate: string | null = '18') => {
      const masters = await w.backend.load(w.companyId);
      const ls = [{ itemId: w.uuid('item:bolt'), warehouseId: await main(), qty, rate, ...(gstRate === null ? {} : { gstRate }), hsn: '7318' }];
      const partyDetails = details(party);
      const gst = deriveGstHeader(masters, 'sales', { partyId: w.uuid(`party:${party}`), partyDetails, lines: ls });
      return {
        id: w.uuid(`v:${id}`),
        voucherTypeId: w.uuid('type:sales'),
        date: '2024-05-12',
        partyId: w.uuid(`party:${party}`),
        partyDetails,
        salesLedgerId: w.uuid('ledger:sales'),
        dueDate: '2024-06-11',
        lines: ls,
        ...(gst ? { gst } : {}),
      };
    };
    const systemLedger = async (key: string) => (await w.backend.load(w.companyId)).ledgers.find((l) => l.reservedKey === key)?.id as string;

    it('every company has the system ledgers, found by reserved key', async () => {
      for (const key of ['gst-output-cgst', 'gst-output-sgst', 'gst-output-igst', 'gst-input-cgst', 'gst-input-sgst', 'gst-input-igst', 'tds-receivable']) {
        expect(await systemLedger(key), key).toBeDefined();
      }
    });

    it('GST is off by default: a rated line is refused, an unrated invoice is exactly what it was', async () => {
      const refused = await post(await sale('s0', 'acme'));
      expect(codesOf(refused)).toEqual([IssueCode.GstInvalid]);
      const plain = mustOk(await post(await sale('s1', 'acme', '10', '100', null)));
      expect((await lines(plain.voucher.id)).map((l) => l[2])).toEqual([100000n, 100000n]);
    });

    it('a sale within the state: CGST + SGST to the Output ledgers; the customer owes the total; the bill is the total with tax', async () => {
      await chargeGst();
      const v = mustOk(await post(await sale('s1', 'acme'))).voucher; // 10 × 100 @ 18%
      expect(await lines(v.id)).toEqual([
        [partyLedgerId(w.uuid('party:acme') as never, 'customer'), 'debit', 118000n],
        [w.uuid('ledger:sales'), 'credit', 100000n],
        [await systemLedger('gst-output-cgst'), 'credit', 9000n],
        [await systemLedger('gst-output-sgst'), 'credit', 9000n],
      ]);
      const bills = openBills(await w.backend.list(w.companyId), await w.backend.load(w.companyId), partyLedgerId(w.uuid('party:acme') as never, 'customer') as never);
      expect(bills.map((b) => [b.ref, b.pending])).toEqual([[v.number, 118000n]]);
    });

    it('a sale between states: IGST alone', async () => {
      await chargeGst();
      const v = mustOk(await post(await sale('s1', 'delhi'))).voucher;
      expect((await lines(v.id)).map((l) => l[2])).toEqual([118000n, 100000n, 18000n]);
      expect((await lines(v.id))[2]?.[0]).toBe(await systemLedger('gst-output-igst'));
    });

    it('tax that is not what the lines come to is refused, and nothing is written', async () => {
      await chargeGst();
      const draft = (await sale('s1', 'acme')) as { gst: Record<string, unknown> };
      const r = await post({ ...draft, gst: { ...draft.gst, cgst: '80.00' } });
      expect(codesOf(r)).toEqual([IssueCode.GstInvalid]);
      expect(await w.backend.get(w.companyId, w.uuid('v:s1') as never)).toBeUndefined();
    });

    it('a purchase: Input tax is debited, the supplier is owed the total, stock is at the items’ value', async () => {
      await chargeGst();
      const masters = await w.backend.load(w.companyId);
      const ls = [{ itemId: w.uuid('item:bolt'), warehouseId: await main(), qty: '100', rate: '10', gstRate: '18', hsn: '7318' }];
      const partyDetails = details('steel');
      const gst = deriveGstHeader(masters, 'purchase', { partyId: w.uuid('party:steel'), partyDetails, lines: ls });
      const p = mustOk(
        await post({
          id: w.uuid('v:p1'), voucherTypeId: w.uuid('type:purchase'), date: '2024-05-12', partyId: w.uuid('party:steel'), partyDetails,
          purchaseLedgerId: w.uuid('ledger:purchases'), billNo: 'SS/1', dueDate: '2024-06-11', lines: ls, gst,
        }),
      ).voucher;
      expect(await lines(p.id)).toEqual([
        [w.uuid('ledger:purchases'), 'debit', 100000n],
        [await systemLedger('gst-input-cgst'), 'debit', 9000n],
        [await systemLedger('gst-input-sgst'), 'debit', 9000n],
        [partyLedgerId(w.uuid('party:steel') as never, 'vendor'), 'credit', 118000n],
      ]);
      const moves = await w.backend.stockMovements({ companyId: w.companyId });
      expect(moves.filter((m) => m.voucherId === p.id).map((m) => m.value)).toEqual([100000n]); // 1,000.00: the tax is not part of the cost
      const bills = openBills(await w.backend.list(w.companyId), await w.backend.load(w.companyId), partyLedgerId(w.uuid('party:steel') as never, 'vendor') as never);
      expect(bills.map((b) => [b.ref, b.pending])).toEqual([['SS/1', 118000n]]);
    });

    describe('TDS on a receipt', () => {
      const receipt = (id: string, amount: string, tds?: string, ref?: string) => ({
        id: w.uuid(`v:${id}`),
        voucherTypeId: w.uuid('type:receipt'),
        date: '2024-05-20',
        accountLedgerId: w.uuid('ledger:cash'),
        lines: [
          {
            ledgerId: partyLedgerId(w.uuid('party:acme') as never, 'customer'),
            amount,
            allocations: [{ kind: 'against', ref: ref ?? 'INV', amount, ...(tds ? { tds } : {}) }],
          },
        ],
      });
      const invoice = async () => {
        const s = mustOk(await post(await sale('s1', 'acme', '1000', '100', null))); // 1,00,000.00, no GST
        return s.voucher;
      };

      it('₹100,000 with ₹2,000 TDS: Dr cash 98,000, Dr TDS Receivable 2,000, Cr customer 100,000 — the bill settles in full', async () => {
        const inv = await invoice();
        const v = mustOk(await post(receipt('r1', '100000', '2000', inv.number))).voucher;
        expect(await lines(v.id)).toEqual([
          [w.uuid('ledger:cash'), 'debit', 9800000n],
          [await systemLedger('tds-receivable'), 'debit', 200000n],
          [partyLedgerId(w.uuid('party:acme') as never, 'customer'), 'credit', 10000000n],
        ]);
        const bills = openBills(await w.backend.list(w.companyId), await w.backend.load(w.companyId), partyLedgerId(w.uuid('party:acme') as never, 'customer') as never);
        expect(bills).toEqual([]);
      });

      it('TDS cannot exceed the bill it comes off; a receipt without TDS is as before', async () => {
        const inv = await invoice();
        expect(codesOf(await post(receipt('r0', '100000', '100001', inv.number)))).toContain(IssueCode.TdsInvalid);
        const v = mustOk(await post(receipt('r1', '100000', undefined, inv.number))).voucher;
        expect((await lines(v.id)).map((l) => l[2])).toEqual([10000000n, 10000000n]);
      });

      it('altering the receipt re-posts the TDS; cancelling reverses it and the bill is open again', async () => {
        const inv = await invoice();
        const v = mustOk(await post(receipt('r1', '100000', '2000', inv.number))).voucher;
        const altered = mustOk(await w.backend.alter({ companyId: w.companyId, voucherId: v.id, expectedVersion: 1, draft: receipt('r1', '100000', '3000', inv.number) })).voucher;
        expect((await lines(v.id)).map((l) => l[2])).toEqual([9700000n, 300000n, 10000000n]);
        mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: altered.id, expectedVersion: altered.version }));
        expect(await lines(v.id)).toEqual([]);
        const bills = openBills(await w.backend.list(w.companyId), await w.backend.load(w.companyId), partyLedgerId(w.uuid('party:acme') as never, 'customer') as never);
        expect(bills.map((b) => b.pending)).toEqual([10000000n]);
      });
    });
  });
}
