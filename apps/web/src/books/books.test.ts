import { MemoryBackend } from '@minimalerp/adapter-memory';
import { IssueCode, MASTER_KINDS, deterministicUuid, trialBalance } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend, newCompanyIssues } from './books';
import { loadDemoCompany } from './demo';
import { entityDocsOf } from './entities';
import { FORMS, blankValues, isMasterKindName, optionsFor, recordToValues, valuesToData } from './forms';
import { createLocalFactory, memoryStore } from './local';

const factory = (store = memoryStore()) =>
  createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store, newIdSeed: () => 'seed-1' });
const newHost = (store = memoryStore()) => new BooksHost(factory(store));

const acme = { name: 'Acme Works', fyStart: '2024-04-01' };

async function opened(store = memoryStore()): Promise<{ books: Books; host: BooksHost; store: ReturnType<typeof memoryStore> }> {
  const host = newHost(store);
  const created = await host.create(acme);
  if (!created.ok) throw new Error(JSON.stringify(created.issues));
  return { books: created.value, host, store };
}

describe('company creation', () => {
  it('seeds the standard chart, voucher types with numbering, GST slabs, units and a warehouse', async () => {
    const { books } = await opened();
    const m = books.masters;
    expect(m.company.name).toBe('Acme Works');
    expect(m.groups.all.length).toBeGreaterThan(20);
    expect(m.voucherTypes.map((t) => t.baseKind)).toContain('opening');
    expect(m.gstRates.length).toBe(5);
    expect(m.units.length).toBeGreaterThan(0);
    expect(m.warehouses).toHaveLength(1);
  });

  it('refuses a second company while one is open', async () => {
    const { host } = await opened();
    const again = await host.create(acme);
    expect(again.ok).toBe(false);
  });

  it.each([
    ['a missing name', { ...acme, name: '  ' }, 'name'],
    ['an impossible date', { ...acme, fyStart: '2024-13-40' }, 'fyStart'],
    ['a wrong GSTIN', { ...acme, gstin: '27AAPFU0939F1ZA' }, 'gstin'],
    ['a state that disagrees with the GSTIN', { ...acme, gstin: '27AAPFU0939F1ZV', stateCode: '29' }, 'stateCode'],
  ])('refuses %s, naming the field', async (_what, input, path) => {
    expect(newCompanyIssues(input).map((i) => i.path)).toEqual([path]);
    const host = newHost();
    const r = await host.create(input);
    expect(r.ok).toBe(false);
    expect(host.current).toBeUndefined();
  });

  it('tells subscribers when a company opens and closes', async () => {
    const host = newHost();
    let notified = 0;
    host.subscribe(() => notified++);
    await host.create(acme);
    expect(notified).toBeGreaterThan(0);
    expect(host.current).toBeDefined();
    await host.close();
    expect(host.current).toBeUndefined();
  });
});

describe('the company is remembered', () => {
  it('reopens with every master and voucher exactly as it was, numbers included', async () => {
    const { books, store } = await opened();
    const groupId = books.masters.groups.all.find((g) => g.name === 'Bank Accounts')?.id as string;
    expect((await books.execute({ op: 'create', kind: 'ledger', id: '00000000-0000-4000-8000-000000000001', data: { name: 'HDFC Bank', groupId } })).ok).toBe(true);
    const opening = await books.postOpening('00000000-0000-4000-8000-000000000001', 'debit', '1000');
    expect(opening).toMatchObject({ ok: true, value: { number: 'OB/0001' } });
    await new Promise((r) => setTimeout(r, 0)); // let the queued save finish

    const reopened = newHost(store);
    await reopened.restore();
    const again = reopened.current;
    expect(again?.masters.company.name).toBe('Acme Works');
    expect(again?.masters.ledgers.map((l) => l.name)).toContain('HDFC Bank');
    const lines = await (again?.backend as unknown as { lines(q: { companyId: string }): Promise<unknown[]> }).lines({ companyId: again?.companyId as string });
    expect(lines).toHaveLength(2);
  });

  it('starts empty when nothing was saved, and forgets everything on close', async () => {
    const empty = newHost();
    await empty.restore();
    expect(empty.current).toBeUndefined();

    const { host, store } = await opened();
    await host.close();
    const after = newHost(store);
    await after.restore();
    expect(after.current).toBeUndefined();
  });

  it('a save still queued when the company is closed does not bring it back', async () => {
    // A slow disk: every write waits, so the saves of a burst of changes are still queued when Close Company runs.
    const store = memoryStore();
    const set = store.set;
    const slow = { ...store, set: async (key: string, value: unknown) => new Promise<void>((r) => setTimeout(() => void set(key, value).then(r), 20)) };
    const host = new BooksHost(createLocalFactory({ makeBackend: (masters) => new MemoryBackend(masters) as unknown as LocalBackend, store: slow, newIdSeed: () => 'seed-1' }));
    const created = await host.create(acme);
    if (!created.ok) throw new Error(JSON.stringify(created.issues));
    const groupId = created.value.masters.groups.all.find((g) => g.name === 'Bank Accounts')?.id as string;
    for (let i = 1; i <= 3; i++) await created.value.execute({ op: 'create', kind: 'ledger', id: `00000000-0000-4000-8000-00000000000${i}`, data: { name: `Bank ${i}`, groupId } });

    await host.close();
    await new Promise((r) => setTimeout(r, 100)); // long enough for any write left behind to land
    expect(store.data.has('company')).toBe(false);
  });
});

