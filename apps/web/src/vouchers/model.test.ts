import { type Masters, type Voucher, type VoucherId, deterministicUuid, localDate, prepareMasterCommand, prepareVoucher, defaultVoucherKinds, seedCompany } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { formatAmount, formatBalance, formatCashBalance, formatDate, normalizeAmount, parseDateInput, weekday } from './format';
import {
  type VoucherForm,
  blankForm,
  blankLine,
  fieldOfPath,
  formFromVoucher,
  formToDraft,
  isBlank,
  layoutOf,
  ledgerChoices,
  previewVoucher,
  switchType,
  totalsOf,
} from './model';

const newId = (n: string) => deterministicUuid(`m|${n}`);

function company() {
  let masters: Masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
  const add = (name: string, group: string) => {
    const r = prepareMasterCommand({ op: 'create', kind: 'ledger', id: newId(`l:${name}`), data: { name, groupId: newId(`group:${group}`) } }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
    return newId(`l:${name}`);
  };
  const L = { bank: add('HDFC', 'bank-accounts'), rent: add('Rent', 'indirect-expenses'), power: add('Power', 'indirect-expenses'), steel: add('Steel', 'sundry-creditors') };
  const type = (kind: string) => masters.voucherTypes.find((t) => t.baseKind === kind)!.id as string;
  return { L, m: () => masters, type };
}

const line = (ledgerId: string, label: string, amount: string, side: 'debit' | 'credit' = 'debit') => ({ ...blankLine(side), ledgerId, label, amount });

describe('amounts and dates as people type them', () => {
  it.each([
    [0n, '0.00'], [5n, '0.05'], [123456n, '1,234.56'], [10000000n, '1,00,000.00'], [85000000n, '8,50,000.00'], [123456789n, '12,34,567.89'], [-2500n, '-25.00'],
  ])('formats %s paise as %s (Indian grouping)', (m, text) => expect(formatAmount(m)).toBe(text));

  it('shows a cash or bank balance with an explicit sign as well as Dr/Cr', () => {
    expect(formatCashBalance(60000n)).toBe('+₹600.00 Dr'); // money available
    expect(formatCashBalance(-60000n)).toBe('−₹600.00 Cr'); // overdrawn
    expect(formatCashBalance(85000000n)).toBe('+₹8,50,000.00 Dr');
    expect(formatCashBalance(0n)).toBe('₹0.00');
    // the accounting reading is untouched
    expect(formatBalance(60000n)).toBe('600.00 Dr');
    expect(formatBalance(-60000n)).toBe('600.00 Cr');
  });

  it('shows a balance with Dr/Cr', () => {
    expect(formatBalance(85000000n)).toBe('8,50,000.00 Dr');
    expect(formatBalance(-120000n)).toBe('1,200.00 Cr');
    expect(formatBalance(0n)).toBe('0.00');
  });

  it.each([['12,000', '12000.00'], [' 1 200.5 ', '1200.50'], ['₹99', '99.00'], ['0.05', '0.05']])('reads %j as %s', (typed, out) => expect(normalizeAmount(typed)).toBe(out));
  it.each(['', 'abc', '12.345', '1.2.3', '-5'])('does not read %j as an amount', (typed) => expect(normalizeAmount(typed)).toBeUndefined());

  const ctx = { start: '2024-04-01', end: '2025-03-31', base: '2024-05-10' };
  it.each([
    ['15', '2024-05-15'], ['3-6', '2024-06-03'], ['3/6/24', '2024-06-03'], ['03.06.2024', '2024-06-03'], ['2024-05-10', '2024-05-10'],
    ['5-1', '2025-01-05'], // January belongs to the NEXT calendar year of an April–March year
    ['10 5', '2024-05-10'],
    ['10-May-2024', '2024-05-10'], ['3-jun-24', '2024-06-03'], ['15 May', '2024-05-15'], ['5-January', '2025-01-05'], // the window's own format, month by name
  ])('reads the date %j as %s', (typed, iso) => expect(parseDateInput(typed, ctx)).toBe(iso));
  it.each(['', 'abc', '32', '31-2', '5-13', '1-2-3-4', '2024-02-30', '10-Foo-2024', 'May-10', '10-May-20x4', 'Ten'])('refuses the date %j', (typed) => expect(parseDateInput(typed, ctx)).toBeUndefined());

  it('writes dates the way people read them', () => {
    expect(formatDate('2024-05-10')).toBe('10-May-2024');
    expect(weekday('2024-05-10')).toBe('Fri');
  });
});

describe('form → draft', () => {
  it('builds a Payment draft, dropping the empty trailing line and tolerating typed commas', () => {
    const c = company();
    const form: VoucherForm = { ...blankForm('id1', c.type('payment'), '2024-05-10'), accountId: c.L.bank, accountLabel: 'HDFC', narration: ' May ', lines: [line(c.L.rent, 'Rent', '12,000'), blankLine()] };
    const { draft, kept } = formToDraft(form, 'single-entry');
    expect(draft).toEqual({ id: 'id1', voucherTypeId: c.type('payment'), date: '2024-05-10', narration: 'May', accountLedgerId: c.L.bank, lines: [{ ledgerId: c.L.rent, amount: '12000.00' }] });
    expect(kept).toEqual([0]);
  });

  it('builds a Journal draft with sides', () => {
    const c = company();
    const form: VoucherForm = { ...blankForm('j', c.type('journal'), '2024-05-10'), lines: [line(c.L.rent, 'Rent', '5', 'debit'), line(c.L.steel, 'Steel', '5', 'credit')] };
    expect(formToDraft(form, 'double-entry').draft).toMatchObject({ entries: [{ ledgerId: c.L.rent, side: 'debit', amount: '5.00' }, { ledgerId: c.L.steel, side: 'credit', amount: '5.00' }] });
  });

  it('carries bill-wise parts and party details, and leaves out blank parts', () => {
    const c = company();
    const l = { ...line(c.L.steel, 'Steel', '100'), allocations: [{ kind: 'new' as const, ref: 'B1', dueDate: '2024-06-01', amount: '100' }, { kind: 'onAccount' as const, ref: '', dueDate: '', amount: '' }] };
    const form: VoucherForm = { ...blankForm('p', c.type('payment'), '2024-05-10'), accountId: c.L.bank, lines: [l], partyDetails: { mailingName: 'Steel Co' } };
    const { draft } = formToDraft(form, 'single-entry');
    expect(draft['partyDetails']).toEqual({ mailingName: 'Steel Co' });
    expect((draft['lines'] as { allocations: unknown[] }[])[0]?.allocations).toEqual([{ kind: 'new', ref: 'B1', dueDate: '2024-06-01', amount: '100.00' }]);
  });
});

describe('preview: the same engine as the server, with problems on their fields', () => {
  it('accepts a good Payment and computes totals', () => {
    const c = company();
    const form: VoucherForm = { ...blankForm('p', c.type('payment'), '2024-05-10'), accountId: c.L.bank, lines: [line(c.L.rent, 'Rent', '12000'), line(c.L.power, 'Power', '3450')] };
    const p = previewVoucher(form, 'single-entry', c.m());
    expect(p).toMatchObject({ ok: true, issues: [], debit: 1545000n, credit: 1545000n, balanced: true });
  });

  it('says kindly what is missing, on the field', () => {
    const c = company();
    const form: VoucherForm = { ...blankForm('p', c.type('payment'), '2024-05-10'), lines: [line('', '', '50'), line(c.L.rent, 'Rent', '')] };
    const p = previewVoucher(form, 'single-entry', c.m());
    expect(p.ok).toBe(false);
    expect(p.issues.map((i) => [i.field, i.message])).toEqual([
      ['account', 'Choose the account (cash or bank)'],
      ['line.0.ledger', 'Choose a ledger'],
      ['line.1.amount', 'Enter an amount'],
    ]);
  });

  it('puts an engine rule on the exact line, counting only the lines actually sent', () => {
    const c = company();
    // an empty line first: the engine sees "lines.0" = the SECOND form line; the issue must still land on form line 1
    const form: VoucherForm = { ...blankForm('p', c.type('payment'), '2024-05-10'), accountId: c.L.bank, lines: [blankLine(), line(c.L.bank, 'HDFC', '5')] };
    const p = previewVoucher(form, 'single-entry', c.m());
    expect(p.issues.map((i) => [i.field, i.code])).toEqual([['line.1.ledger', 'SAME_LEDGER_BOTH_SIDES']]);
  });

  it('a Journal must balance, and refuses cash/bank', () => {
    const c = company();
    const j: VoucherForm = { ...blankForm('j', c.type('journal'), '2024-05-10'), lines: [line(c.L.rent, 'Rent', '10', 'debit'), line(c.L.steel, 'Steel', '4', 'credit')] };
    const p = previewVoucher(j, 'double-entry', c.m());
    expect(p).toMatchObject({ ok: false, balanced: false, debit: 1000n, credit: 400n });
    expect(p.issues[0]).toMatchObject({ field: 'general', code: 'UNBALANCED' });
    const cash: VoucherForm = { ...j, lines: [line(c.L.bank, 'HDFC', '10', 'debit'), line(c.L.steel, 'Steel', '10', 'credit')] };
    expect(previewVoucher(cash, 'double-entry', c.m()).issues[0]).toMatchObject({ field: 'line.0.ledger', code: 'CASH_BANK_IN_JOURNAL' });
    expect(previewVoucher({ ...j, lines: [line(c.L.rent, 'Rent', '10', 'debit'), line(c.L.steel, 'Steel', '10', 'credit')] }, 'double-entry', c.m())).toMatchObject({ ok: true, balanced: true });
  });

  it('a date outside the financial year is refused on the date field', () => {
    const c = company();
    const form: VoucherForm = { ...blankForm('p', c.type('payment'), '2030-01-01'), accountId: c.L.bank, lines: [line(c.L.rent, 'Rent', '5')] };
    expect(previewVoucher(form, 'single-entry', c.m()).issues[0]?.field).toBe('date');
  });

  it('bill-wise problems land on the party line', () => {
    const c = company();
    const bad = { ...line(c.L.steel, 'Steel', '100'), allocations: [{ kind: 'new' as const, ref: 'A', dueDate: '', amount: '60' }] };
    const form: VoucherForm = { ...blankForm('p', c.type('payment'), '2024-05-10'), accountId: c.L.bank, lines: [bad] };
    expect(previewVoucher(form, 'single-entry', c.m()).issues.map((i) => i.field)).toEqual(['line.0.alloc']);
  });

  it('maps every path shape', () => {
    expect(fieldOfPath('date', [])).toBe('date');
    expect(fieldOfPath('accountLedgerId', [])).toBe('account');
    expect(fieldOfPath('lines.1.amount', [0, 3])).toBe('line.3.amount');
    expect(fieldOfPath('entries.0.allocations.1.ref', [2])).toBe('line.2.alloc');
    expect(fieldOfPath('partyDetails.gstin', [])).toBe('party.gstin');
    expect(fieldOfPath('lines', [])).toBe('general');
    expect(fieldOfPath(undefined, [])).toBe('general');
  });
});

describe('totals, switching, choices, round trip', () => {
  it('totals by layout', () => {
    const c = company();
    const single: VoucherForm = { ...blankForm('p', c.type('payment'), '2024-05-10'), lines: [line(c.L.rent, 'R', '10'), line(c.L.power, 'P', '2.50')] };
    expect(totalsOf(single, 'single-entry')).toEqual({ debit: 1250n, credit: 1250n });
    const journal: VoucherForm = { ...single, lines: [line(c.L.rent, 'R', '10', 'debit'), line(c.L.steel, 'S', '7', 'credit')] };
    expect(totalsOf(journal, 'double-entry')).toEqual({ debit: 1000n, credit: 700n });
  });

  it('switching within a layout keeps everything; across layouts the account is cleared and the user told', () => {
    const c = company();
    const form: VoucherForm = { ...blankForm('p', c.type('payment'), '2024-05-10'), accountId: c.L.bank, accountLabel: 'HDFC', narration: 'n', lines: [line(c.L.rent, 'Rent', '5')] };
    const toReceipt = switchType(form, 'single-entry', 'single-entry', c.type('receipt'));
    expect(toReceipt.form).toMatchObject({ typeId: c.type('receipt'), accountId: c.L.bank, narration: 'n' });
    expect(toReceipt.note).toBeUndefined();
    const toJournal = switchType(form, 'single-entry', 'double-entry', c.type('journal'));
    expect(toJournal.form).toMatchObject({ accountId: '', lines: form.lines, narration: 'n', date: '2024-05-10' });
    expect(toJournal.note).toContain('HDFC');
    expect(switchType({ ...form, accountId: '', accountLabel: '' }, 'single-entry', 'double-entry', c.type('journal')).note).toBeUndefined();
  });

  it('knows each type’s layout', () => {
    const c = company();
    expect(layoutOf(c.m(), c.type('payment'))).toBe('single-entry');
    expect(layoutOf(c.m(), c.type('contra'))).toBe('single-entry');
    expect(layoutOf(c.m(), c.type('journal'))).toBe('double-entry');
    expect(layoutOf(c.m(), c.type('opening'))).toBeUndefined();
    expect(layoutOf(c.m(), 'nope')).toBeUndefined();
  });

  it('pickers offer only what the engine would accept', () => {
    const c = company();
    const names = (role: Parameters<typeof ledgerChoices>[1]) => ledgerChoices(c.m(), role).map((l) => l.name).sort();
    expect(names('account')).toEqual(['Cash', 'HDFC']);
    expect(names('contra-particular')).toEqual(['Cash', 'HDFC']);
    expect(names('journal')).toEqual(['Power', 'Rent', 'Steel']);
    expect(names('particular')).toEqual(['Cash', 'HDFC', 'Power', 'Rent', 'Steel']); // never the built-in difference ledger
    expect(ledgerChoices(c.m(), 'particular', c.L.bank).map((l) => l.name)).not.toContain('HDFC');
  });

  it('a posted voucher comes back as the same form (display and alter)', () => {
    const c = company();
    const form: VoucherForm = { ...blankForm('rt', c.type('payment'), '2024-05-10'), accountId: c.L.bank, narration: 'May', lines: [line(c.L.rent, 'Rent', '12000'), line(c.L.power, 'Power', '3450.50')] };
    const r = prepareVoucher(formToDraft(form, 'single-entry').draft, c.m(), defaultVoucherKinds());
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const voucher: Voucher = { id: 'rt' as VoucherId, companyId: c.m().company.id, voucherTypeId: r.value.voucherType.id, financialYearId: r.value.financialYear.id, number: 'PAY/1', date: r.value.draft.date, status: 'posted', version: 1, revision: 0, content: r.value.draft };
    const back = formFromVoucher(voucher, c.m());
    expect(back).toMatchObject({ id: 'rt', date: '2024-05-10', narration: 'May', accountId: c.L.bank, accountLabel: 'HDFC' });
    expect(back.lines.map((l) => [l.label, l.amount])).toEqual([['Rent', '12000.00'], ['Power', '3450.50']]);
    expect(formToDraft(back, 'single-entry').draft).toEqual(formToDraft(form, 'single-entry').draft); // identical draft ⇒ altering unchanged = a no-op
  });

  it('knows a form with nothing entered is blank', () => {
    const c = company();
    expect(isBlank(blankForm('x', c.type('payment'), '2024-05-10'))).toBe(true);
    expect(isBlank({ ...blankForm('x', c.type('payment'), '2024-05-10'), narration: 'hi' })).toBe(false);
  });
});

describe('a Receipt is entered the way the payment advice reads: received + TDS', () => {
  const receiptForm = (received: string, rows: { ref: string; amount: string; tds?: string }[]): VoucherForm => {
    const c = company();
    return {
      ...blankForm('r1', c.type('receipt'), '2024-05-01'),
      accountId: c.L.bank,
      accountLabel: 'HDFC',
      lines: [{ ...line(c.L.steel, 'Steel', received, 'credit'), allocations: rows.map((r) => ({ kind: 'against' as const, ref: r.ref, dueDate: '', amount: r.amount, ...(r.tds ? { tds: r.tds } : {}) })) }],
    };
  };

  it('850 received and 5 TDS settles the bill by 855: the draft carries the settled amount, the TDS beside it', () => {
    const { draft } = formToDraft(receiptForm('850', [{ ref: 'INV-1', amount: '850', tds: '5' }]), 'single-entry');
    const l = (draft.lines as { amount: string; allocations: { amount: string; tds: string }[] }[])[0];
    expect(l?.amount).toBe('855.00');
    expect(l?.allocations[0]).toMatchObject({ kind: 'against', ref: 'INV-1', amount: '855.00', tds: '5.00' });
  });

  it('two invoices: 1,490 received, 5 TDS on each (745 + 5), each bill settled by 750 and the line by 1,500', () => {
    const { draft } = formToDraft(receiptForm('1490', [{ ref: 'A', amount: '745', tds: '5' }, { ref: 'B', amount: '745', tds: '5' }]), 'single-entry');
    const l = (draft.lines as { amount: string; allocations: { amount: string; tds: string }[] }[])[0];
    expect(l?.amount).toBe('1500.00');
    expect(l?.allocations.map((a) => [a.amount, a.tds])).toEqual([['750.00', '5.00'], ['750.00', '5.00']]);
  });

  it('a row with no TDS, or a payment, is exactly as typed', () => {
    const { draft } = formToDraft(receiptForm('500', [{ ref: 'A', amount: '500' }]), 'single-entry');
    const l = (draft.lines as { amount: string; allocations: { amount: string; tds?: string }[] }[])[0];
    expect(l?.amount).toBe('500.00');
    expect(l?.allocations[0]?.amount).toBe('500.00');
    expect(l?.allocations[0]?.tds).toBeUndefined();
  });

  it('the Total under the grid is what was received; the form shows a stored receipt the same way it was typed', () => {
    const form = receiptForm('850', [{ ref: 'INV-1', amount: '850', tds: '5' }]);
    expect(totalsOf(form, 'single-entry')).toEqual({ debit: 85000n, credit: 85000n });
    const voucher = {
      id: 'v1',
      voucherTypeId: form.typeId,
      date: '2024-05-01',
      content: { accountLedgerId: form.accountId, lines: [{ ledgerId: form.lines[0]?.ledgerId, amount: 85500n, allocations: [{ kind: 'against', ref: 'INV-1', amount: 85500n, tds: 500n }] }] },
    } as unknown as Voucher;
    const back = formFromVoucher(voucher, company().m());
    expect(back.lines[0]?.amount).toBe('850.00'); // 855 settled − 5 TDS
    expect(back.lines[0]?.allocations[0]).toMatchObject({ ref: 'INV-1', amount: '850.00', tds: '5.00' });
  });
});

