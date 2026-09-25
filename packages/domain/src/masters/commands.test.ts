import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { IssueCode } from '../errors';
import { deterministicUuid } from '../ids';
import { gstinCheckChar } from './rules';
import { seedCompany } from './seed';
import { type MasterKind, type MasterUsage, NO_USAGE, prepareMasterCommand, findMaster, seriesAdvanceIssues } from './commands';
import type { Masters } from './masters';

const newId = (name: string) => deterministicUuid(`t|${name}`);
const fresh = () => seedCompany({ name: 'Acme Works', fyStart: localDate('2024-04-01'), newId });
const gid = (key: string) => newId(`group:${key}`);

interface Step {
  masters: Masters;
  codes: string[];
  ok: boolean;
  replayed: boolean;
}

/** Runs a command and returns the next snapshot (unchanged if refused). */
function run(masters: Masters, op: 'create' | 'alter' | 'setActive', kind: MasterKind, id: string, data?: unknown, usage: MasterUsage = NO_USAGE, active?: boolean): Step {
  const r = prepareMasterCommand({ op, kind, id, data, ...(active === undefined ? {} : { active }) }, masters, usage);
  if (!r.ok) return { masters, codes: r.issues.map((i) => i.code), ok: false, replayed: false };
  return { masters: r.value.masters, codes: [], ok: true, replayed: r.value.change.replayed };
}
const create = (m: Masters, kind: MasterKind, id: string, data: unknown, usage?: MasterUsage) => run(m, 'create', kind, id, data, usage);
const alter = (m: Masters, kind: MasterKind, id: string, data: unknown, usage?: MasterUsage) => run(m, 'alter', kind, id, data, usage);
const setActive = (m: Masters, kind: MasterKind, id: string, active: boolean) => run(m, 'setActive', kind, id, undefined, NO_USAGE, active);

const issuesOf = (m: Masters, cmd: unknown, usage: MasterUsage = NO_USAGE) => {
  const r = prepareMasterCommand(cmd, m, usage);
  return r.ok ? [] : r.issues;
};

const validGstin = (prefix = '27AAPFU0939F1Z') => prefix + gstinCheckChar(prefix);

describe('a new company', () => {
  const m = fresh();

  it('starts with the standard chart, cash, the built-in difference ledger, GST slabs, units and a warehouse', () => {
    expect(m.groups.all).toHaveLength(28);
    // Cash, the built-in difference ledger, and the system ledgers GST and TDS post to (Phase 9, ADR-0019)
    expect(m.ledgers.map((l) => l.name).sort()).toEqual(['Cash', 'Input CGST', 'Input IGST', 'Input SGST', 'Opening Balance Difference', 'Output CGST', 'Output IGST', 'Output SGST', 'Round Off', 'TDS Receivable']);
    expect(m.openingDifferenceLedger()?.reservedKey).toBe('opening-difference');
    expect(m.gstRates.map((r) => r.ratePercent)).toEqual(['0', '5', '12', '18', '28']);
    expect(m.units.map((u) => u.symbol)).toEqual(['Nos', 'Kg', 'Ltr', 'Mtr', 'Box']);
    expect(m.warehouses).toHaveLength(1);
    expect(m.voucherTypes.map((t) => t.baseKind)).toEqual(['contra', 'payment', 'receipt', 'journal', 'opening', 'stockJournal', 'stockOpening', 'sales', 'salesOrder', 'quotation', 'purchase', 'purchaseOrder']);
    expect(m.series).toHaveLength(12);
  });

  it('has a financial year running exactly one year from the start date', () => {
    expect(m.financialYears[0]).toMatchObject({ label: '2024-25', start: '2024-04-01', end: '2025-03-31' });
    const leap = seedCompany({ name: 'x', fyStart: localDate('2023-04-01'), newId }).financialYears[0];
    expect(leap).toMatchObject({ start: '2023-04-01', end: '2024-03-31' });
    const calendar = seedCompany({ name: 'x', fyStart: localDate('2024-01-01'), newId }).financialYears[0];
    expect(calendar).toMatchObject({ label: '2024', start: '2024-01-01', end: '2024-12-31' });
  });

  it('numbers each voucher type from 0001 with a readable prefix', () => {
    expect(m.series.map((s) => s.prefix)).toEqual(['CON/24-25/', 'PAY/24-25/', 'REC/24-25/', 'JRN/24-25/', 'OB/', 'STJ/24-25/', 'OS/', 'SAL/24-25/', 'SO/24-25/', 'QT/24-25/', 'PUR/24-25/', 'PO/24-25/']);
  });

  it('is deterministic for the same ids', () => {
    expect(fresh().company.id).toBe(fresh().company.id);
  });
});

