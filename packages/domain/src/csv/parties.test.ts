import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import { seedCompany } from '../masters/seed';
import { parsePartiesCsv, resolvePartyRow, serializePartiesCsv } from './parties';

const newId = (n: string) => deterministicUuid(`csv-parties|${n}`);

describe('parsePartiesCsv', () => {
  it('reads a row, including the pipe-separated roles cell', () => {
    const csv = 'name,gstin,pan,phone,email,address,stateCode,creditDays,creditLimit,gstRegistration,pincode,country,shippingLines,shippingStateCode,shippingPincode,shippingCountry,roles\n' +
      'Acme Ltd,27AAACE9659G1ZB,,,,,,,,,,,,,,,customer|vendor';
    const [row] = parsePartiesCsv(csv);
    expect(row?.name).toBe('Acme Ltd');
    expect(row?.gstin).toBe('27AAACE9659G1ZB');
    expect(row?.roles).toBe('customer|vendor');
  });
});

describe('resolvePartyRow', () => {
  it('parses roles, creditDays and creditLimit into the party command’s data', () => {
    const r = resolvePartyRow({
      name: 'Acme Ltd', gstin: '', pan: '', phone: '', email: '', address: '', stateCode: '',
      creditDays: '45', creditLimit: '50000.00', gstRegistration: '', pincode: '', country: '',
      shippingLines: '', shippingStateCode: '', shippingPincode: '', shippingCountry: '', roles: 'customer',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ name: 'Acme Ltd', creditDays: 45, creditLimit: '50000.00', roles: ['customer'] });
  });

  it('an unknown role is reported, not silently dropped', () => {
    const r = resolvePartyRow({
      name: 'Acme Ltd', gstin: '', pan: '', phone: '', email: '', address: '', stateCode: '',
      creditDays: '', creditLimit: '', gstRegistration: '', pincode: '', country: '',
      shippingLines: '', shippingStateCode: '', shippingPincode: '', shippingCountry: '', roles: 'buyer',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('buyer');
  });

  it('the resolved data passes prepareMasterCommand, same as the app’s own Party screen', () => {
    const masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
    const r = resolvePartyRow({
      name: 'Acme Ltd', gstin: '', pan: '', phone: '', email: '', address: '', stateCode: '',
      creditDays: '', creditLimit: '', gstRegistration: '', pincode: '', country: '',
      shippingLines: '', shippingStateCode: '', shippingPincode: '', shippingCountry: '', roles: 'customer',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const prepared = prepareMasterCommand({ op: 'create', kind: 'party', id: newId('acme'), data: r.data }, masters);
      expect(prepared.ok).toBe(true);
    }
  });
});

describe('serializePartiesCsv', () => {
  it('round-trips through resolvePartyRow back to equivalent command data', () => {
    let masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
    const created = prepareMasterCommand({ op: 'create', kind: 'party', id: newId('acme'), data: { name: 'Acme Ltd', creditDays: 45, roles: ['customer', 'vendor'] } }, masters);
    if (!created.ok) throw new Error(JSON.stringify(created.issues));
    masters = created.value.masters;

    const csv = serializePartiesCsv(masters.parties);
    const [row] = parsePartiesCsv(csv);
    expect(row?.name).toBe('Acme Ltd');
    expect(row?.roles).toBe('customer|vendor');
    const resolved = resolvePartyRow(row as NonNullable<typeof row>);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.data).toMatchObject({ creditDays: 45, roles: ['customer', 'vendor'] });
  });
});
