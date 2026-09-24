import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { type LedgerId, type StockItemId, type WarehouseId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { seedCompany } from '../masters/seed';
import { money } from '../money';
import { OrderBook } from '../orders/orderBook';
import { prepareVoucher } from '../posting/engine';
import { gstInvoices } from '../reports/gst';
import { StockBook } from '../stock/book';
import { customerLedgerOf, vendorLedgerOf } from './kinds/documents';
import { defaultVoucherKinds } from './registry';
import type { Voucher } from './voucher';
import { asCompanyId } from '../ids';

const newId = (n: string) => deterministicUuid(`onetime|${n}`);
const kinds = defaultVoucherKinds();

const details = (partyId: string) => ({ partyId, mailingName: 'X', placeOfSupply: '27' });

/** A company that charges GST (Maharashtra), a customer and a supplier in the same state, one stocked item. */
function company() {
  let m: Masters = seedCompany({ name: 'Micro Components', fyStart: localDate('2026-04-01'), stateCode: '27', newId });
  const run = (kind: string, id: string, data: unknown) => {
    const r = prepareMasterCommand({ op: 'create', kind, id, data }, m);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    m = r.value.masters;
  };
  m = m.with({ company: { ...m.company, chargeGst: true } });
  const bolt = newId('bolt') as StockItemId;
  run('stockItem', bolt, { name: 'Hex Bolt', unitId: m.units.find((u) => u.symbol === 'Nos')?.id, itemType: 'finished' });
  run('party', newId('acme'), { name: 'Acme Ltd', roles: ['customer'], stateCode: '27' });
  run('party', newId('steel'), { name: 'Steel Supplier', roles: ['vendor'], stateCode: '27' });
  run('ledger', newId('sales'), { name: 'Sales', groupId: newId('group:sales-accounts') });
  run('ledger', newId('purchases'), { name: 'Purchases', groupId: newId('group:purchase-accounts') });
  const main = m.warehouses[0]?.id as WarehouseId;
  // 100 bolts in stock, bought on 1 April, so a sale of 10 is possible
  const bought = prepareVoucher(
    {
      id: newId('buy'), voucherTypeId: m.voucherTypes.find((t) => t.baseKind === 'purchase')?.id, date: '2026-04-01', partyId: newId('steel'), partyDetails: details(newId('steel')),
      purchaseLedgerId: newId('purchases'), billNo: 'OPEN-1', dueDate: '2026-04-01', lines: [{ itemId: bolt, warehouseId: main, qty: '100', rate: '4' }],
    },
    m,
    kinds,
    StockBook.empty,
    new OrderBook([], []),
  );
  if (!bought.ok) throw new Error(JSON.stringify(bought.issues));
  const stock = new StockBook(bought.value.plan.stock.map((s, i) => ({ ...s, voucherId: newId('buy') as never, lineNo: i + 1, date: '2026-04-01' as never })));
  return { m, bolt, main, stock, type: (base: string) => m.voucherTypes.find((t) => t.baseKind === base)?.id as string };
}


describe('a one-time (written) line on a Sales Invoice', () => {
  it('is billed and taxed like any line and moves no stock; the item line beside it moves its stock', () => {
    const c = company();
    const draft = {
      id: newId('inv'),
      voucherTypeId: c.type('sales'),
      date: '2026-09-24',
      partyId: newId('acme'),
      partyDetails: details(newId('acme')),
      salesLedgerId: newId('sales'),
      dueDate: '2026-10-24',
      gst: { supplyState: '27', placeOfSupply: '27', cgst: '495', sgst: '495', igst: '0' },
      lines: [
        { itemId: c.bolt, warehouseId: c.main, qty: '10', rate: '50', gstRate: '18', hsn: '7318' },
        { description: 'Machining charges – job 44', qty: '1', rate: '5000', gstRate: '18', hsn: '998898', unit: 'Nos' },
      ],
    };
    const r = prepareVoucher(draft, c.m, kinds, c.stock, new OrderBook([], []));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    // Dr the customer 5,500 + 990 GST; Cr Sales 5,500; Cr Output CGST / SGST 495 each
    const customer = r.value.plan.journal.find((l) => l.ledgerId === customerLedgerOf(newId('acme') as never));
    expect(customer?.amount).toBe(money(649000n));
    expect(r.value.plan.journal.find((l) => l.ledgerId === (newId('sales') as LedgerId))?.amount).toBe(money(550000n));
    // only the bolt leaves the godown
    expect(r.value.plan.stock).toEqual([expect.objectContaining({ itemId: c.bolt, direction: 'out' })]);

    const v: Voucher = { id: r.value.draft.id, companyId: asCompanyId('c'), voucherTypeId: r.value.voucherType.id, financialYearId: r.value.financialYear.id, number: 'INV/1', date: r.value.draft.date, status: 'posted', version: 1, revision: 0, content: r.value.draft };
    const [inv] = gstInvoices({ vouchers: [v], masters: c.m, side: 'sales', range: {} });
    expect(inv?.lines.map((l) => [l.itemId ?? null, l.description, l.hsn, l.uqc, l.taxable])).toEqual([
      [c.bolt, 'Hex Bolt', '7318', 'NOS', money(50000n)],
      [null, 'Machining charges – job 44', '998898', 'NOS', money(500000n)],
    ]);
    expect(inv?.tax).toBe(money(99000n));
  });

  it('refuses a line that is both, or neither, or a written line against an order', () => {
    const c = company();
    const base = { id: newId('bad'), voucherTypeId: c.type('sales'), date: '2026-09-24', partyId: newId('acme'), partyDetails: details(newId('acme')), salesLedgerId: newId('sales'), dueDate: '2026-10-24' };
    const codes = (lines: unknown[]) => {
      const r = prepareVoucher({ ...base, lines }, c.m, kinds, c.stock, new OrderBook([], []));
      return r.ok ? [] : r.issues.map((i) => i.path);
    };
    expect(codes([{ itemId: c.bolt, description: 'x', warehouseId: c.main, qty: '1', rate: '1' }])).toContain('lines.0.itemId');
    expect(codes([{ qty: '1', rate: '1' }])).toContain('lines.0.itemId');
    expect(codes([{ description: 'x', qty: '1', rate: '1', orderRef: { orderId: newId('so'), lineId: 'a' } }])).toContain('lines.0.orderRef');
    expect(codes([{ description: 'x', qty: '0', rate: '1' }])).toContain('lines.0.qty');
    expect(codes([{ itemId: c.bolt, warehouseId: c.main, unit: 'Kg', qty: '1', rate: '1' }])).toContain('lines.0.unit');
  });

  it("a stock problem is reported on the stock line's own place, after a written line", () => {
    const c = company();
    const r = prepareVoucher(
      {
        id: newId('short'), voucherTypeId: c.type('sales'), date: '2026-09-24', partyId: newId('acme'), partyDetails: details(newId('acme')), salesLedgerId: newId('sales'), dueDate: '2026-10-24',
        lines: [{ description: 'Packing', qty: '1', rate: '100' }, { itemId: c.bolt, warehouseId: c.main, qty: '500', rate: '5' }],
      },
      c.m,
      kinds,
      c.stock,
      new OrderBook([], []),
    );
    expect(r.ok ? [] : r.issues.map((i) => i.path)).toEqual(['lines.1.qty']);
  });
});

describe('a one-time line on a Purchase Invoice', () => {
  it("raises the supplier's bill with it and brings no stock in", () => {
    const c = company();
    const r = prepareVoucher(
      {
        id: newId('pur'), voucherTypeId: c.type('purchase'), date: '2026-09-24', partyId: newId('steel'), partyDetails: details(newId('steel')), purchaseLedgerId: newId('purchases'), billNo: 'SS/77', dueDate: '2026-10-24',
        gst: { supplyState: '27', placeOfSupply: '27', cgst: '90', sgst: '90', igst: '0' },
        lines: [{ description: 'Freight to Chakan', qty: '1', rate: '1000', gstRate: '18', hsn: '996511' }],
      },
      c.m,
      kinds,
      c.stock,
      new OrderBook([], []),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.value.plan.stock).toEqual([]);
    expect(r.value.plan.journal.find((l) => l.ledgerId === vendorLedgerOf(newId('steel') as never))?.amount).toBe(money(118000n));
  });
});