describe('the GST / TDS system ledgers of a company saved before they existed', () => {
  const saved = { name: 'Old Co', fyStart: '2024-04-01', idSeed: 'seed-1' };
  const handMade = '00000000-0000-4000-8000-0000000000aa';
  const reopen = async (store: ReturnType<typeof memoryStore>) => {
    const host = newHost(store);
    await host.restore();
    return host.current as Books;
  };

  it('every one is there, once, however often the company is reopened', async () => {
    const store = memoryStore();
    store.data.set('company', { version: 1, company: saved, log: [] });
    const first = await reopen(store);
    const keys = first.masters.ledgers.flatMap((l) => (l.reservedKey === undefined ? [] : [l.reservedKey]));
    expect(keys.filter((k) => k !== 'opening-difference').sort()).toEqual(['gst-input-cgst', 'gst-input-igst', 'gst-input-sgst', 'gst-output-cgst', 'gst-output-igst', 'gst-output-sgst', 'round-off', 'tds-receivable']);
    const second = await reopen(store);
    expect(second.masters.ledgers.map((l) => [l.id, l.name])).toEqual(first.masters.ledgers.map((l) => [l.id, l.name]));
  });

  it('a "TDS Receivable" the company made by hand is adopted — its entries stay with it — not duplicated', async () => {
    const store = memoryStore();
    const group = deterministicUuid('seed-1|group:current-assets');
    store.data.set('company', { version: 1, company: saved, log: [{ type: 'master', command: { op: 'create', kind: 'ledger', id: handMade, data: { name: 'TDS Receivable', groupId: group } } }] });
    const books = await reopen(store);
    const tds = books.masters.ledgers.filter((l) => l.name.toLowerCase() === 'tds receivable');
    expect(tds.map((l) => [l.id, l.reservedKey])).toEqual([[handMade, 'tds-receivable']]);
    expect(books.masters.systemLedger('tds-receivable')?.id).toBe(handMade);
    // and again: still one, still that one
    const again = await reopen(store);
    expect(again.masters.ledgers.filter((l) => l.name.toLowerCase() === 'tds receivable').map((l) => l.id)).toEqual([handMade]);
    expect(again.masters.ledgers).toHaveLength(books.masters.ledgers.length);
  });
});

describe('opening balances through the books', () => {
  it('post once; asking again is a replay, not a second balance', async () => {
    const { books } = await opened();
    const groupId = books.masters.groups.all.find((g) => g.name === 'Bank Accounts')?.id as string;
    await books.execute({ op: 'create', kind: 'ledger', id: '00000000-0000-4000-8000-0000000000aa', data: { name: 'Bank', groupId } });
    await books.postOpening('00000000-0000-4000-8000-0000000000aa', 'debit', '500');
    await books.postOpening('00000000-0000-4000-8000-0000000000aa', 'debit', '500');
    const lines = await (books.backend as unknown as { lines(q: { companyId: string }): Promise<unknown[]> }).lines({ companyId: books.companyId });
    expect(lines).toHaveLength(2);
  });

  it('refuses a bad amount with a reason', async () => {
    const { books } = await opened();
    const groupId = books.masters.groups.all.find((g) => g.name === 'Bank Accounts')?.id as string;
    await books.execute({ op: 'create', kind: 'ledger', id: '00000000-0000-4000-8000-0000000000bb', data: { name: 'Bank', groupId } });
    const r = await books.postOpening('00000000-0000-4000-8000-0000000000bb', 'debit', 'lots');
    expect(r.ok).toBe(false);
  });
});