describe('the command envelope', () => {
  const m = fresh();
  it.each([
    ['not an object', 'nonsense'],
    ['unknown op', { op: 'delete', kind: 'ledger', id: 'x' }],
    ['unknown kind', { op: 'create', kind: 'spaceship', id: 'x' }],
    ['missing id', { op: 'create', kind: 'ledger' }],
    ['setActive without a target state is treated as deactivate, so needs a real record', { op: 'setActive', kind: 'ledger', id: 'nope' }],
  ])('rejects %s', (_n, cmd) => {
    expect(issuesOf(m, cmd)[0]?.code).toMatch(/SCHEMA_INVALID|MASTER_NOT_FOUND/);
  });

  it('a company cannot be created as a master — only altered', () => {
    expect(issuesOf(m, { op: 'create', kind: 'company', id: newId('c2'), data: { name: 'Other' } })[0]?.code).toBe(IssueCode.UnsupportedOperation);
  });
});

describe('ledgers and groups share one name space (as in Tally)', () => {
  const base = fresh();

  it('creates a ledger, trimming and collapsing spaces in its name', () => {
    const r = create(base, 'ledger', newId('l1'), { name: '  Rent   Paid ', groupId: gid('indirect-expenses') });
    expect(r.ok).toBe(true);
    expect(r.masters.ledgers.find((l) => l.id === newId('l1'))).toMatchObject({ name: 'Rent Paid', isActive: true });
  });

  it('refuses a name already used by a ledger — ignoring case and spacing', () => {
    expect(create(base, 'ledger', newId('l2'), { name: ' cash ', groupId: gid('indirect-expenses') }).codes).toEqual([IssueCode.NameTaken]);
  });

  it('refuses a ledger named like an existing GROUP, and a group named like an existing ledger', () => {
    expect(create(base, 'ledger', newId('l3'), { name: 'sales accounts', groupId: gid('sales-accounts') }).codes).toEqual([IssueCode.NameTaken]);
    expect(create(base, 'group', newId('g1'), { name: 'CASH', parentId: gid('current-assets') }).codes).toEqual([IssueCode.NameTaken]);
  });

  it('refuses an unknown group, an inactive group, and an unknown party', () => {
    expect(create(base, 'ledger', newId('l4'), { name: 'X', groupId: 'nope' }).codes).toEqual([IssueCode.ReferenceUnknown]);
    const g = create(base, 'group', newId('g2'), { name: 'Old Expenses', parentId: gid('indirect-expenses') });
    const off = setActive(g.masters, 'group', newId('g2'), false);
    expect(create(off.masters, 'ledger', newId('l5'), { name: 'Y', groupId: newId('g2') }).codes).toEqual([IssueCode.ReferenceInactive]);
    expect(create(base, 'ledger', newId('l6'), { name: 'Z', groupId: gid('sundry-debtors'), partyId: 'ghost' }).codes).toEqual([IssueCode.ReferenceUnknown]);
  });

  it('requires a name', () => {
    expect(create(base, 'ledger', newId('l7'), { name: '   ', groupId: gid('sundry-debtors') }).codes).toEqual([IssueCode.SchemaInvalid]);
  });

  it('keeps ledger codes unique, ignoring case', () => {
    const a = create(base, 'ledger', newId('l8'), { name: 'A', groupId: gid('sundry-debtors'), code: 'c001' });
    expect(a.masters.ledgers.find((l) => l.id === newId('l8'))?.code).toBe('C001');
    expect(create(a.masters, 'ledger', newId('l9'), { name: 'B', groupId: gid('sundry-debtors'), code: 'C001' }).codes).toEqual([IssueCode.CodeTaken]);
  });

  it('a retry of the same create is a safe replay; the same id with different content is refused', () => {
    const data = { name: 'Rent', groupId: gid('indirect-expenses') };
    const first = create(base, 'ledger', newId('r1'), data);
    const again = create(first.masters, 'ledger', newId('r1'), data);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(again.masters.ledgers).toHaveLength(first.masters.ledgers.length);
    expect(create(first.masters, 'ledger', newId('r1'), { ...data, name: 'Different' }).codes).toEqual([IssueCode.MasterIdExists]);
  });

  it('alter: can rename, cannot take another ledger’s name, and saving no changes is a no-op', () => {
    const a = create(base, 'ledger', newId('a1'), { name: 'Alpha', groupId: gid('sundry-debtors') });
    const b = create(a.masters, 'ledger', newId('b1'), { name: 'Beta', groupId: gid('sundry-debtors') });
    expect(alter(b.masters, 'ledger', newId('a1'), { name: 'Alpha Two', groupId: gid('sundry-debtors') }).ok).toBe(true);
    expect(alter(b.masters, 'ledger', newId('a1'), { name: 'beta', groupId: gid('sundry-debtors') }).codes).toEqual([IssueCode.NameTaken]);
    expect(alter(b.masters, 'ledger', newId('a1'), { name: 'Alpha', groupId: gid('sundry-debtors') })).toMatchObject({ ok: true, replayed: true });
  });

  it('alter of something that does not exist is refused', () => {
    expect(alter(base, 'ledger', newId('ghost'), { name: 'X', groupId: gid('sundry-debtors') }).codes).toEqual([IssueCode.MasterNotFound]);
  });

  it('the built-in ledger cannot be renamed, moved or deactivated', () => {
    const id = base.openingDifferenceLedger()?.id as string;
    expect(alter(base, 'ledger', id, { name: 'Hacked', groupId: gid('suspense') }).codes).toEqual([IssueCode.SystemMasterLocked]);
    expect(setActive(base, 'ledger', id, false).codes).toEqual([IssueCode.SystemMasterLocked]);
  });

  it('a ledger with entries keeps its nature: it may move within assets but not to an expense group', () => {
    const l = create(base, 'ledger', newId('e1'), { name: 'Petty', groupId: gid('cash-in-hand') });
    const used: MasterUsage = { ...NO_USAGE, ledgersWithEntries: new Set([newId('e1')]) };
    expect(alter(l.masters, 'ledger', newId('e1'), { name: 'Petty', groupId: gid('bank-accounts') }, used).ok).toBe(true); // asset → asset
    expect(alter(l.masters, 'ledger', newId('e1'), { name: 'Petty', groupId: gid('indirect-expenses') }, used).codes).toEqual([IssueCode.NatureLocked]);
    // with no entries the same move is allowed
    expect(alter(l.masters, 'ledger', newId('e1'), { name: 'Petty', groupId: gid('indirect-expenses') }).ok).toBe(true);
  });

  it('deactivating and reactivating a ledger is idempotent', () => {
    const l = create(base, 'ledger', newId('d1'), { name: 'Temp', groupId: gid('sundry-debtors') });
    const off = setActive(l.masters, 'ledger', newId('d1'), false);
    expect(off).toMatchObject({ ok: true, replayed: false });
    expect(setActive(off.masters, 'ledger', newId('d1'), false)).toMatchObject({ ok: true, replayed: true });
    expect(setActive(off.masters, 'ledger', newId('d1'), true)).toMatchObject({ ok: true, replayed: false });
  });
});

