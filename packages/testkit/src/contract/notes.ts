import { IssueCode, deriveGstHeader, gstInvoices, gstTotals, gstinCheckChar, openBills, partyLedgerId } from '@minimalerp/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { codesOf, mustOk } from '../helpers';
import type { MakeMasterWorld, MasterWorld } from '../masterWorld';

/**
 * Credit and Debit Notes on every backend (ADR-0026): a Credit Note is a Sales Invoice turned round (Dr sales and Output GST / Cr the customer,
 * the goods back IN at the book's cost), a Debit Note a Purchase Invoice turned round (Dr the supplier / Cr purchases and Input GST, the goods
 * OUT). The part of a note set against an invoice settles that invoice's bill; the rest is a bill of the note's own, on the other side of the
 * party's ledger, that a refund then settles. Same rules, same figures, memory and PostgreSQL alike.
 */
type NoteLine = { qty: string; rate: string; gstRate?: string; description?: string };

export function notesContract(label: string, makeWorld: MakeMasterWorld): void {
  describe(`${label}: credit and debit notes`, () => {
    let w: MasterWorld;
    beforeEach(async () => {
      w = await makeWorld();
      const create = async (kind: string, id: string, data: unknown) =>
        mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
      await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished', hsn: '7318' });
      await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'], stateCode: '27' });
      await create('party', w.uuid('party:steel'), { name: 'Steel Co', roles: ['vendor'], stateCode: '27' });
      await create('ledger', w.uuid('ledger:sales'), { name: 'Domestic Sales', groupId: w.uuid('group:sales-accounts') });
      await create('ledger', w.uuid('ledger:purchases'), { name: 'Purchases', groupId: w.uuid('group:purchase-accounts') });
      mustOk(await post({ id: w.uuid('v:open'), voucherTypeId: w.uuid('type:stockOpening'), date: '2024-04-01', itemId: bolt(), warehouseId: await main(), qty: '1000', rate: '40' }));
    });

    const bolt = () => w.uuid('item:bolt');
    const acme = () => w.uuid('party:acme');
    const steel = () => w.uuid('party:steel');
    const main = async () => (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
    const post = (draft: unknown) => w.backend.post({ companyId: w.companyId, draft });
    const details = (party: string) => ({ partyId: party, mailingName: 'X' });
    const customerLedger = () => partyLedgerId(acme(), 'customer');
    const supplierLedger = () => partyLedgerId(steel(), 'vendor');
    const journal = async (id: string) => (await w.backend.lines({ companyId: w.companyId, voucherId: id as never })).map((l) => [l.ledgerId, l.side, l.amount]);
    const moves = async (id: string) => (await w.backend.stockMovements({ companyId: w.companyId })).filter((m) => m.voucherId === id).map((m) => [m.direction, m.qty, m.value]);
    const bills = async (ledger: string) =>
      openBills(await w.backend.list(w.companyId), await w.backend.load(w.companyId), ledger as never).map((b) => [b.ref, b.side, b.pending]);
    const item = async (qty: string, rate: string, extra: Record<string, unknown> = {}) => ({ itemId: bolt(), warehouseId: await main(), qty, rate, ...extra });
    const withGst = async (side: 'sales' | 'purchase', partyId: string, lines: NoteLine[]) => {
      const gst = deriveGstHeader(await w.backend.load(w.companyId), side, { partyId, partyDetails: details(partyId), lines });
      return gst ? { gst } : {};
    };

    const sale = async (id: string, lines: NoteLine[]) =>
      mustOk(
        await post({
          id: w.uuid(`v:${id}`), voucherTypeId: w.uuid('type:sales'), date: '2024-05-12', partyId: acme(), partyDetails: details(acme()),
          salesLedgerId: w.uuid('ledger:sales'), dueDate: '2024-06-11', lines, ...(await withGst('sales', acme(), lines)),
        }),
      ).voucher;
    const purchase = async (id: string, lines: NoteLine[]) =>
      mustOk(
        await post({
          id: w.uuid(`v:${id}`), voucherTypeId: w.uuid('type:purchase'), date: '2024-05-12', partyId: steel(), partyDetails: details(steel()),
          purchaseLedgerId: w.uuid('ledger:purchases'), billNo: `SS/${id}`, dueDate: '2024-06-11', lines, ...(await withGst('purchase', steel(), lines)),
        }),
      ).voucher;
    const creditNote = async (id: string, lines: NoteLine[], over: Record<string, unknown> = {}) => ({
      id: w.uuid(`v:${id}`), voucherTypeId: w.uuid('type:creditNote'), date: '2024-05-20', partyId: acme(), partyDetails: details(acme()),
      salesLedgerId: w.uuid('ledger:sales'), lines, ...(await withGst('sales', acme(), lines)), ...over,
    });
    const debitNote = async (id: string, lines: NoteLine[], over: Record<string, unknown> = {}) => ({
      id: w.uuid(`v:${id}`), voucherTypeId: w.uuid('type:debitNote'), date: '2024-05-20', partyId: steel(), partyDetails: details(steel()),
      purchaseLedgerId: w.uuid('ledger:purchases'), lines, ...(await withGst('purchase', steel(), lines)), ...over,
    });
    const chargeGst = async () => {
      const c = (await w.backend.load(w.companyId)).company;
      const id = '27AABCD1234E1Z';
      mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'alter', kind: 'company', id: w.companyId, data: { name: c.name, gstin: id + gstinCheckChar(id), chargeGst: 'yes' } } }));
    };
    const systemLedger = async (key: string) => (await w.backend.load(w.companyId)).ledgers.find((l) => l.reservedKey === key)?.id as string;

    it('a credit note set against its invoice reverses the sale, brings the goods back at cost and takes its amount off the invoice’s bill', async () => {
      const inv = await sale('s1', [await item('10', '100')]);
      const note = mustOk(await post(await creditNote('cn1', [await item('4', '100')], { invoiceRef: inv.number, against: '400.00' })));
      expect(note.voucher.number).toMatch(/^CN\//);
      expect(await journal(note.voucher.id)).toEqual([
        [customerLedger(), 'credit', 40000n],
        [w.uuid('ledger:sales'), 'debit', 40000n],
      ]);
      // 1000 at 40.00, 10 sold: the 4 come back at the 40.00 the book holds them at, not at the 100.00 they were sold for
      expect(await moves(note.voucher.id)).toEqual([['in', 40000n, 16000n]]);
      expect(await bills(customerLedger())).toEqual([[inv.number, 'debit', 60000n]]);
      expect(mustOk(await post(await creditNote('cn1', [await item('4', '100')], { invoiceRef: inv.number, against: '400.00' }))).replayed).toBe(true);
    });

    it('what is not set against an invoice is a credit of the note’s own, which a refund settles', async () => {
      const inv = await sale('s1', [await item('10', '100')]);
      // the customer has paid in full; then 3 come back
      mustOk(
        await post({
          id: w.uuid('v:rec'), voucherTypeId: w.uuid('type:receipt'), date: '2024-05-15', accountLedgerId: w.uuid('ledger:cash'),
          lines: [{ ledgerId: customerLedger(), amount: '1000.00', allocations: [{ kind: 'against', ref: inv.number, amount: '1000.00' }] }],
        }),
      );
      const note = mustOk(await post(await creditNote('cn1', [await item('3', '100')], { invoiceRef: inv.number }))).voucher;
      expect(await bills(customerLedger())).toEqual([[note.number, 'credit', 30000n]]);
      mustOk(
        await post({
          id: w.uuid('v:refund'), voucherTypeId: w.uuid('type:payment'), date: '2024-05-22', accountLedgerId: w.uuid('ledger:cash'),
          lines: [{ ledgerId: customerLedger(), amount: '300.00', allocations: [{ kind: 'against', ref: note.number, amount: '300.00' }] }],
        }),
      );
      expect(await bills(customerLedger())).toEqual([]);
    });

    it('a note partly set against an invoice leaves the rest as its own credit; cancelling it gives the invoice its bill back', async () => {
      const inv = await sale('s1', [await item('2', '100')]);
      const note = mustOk(await post(await creditNote('cn1', [await item('2', '100'), { description: 'Rate difference', qty: '1', rate: '50' }], { invoiceRef: inv.number, against: '200.00' }))).voucher;
      // the written line moves no stock: only the 2 bolts come back
      expect(await moves(note.id)).toEqual([['in', 20000n, 8000n]]);
      expect(await bills(customerLedger())).toEqual([[note.number, 'credit', 5000n]]);
      mustOk(await w.backend.cancel({ companyId: w.companyId, voucherId: note.id as never, expectedVersion: note.version }));
      expect(await bills(customerLedger())).toEqual([[inv.number, 'debit', 20000n]]);
      expect(await moves(note.id)).toEqual([]);
    });

    it('a note cannot set more against an invoice than it comes to, nor set an amount against no invoice, nor fill an order', async () => {
      const inv = await sale('s1', [await item('10', '100')]);
      expect(codesOf(await post(await creditNote('cn1', [await item('1', '100')], { invoiceRef: inv.number, against: '100.01' })))).toEqual([IssueCode.AllocationInvalid]);
      expect(codesOf(await post(await creditNote('cn2', [await item('1', '100')], { against: '100.00' })))).toEqual([IssueCode.AllocationInvalid]);
      expect(codesOf(await post(await creditNote('cn3', [await item('1', '100', { orderRef: { orderId: w.uuid('v:none'), lineId: 'a' } })])))).toEqual([IssueCode.OrderRefInvalid]);
      expect(codesOf(await post(await creditNote('cn4', [])))).toContain(IssueCode.TooFewLines);
      expect(await bills(customerLedger())).toEqual([[inv.number, 'debit', 100000n]]);
    });

    it('a debit note set against the supplier’s bill reverses the purchase, sends the goods out and takes its amount off the bill', async () => {
      await purchase('p1', [await item('100', '10')]);
      const note = mustOk(await post(await debitNote('dn1', [await item('30', '10')], { invoiceRef: 'SS/p1', against: '300.00' })));
      expect(note.voucher.number).toMatch(/^DN\//);
      expect(await journal(note.voucher.id)).toEqual([
        [w.uuid('ledger:purchases'), 'credit', 30000n],
        [supplierLedger(), 'debit', 30000n],
      ]);
      expect(await moves(note.voucher.id)).toEqual([['out', 300000n, undefined]]);
      expect(await bills(supplierLedger())).toEqual([['SS/p1', 'credit', 70000n]]);
    });

    it('a debit note cannot send back more than there is, and one against nothing stands as a debit the supplier owes', async () => {
      await purchase('p1', [await item('100', '10')]);
      expect(codesOf(await post(await debitNote('dn1', [await item('5000', '10')])))).toEqual([IssueCode.StockNegative]);
      const note = mustOk(await post(await debitNote('dn2', [{ description: 'Short supply claim', qty: '1', rate: '120' }]))).voucher;
      expect(await moves(note.id)).toEqual([]);
      expect(await bills(supplierLedger())).toEqual([
        ['SS/p1', 'credit', 100000n],
        [note.number, 'debit', 12000n],
      ]);
    });

    it('GST comes back with the goods: the Output ledgers are debited, the Input ledgers credited, and the GST reports net the notes', async () => {
      await chargeGst();
      const inv = await sale('s1', [await item('10', '100', { gstRate: '18', hsn: '7318' })]);
      const cn = mustOk(await post(await creditNote('cn1', [await item('4', '100', { gstRate: '18', hsn: '7318' })], { invoiceRef: inv.number, against: '472.00' }))).voucher;
      expect(await journal(cn.id)).toEqual([
        [customerLedger(), 'credit', 47200n],
        [w.uuid('ledger:sales'), 'debit', 40000n],
        [await systemLedger('gst-output-cgst'), 'debit', 3600n],
        [await systemLedger('gst-output-sgst'), 'debit', 3600n],
      ]);
      expect(await bills(customerLedger())).toEqual([[inv.number, 'debit', 70800n]]);

      await purchase('p1', [await item('100', '10', { gstRate: '18', hsn: '7318' })]);
      const dn = mustOk(await post(await debitNote('dn1', [await item('50', '10', { gstRate: '18', hsn: '7318' })], { invoiceRef: 'SS/p1', against: '590.00' }))).voucher;
      expect(await journal(dn.id)).toEqual([
        [w.uuid('ledger:purchases'), 'credit', 50000n],
        [await systemLedger('gst-input-cgst'), 'credit', 4500n],
        [await systemLedger('gst-input-sgst'), 'credit', 4500n],
        [supplierLedger(), 'debit', 59000n],
      ]);

      const vouchers = await w.backend.list(w.companyId);
      const masters = await w.backend.load(w.companyId);
      const sales = gstInvoices({ vouchers, masters, side: 'sales', range: {} });
      expect(sales.map((i) => [i.number, i.note, i.taxable, i.tax])).toEqual([
        [inv.number, false, 100000n, 18000n],
        [cn.number, true, -40000n, -7200n],
      ]);
      expect(gstTotals(sales)).toMatchObject({ taxable: 60000n, cgst: 5400n, sgst: 5400n, tax: 10800n });
      expect(gstTotals(gstInvoices({ vouchers, masters, side: 'purchase', range: {} }))).toMatchObject({ taxable: 50000n, tax: 9000n });
      expect(gstInvoices({ vouchers, masters, side: 'purchase', range: {}, notes: false }).map((i) => i.note)).toEqual([false]);
    });
  });
}
