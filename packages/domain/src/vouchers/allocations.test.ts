import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { IssueCode } from '../errors';
import { deterministicUuid } from '../ids';
import type { LedgerId, VoucherId } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import type { Masters } from '../masters/masters';
import { gstinCheckChar } from '../masters/rules';
import { seedCompany } from '../masters/seed';
import { prepareVoucher } from '../posting/engine';
import { allocatedLinesOf, openBills } from './allocations';
import { defaultVoucherKinds } from './registry';
import type { Voucher } from './voucher';

const newId = (n: string) => deterministicUuid(`a|${n}`);
const registry = defaultVoucherKinds();
const gstin = (p: string) => p + gstinCheckChar(p);

function setup() {
  let masters: Masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
  const add = (kind: string, id: string, data: unknown) => {
    const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
  };
  const g = (k: string) => newId(`group:${k}`);
  add('party', newId('p:abc'), { name: 'ABC Industries', gstin: gstin('27AAPFU0939F1Z') });
  add('ledger', newId('l:bank'), { name: 'HDFC', groupId: g('bank-accounts') });
  add('ledger', newId('l:abc'), { name: 'ABC Industries', groupId: g('sundry-debtors'), partyId: newId('p:abc') });
  add('ledger', newId('l:steel'), { name: 'Steel Supplies', groupId: g('sundry-creditors') });
  add('ledger', newId('l:rent'), { name: 'Rent', groupId: g('indirect-expenses') });
  const L = { bank: newId('l:bank'), abc: newId('l:abc'), steel: newId('l:steel'), rent: newId('l:rent') };
  const vouchers: Voucher[] = [];
  let n = 0;
  const post = (kind: string, date: string, body: Record<string, unknown>) => {
    const type = masters.voucherTypes.find((t) => t.baseKind === kind)!;
    const id = newId(`v${++n}`);
    const r = prepareVoucher({ id, voucherTypeId: type.id, date, ...body }, masters, registry);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    vouchers.push({
      id: id as VoucherId, companyId: masters.company.id, voucherTypeId: type.id, financialYearId: r.value.financialYear.id,
      number: `${n}`, date: r.value.draft.date, status: 'posted', version: 1, revision: 0, content: r.value.draft,
    });
  };
  const check = (kind: string, body: Record<string, unknown>) => {
    const type = masters.voucherTypes.find((t) => t.baseKind === kind)!;
    const r = prepareVoucher({ id: newId('chk'), voucherTypeId: type.id, date: '2024-05-10', ...body }, masters, registry);
    return r.ok ? [] : r.issues;
  };
  return { L, post, check, vouchers, m: () => masters };
}

const codes = (issues: readonly { code: string }[]) => issues.map((i) => i.code);