describe('groups', () => {
  const base = fresh();

  it('a new group takes the nature and trading-account flag of its parent', () => {
    const r = create(base, 'group', newId('g1'), { name: 'Domestic Sales', parentId: gid('sales-accounts') });
    const g = r.masters.groups.get(newId('g1') as never);
    expect(g).toMatchObject({ nature: 'income', affectsGrossProfit: true, isSystem: false, parentId: gid('sales-accounts') });
  });

  it('needs a parent that exists', () => {
    expect(create(base, 'group', newId('g2'), { name: 'X', parentId: 'nope' }).codes).toEqual([IssueCode.ReferenceUnknown]);
    expect(create(base, 'group', newId('g3'), { name: 'X' }).codes).toEqual([IssueCode.SchemaInvalid]);
  });

  it('built-in groups cannot be altered or deactivated', () => {
    expect(alter(base, 'group', gid('sales-accounts'), { name: 'Revenue', parentId: gid('sales-accounts') }).codes).toEqual([IssueCode.SystemMasterLocked]);
    expect(setActive(base, 'group', gid('sales-accounts'), false).codes).toEqual([IssueCode.SystemMasterLocked]);
  });

  it('cannot be moved inside itself or its own child, nor under a group of a different nature', () => {
    const a = create(base, 'group', newId('ga'), { name: 'A', parentId: gid('indirect-expenses') });
    const b = create(a.masters, 'group', newId('gb'), { name: 'B', parentId: newId('ga') });
    expect(alter(b.masters, 'group', newId('ga'), { name: 'A', parentId: newId('gb') }).codes).toContain(IssueCode.HierarchyCycle);
    expect(alter(b.masters, 'group', newId('ga'), { name: 'A', parentId: newId('ga') }).codes).toContain(IssueCode.HierarchyCycle);
    expect(alter(b.masters, 'group', newId('ga'), { name: 'A', parentId: gid('sales-accounts') }).codes).toEqual([IssueCode.NatureLocked]);
    expect(alter(b.masters, 'group', newId('gb'), { name: 'B', parentId: gid('sales-accounts') }).codes).toEqual([IssueCode.NatureLocked]);
    // purchase accounts is an expense group like indirect expenses, so that move is fine
    expect(alter(b.masters, 'group', newId('gb'), { name: 'B', parentId: gid('purchase-accounts') }).ok).toBe(true);
  });

  it('cannot be deactivated while it still holds active ledgers or sub-groups', () => {
    const g = create(base, 'group', newId('gx'), { name: 'X', parentId: gid('indirect-expenses') });
    const l = create(g.masters, 'ledger', newId('lx'), { name: 'Lx', groupId: newId('gx') });
    expect(setActive(l.masters, 'group', newId('gx'), false).codes).toEqual([IssueCode.HasDependents]);
    const emptied = setActive(l.masters, 'ledger', newId('lx'), false);
    expect(setActive(emptied.masters, 'group', newId('gx'), false).ok).toBe(true);
  });
});

