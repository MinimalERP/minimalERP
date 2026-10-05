import { type Masters, type Voucher, type VoucherId, defaultVoucherKinds, deterministicUuid, localDate, openBills, prepareMasterCommand, prepareVoucher, seedCompany } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { creditsOf, planCredit, unappliedOf, withCreditApplied } from './applyCredit';

const newId = (n: string) => deterministicUuid(`credit|${n}`);

function setup() {
  let masters: Masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
  const add = (kind: string, id: string, data: unknown) => {
    const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
  };
  add('ledger', newId('hdfc'), { name: 'HDFC', groupId: newId('group:bank-accounts') });
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
    post('journal', '2024-04-25', { entries: [{ ledgerId: newId('rent'), side: 'debit', amount }, { ledgerId: newId(ledger), side: 'credit', amount, allocations: [{ kind: 'new', ref, dueDate: '2024-05-25', amount }] }] });
  const pay = (date: string, ledger: string, amount: string, allocations: object[]) =>
    post('payment', date, { accountLedgerId: newId('hdfc'), lines: [{ ledgerId: newId(ledger), amount, allocations }] });
  /** The altered content goes through the same validation a save does, and replaces the Payment in the books. */
  const alter = (payment: Voucher, content: unknown): Voucher => {
    const r = prepareVoucher(content, masters, defaultVoucherKinds());
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const v: Voucher = { ...payment, version: payment.version + 1, content: r.value.draft };
    vouchers[vouchers.indexOf(payment)] = v;
    return v;
  };
  const rows = (v: Voucher) => (v.content as unknown as { lines: { allocations: { kind: string; ref?: string; amount: bigint }[] }[] }).lines[0]!.allocations.map((a) => [a.kind, a.ref ?? '', a.amount]);
  const pending = (ledger: string) => openBills(vouchers, masters, newId(ledger) as never).map((b) => [b.ref, b.pending]);
  return { masters: () => masters, vouchers, bill, pay, alter, rows, pending, steel: newId('steel') };
}

describe('the credit a supplier holds', () => {
  it('is what its Payments still carry as Advance or On account, oldest first', () => {
    const s = setup();
    const late = s.pay('2024-04-20', 'steel', '250', [{ kind: 'onAccount', amount: '250' }]);
    const early = s.pay('2024-04-05', 'steel', '300', [{ kind: 'advance', amount: '300' }]);
    s.bill('steel', 'PB-1', '100');
    s.pay('2024-04-26', 'steel', '100', [{ kind: 'against', ref: 'PB-1', amount: '100' }]);
    s.pay('2024-04-06', 'other', '40', [{ kind: 'advance', amount: '40' }]);

    expect(creditsOf(s.vouchers, s.masters(), s.steel).map((c) => [c.voucher.id, c.unapplied])).toEqual([[early.id, 30000n], [late.id, 25000n]]);
    expect(unappliedOf(early, s.masters())).toEqual({ ledgerId: s.steel, unapplied: 30000n });
    expect(unappliedOf(s.vouchers[3]!, s.masters())).toBeUndefined();
  });
});

describe('who gives how much', () => {
  it('in order, each no more than it has, until the need is met', () => {
    expect(planCredit([{ id: 'a', amount: 30000n }, { id: 'b', amount: 25000n }, { id: 'c', amount: 10000n }], 42000n)).toEqual([{ id: 'a', amount: 30000n }, { id: 'b', amount: 12000n }]);
    expect(planCredit([{ id: 'a', amount: 100n }], 500n)).toEqual([{ id: 'a', amount: 100n }]);
  });
});

describe('applying an advance to bills', () => {
  it('all of it: the Advance row becomes Against ref, and the bill is settled by that much', () => {
    const s = setup();
    const adv = s.pay('2024-04-05', 'steel', '300', [{ kind: 'advance', amount: '300' }]);
    s.bill('steel', 'PB-1', '420');
    const after = s.alter(adv, withCreditApplied(adv, s.steel, [{ ref: 'PB-1', amount: 30000n }]));
    expect(s.rows(after)).toEqual([['against', 'PB-1', 30000n]]);
    expect(s.pending('steel')).toEqual([['PB-1', 12000n]]);
    expect(creditsOf(s.vouchers, s.masters(), s.steel)).toEqual([]);
  });

  it('part of it: the rest stays as it was', () => {
    const s = setup();
    const adv = s.pay('2024-04-05', 'steel', '300', [{ kind: 'onAccount', amount: '300' }]);
    s.bill('steel', 'PB-1', '120');
    const after = s.alter(adv, withCreditApplied(adv, s.steel, [{ ref: 'PB-1', amount: 12000n }]));
    expect(s.rows(after)).toEqual([['against', 'PB-1', 12000n], ['onAccount', '', 18000n]]);
    expect(s.pending('steel')).toEqual([]);
  });

  it('over two bills, the Advance used before the On account; a bill it already pays grows', () => {
    const s = setup();
    s.bill('steel', 'PB-1', '500');
    s.bill('steel', 'PB-2', '200');
    const adv = s.pay('2024-04-26', 'steel', '400', [{ kind: 'against', ref: 'PB-1', amount: '100' }, { kind: 'onAccount', amount: '200' }, { kind: 'advance', amount: '100' }]);
    const after = s.alter(adv, withCreditApplied(adv, s.steel, [{ ref: 'PB-1', amount: 15000n }, { ref: 'PB-2', amount: 10000n }]));
    expect(s.rows(after)).toEqual([['against', 'PB-1', 25000n], ['against', 'PB-2', 10000n], ['onAccount', '', 5000n]]);
    expect(s.pending('steel')).toEqual([['PB-1', 25000n], ['PB-2', 10000n]]);
  });

  it('never more than the Payment holds', () => {
    const s = setup();
    const adv = s.pay('2024-04-05', 'steel', '100', [{ kind: 'advance', amount: '100' }]);
    s.bill('steel', 'PB-1', '420');
    const after = s.alter(adv, withCreditApplied(adv, s.steel, [{ ref: 'PB-1', amount: 99900n }]));
    expect(s.rows(after)).toEqual([['against', 'PB-1', 10000n]]);
  });
});