describe('bill-wise allocations: what makes them valid', () => {
  it('a new bill on a supplier line that adds up is accepted', () => {
    const s = setup();
    const issues = s.check('payment', {
      accountLedgerId: s.L.bank,
      lines: [{ ledgerId: s.L.steel, amount: '1000', allocations: [{ kind: 'new', ref: 'ADV-1', dueDate: '2024-06-15', amount: '1000' }] }],
    });
    expect(issues).toEqual([]);
  });

  it('a split across against / new / on account must add up to the line', () => {
    const s = setup();
    const ok = s.check('receipt', {
      accountLedgerId: s.L.bank,
      lines: [{ ledgerId: s.L.abc, amount: '1000', allocations: [{ kind: 'against', ref: 'INV-1', amount: '600' }, { kind: 'onAccount', amount: '400' }] }],
    });
    expect(ok).toEqual([]);
    const off = s.check('receipt', {
      accountLedgerId: s.L.bank,
      lines: [{ ledgerId: s.L.abc, amount: '1000', allocations: [{ kind: 'against', ref: 'INV-1', amount: '600' }, { kind: 'onAccount', amount: '300' }] }],
    });
    expect(off.map((i) => [i.code, i.path])).toEqual([[IssueCode.AllocationInvalid, 'lines.0.allocations']]);
    expect(off[0]?.message).toContain('900.00');
  });

  it('is refused on a ledger that is not a customer or supplier', () => {
    const s = setup();
    const issues = s.check('payment', {
      accountLedgerId: s.L.bank,
      lines: [{ ledgerId: s.L.rent, amount: '10', allocations: [{ kind: 'new', ref: 'X', amount: '10' }] }],
    });
    expect(codes(issues)).toEqual([IssueCode.AllocationInvalid]);
  });

  it('a new or against part needs a reference; a due date belongs only to a new bill; parts must be positive', () => {
    const s = setup();
    const at = (allocations: unknown[]) =>
      s.check('payment', { accountLedgerId: s.L.bank, lines: [{ ledgerId: s.L.steel, amount: '100', allocations }] }).map((i) => i.path);
    expect(at([{ kind: 'new', amount: '100' }])).toEqual(['lines.0.allocations.0.ref']);
    expect(at([{ kind: 'against', ref: ' ', amount: '100' }])).toEqual(['lines.0.allocations.0.ref']);
    expect(at([{ kind: 'advance', dueDate: '2024-06-01', amount: '100' }])).toEqual(['lines.0.allocations.0.dueDate']);
    expect(at([{ kind: 'onAccount', amount: '0' }, { kind: 'onAccount', amount: '100' }])).toContain('lines.0.allocations.0.amount');
  });

  it('a journal entry can carry them too, and so can an opening balance', () => {
    const s = setup();
    expect(
      s.check('journal', {
        entries: [
          { ledgerId: s.L.rent, side: 'debit', amount: '500' },
          { ledgerId: s.L.steel, side: 'credit', amount: '500', allocations: [{ kind: 'new', ref: 'BILL-9', amount: '500' }] },
        ],
      }),
    ).toEqual([]);
    const opening = s.m().voucherTypes.find((t) => t.baseKind === 'opening')!;
    const r = prepareVoucher(
      { id: newId('ob'), voucherTypeId: opening.id, date: '2024-04-01', ledgerId: s.L.abc, side: 'debit', amount: '5000', offsetLedgerId: s.m().openingDifferenceLedger()!.id, allocations: [{ kind: 'new', ref: 'OB-1', dueDate: '2024-04-30', amount: '5000' }] },
      s.m(),
      registry,
    );
    expect(r.ok).toBe(true);
  });

  it('bill-wise details never change the journal: the same lines post either way', () => {
    const s = setup();
    const plain = { accountLedgerId: s.L.bank, lines: [{ ledgerId: s.L.steel, amount: '1000' }] };
    const billed = { accountLedgerId: s.L.bank, lines: [{ ledgerId: s.L.steel, amount: '1000', allocations: [{ kind: 'new', ref: 'A', amount: '1000' }] }] };
    const type = s.m().voucherTypes.find((t) => t.baseKind === 'payment')!;
    const plan = (b: object) => {
      const r = prepareVoucher({ id: newId('same'), voucherTypeId: type.id, date: '2024-05-10', ...b }, s.m(), registry);
      if (!r.ok) throw new Error('x');
      return r.value.plan.journal.map((l) => [l.ledgerId, l.side, l.amount]);
    };
    expect(plan(billed)).toEqual(plan(plain));
  });
});