describe('every form works end to end', () => {
  it('has a form for every kind of master', () => {
    for (const k of MASTER_KINDS) {
      expect(FORMS[k], k).toBeDefined();
      expect(isMasterKindName(k)).toBe(true);
    }
    expect(isMasterKindName('spaceship')).toBe(false);
  });

  it('a form filled the way a person would fill it creates a record, and shows it back the same way', async () => {
    const { books } = await opened();
    const m0 = books.masters;
    const group = (name: string) => m0.groups.all.find((g) => g.name === name)?.id as string;
    const filled: Record<string, Record<string, string>> = {
      group: { name: 'Domestic Sales', parentId: group('Sales Accounts') },
      ledger: { name: 'Rent', groupId: group('Indirect Expenses'), code: 'r1', alias: 'Office rent' },
      party: { name: 'ABC Industries', phone: '9876543210', creditDays: '30', creditLimit: '5000.50' },
      unit: { symbol: 'Ton', name: 'Tonnes', decimals: '3', baseUnitId: m0.units.find((u) => u.symbol === 'Kg')?.id as string, factor: '1000' },
      stockGroup: { name: 'Raw Material' },
      warehouse: { name: 'Plant 2' },
      stockItem: { name: 'MS Sheet', unitId: m0.units[0]?.id as string, itemType: 'raw', hsn: '7208' },
      gstRate: { name: 'GST 3%', ratePercent: '3', effectiveFrom: '2024-04-01' },
      voucherType: { name: 'Petty Cash', baseKind: 'payment' },
    };
    let n = 0;
    for (const [kind, given] of Object.entries(filled)) {
      const spec = FORMS[kind as keyof typeof FORMS];
      const values = { ...blankValues(spec), ...given };
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const r = await books.execute({ op: 'create', kind, id, data: valuesToData(spec, values) });
      expect(r.ok, `${kind}: ${JSON.stringify(!r.ok && r.issues)}`).toBe(true);
    }
    // display it back: the strings a person typed come out again (normalised)
    const party = books.masters.parties.find((p) => p.name === 'ABC Industries');
    expect(recordToValues(FORMS.party, party as never)).toMatchObject({ name: 'ABC Industries', phone: '9876543210', creditDays: '30', creditLimit: '5000.50' });
  });

  it('a blank form is refused, with the issue on the right field', async () => {
    const { books } = await opened();
    const r = await books.execute({ op: 'create', kind: 'ledger', id: '00000000-0000-4000-8000-0000000000cc', data: valuesToData(FORMS.ledger, blankValues(FORMS.ledger)) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['name', 'groupId']));
  });

  it('pickers offer only what can be chosen: active records, never the record being edited', async () => {
    const { books } = await opened();
    const m = books.masters;
    const parentField = FORMS.warehouse.fields.find((f) => f.key === 'parentId');
    const all = optionsFor(parentField as never, m);
    expect(all.map((o) => o.label)).toEqual(['Main Location']);
    expect(optionsFor(parentField as never, m, all[0]?.value)).toEqual([]);
  });
});

