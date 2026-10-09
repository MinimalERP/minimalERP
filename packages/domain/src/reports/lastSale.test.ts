import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { type LedgerId, type StockItemId, type WarehouseId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import { seedCompany } from '../masters/seed';
import { orderBookOf } from '../orders/orderBook';
import { prepareVoucher } from '../posting/engine';
import { StockBook } from '../stock/book';
import type { StockMovement } from '../stock/movement';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { lastSaleOf } from './lastSale';

const newId = (n: string) => deterministicUuid(`lastSale|${n}`);
const kinds = defaultVoucherKinds();

describe('an item’s last sale', () => {
  it('is the rate, date, party and number of its most recently dated posted Sales Invoice line — never a purchase, never a cancelled one', () => {
    let m = seedCompany({ name: 'Last Sale Co', fyStart: localDate('2026-04-01'), newId });
    const run = (kind: string, id: string, data: unknown) => {
      const r = prepareMasterCommand({ op: 'create', kind, id, data }, m);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      m = r.value.masters;
    };
    const item = newId('bolt') as StockItemId;
    const customerA = newId('customerA');
    const customerB = newId('customerB');
    const vendor = newId('vendor');
    const sales = newId('sales') as LedgerId;
    const purchases = newId('purchases') as LedgerId;
    const nos = m.units.find((u) => u.symbol === 'Nos')?.id;
    const group = (key: string) => newId(`group:${key}`);
    run('stockItem', item, { name: 'Bolt', unitId: nos, itemType: 'trading' });
    run('party', customerA, { name: 'Alpha Traders', roles: ['customer'] });
    run('party', customerB, { name: 'Beta Traders', roles: ['customer'] });
    run('party', vendor, { name: 'A Supplier', roles: ['vendor'] });
    run('ledger', sales, { name: 'Sales', groupId: group('sales-accounts') });
    run('ledger', purchases, { name: 'Purchases', groupId: group('purchase-accounts') });
    const main = m.warehouses[0]?.id as WarehouseId;

    const vouchers: Voucher[] = [];
    const plans: { journal: unknown[]; stock: unknown[] }[] = [];
    const post = (input: Record<string, unknown>): Voucher => {
      const stock = new StockBook(vouchers.flatMap((v, i) => (plans[i]?.stock ?? []) as StockMovement[]));
      const r = prepareVoucher({ id: newId(`v${vouchers.length}`), ...input }, m, kinds, stock, orderBookOf(vouchers, m));
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      const v: Voucher = {
        id: r.value.draft.id,
        companyId: 'c' as never,
        voucherTypeId: r.value.voucherType.id,
        financialYearId: r.value.financialYear.id,
        number: `V${vouchers.length + 1}`,
        date: r.value.draft.date,
        status: 'posted',
        version: 1,
        revision: 0,
        content: r.value.draft,
      };
      vouchers.push(v);
      plans.push(r.value.plan as never);
      return v;
    };
    const type = (base: string) => m.voucherTypes.find((t) => t.baseKind === base)?.id as string;

    expect(lastSaleOf(vouchers, m, item)).toBeUndefined();

    post({
      voucherTypeId: type('purchase'),
      date: '2026-04-05',
      partyId: vendor,
      partyDetails: { partyId: vendor, mailingName: 'X' },
      purchaseLedgerId: purchases,
      billNo: 'SUP/0',
      dueDate: '2026-05-05',
      lines: [{ itemId: item, warehouseId: main, qty: '100', rate: '50' }],
    });

    const first = post({
      voucherTypeId: type('sales'),
      date: '2026-04-10',
      partyId: customerA,
      partyDetails: { partyId: customerA, mailingName: 'X' },
      salesLedgerId: sales,
      dueDate: '2026-05-10',
      lines: [{ itemId: item, warehouseId: main, qty: '10', rate: '100' }],
    });
    expect(lastSaleOf(vouchers, m, item)).toMatchObject({ rate: '100.00', date: '2026-04-10', party: 'Alpha Traders', number: first.number });

    // a later sale, to a different party, at a different rate: that one wins
    const second = post({
      voucherTypeId: type('sales'),
      date: '2026-04-20',
      partyId: customerB,
      partyDetails: { partyId: customerB, mailingName: 'X' },
      salesLedgerId: sales,
      dueDate: '2026-05-20',
      lines: [{ itemId: item, warehouseId: main, qty: '5', rate: '120' }],
    });
    expect(lastSaleOf(vouchers, m, item)).toMatchObject({ rate: '120.00', date: '2026-04-20', party: 'Beta Traders', number: second.number });

    // a purchase of the same item, dated even later: never counted — it is not a sale
    post({
      voucherTypeId: type('purchase'),
      date: '2026-04-25',
      partyId: vendor,
      partyDetails: { partyId: vendor, mailingName: 'X' },
      purchaseLedgerId: purchases,
      billNo: 'SUP/1',
      dueDate: '2026-05-25',
      lines: [{ itemId: item, warehouseId: main, qty: '50', rate: '70' }],
    });
    expect(lastSaleOf(vouchers, m, item)).toMatchObject({ rate: '120.00', number: second.number });

    // the later sale cancelled: the first sale is last again
    const secondIndex = vouchers.findIndex((v) => v.id === second.id);
    vouchers[secondIndex] = { ...second, status: 'cancelled' };
    expect(lastSaleOf(vouchers, m, item)).toMatchObject({ rate: '100.00', number: first.number });
  });
});