describe('parties', () => {
  const base = fresh();
  const gstin = validGstin();

  it('stores a valid GSTIN and derives the PAN and state from it', () => {
    const r = create(base, 'party', newId('p1'), { name: 'ABC Industries', gstin: gstin.toLowerCase(), phone: '98765 43210', email: 'a@abc.in', creditDays: '30', creditLimit: '500000.50' });
    expect(r.ok).toBe(true);
    const p = r.masters.parties.find((x) => x.id === newId('p1'));
    expect(p).toMatchObject({ gstin, pan: 'AAPFU0939F', stateCode: '27', creditDays: 30, creditLimit: 50000050n, isActive: true });
  });

  it('accepts a party with nothing but a name', () => {
    expect(create(base, 'party', newId('p2'), { name: 'Walk-in Customer' }).ok).toBe(true);
  });

  it.each([
    ['a wrong GSTIN check digit', { gstin: gstin.slice(0, 14) + 'A' }, IssueCode.InvalidGstin],
    ['a PAN that disagrees with the GSTIN', { gstin, pan: 'ABCDE1234F' }, IssueCode.InvalidPan],
    ['a state code that disagrees with the GSTIN', { gstin, stateCode: '29' }, IssueCode.InvalidGstin],
    ['a malformed PAN', { pan: 'abc' }, IssueCode.InvalidPan],
    ['a bad phone number', { phone: '123' }, IssueCode.InvalidPhone],
    ['a bad email', { email: 'nope' }, IssueCode.InvalidEmail],
    ['credit days out of range', { creditDays: 99999 }, IssueCode.OutOfRange],
    ['credit days that are not a whole number', { creditDays: 'abc' }, IssueCode.OutOfRange],
    ['a negative credit limit', { creditLimit: '-5' }, IssueCode.OutOfRange],
  ])('refuses %s', (_what, extra, code) => {
    expect(create(base, 'party', newId('bad'), { name: 'Bad Co', ...extra }).codes).toContain(code);
  });

  it('a malformed credit limit is a field error, not a crash', () => {
    expect(create(base, 'party', newId('bad2'), { name: 'X', creditLimit: '12,000' }).codes).toEqual([IssueCode.SchemaInvalid]);
  });

  it('keeps party names unique', () => {
    const a = create(base, 'party', newId('u1'), { name: 'Sharma Traders' });
    expect(create(a.masters, 'party', newId('u2'), { name: ' SHARMA   traders' }).codes).toEqual([IssueCode.NameTaken]);
  });

  it('a party is not a ledger: it can share a name with one', () => {
    expect(create(base, 'party', newId('u3'), { name: 'Cash' }).ok).toBe(true);
  });

  it('a ledger can belong to a party, and the party cannot be deactivated while it has active ledgers', () => {
    const p = create(base, 'party', newId('pp'), { name: 'ABC Industries' });
    const l = create(p.masters, 'ledger', newId('lp'), { name: 'ABC Industries (Dr)', groupId: gid('sundry-debtors'), partyId: newId('pp') });
    expect(l.ok).toBe(true);
    expect(setActive(l.masters, 'party', newId('pp'), false).codes).toEqual([IssueCode.HasDependents]);
    const off = setActive(l.masters, 'ledger', newId('lp'), false);
    expect(setActive(off.masters, 'party', newId('pp'), false).ok).toBe(true);
    expect(create(setActive(off.masters, 'party', newId('pp'), false).masters, 'ledger', newId('lq'), { name: 'Q', groupId: gid('sundry-debtors'), partyId: newId('pp') }).codes).toEqual([IssueCode.ReferenceInactive]);
  });
});