describe('open bills', () => {
  it('a new bill is open until settled; part payments reduce it; full payment closes it', () => {
    const s = setup();
    s.post('journal', '2024-04-10', {
      entries: [{ ledgerId: s.L.rent, side: 'debit', amount: '1000' }, { ledgerId: s.L.steel, side: 'credit', amount: '1000', allocations: [{ kind: 'new', ref: 'PO-1', dueDate: '2024-05-10', amount: '1000' }] }],
    });
    expect(openBills(s.vouchers, s.m(), s.L.steel as LedgerId)).toMatchObject([{ ref: 'PO-1', pending: 100000n, side: 'credit', dueDate: '2024-05-10' }]);

    s.post('payment', '2024-05-01', { accountLedgerId: s.L.bank, lines: [{ ledgerId: s.L.steel, amount: '400', allocations: [{ kind: 'against', ref: 'PO-1', amount: '400' }] }] });
    expect(openBills(s.vouchers, s.m(), s.L.steel as LedgerId)[0]?.pending).toBe(60000n);

    s.post('payment', '2024-05-02', { accountLedgerId: s.L.bank, lines: [{ ledgerId: s.L.steel, amount: '600', allocations: [{ kind: 'against', ref: 'PO-1', amount: '600' }] }] });
    expect(openBills(s.vouchers, s.m(), s.L.steel as LedgerId)).toEqual([]);
  });

  it('a customer bill settled by receipts works the other way round', () => {
    const s = setup();
    s.post('journal', '2024-04-10', {
      entries: [{ ledgerId: s.L.abc, side: 'debit', amount: '2000', allocations: [{ kind: 'new', ref: 'INV-7', amount: '2000' }] }, { ledgerId: s.L.rent, side: 'credit', amount: '2000' }],
    });
    s.post('receipt', '2024-04-20', { accountLedgerId: s.L.bank, lines: [{ ledgerId: s.L.abc, amount: '500', allocations: [{ kind: 'against', ref: 'INV-7', amount: '500' }] }] });
    expect(openBills(s.vouchers, s.m(), s.L.abc as LedgerId)).toMatchObject([{ ref: 'INV-7', pending: 150000n, side: 'debit' }]);
  });

  it('a cancelled voucher counts for nothing, and a voucher being altered can be ignored', () => {
    const s = setup();
    s.post('journal', '2024-04-10', {
      entries: [{ ledgerId: s.L.rent, side: 'debit', amount: '100' }, { ledgerId: s.L.steel, side: 'credit', amount: '100', allocations: [{ kind: 'new', ref: 'B1', amount: '100' }] }],
    });
    const original = s.vouchers[0]!;
    expect(openBills(s.vouchers, s.m(), s.L.steel as LedgerId, original.id)).toEqual([]); // altering it: its own bill is not "existing"
    s.vouchers[0] = { ...original, status: 'cancelled' };
    expect(openBills(s.vouchers, s.m(), s.L.steel as LedgerId)).toEqual([]);
  });

  it('only this ledger’s bills, and an on-account/advance part raises no bill', () => {
    const s = setup();
    s.post('payment', '2024-05-01', {
      accountLedgerId: s.L.bank,
      lines: [{ ledgerId: s.L.steel, amount: '100', allocations: [{ kind: 'advance', ref: 'ADV', amount: '100' }] }, { ledgerId: s.L.rent, amount: '5' }],
    });
    expect(openBills(s.vouchers, s.m(), s.L.steel as LedgerId)).toEqual([]);
    expect(openBills(s.vouchers, s.m(), s.L.abc as LedgerId)).toEqual([]);
  });

  it('reads the party lines of each kind of voucher with the side they were posted on', () => {
    const s = setup();
    s.post('payment', '2024-05-01', { accountLedgerId: s.L.bank, lines: [{ ledgerId: s.L.steel, amount: '100', allocations: [{ kind: 'new', ref: 'P', amount: '100' }] }] });
    s.post('receipt', '2024-05-02', { accountLedgerId: s.L.bank, lines: [{ ledgerId: s.L.abc, amount: '100', allocations: [{ kind: 'new', ref: 'R', amount: '100' }] }] });
    expect(allocatedLinesOf(s.vouchers[0]!, s.m()).map((l) => l.side)).toEqual(['debit']);
    expect(allocatedLinesOf(s.vouchers[1]!, s.m()).map((l) => l.side)).toEqual(['credit']);
  });
});