describe('the demo company', () => {
  it('loads with no refusals, and its opening balances agree', async () => {
    const host = newHost();
    const r = await loadDemoCompany(host);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const books = r.value;
    const lines = await books.backend.load(books.companyId).then(async () =>
      (books.backend as unknown as { lines(q: { companyId: string }): Promise<Parameters<typeof trialBalance>[0]> }).lines({ companyId: books.companyId }),
    );
    const tb = trialBalance(lines);
    expect(tb.isBalanced).toBe(true);
    const diff = books.masters.openingDifferenceLedger()?.id;
    // capital and debtors/creditors were chosen to agree, so the difference ledger nets to nothing
    expect(tb.rows.find((row) => row.ledgerId === diff)?.closing ?? 0n).toBe(0n);
    expect(books.masters.ledgers.length).toBeGreaterThan(20);
    expect(books.masters.parties).toHaveLength(5);
    // a customer, a vendor and one that is both: 1 + 1 + 2 + 1 + 1 party ledgers
    expect(books.masters.ledgers.filter((l) => l.partyRole !== undefined)).toHaveLength(6);
    expect(books.masters.ledgers.filter((l) => l.partyId !== undefined && l.name.startsWith('Kumar')).map((l) => l.name).sort()).toEqual(['Kumar Engineering Works', 'Kumar Engineering Works (Vendor)']);
    expect(books.masters.stockItems.length).toBeGreaterThan(5);
  });

  it('cannot be loaded over an open company', async () => {
    const { host } = await opened();
    const r = await loadDemoCompany(host);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.issues[0]?.code).toBe(IssueCode.UnsupportedOperation);
  });
});

describe('search documents', () => {
  it('turn every kind of master into something findable, with actions', async () => {
    const host = newHost();
    const r = await loadDemoCompany(host);
    if (!r.ok) throw new Error('demo failed');
    const docs = entityDocsOf(r.value.masters);
    const kinds = new Set(docs.map((d) => d.kind));
    for (const k of ['Ledger', 'Group', 'Party', 'Stock Item', 'Stock Group', 'Unit', 'Warehouse', 'Voucher Type', 'GST Rate']) expect(kinds.has(k), k).toBe(true);
    // a party is ONE master hit (its own ledgers are reached through it), with its ledger report as an action — and its Ledger report is a result of
    // its own, so typing the name and choosing the second row goes straight to the report
    const abc = docs.filter((d) => d.title === 'ABC Industries');
    expect(abc.map((d) => d.kind)).toEqual(['Party', 'Ledger report']);
    expect(abc[0]?.actions?.map((x) => x.label)).toEqual(['Display Party', 'Alter Party', 'Ledger report']);
    expect(abc[0]?.subtitle).toContain('Customer');
    expect(abc[1]).toMatchObject({ commandId: 'report.ledgerOf', scope: 'party' });
    // a party that is both offers one report per ledger
    const kumar = docs.filter((d) => d.title.startsWith('Kumar Engineering Works'));
    expect(kumar.map((d) => d.kind)).toEqual(['Party', 'Ledger report', 'Ledger report']);
    expect(kumar[0]?.actions?.map((x) => x.label)).toEqual(['Display Party', 'Alter Party', 'Ledger report (as customer)', 'Ledger report (as vendor)']);
    expect(kumar[0]?.subtitle).toContain('Customer · Vendor');
    expect(kumar.slice(1).map((d) => d.title)).toEqual(['Kumar Engineering Works (as customer)', 'Kumar Engineering Works (as vendor)']);
    // a stock item has its Stock ledger as a result of its own (a service has none)
    const sheet = docs.filter((d) => d.title === 'MS Sheet 2mm');
    expect(sheet.map((d) => d.kind)).toEqual(['Stock Item', 'Stock ledger']);
    expect(sheet[1]).toMatchObject({ commandId: 'report.stockLedgerOf', scope: 'item' });
    // ordinary ledgers are still hits of their own, and can open their report
    const bank = docs.find((d) => d.title === 'HDFC Bank Current A/c');
    expect(bank?.actions?.map((x) => x.label)).toEqual(['Display Ledger', 'Alter Ledger', 'Ledger report']);
    expect(docs.filter((d) => d.title === 'HDFC Bank Current A/c').map((d) => d.kind)).toEqual(['Ledger', 'Ledger report']);
    expect(docs.some((d) => d.kind === 'Ledger' && d.title === 'ABC Industries')).toBe(false);
  });

  it('are rebuilt for a new snapshot, so a record created a moment ago is found immediately', async () => {
    const { books } = await opened();
    const before = entityDocsOf(books.masters);
    await books.execute({ op: 'create', kind: 'party', id: '00000000-0000-4000-8000-0000000000dd', data: { name: 'Fresh Party' } });
    const after = entityDocsOf(books.masters);
    expect(after).not.toBe(before);
    expect(after.some((d) => d.title === 'Fresh Party')).toBe(true);
    expect(before.some((d) => d.title === 'Fresh Party')).toBe(false);
  });
});