describe('units', () => {
  const base = fresh();

  it('creates a unit with decimals, and keeps symbols unique ignoring case', () => {
    const r = create(base, 'unit', newId('u1'), { symbol: 'Cm', name: 'Centimetres', decimals: 1 });
    expect(r.masters.units.find((u) => u.id === newId('u1'))).toMatchObject({ symbol: 'Cm', decimals: 1 });
    expect(create(r.masters, 'unit', newId('u2'), { symbol: 'cm', name: 'Other' }).codes).toEqual([IssueCode.NameTaken]);
    expect(create(base, 'unit', newId('u3'), { symbol: 'kg', name: 'Kilo' }).codes).toEqual([IssueCode.NameTaken]); // Kg is seeded
  });

  it('decimals must be 0–4', () => {
    expect(create(base, 'unit', newId('u4'), { symbol: 'X', name: 'X', decimals: 5 }).codes).toEqual([IssueCode.OutOfRange]);
    expect(create(base, 'unit', newId('u5'), { symbol: 'Y', name: 'Y', decimals: 'two' }).codes).toEqual([IssueCode.OutOfRange]);
  });

  it('a compound unit needs a base and a positive factor', () => {
    const kg = newId('unit:Kg');
    const ok = create(base, 'unit', newId('t1'), { symbol: 'Qtl', name: 'Quintal', decimals: 2, baseUnitId: kg, factor: '100' });
    expect(ok.masters.units.find((u) => u.id === newId('t1'))).toMatchObject({ baseUnitId: kg, factor: '100' });
    expect(create(base, 'unit', newId('t2'), { symbol: 'Q2', name: 'Q2', baseUnitId: kg }).codes).toEqual([IssueCode.OutOfRange]);
    expect(create(base, 'unit', newId('t3'), { symbol: 'Q3', name: 'Q3', baseUnitId: kg, factor: '0' }).codes).toEqual([IssueCode.OutOfRange]);
    expect(create(base, 'unit', newId('t4'), { symbol: 'Q4', name: 'Q4', factor: '5' }).codes).toEqual([IssueCode.SchemaInvalid]);
    expect(create(base, 'unit', newId('t5'), { symbol: 'Q5', name: 'Q5', baseUnitId: 'ghost', factor: '2' }).codes).toEqual([IssueCode.ReferenceUnknown]);
  });

  it('units cannot be defined in terms of each other in a loop', () => {
    const a = create(base, 'unit', newId('la'), { symbol: 'LA', name: 'LA', baseUnitId: newId('unit:Kg'), factor: '2' });
    const b = create(a.masters, 'unit', newId('lb'), { symbol: 'LB', name: 'LB', baseUnitId: newId('la'), factor: '3' });
    expect(alter(b.masters, 'unit', newId('la'), { symbol: 'LA', name: 'LA', baseUnitId: newId('lb'), factor: '2' }).codes).toContain(IssueCode.HierarchyCycle);
  });

  it('a unit still used by an active item cannot be deactivated', () => {
    const item = create(base, 'stockItem', newId('i1'), { name: 'Bolt', unitId: newId('unit:Nos'), itemType: 'raw' });
    expect(setActive(item.masters, 'unit', newId('unit:Nos'), false).codes).toEqual([IssueCode.HasDependents]);
  });
});

