import { type Masters, type Voucher, type VoucherId, defaultVoucherKinds, deterministicUuid, localDate, prepareMasterCommand, prepareVoucher, seedCompany } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { pendingBillOf, settleFormFor } from './settleBill';

const newId = (n: string) => deterministicUuid(`settle|${n}`);

function setup() {
  let masters: Masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
  const add = (kind: string, id: string, data: unknown) => {
    const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
  };
  add('ledger', newId('hdfc'), { name: 'HDFC', groupId: newId('group:bank-accounts') });
  add('ledger', newId('sbi'), { name: 'SBI', groupId: newId('group:bank-accounts') });
  add('ledger', newId('steel'), { name: 'Steel Co', groupId: newId('group:sundry-creditors') });
  add('ledger', newId('other'), { name: 'Other Co', groupId: newId('group:sundry-creditors') });
  add('ledger', newId('rent'), { name: 'Rent', groupId: newId('group:indirect-expenses') });
  const vouchers: Voucher[] = [];
  const post = (kind: string, date: string, body: object): Voucher => {
    const type = masters.voucherTypes.find((t) => t.baseKind === kind)!;
    const id = newId(`v${vouchers.length}`);
    const r = prepareVoucher({ id, voucherTypeId: type.id, date, ...body }, masters, defaultVoucherKinds());
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const v: Voucher = { id: id as VoucherId, companyId: masters.company.id, voucherTypeId: type.id, financialYearId: r.value.financialYear.id, number: String(vouchers.length + 1), date: r.value.draft.date, status: 'posted', version: 1, revision: 0, content: r.value.draft };
    vouchers.push(v);
    return v;
  };
  const bill = (ledger: string, ref: string, amount: string) =>
    post('journal', '2024-04-10', { entries: [{ ledgerId: newId('rent'), side: 'debit', amount }, { ledgerId: newId(ledger), side: 'credit', amount, allocations: [{ kind: 'new', ref, dueDate: '2024-05-10', amount }] }] });
  const pay = (bank: string, ledger: string, amount: string, allocations: object[]) =>
    post('payment', '2024-04-20', { accountLedgerId: newId(bank), lines: [{ ledgerId: newId(ledger), amount, allocations }] });
  const paymentType = () => masters.voucherTypes.find((t) => t.baseKind === 'payment')!.id;
  return { masters: () => masters, vouchers, bill, pay, paymentType };
}

describe('the Payment (Receipt) that settles a bill, filled in', () => {
  it('pays what is still pending, against the bill, from the account the party was last paid from', () => {
    const s = setup();
    const b = s.bill('steel', 'PB-7', '1000');
    s.pay('sbi', 'other', '50', [{ kind: 'onAccount', amount: '50' }]); // someone else, later: not this party's account
    s.pay('hdfc', 'steel', '400', [{ kind: 'against', ref: 'PB-7', amount: '400' }]);
    s.pay('sbi', 'other', '60', [{ kind: 'onAccount', amount: '60' }]);

    expect(pendingBillOf(b, s.vouchers, s.masters())).toMatchObject({ ref: 'PB-7', pending: 60000n });
    const form = settleFormFor(b, s.vouchers, s.masters(), s.paymentType(), '2024-05-01')!;
    expect(form.accountLabel).toBe('HDFC');
    expect(form.narration).toBe('Paid against bill PB-7 dated 10-Apr-2024');
    expect(form.lines).toHaveLength(1);
    expect(form.lines[0]).toMatchObject({ label: 'Steel Co', side: 'debit', amount: '600.00', allocations: [{ kind: 'against', ref: 'PB-7', amount: '600.00' }] });
  });

  it('a party never paid before: the account anyone was last paid from', () => {
    const s = setup();
    const b = s.bill('steel', 'PB-8', '250');
    s.pay('sbi', 'other', '10', [{ kind: 'onAccount', amount: '10' }]);
    expect(settleFormFor(b, s.vouchers, s.masters(), s.paymentType(), '2024-05-01')?.accountLabel).toBe('SBI');
  });

  it('nothing to settle once the bill is paid in full', () => {
    const s = setup();
    const b = s.bill('steel', 'PB-9', '300');
    s.pay('hdfc', 'steel', '300', [{ kind: 'against', ref: 'PB-9', amount: '300' }]);
    expect(pendingBillOf(b, s.vouchers, s.masters())).toBeUndefined();
    expect(settleFormFor(b, s.vouchers, s.masters(), s.paymentType(), '2024-05-01')).toBeUndefined();
  });
});
