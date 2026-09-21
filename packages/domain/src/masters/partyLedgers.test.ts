import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { IssueCode } from '../errors';
import { deterministicUuid } from '../ids';
import { type MasterKind, NO_USAGE, prepareMasterCommand } from './commands';
import type { Masters } from './masters';
import { partyLedgerId } from './records';
import { seedCompany } from './seed';

const newId = (name: string) => deterministicUuid(`t|${name}`);
const base = seedCompany({ name: 'Acme Works', fyStart: localDate('2024-04-01'), newId });
const gid = (key: string) => newId(`group:${key}`);

interface Step {
  masters: Masters;
  codes: string[];
  ok: boolean;
  replayed: boolean;
}

function run(masters: Masters, op: 'create' | 'alter' | 'setActive', kind: MasterKind, id: string, data?: unknown, active?: boolean): Step {
  const r = prepareMasterCommand({ op, kind, id, data, ...(active === undefined ? {} : { active }) }, masters, NO_USAGE);
  if (!r.ok) return { masters, codes: r.issues.map((i) => i.code), ok: false, replayed: false };
  return { masters: r.value.masters, codes: [], ok: true, replayed: r.value.change.replayed };
}
const create = (m: Masters, kind: MasterKind, id: string, data: unknown) => run(m, 'create', kind, id, data);
const alter = (m: Masters, kind: MasterKind, id: string, data: unknown) => run(m, 'alter', kind, id, data);
const setActive = (m: Masters, kind: MasterKind, id: string, active: boolean) => run(m, 'setActive', kind, id, undefined, active);