describe('stock groups, warehouses and items', () => {
  const base = fresh();

  it('stock groups and warehouses nest, but never loop', () => {
    const a = create(base, 'stockGroup', newId('sg1'), { name: 'Raw Material' });
    const b = create(a.masters, 'stockGroup', newId('sg2'), { name: 'Steel', parentId: newId('sg1') });
    expect(b.ok).toBe(true);
    expect(alter(b.masters, 'stockGroup', newId('sg1'), { name: 'Raw Material', parentId: newId('sg2') }).codes).toContain(IssueCode.HierarchyCycle);
    const w = create(base, 'warehouse', newId('w1'), { name: 'Plant 1' });
    const w2 = create(w.masters, 'warehouse', newId('w2'), { name: 'Store A', parentId: newId('w1') });
    expect(alter(w2.masters, 'warehouse', newId('w1'), { name: 'Plant 1', parentId: newId('w2') }).codes).toContain(IssueCode.HierarchyCycle);
    expect(create(base, 'warehouse', newId('w3'), { name: 'main location' }).codes).toEqual([IssueCode.NameTaken]);
    expect(setActive(w2.masters, 'warehouse', newId('w1'), false).codes).toEqual([IssueCode.HasDependents]);
  });

  it('creates a stock item with unit, group, HSN and GST rate', () => {
    const sg = create(base, 'stockGroup', newId('sg'), { name: 'Fasteners' });
    const r = create(sg.masters, 'stockItem', newId('i1'), {
      name: 'M8 Bolt', code: 'bl-m8', alias: 'Hex bolt 8mm', groupId: newId('sg'), unitId: newId('unit:Nos'),
      hsn: '7318', gstRateId: newId('gst:18'), itemType: 'raw',
    });
    expect(r.ok).toBe(true);
    expect(r.masters.stockItems.find((i) => i.id === newId('i1'))).toMatchObject({ name: 'M8 Bolt', code: 'BL-M8', hsn: '7318', itemType: 'raw', isActive: true });
  });

  it.each([
    ['an unknown unit', { unitId: 'ghost' }, IssueCode.ReferenceUnknown],
    ['an unknown stock group', { groupId: 'ghost' }, IssueCode.ReferenceUnknown],
    ['an unknown GST rate', { gstRateId: 'ghost' }, IssueCode.ReferenceUnknown],
    ['a malformed HSN', { hsn: '12' }, IssueCode.InvalidHsn],
    ['an unknown item type', { itemType: 'gadget' }, IssueCode.SchemaInvalid],
  ])('refuses %s', (_w, extra, code) => {
    expect(create(base, 'stockItem', newId('bad'), { name: 'X', unitId: newId('unit:Nos'), itemType: 'raw', ...extra }).codes).toContain(code);
  });

  it('keeps item names and codes unique', () => {
    const a = create(base, 'stockItem', newId('i1'), { name: 'Washer', code: 'W1', unitId: newId('unit:Nos'), itemType: 'raw' });
    expect(create(a.masters, 'stockItem', newId('i2'), { name: 'WASHER', unitId: newId('unit:Nos'), itemType: 'raw' }).codes).toEqual([IssueCode.NameTaken]);
    expect(create(a.masters, 'stockItem', newId('i3'), { name: 'Other', code: 'w1', unitId: newId('unit:Nos'), itemType: 'raw' }).codes).toEqual([IssueCode.CodeTaken]);
  });

  it('an inactive unit cannot be chosen for a new item', () => {
    const u = create(base, 'unit', newId('un'), { symbol: 'Old', name: 'Old unit' });
    const off = setActive(u.masters, 'unit', newId('un'), false);
    expect(create(off.masters, 'stockItem', newId('i9'), { name: 'Z', unitId: newId('un'), itemType: 'raw' }).codes).toEqual([IssueCode.ReferenceInactive]);
  });
});

describe('GST rates', () => {
  const base = fresh();

  it('creates a dated rate', () => {
    const r = create(base, 'gstRate', newId('r1'), { name: 'GST 3%', ratePercent: '3', cessPercent: '1.5', effectiveFrom: '2024-04-01' });
    expect(r.masters.gstRates.find((x) => x.id === newId('r1'))).toMatchObject({ ratePercent: '3', cessPercent: '1.5', effectiveFrom: '2024-04-01' });
  });

  it.each([
    ['a rate above 100', { ratePercent: '101' }],
    ['a negative rate', { ratePercent: '-5' }],
    ['a non-numeric rate', { ratePercent: 'x' }],
    ['a bad cess', { cessPercent: '200' }],
    ['an impossible date', { effectiveFrom: '2024-02-30' }],
  ])('refuses %s', (_w, extra) => {
    expect(create(base, 'gstRate', newId('rb'), { name: 'Bad', ratePercent: '5', effectiveFrom: '2024-04-01', ...extra }).ok).toBe(false);
  });

  it('rate names are unique, and a rate cannot be deactivated (add a newer dated one instead)', () => {
    expect(create(base, 'gstRate', newId('rc'), { name: 'gst 18%', ratePercent: '18', effectiveFrom: '2024-04-01' }).codes).toEqual([IssueCode.NameTaken]);
    expect(setActive(base, 'gstRate', newId('gst:18'), false).codes).toEqual([IssueCode.UnsupportedOperation]);
  });
});

