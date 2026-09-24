import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { asCompanyId, deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import { seedCompany } from '../masters/seed';
import { orderBookOf } from '../orders/orderBook';
import { prepareVoucher } from '../posting/engine';
import { StockBook } from '../stock/book';
import { defaultVoucherKinds } from '../vouchers/registry';
import type { Voucher } from '../vouchers/voucher';
import { parseVouchersCsv, serializeVouchersCsv, voucherEntriesOf } from './vouchers';

const newId = (n: string) => deterministicUuid(`csv-vouchers|${n}`);
const kinds = defaultVoucherKinds();

function world() {
  let masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
  const run = (kind: string, id: string, data: unknown) => {
    const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
  };
  run('party', newId('acme'), { name: 'Acme Ltd', roles: ['customer'] });
  run('ledger', newId('sales'), { name: 'Domestic Sales', groupId: newId('group:sales-accounts') });

  const post = (input: unknown, number: string): Voucher => {
    const r = prepareVoucher(input, masters, kinds, new StockBook([]), orderBookOf([], masters));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return {
      id: r.value.draft.id,
      companyId: asCompanyId('c'),
      voucherTypeId: r.value.voucherType.id,
      financialYearId: r.value.financialYear.id,
      number,
      date: r.value.draft.date,
      status: 'posted',
      version: 1,
      revision: 0,
      content: r.value.draft,
    };
  };

  // a one-time (written) line — no stock item, so no opening stock needs setting up for this test
  const invoice = post(
    {
      id: newId('inv1'),
      voucherTypeId: masters.voucherTypes.find((t) => t.baseKind === 'sales')?.id as string,
      date: '2024-05-12',
      partyId: newId('acme'),
      partyDetails: { partyId: newId('acme'), mailingName: 'Acme Ltd' },
      salesLedgerId: newId('sales'),
      dueDate: '2024-06-11',
      lines: [{ description: 'Machining charges', unit: 'Job', qty: '4', rate: '25' }],
    },
    'SAL/24-25/0001',
  );
  return { masters, vouchers: [invoice] };
}

describe('voucherEntriesOf', () => {
  it('reads a posted Sales Invoice back into one CSV entry, docRef = its number', () => {
    const { masters, vouchers } = world();
    const entries = voucherEntriesOf(vouchers, masters);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.docRef).toBe('SAL/24-25/0001');
    expect(entries[0]?.kind).toBe('sales');
    expect(entries[0]?.extraction.partyName).toBe('Acme Ltd');
    expect(entries[0]?.extraction.lines).toHaveLength(1);
    expect(entries[0]?.extraction.lines[0]).toMatchObject({ description: 'Machining charges', qty: '4.0000', rate: '25.0000' });
    expect(entries[0]?.extraction.subtotal).toBe('100.00');
  });

  it('round-trips through serializeVouchersCsv / parseVouchersCsv', () => {
    const { masters, vouchers } = world();
    const entries = voucherEntriesOf(vouchers, masters);
    const back = parseVouchersCsv(serializeVouchersCsv(entries));
    expect(back).toHaveLength(1);
    expect(back[0]?.docRef).toBe(entries[0]?.docRef);
    expect(back[0]?.extraction.partyName).toBe(entries[0]?.extraction.partyName);
    expect(back[0]?.extraction.lines).toHaveLength(1);
  });

  it('the filter keeps only vouchers inside the period and of the chosen kinds', () => {
    const { masters, vouchers } = world();
    expect(voucherEntriesOf(vouchers, masters, { from: '2024-05-01', to: '2024-05-31' })).toHaveLength(1);
    expect(voucherEntriesOf(vouchers, masters, { from: '2024-05-13' })).toHaveLength(0);
    expect(voucherEntriesOf(vouchers, masters, { to: '2024-05-11' })).toHaveLength(0);
    expect(voucherEntriesOf(vouchers, masters, { kinds: ['sales'] })).toHaveLength(1);
    expect(voucherEntriesOf(vouchers, masters, { kinds: ['purchase', 'salesOrder'] })).toHaveLength(0);
  });
});