describe('a party makes and keeps its own ledgers', () => {
  const pid = newId('party');
  const cust = partyLedgerId(pid, 'customer');
  const vend = partyLedgerId(pid, 'vendor');
  const ledger = (m: Masters, id: string) => m.ledgers.find((l) => l.id === id);
  const named = (m: Masters, party: string) =>
    m.ledgers
      .filter((l) => l.partyId === party)
      .map((l) => `${l.name} [${l.partyRole}] ${m.groups.get(l.groupId)?.name}`)
      .sort();
  const prepared = (m: Masters, cmd: unknown) => {
    const r = prepareMasterCommand(cmd, m);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  };
  const make = (roles: string[], name = 'ABC Industries') => create(base, 'party', pid, { name, roles });

  it('a customer gets one ledger under Sundry Debtors, named as the party', () => {
    expect(named(make(['customer']).masters, pid)).toEqual(['ABC Industries [customer] Sundry Debtors']);
  });

  it('a vendor gets one ledger under Sundry Creditors, named as the party', () => {
    expect(named(make(['vendor']).masters, pid)).toEqual(['ABC Industries [vendor] Sundry Creditors']);
  });

  it('both gets two ledgers — the vendor one says so in its name', () => {
    expect(named(make(['customer', 'vendor']).masters, pid)).toEqual([
      'ABC Industries (Vendor) [vendor] Sundry Creditors',
      'ABC Industries [customer] Sundry Debtors',
    ]);
  });

  it('the ledger ids are derived from the party, and the command lists the party first, then its ledgers', () => {
    const v = prepared(base, { op: 'create', kind: 'party', id: pid, data: { name: 'ABC', roles: ['customer', 'vendor'] } });
    expect(v.changes.map((c) => [c.kind, c.id])).toEqual([['party', pid], ['ledger', cust], ['ledger', vend]]);
    expect(v.change.kind).toBe('party');
  });

  it('a party without roles (older data, linked by hand) makes no ledgers', () => {
    expect(create(base, 'party', pid, { name: 'Old Co' }).masters.ledgers.filter((l) => l.partyId === pid)).toEqual([]);
  });

  it('repeating the command is a replay that changes nothing', () => {
    const first = make(['customer', 'vendor']);
    const again = create(first.masters, 'party', pid, { name: 'ABC Industries', roles: ['customer', 'vendor'] });
    expect(again.replayed).toBe(true);
    expect(again.masters).toBe(first.masters);
    expect(prepared(first.masters, { op: 'create', kind: 'party', id: pid, data: { name: 'ABC Industries', roles: ['customer', 'vendor'] } }).changes).toHaveLength(1);
  });

  it('a name already used by a ledger or group refuses the party — on the party’s name — and creates nothing', () => {
    const taken = create(base, 'ledger', newId('other'), { name: 'ABC Industries', groupId: gid('indirect-expenses') });
    const cmd = { op: 'create', kind: 'party', id: pid, data: { name: 'ABC Industries', roles: ['customer'] } };
    const r = prepareMasterCommand(cmd, taken.masters);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.code)).toEqual([IssueCode.NameTaken]);
      expect(r.issues[0]?.path).toBe('name');
    }
    expect(taken.masters.parties).toHaveLength(0);
  });

  it('for both, a clash on just the "(Vendor)" name also refuses the whole party', () => {
    const taken = create(base, 'ledger', newId('x'), { name: 'ABC Industries (Vendor)', groupId: gid('indirect-expenses') });
    const r = create(taken.masters, 'party', pid, { name: 'ABC Industries', roles: ['customer', 'vendor'] });
    expect(r.codes).toEqual([IssueCode.NameTaken]);
    expect(r.masters.ledgers.some((l) => l.partyId === pid)).toBe(false);
  });

  it('renaming the party renames its ledgers', () => {
    const r = alter(make(['customer', 'vendor']).masters, 'party', pid, { name: 'XYZ Traders', roles: ['customer', 'vendor'] });
    expect(named(r.masters, pid)).toEqual(['XYZ Traders (Vendor) [vendor] Sundry Creditors', 'XYZ Traders [customer] Sundry Debtors']);
  });

  it('a vendor who becomes a customer too: the vendor ledger gives up the plain name, the customer ledger takes it', () => {
    const r = alter(make(['vendor']).masters, 'party', pid, { name: 'ABC Industries', roles: ['customer', 'vendor'] });
    expect(r.ok).toBe(true);
    expect(ledger(r.masters, vend)?.name).toBe('ABC Industries (Vendor)');
    expect(ledger(r.masters, cust)?.name).toBe('ABC Industries');
    expect(ledger(r.masters, vend)?.groupId).toBe(gid('sundry-creditors')); // the same record: its id, hence its history, is untouched
  });

  it('a role cannot be taken away, and a party cannot end up with none', () => {
    const m = make(['customer', 'vendor']).masters;
    expect(alter(m, 'party', pid, { name: 'ABC Industries', roles: ['customer'] }).codes).toEqual([IssueCode.UnsupportedOperation]);
    expect(alter(m, 'party', pid, { name: 'ABC Industries', roles: [] }).codes).toContain(IssueCode.SchemaInvalid);
  });

  it('altering the party without stating roles keeps them (and their ledgers)', () => {
    const r = alter(make(['customer', 'vendor']).masters, 'party', pid, { name: 'ABC Industries', phone: '9820012345' });
    expect(named(r.masters, pid)).toHaveLength(2);
    expect(r.masters.parties[0]?.roles).toEqual(['customer', 'vendor']);
  });

  it('deactivating the party deactivates its ledgers; activating brings them back', () => {
    const off = setActive(make(['customer', 'vendor']).masters, 'party', pid, false);
    expect(off.ok).toBe(true);
    expect(off.masters.ledgers.filter((l) => l.partyId === pid).map((l) => l.isActive)).toEqual([false, false]);
    const on = setActive(off.masters, 'party', pid, true);
    expect(on.masters.ledgers.filter((l) => l.partyId === pid).map((l) => l.isActive)).toEqual([true, true]);
  });

  it('a party’s ledger is not edited or deactivated on its own — only through the party', () => {
    const m = make(['customer']).masters;
    expect(alter(m, 'ledger', cust, { name: 'Renamed', groupId: gid('sundry-debtors'), partyId: pid, partyRole: 'customer' }).codes).toContain(IssueCode.UnsupportedOperation);
    expect(setActive(m, 'ledger', cust, false).codes).toEqual([IssueCode.UnsupportedOperation]);
    expect(create(base, 'ledger', newId('sneaky'), { name: 'S', groupId: gid('sundry-debtors'), partyId: pid, partyRole: 'customer' }).codes).toContain(
      IssueCode.UnsupportedOperation,
    );
  });

  it('keeps the billing and shipping address, validated', () => {
    const made = make(['customer']);
    const r = alter(made.masters, 'party', pid, {
      name: 'ABC Industries',
      roles: ['customer'],
      address: 'Plot 14, MIDC',
      stateCode: '27',
      pincode: '411026',
      country: 'India',
      shipping: { lines: 'Godown 3, Chakan', stateCode: '27', pincode: '410501' },
    });
    expect(r.ok).toBe(true);
    expect(r.masters.parties[0]).toMatchObject({ pincode: '411026', shipping: { lines: 'Godown 3, Chakan', pincode: '410501' } });
    const bad = (extra: object) => alter(made.masters, 'party', pid, { name: 'ABC Industries', roles: ['customer'], ...extra }).codes;
    expect(bad({ pincode: '4110' })).toEqual([IssueCode.OutOfRange]);
    expect(bad({ stateCode: '00' })).toEqual([IssueCode.OutOfRange]);
    expect(bad({ shipping: { lines: 'x', pincode: '12345a' } })).toEqual([IssueCode.OutOfRange]);
    expect(bad({ shipping: { lines: 'x', stateCode: '00' } })).toEqual([IssueCode.OutOfRange]);
  });

  it('an empty shipping address means "same as billing" (nothing is stored)', () => {
    const r = create(base, 'party', pid, { name: 'ABC', roles: ['customer'], shipping: {} });
    expect(r.masters.parties[0]?.shipping).toBeUndefined();
  });

  it('the set of a party’s ledgers always matches its roles, whatever the sequence of commands', () => {
    const sequences: string[][][] = [
      [['vendor']],
      [['customer']],
      [['vendor'], ['customer', 'vendor']],
      [['customer'], ['customer', 'vendor']],
      [['customer', 'vendor'], ['customer', 'vendor']],
    ];
    for (const seq of sequences) {
      let m = base;
      seq.forEach((roles, i) => {
        m = (i === 0 ? create : alter)(m, 'party', pid, { name: `Name ${i}`, roles }).masters;
        const mine = m.ledgers.filter((l) => l.partyId === pid);
        expect(mine.map((l) => l.partyRole).sort()).toEqual([...(m.parties[0]?.roles ?? [])].sort());
        expect(new Set(mine.map((l) => l.name)).size).toBe(mine.length);
      });
    }
  });
});