describe('voucher types and numbering series', () => {
  const base = fresh();

  it('creates a custom voucher type on a user-creatable base kind', () => {
    const r = create(base, 'voucherType', newId('vt1'), { name: 'Petty Cash Payment', baseKind: 'payment' });
    expect(r.masters.voucherTypes.find((t) => t.id === newId('vt1'))).toMatchObject({ baseKind: 'payment', isSystem: false });
  });

  it('refuses the system opening kind and unknown kinds', () => {
    expect(create(base, 'voucherType', newId('vt2'), { name: 'X', baseKind: 'opening' }).codes).toEqual([IssueCode.OutOfRange]);
    expect(create(base, 'voucherType', newId('vt3'), { name: 'Y', baseKind: 'creditNote' }).codes).toEqual([IssueCode.OutOfRange]);
  });

  it('built-in types cannot be changed; names are unique', () => {
    expect(alter(base, 'voucherType', newId('type:payment'), { name: 'Pay', baseKind: 'payment' }).codes).toEqual([IssueCode.SystemMasterLocked]);
    expect(create(base, 'voucherType', newId('vt4'), { name: 'payment', baseKind: 'payment' }).codes).toEqual([IssueCode.NameTaken]);
  });

  it('a type in use keeps its base kind', () => {
    const r = create(base, 'voucherType', newId('vt5'), { name: 'Custom', baseKind: 'payment' });
    const used: MasterUsage = { ...NO_USAGE, voucherTypesInUse: new Set([newId('vt5')]) };
    expect(alter(r.masters, 'voucherType', newId('vt5'), { name: 'Custom', baseKind: 'receipt' }, used).codes).toEqual([IssueCode.InUse]);
    expect(alter(r.masters, 'voucherType', newId('vt5'), { name: 'Custom Renamed', baseKind: 'payment' }, used).ok).toBe(true);
  });

  it('numbering: one series per type per year, width 1–12, start ≥ 1', () => {
    const fy = base.financialYears[0]?.id as string;
    const vt = create(base, 'voucherType', newId('vt6'), { name: 'Custom', baseKind: 'journal' });
    const s = create(vt.masters, 'numberingSeries', newId('s1'), { voucherTypeId: newId('vt6'), financialYearId: fy, prefix: 'CU/', width: 5, startAt: 100 });
    expect(s.masters.series.find((x) => x.id === newId('s1'))).toMatchObject({ prefix: 'CU/', suffix: '', width: 5, startAt: 100 });
    expect(create(s.masters, 'numberingSeries', newId('s2'), { voucherTypeId: newId('vt6'), financialYearId: fy }).codes).toEqual([IssueCode.NameTaken]);
    for (const bad of [{ width: 0 }, { width: 13 }, { startAt: 0 }]) {
      expect(create(vt.masters, 'numberingSeries', newId('s3'), { voucherTypeId: newId('vt6'), financialYearId: fy, ...bad }).codes).toEqual([IssueCode.OutOfRange]);
    }
    expect(create(vt.masters, 'numberingSeries', newId('s4'), { voucherTypeId: 'ghost', financialYearId: fy }).codes).toEqual([IssueCode.ReferenceUnknown]);
  });

  it('a series in use may change its prefix but not its start number', () => {
    const s = base.series[0]!;
    const used: MasterUsage = { ...NO_USAGE, seriesInUse: new Set([s.id]) };
    const data = { voucherTypeId: s.voucherTypeId, financialYearId: s.financialYearId, prefix: 'NEW/', suffix: '', width: 4, startAt: 1 };
    expect(alter(base, 'numberingSeries', s.id, data, used).ok).toBe(true);
    expect(alter(base, 'numberingSeries', s.id, { ...data, startAt: 50 }, used).codes).toEqual([IssueCode.InUse]);
    expect(alter(base, 'numberingSeries', s.id, { ...data, startAt: 50 }).ok).toBe(true); // unused: free to change
  });
});

describe('seriesAdvanceIssues (ADR-0021): the next-number override, forward only', () => {
  it('accepts a forward jump and the no-op of the same value', () => {
    expect(seriesAdvanceIssues(10, 10)).toEqual([]);
    expect(seriesAdvanceIssues(10, 11)).toEqual([]);
    expect(seriesAdvanceIssues(10, 500)).toEqual([]);
  });

  it('refuses a value behind the current one, without saying which one is "wrong" beyond the number itself', () => {
    const problems = seriesAdvanceIssues(10, 9);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ code: IssueCode.SeriesNextBehind, path: 'nextValue' });
    expect(problems[0]?.message).toContain('10');
  });

  it('refuses a non-integer or a value below 1', () => {
    expect(seriesAdvanceIssues(1, 0).map((i) => i.code)).toEqual([IssueCode.OutOfRange]);
    expect(seriesAdvanceIssues(1, -5).map((i) => i.code)).toEqual([IssueCode.OutOfRange]);
    expect(seriesAdvanceIssues(1, 1.5).map((i) => i.code)).toEqual([IssueCode.OutOfRange]);
    expect(seriesAdvanceIssues(1, NaN).map((i) => i.code)).toEqual([IssueCode.OutOfRange]);
  });
});