describe('party details on a voucher', () => {
  const details = (over: Record<string, unknown>) => ({ partyId: undefined, ...over });
  const check = (over: Record<string, unknown>) => {
    const s = setup();
    return s.check('journal', {
      entries: [{ ledgerId: s.L.rent, side: 'debit', amount: '5' }, { ledgerId: s.L.steel, side: 'credit', amount: '5' }],
      partyDetails: details(over),
    });
  };

  it('accepts a complete, consistent snapshot; ship-to may differ from bill-to', () => {
    expect(
      check({
        mailingName: 'ABC Industries',
        billTo: { lines: 'Plot 14, MIDC Bhosari, Pune', stateCode: '27', country: 'India' },
        shipTo: { name: 'ABC — Chakan unit', lines: 'Gat 45, Chakan', stateCode: '27' },
        gstRegistration: 'regular',
        gstin: gstin('27AAPFU0939F1Z'),
        placeOfSupply: '27',
      }),
    ).toEqual([]);
  });

  it('may be omitted entirely, or partly filled', () => {
    expect(check({})).toEqual([]);
    expect(check({ mailingName: 'Cash customer', gstRegistration: 'unregistered' })).toEqual([]);
  });

  it.each([
    ['a wrong GSTIN check digit', { gstin: '27AAPFU0939F1ZA' }, 'partyDetails.gstin', IssueCode.InvalidGstin],
    ['a GSTIN on an unregistered party', { gstRegistration: 'unregistered', gstin: gstin('27AAPFU0939F1Z') }, 'partyDetails.gstin', IssueCode.PartyDetailsInvalid],
    ['a billing state that disagrees with the GSTIN', { gstin: gstin('27AAPFU0939F1Z'), billTo: { stateCode: '29' } }, 'partyDetails.billTo.stateCode', IssueCode.InvalidGstin],
    ['a ship-to state that is not a GST state', { shipTo: { stateCode: '55' } }, 'partyDetails.shipTo.stateCode', IssueCode.PartyDetailsInvalid],
    ['a place of supply that is not a GST state', { placeOfSupply: '00' }, 'partyDetails.placeOfSupply', IssueCode.PartyDetailsInvalid],
    ['a party that does not exist', { partyId: 'ghost' }, 'partyDetails.partyId', IssueCode.PartyDetailsInvalid],
  ])('refuses %s, on the right field', (_w, over, path, code) => {
    const issues = check(over);
    expect(issues.map((i) => [i.path, i.code])).toEqual([[path, code]]);
  });

  it('a snapshot survives editing the party afterwards (it is a copy, not a link)', () => {
    const s = setup();
    s.post('journal', '2024-05-10', {
      entries: [{ ledgerId: s.L.rent, side: 'debit', amount: '5' }, { ledgerId: s.L.steel, side: 'credit', amount: '5' }],
      partyDetails: { partyId: newId('p:abc'), mailingName: 'ABC Industries', billTo: { lines: 'Old address', stateCode: '27' } },
    });
    const altered = prepareMasterCommand({ op: 'alter', kind: 'party', id: newId('p:abc'), data: { name: 'ABC Industries', address: 'New address' } }, s.m());
    expect(altered.ok).toBe(true);
    expect((s.vouchers[0]?.content as { partyDetails?: { billTo?: { lines?: string } } }).partyDetails?.billTo?.lines).toBe('Old address');
  });
});

describe('the party master: GST registration and saved addresses', () => {
  const base = () => setup();
  const alter = (m: Masters, data: Record<string, unknown>) => prepareMasterCommand({ op: 'alter', kind: 'party', id: newId('p:abc'), data: { name: 'ABC Industries', ...data } }, m);

  it('stores a registration type and an address book', () => {
    const s = base();
    const r = alter(s.m(), {
      gstRegistration: 'regular',
      addresses: [{ id: 'a1', label: 'Head office', lines: 'Plot 14, Pune', stateCode: '27' }, { id: 'a2', label: 'Chakan unit', lines: 'Gat 45', stateCode: '27', pincode: '410501' }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const p = r.value.masters.parties[0]!;
    expect(p.gstRegistration).toBe('regular');
    expect(p.addresses?.map((a) => a.label)).toEqual(['Head office', 'Chakan unit']);
  });

  it('altering the profile from the form keeps the saved addresses', () => {
    const s = base();
    const withBook = alter(s.m(), { addresses: [{ id: 'a1', label: 'Head office', lines: 'Plot 14' }] });
    if (!withBook.ok) throw new Error('x');
    const again = alter(withBook.value.masters, { phone: '9820012345' });
    if (!again.ok) throw new Error(JSON.stringify(again.issues));
    expect(again.value.masters.parties[0]?.addresses).toHaveLength(1);
  });

  it('refuses two addresses with one label, a bad state and an unknown registration type', () => {
    const s = base();
    const dup = alter(s.m(), { addresses: [{ id: 'a', label: 'Office', lines: 'x' }, { id: 'b', label: 'office', lines: 'y' }] });
    expect(!dup.ok && dup.issues[0]?.code).toBe(IssueCode.NameTaken);
    const bad = alter(s.m(), { addresses: [{ id: 'a', label: 'Office', lines: 'x', stateCode: '77' }] });
    expect(!bad.ok && bad.issues[0]?.path).toBe('addresses.0.stateCode');
    expect(alter(s.m(), { gstRegistration: 'sometimes' }).ok).toBe(false);
  });
});
