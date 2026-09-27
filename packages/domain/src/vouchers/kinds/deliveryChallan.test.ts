import { describe, expect, it } from 'vitest';
import { localDate } from '../../dates';
import { IssueCode } from '../../errors';
import { type StockItemId, type VoucherId, type WarehouseId, deterministicUuid } from '../../ids';
import { prepareMasterCommand } from '../../masters/commands';
import type { Masters } from '../../masters/masters';
import { seedCompany } from '../../masters/seed';
import { money } from '../../money';
import { prepareVoucher } from '../../posting/engine';
import { StockBook } from '../../stock/book';
import { parseQty } from '../../stock/quantity';
import { defaultVoucherKinds } from '../registry';

const newId = (n: string) => deterministicUuid(`dc|${n}`);
const kinds = defaultVoucherKinds();

function company(): { masters: Masters; partyId: string; itemId: string; typeId: string; godown: string; stock: StockBook } {
  let masters = seedCompany({ name: 'Co', fyStart: localDate('2024-04-01'), newId });
  const run = (kind: string, id: string, data: unknown) => {
    const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
  };
  const nos = masters.units.find((u) => u.symbol === 'Nos')?.id as string;
  const partyId = newId('party:acme');
  const itemId = newId('item:bolt');
  run('stockItem', itemId, { name: 'Bolt', unitId: nos, itemType: 'finished' });
  run('party', partyId, { name: 'Acme Ltd', roles: ['customer'] });
  const typeId = masters.voucherTypes.find((t) => t.baseKind === 'deliveryChallan')?.id as string;
  const godown = masters.warehouses[0]?.id as string;
  // 100 bolts in the main godown on 1 April
  const stock = new StockBook([
    {
      voucherId: newId('opening') as VoucherId,
      lineNo: 1,
      date: localDate('2024-04-01'),
      itemId: itemId as StockItemId,
      warehouseId: godown as WarehouseId,
      direction: 'in',
      qty: parseQty('100') as never,
      value: money(100000n),
    },
  ]);
  return { masters, partyId, itemId, typeId, godown, stock };
}

const challan = (c: ReturnType<typeof company>, extra: Record<string, unknown> = {}, qty = '40') => ({
  id: newId('v1'),
  voucherTypeId: c.typeId,
  date: '2024-05-01',
  partyId: c.partyId,
  partyDetails: { partyId: c.partyId, mailingName: 'Acme Ltd' },
  purpose: 'sale',
  lines: [{ id: 'a', itemId: c.itemId, warehouseId: c.godown, qty, rate: '12.5' }],
  ...extra,
});

describe('deliveryChallanKind', () => {
  it('is in the seeded company with its own DC series', () => {
    const c = company();
    expect(c.masters.voucherTypes.find((t) => t.id === c.typeId)?.name).toBe('Delivery Challan');
    expect(c.masters.series.find((s) => s.voucherTypeId === c.typeId)?.prefix).toBe('DC/24-25/');
  });

  it('takes the goods out of stock and posts nothing to the accounts', () => {
    const c = company();
    const r = prepareVoucher(challan(c), c.masters, kinds, c.stock);
    expect(r.ok, r.ok ? '' : r.issues.map((i) => i.message).join('; ')).toBe(true);
    if (!r.ok) return;
    expect(r.value.plan.journal).toHaveLength(0);
    expect(r.value.plan.stock).toEqual([expect.objectContaining({ itemId: c.itemId, warehouseId: c.godown, direction: 'out', qty: parseQty('40') })]);
    expect(r.value.plan.links).toHaveLength(0);
  });

  it('free of cost moves the stock the same way', () => {
    const c = company();
    const r = prepareVoucher(challan(c, { purpose: 'foc' }), c.masters, kinds, c.stock);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.plan.stock).toHaveLength(1);
  });

  it('cannot send more than the godown holds', () => {
    const c = company();
    const r = prepareVoucher(challan(c, {}, '150'), c.masters, kinds, c.stock);
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.issues.map((i) => [i.code, i.path])).toContainEqual([IssueCode.StockNegative, 'lines.0.qty']);
  });

  it('needs a purpose it knows, a customer and party details', () => {
    const c = company();
    const bad = prepareVoucher(challan(c, { purpose: 'gift' }), c.masters, kinds, c.stock);
    expect(bad.ok).toBe(false);
    const noDetails = prepareVoucher(challan(c, { partyDetails: undefined }), c.masters, kinds, c.stock);
    expect(noDetails.ok ? [] : noDetails.issues.map((i) => i.code)).toContain(IssueCode.PartyDetailsInvalid);
  });
});
