import { describe, expect, it } from 'vitest';
import { type EntityDoc, entityProvider, searchEntities } from './entity';
import { parseQuery } from './query';

const doc = (over: Partial<EntityDoc> & Pick<EntityDoc, 'key' | 'title'>): EntityDoc => ({
  kind: 'Ledger',
  scope: 'ledger',
  commandId: 'master.open',
  ...over,
});

const docs: EntityDoc[] = [
  doc({ key: 'l1', title: 'ABC Industries', subtitle: 'Sundry Debtors' }),
  doc({
    key: 'p1',
    title: 'ABC Industries',
    kind: 'Party',
    scope: 'party',
    subtitle: '27AAPFU0939F1ZV',
    identifiers: ['27AAPFU0939F1ZV', '9876543210'],
  }),
  doc({ key: 'i1', title: 'ABC Bolt M8', kind: 'Stock Item', scope: 'item', identifiers: ['BL-M8', '7318'] }),
  doc({ key: 'l2', title: 'Rent Paid', subtitle: 'Indirect Expenses' }),
  doc({ key: 'l3', title: 'Old ABC Traders', inactive: true }),
];
const keys = (q: string, o = {}) => searchEntities(docs, q, o).map((h) => h.key);

describe('searchEntities', () => {
  it('finds every kind of thing matching a name — ledger, party and item together', () => {
    expect(new Set(keys('abc'))).toEqual(new Set(['l1', 'p1', 'i1', 'l3']));
  });

  it('a scope narrows to one kind', () => {
    expect(keys('abc', { scope: 'party' })).toEqual(['p1']);
    expect(keys('abc', { scope: 'item' })).toEqual(['i1']);
  });

  it('a picker can restrict to kinds', () => {
    expect(keys('abc', { kinds: ['Ledger'] }).sort()).toEqual(['l1', 'l3']);
  });

  it('finds by GSTIN, phone, code and HSN — exact identifier beats everything', () => {
    expect(keys('27AAPFU0939F1ZV')[0]).toBe('p1');
    expect(keys('98765 43210')[0]).toBe('p1');
    expect(keys('bl-m8')[0]).toBe('i1');
    expect(keys('7318')[0]).toBe('i1');
  });

  it('a prefix of an identifier finds it', () => {
    expect(keys('27AAPF')).toContain('p1');
  });

  it('tolerates a typo', () => {
    expect(keys('industrys')).toContain('l1');
  });

  it('does not match unrelated names', () => {
    expect(keys('zzzz')).toEqual([]);
  });

  it('inactive records are found, marked, and rank below an equally good active one', () => {
    const hits = searchEntities(docs, 'abc');
    expect(hits.find((h) => h.key === 'l3')?.badge).toBe('Inactive');
    expect(hits.findIndex((h) => h.key === 'l3')).toBeGreaterThan(hits.findIndex((h) => h.key === 'l1'));
  });

  it('carries the actions through, and honours the limit', () => {
    const actions = [{ label: 'Alter', commandId: 'master.open', args: { mode: 'alter' } }];
    expect(searchEntities([doc({ key: 'x', title: 'Thing', actions })], 'thing')[0]?.actions).toEqual(actions);
    expect(searchEntities(docs, 'abc', { limit: 2 })).toHaveLength(2);
  });

  it('is fast enough for a big company: 20,000 records in well under a second', () => {
    const big: EntityDoc[] = Array.from({ length: 20_000 }, (_, i) =>
      doc({ key: `k${i}`, title: `Customer ${i} Trading Company`, identifiers: [`C${i}`] }),
    );
    searchEntities(big, 'warm'); // JIT warm-up
    const t0 = performance.now();
    const hits = searchEntities(big, 'customer 1999 trad');
    const ms = performance.now() - t0;
    expect(hits.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  });
});

describe('entityProvider', () => {
  const provider = entityProvider({ id: 'masters', scopes: ['ledger', 'party', 'item'], docs: () => docs });
  const ask = (q: string) => provider.search(parseQuery(q), { app: {}, scopes: [] });

  it('answers Go To queries and honours the l:/@/i: prefixes', async () => {
    expect((await ask('abc')).length).toBe(4);
    expect((await ask('@abc')).map((h) => h.key)).toEqual(['p1']);
    expect((await ask('i:abc')).map((h) => h.key)).toEqual(['i1']);
  });

  it('a code with a hyphen and digits finds its item — "14188-1" is not "no match" — and does not pull in the item whose code it merely starts', () => {
    const docs: EntityDoc[] = [
      { key: 'a', kind: 'Stock Item', scope: 'item', title: '14188- Orifice Plate .Blank 90', subtitle: 'Nos · 14188', commandId: 'x' },
      { key: 'b', kind: 'Stock Item', scope: 'item', title: '14188-1 - ORIF ,24 MM', subtitle: 'Nos · 14188-1', commandId: 'x' },
    ];
    expect(searchEntities(docs, '14188-1').map((h) => h.key)).toEqual(['b']);
    expect(searchEntities(docs, '14188-1 -').map((h) => h.key)).toEqual(['b']);
    expect(searchEntities(docs, '14188').map((h) => h.key).sort()).toEqual(['a', 'b']);
    expect(searchEntities(docs, 'orif').map((h) => h.key)[0]).toBe('b');
  });
});
