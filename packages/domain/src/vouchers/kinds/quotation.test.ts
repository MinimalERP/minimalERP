import { describe, expect, it } from 'vitest';
import { localDate } from '../../dates';
import { IssueCode } from '../../errors';
import { deterministicUuid } from '../../ids';
import { prepareMasterCommand } from '../../masters/commands';
import type { Masters } from '../../masters/masters';
import { seedCompany } from '../../masters/seed';
import { prepareVoucher } from '../../posting/engine';
import { defaultVoucherKinds } from '../registry';

const newId = (n: string) => deterministicUuid(`qt|${n}`);
const kinds = defaultVoucherKinds();

function company(): { masters: Masters; partyId: string; itemId: string; typeId: string } {
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
  const typeId = masters.voucherTypes.find((t) => t.baseKind === 'quotation')?.id as string;
  return { masters, partyId, itemId, typeId };
}

describe('quotationKind', () => {
  it('posts nothing: an empty plan is accepted', () => {
    const { masters, partyId, itemId, typeId } = company();
    const r = prepareVoucher(
      {
        id: newId('v1'),
        voucherTypeId: typeId,
        date: '2024-05-01',
        partyId,
        partyDetails: { partyId, mailingName: 'Acme Ltd' },
        lines: [{ id: 'a', itemId, qty: '2', rate: '100' }],
      },
      masters,
      kinds,
    );
    expect(r.ok, r.ok ? '' : r.issues.map((i) => i.message).join('; ')).toBe(true);
    if (r.ok) {
      expect(r.value.plan.journal).toHaveLength(0);
      expect(r.value.plan.stock).toHaveLength(0);
    }
  });

  it('needs party details', () => {
    const { masters, partyId, itemId, typeId } = company();
    const r = prepareVoucher(
      {
        id: newId('v2'),
        voucherTypeId: typeId,
        date: '2024-05-01',
        partyId,
        lines: [{ id: 'a', itemId, qty: '1', rate: '10' }],
      },
      masters,
      kinds,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain(IssueCode.PartyDetailsInvalid);
  });
});