describe('numbering series: the manual next-number override (ADR-0021)', () => {
  const base = fresh();
  const s = base.series[0]!;
  const usageAt = (nextValue: number): MasterUsage => ({ ...NO_USAGE, seriesNextValue: new Map([[s.id, nextValue]]) });

  it('a forward jump is accepted, replays nothing, and leaves the series record itself unchanged', () => {
    const r = prepareMasterCommand({ op: 'advanceSeries', kind: 'numberingSeries', id: s.id, data: { nextValue: 50 } }, base, usageAt(1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.change).toMatchObject({ op: 'advanceSeries', id: s.id, replayed: false });
    expect(r.value.masters.series.find((x) => x.id === s.id)).toEqual(s); // the running counter is adapter-side, not on the record
  });

  it('the same value as the current one is a safe replay — "continue from the last made number"', () => {
    const r = prepareMasterCommand({ op: 'advanceSeries', kind: 'numberingSeries', id: s.id, data: { nextValue: 1 } }, base, usageAt(1));
    expect(r).toMatchObject({ ok: true, value: { change: { replayed: true } } });
  });

  it('a backward value is refused', () => {
    const r = prepareMasterCommand({ op: 'advanceSeries', kind: 'numberingSeries', id: s.id, data: { nextValue: 5 } }, base, usageAt(10));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual([IssueCode.SeriesNextBehind]);
  });

  it('only a numbering series has a next number to move', () => {
    expect(issuesOf(base, { op: 'advanceSeries', kind: 'ledger', id: newId('ledger:cash'), data: { nextValue: 5 } }).map((i) => i.code)).toEqual([
      IssueCode.UnsupportedOperation,
    ]);
  });

  it('refuses an id that does not exist', () => {
    expect(issuesOf(base, { op: 'advanceSeries', kind: 'numberingSeries', id: newId('ghost'), data: { nextValue: 5 } }).map((i) => i.code)).toEqual([
      IssueCode.MasterNotFound,
    ]);
  });

  it('refuses when the current next number could not be read (a backend that never populated it)', () => {
    expect(issuesOf(base, { op: 'advanceSeries', kind: 'numberingSeries', id: s.id, data: { nextValue: 5 } }).map((i) => i.code)).toEqual([
      IssueCode.MastersChanged,
    ]);
  });
});

describe('the company', () => {
  const base = fresh();

  it('can be altered: name, GSTIN (validated), state, address', () => {
    const gstin = validGstin('29AABCT1332L1Z');
    const r = alter(base, 'company', base.company.id, { name: 'Acme Works Pvt Ltd', gstin, address: '12 MG Road, Bengaluru' });
    expect(r.masters.company).toMatchObject({ name: 'Acme Works Pvt Ltd', gstin, stateCode: '29', address: '12 MG Road, Bengaluru' });
  });

  it('refuses a bad GSTIN or a mismatched state', () => {
    expect(alter(base, 'company', base.company.id, { name: 'X', gstin: 'bogus' }).codes).toEqual([IssueCode.InvalidGstin]);
    expect(alter(base, 'company', base.company.id, { name: 'X', gstin: validGstin(), stateCode: '29' }).codes).toEqual([IssueCode.InvalidGstin]);
  });

  it('cannot be deactivated', () => {
    expect(setActive(base, 'company', base.company.id, false).ok).toBe(true); // company has no active flag: treated as a no-op replay
  });
});

describe('lookups', () => {
  it('finds a record by kind and id', () => {
    const m = fresh();
    expect(findMaster(m, 'ledger', newId('ledger:cash'))).toMatchObject({ name: 'Cash' });
    expect(findMaster(m, 'group', gid('sales-accounts'))).toMatchObject({ name: 'Sales Accounts' });
    expect(findMaster(m, 'unit', newId('unit:Kg'))).toMatchObject({ symbol: 'Kg' });
    expect(findMaster(m, 'ledger', 'nope')).toBeUndefined();
  });
});
