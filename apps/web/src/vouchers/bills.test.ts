import { type Masters, type Voucher, type VoucherId, defaultVoucherKinds, deterministicUuid, localDate, prepareMasterCommand, prepareVoucher, seedCompany } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { amountToSettle, billsToOffer, creditDaysOf, defaultAllocations, naturalSide, settleableBills, unallocated } from './bills';

const newId = (n: string) => deterministicUuid(`bw|${n}`);

function setup() {
  let masters: Masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
  const add = (kind: string, id: string, data: unknown) => {
    const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
  };
  add('party', newId('p'), { name: 'Steel Co', creditDays: 30 });
  add('ledger', newId('bank'), { name: 'HDFC', groupId: newId('group:bank-accounts') });
  add('ledger', newId('steel'), { name: 'Steel Co', groupId: newId('group:sundry-creditors'), partyId: newId('p') });
  add('ledger', newId('abc'), { name: 'ABC', groupId: newId('group:sundry-debtors') });
  add('ledger', newId('rent'), { name: 'Rent', groupId: newId('group:indirect-expenses') });
  const vouchers: Voucher[] = [];
  const post = (kind: string, date: string, body: object) => {
    const type = masters.voucherTypes.find((t) => t.baseKind === kind)!;
    const id = newId(`v${vouchers.length}`);
    const r = prepareVoucher({ id, voucherTypeId: type.id, date, ...body }, masters, defaultVoucherKinds());
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    vouchers.push({ id: id as VoucherId, companyId: masters.company.id, voucherTypeId: type.id, financialYearId: r.value.financialYear.id, number: String(vouchers.length + 1), date: r.value.draft.date, status: 'posted', version: 1, revision: 0, content: r.value.draft });
  };
  const bill = (ref: string, amount: string, due: string) =>
    post('journal', '2024-04-10', { entries: [{ ledgerId: newId('rent'), side: 'debit', amount }, { ledgerId: newId('steel'), side: 'credit', amount, allocations: [{ kind: 'new', ref, dueDate: due, amount }] }] });
  return { masters: () => masters, vouchers, post, bill, steel: newId('steel'), abc: newId('abc'), bank: newId('bank') };
}

describe('bill-wise defaults', () => {
  it('a supplier is credited when a bill is raised; a customer is debited', () => {
    const s = setup();
    expect(naturalSide(s.masters(), s.steel)).toBe('credit');
    expect(naturalSide(s.masters(), s.abc)).toBe('debit');
    expect(creditDaysOf(s.masters(), s.steel)).toBe(30);
    expect(creditDaysOf(s.masters(), s.abc)).toBe(0);
  });

  it('a payment to a supplier with open bills starts as ONE BLANK Against-ref row for the whole amount: no bill is chosen for the person', () => {
    const s = setup();
    s.bill('PO-2', '500', '2024-06-30');
    s.bill('PO-1', '300', '2024-05-15');
    const parts = defaultAllocations({ masters: s.masters(), vouchers: s.vouchers, ledgerId: s.steel, side: 'debit', amount: '900', date: '2024-05-20' });
    expect(parts).toEqual([{ kind: 'against', ref: '', dueDate: '', amount: '900.00' }]);
  });

  it('a line on the party’s normal side raises a NEW bill, due after the credit days', () => {
    const s = setup();
    expect(defaultAllocations({ masters: s.masters(), vouchers: s.vouchers, ledgerId: s.steel, side: 'credit', amount: '1,200', date: '2024-05-01' })).toEqual([
      { kind: 'new', ref: '', dueDate: '2024-05-31', amount: '1200.00' },
    ]);
  });

  it('with no open bills, a payment to a supplier is on account; nothing to allocate for zero', () => {
    const s = setup();
    expect(defaultAllocations({ masters: s.masters(), vouchers: s.vouchers, ledgerId: s.steel, side: 'debit', amount: '50', date: '2024-05-01' })).toEqual([{ kind: 'onAccount', ref: '', dueDate: '', amount: '50.00' }]);
    expect(defaultAllocations({ masters: s.masters(), vouchers: s.vouchers, ledgerId: s.steel, side: 'debit', amount: '0', date: '2024-05-01' })).toEqual([]);
    expect(defaultAllocations({ masters: s.masters(), vouchers: s.vouchers, ledgerId: s.steel, side: 'debit', amount: 'abc', date: '2024-05-01' })).toEqual([]);
  });

  it('a voucher being altered does not offer its own bill to itself', () => {
    const s = setup();
    s.bill('PO-1', '300', '2024-05-15');
    expect(settleableBills(s.vouchers, s.masters(), s.steel, 'debit')).toHaveLength(1);
    expect(settleableBills(s.vouchers, s.masters(), s.steel, 'debit', s.vouchers[0]?.id)).toHaveLength(0);
  });

  it('measures what is left to allocate', () => {
    expect(unallocated('1000', [{ kind: 'new', ref: 'a', dueDate: '', amount: '600' }])).toBe(40000n);
    expect(unallocated('1000', [{ kind: 'new', ref: 'a', dueDate: '', amount: '600' }, { kind: 'onAccount', ref: '', dueDate: '', amount: '400' }])).toBe(0n);
    expect(unallocated('1000', [{ kind: 'new', ref: 'a', dueDate: '', amount: '1,100' }])).toBe(-10000n);
    expect(unallocated('', [])).toBe(0n);
  });
});

describe('one receipt or payment for several bills, each in part', () => {
  const offer = (s: ReturnType<typeof setup>, allocations: Parameters<typeof billsToOffer>[0]['allocations'], exceptPart?: number) =>
    billsToOffer({ masters: s.masters(), vouchers: s.vouchers, ledgerId: s.steel, side: 'debit', allocations, exceptPart });

  it('offers every open bill, oldest due first, and leaves out the ones another row of the line already names', () => {
    const s = setup();
    s.bill('B-2', '1500', '2024-06-30');
    s.bill('B-1', '1500', '2024-05-15');
    expect(offer(s, []).map((b) => b.ref)).toEqual(['B-1', 'B-2']);
    const first = { kind: 'against' as const, ref: 'B-1', dueDate: '', amount: '750.00' };
    expect(offer(s, [first]).map((b) => b.ref)).toEqual(['B-2']);
    expect(offer(s, [first], 0).map((b) => b.ref)).toEqual(['B-1', 'B-2']); // the row being edited may keep or change its own bill
  });

  it('a row starts with what is still to allocate on the line, never more than the bill has pending', () => {
    const s = setup();
    s.bill('B-1', '1500', '2024-05-15');
    s.bill('B-2', '1500', '2024-06-30');
    const [b1, b2] = offer(s, []);
    if (!b1 || !b2) throw new Error('no bills');
    expect(amountToSettle(b1, '3,000', [])).toBe('1500.00'); // the whole bill: 1,500 of the 3,000
    expect(amountToSettle(b1, '1,000', [])).toBe('1000.00'); // a part of it: the rest stays open
    const first = { kind: 'against' as const, ref: 'B-1', dueDate: '', amount: '750.00' };
    expect(amountToSettle(b2, '1,500', [first])).toBe('750.00'); // 1,500 received, 750 already on the first bill
    expect(amountToSettle(b1, '1,500', [first], 0)).toBe('1500.00'); // changing the first row's own bill: its 750 is free again
  });

  it('a bill settled in part leaves the rest open, and the next receipt sees only that', () => {
    const s = setup();
    s.bill('B-1', '1500', '2024-05-15');
    s.post('payment', '2024-05-20', { accountLedgerId: s.bank, lines: [{ ledgerId: s.steel, amount: '750', allocations: [{ kind: 'against', ref: 'B-1', amount: '750' }] }] });
    expect(offer(s, []).map((b) => [b.ref, String(b.pending)])).toEqual([['B-1', '75000']]);
  });
});
