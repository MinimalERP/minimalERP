import { describe, expect, it, vi } from 'vitest';
import { parseQuery } from './query';
import { RecentStore, type StorageLike } from './recents';
import { CommandRegistry } from './registry';
import { SearchService, commandProvider } from './search';
import type { Command, SearchHit, SearchProvider } from './types';

const memoryStorage = (): StorageLike & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v), removeItem: (k) => void delete data[k] };
};

const hit = (key: string, title: string, score = 0.8, commandId = key): SearchHit => ({ key, kind: 'Test', title, commandId, score });

describe('parseQuery', () => {
  it('splits plain text into terms', () => {
    expect(parseQuery('  trial   balance ')).toEqual({ raw: '  trial   balance ', text: 'trial   balance', terms: ['trial', 'balance'] });
  });

  it.each([
    ['>trial', 'command', 'trial'], ['> trial bal', 'command', 'trial bal'], ['@abc', 'party', 'abc'],
    ['l:cash', 'ledger', 'cash'], ['L:Cash', 'ledger', 'Cash'], ['i:bolt', 'item', 'bolt'], ['v:S/24', 'voucher', 'S/24'], ['g:assets', 'group', 'assets'],
  ])('%j → scope %s, text %s', (raw, scope, text) => {
    const q = parseQuery(raw);
    expect(q.scope).toBe(scope);
    expect(q.text).toBe(text);
  });

  it('an empty or prefix-only query has no terms', () => {
    expect(parseQuery('').terms).toEqual([]);
    expect(parseQuery('   ').terms).toEqual([]);
    expect(parseQuery('>').terms).toEqual([]);
  });

  it('does not mistake ordinary text for a prefix', () => {
    expect(parseQuery('long term').scope).toBeUndefined();
    expect(parseQuery('a@b').scope).toBeUndefined();
  });
});

describe('RecentStore', () => {
  const t0 = 1_700_000_000_000;
  const day = 86_400_000;

  it('records use, counts it, and remembers what is needed to show and run it again', () => {
    const s = new RecentStore(undefined, () => t0);
    s.record({ ...hit('cmd:a', 'Alpha'), commandId: 'a', args: { id: 7 }, subtitle: 'sub' });
    s.record(hit('cmd:a', 'Alpha'));
    const [e] = s.recents();
    expect(e).toMatchObject({ key: 'cmd:a', title: 'Alpha', count: 2 });
  });

  it('frecency: more use scores higher, with diminishing returns', () => {
    const s = new RecentStore(undefined, () => t0);
    s.record(hit('once', 'Once'));
    for (let i = 0; i < 5; i++) s.record(hit('often', 'Often'));
    for (let i = 0; i < 50; i++) s.record(hit('habit', 'Habit'));
    expect(s.frecency('once')).toBeLessThan(s.frecency('often'));
    expect(s.frecency('often')).toBeLessThan(s.frecency('habit'));
    expect(s.frecency('habit')).toBeLessThanOrEqual(1);
    expect(s.frecency('never')).toBe(0);
  });

  it('frecency: halves every two weeks of disuse', () => {
    let now = t0;
    const s = new RecentStore(undefined, () => now);
    s.record(hit('a', 'A'));
    const fresh = s.frecency('a');
    now = t0 + 14 * day;
    expect(s.frecency('a')).toBeCloseTo(fresh / 2, 5);
    now = t0 + 28 * day;
    expect(s.frecency('a')).toBeCloseTo(fresh / 4, 5);
  });

  it('a habit from last week can outrank a one-off today', () => {
    let now = t0;
    const s = new RecentStore(undefined, () => now);
    for (let i = 0; i < 30; i++) s.record(hit('habit', 'Habit'));
    now = t0 + 7 * day;
    s.record(hit('oneoff', 'One-off'));
    expect(s.frecency('habit')).toBeGreaterThan(s.frecency('oneoff'));
    expect(s.recents()[0]?.key).toBe('habit');
  });

  it('pins and unpins; pinned items are listed separately and never trimmed', () => {
    const s = new RecentStore(undefined, () => t0, 2);
    expect(s.togglePinned(hit('fav', 'Fav'))).toBe(true);
    expect(s.isPinned('fav')).toBe(true);
    for (const k of ['a', 'b', 'c', 'd']) s.record(hit(k, k));
    expect(s.pinned().map((e) => e.key)).toEqual(['fav']);
    expect(s.recents().length).toBeLessThanOrEqual(2); // trimmed to max…
    expect(s.pinned().length).toBe(1); // …but the favourite survives
    expect(s.togglePinned(hit('fav', 'Fav'))).toBe(false);
    expect(s.isPinned('fav')).toBe(false);
  });

  it('recording a pinned item keeps it pinned', () => {
    const s = new RecentStore(undefined, () => t0);
    s.togglePinned(hit('fav', 'Fav'));
    s.record(hit('fav', 'Fav'));
    expect(s.isPinned('fav')).toBe(true);
  });

  it('persists across a reload', () => {
    const storage = memoryStorage();
    const a = new RecentStore(storage, () => t0);
    a.record(hit('x', 'X'));
    a.togglePinned(hit('y', 'Y'));
    const b = new RecentStore(storage, () => t0);
    expect(b.recents().map((e) => e.key)).toEqual(['x']);
    expect(b.pinned().map((e) => e.key)).toEqual(['y']);
  });

  it.each(['{bad', 'null', '{"a":1}', '[1,"x",{"key":1}]'])('survives corrupt stored data (%s)', (raw) => {
    const storage = memoryStorage();
    storage.setItem('minimalerp.recents.v1', raw);
    expect(new RecentStore(storage).recents()).toEqual([]);
  });

  it('keeps working when storage throws', () => {
    const broken: StorageLike = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => undefined };
    const s = new RecentStore(broken, () => t0);
    expect(() => s.record(hit('a', 'A'))).not.toThrow();
    expect(s.recents()).toHaveLength(1);
  });

  it('notifies subscribers of changes', () => {
    const s = new RecentStore(undefined, () => t0);
    const listener = vi.fn();
    s.subscribe(listener);
    s.record(hit('a', 'A'));
    s.togglePinned(hit('b', 'B'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('SearchService', () => {
  const ctx = { app: {}, scopes: ['screen:menu'] };
  const service = (providers: SearchProvider<object>[], recents = new RecentStore(undefined, () => 0), runnable = () => true) =>
    ({ recents, svc: new SearchService<object>({ providers: () => providers, recents, isRunnable: runnable }) });
  const provider = (id: string, hits: SearchHit[], scopes?: string[]): SearchProvider<object> => ({ id, ...(scopes ? { scopes } : {}), search: () => hits });

  it('merges every provider’s hits, best first', async () => {
    const { svc } = service([provider('a', [hit('1', 'One', 0.5)]), provider('b', [hit('2', 'Two', 0.9)])]);
    expect((await svc.search('x', ctx)).map((h) => h.key)).toEqual(['2', '1']);
  });

  it('de-duplicates by key, keeping the better score', async () => {
    const { svc } = service([provider('a', [hit('same', 'Same', 0.4)]), provider('b', [hit('same', 'Same', 0.9)])]);
    const r = await svc.search('x', ctx);
    expect(r).toHaveLength(1);
    expect(r[0]?.score).toBe(0.9);
  });

  it('honours the limit', async () => {
    const hits = Array.from({ length: 50 }, (_, i) => hit(`k${i}`, `T${i}`, 0.5));
    const { svc } = service([provider('a', hits)]);
    expect(await svc.search('x', ctx, { limit: 5 })).toHaveLength(5);
  });

  it('lifts what you use often above an equally-relevant alternative', async () => {
    const { svc, recents } = service([provider('a', [hit('rare', 'Rare', 0.7), hit('usual', 'Usual', 0.7)])]);
    for (let i = 0; i < 10; i++) recents.record(hit('usual', 'Usual'));
    expect((await svc.search('x', ctx)).map((h) => h.key)).toEqual(['usual', 'rare']);
  });

  it('but relevance still dominates: a much better match beats a merely popular one', async () => {
    const { svc, recents } = service([provider('a', [hit('great', 'Great', 0.95), hit('popular', 'Popular', 0.4)])]);
    for (let i = 0; i < 20; i++) recents.record(hit('popular', 'Popular'));
    expect((await svc.search('x', ctx))[0]?.key).toBe('great');
  });

  it('a pinned favourite gets a further lift', async () => {
    const { svc, recents } = service([provider('a', [hit('a', 'A', 0.7), hit('b', 'B', 0.72)])]);
    recents.togglePinned(hit('a', 'A'));
    expect((await svc.search('x', ctx))[0]?.key).toBe('a');
  });

  it('a scope prefix asks only the providers that answer to it', async () => {
    const commands = provider('c', [hit('cmd', 'Cmd')], ['command']);
    const ledgers = provider('l', [hit('led', 'Led')], ['ledger']);
    const unscopedOnly = provider('u', [hit('un', 'Un')]);
    const { svc } = service([commands, ledgers, unscopedOnly]);
    expect((await svc.search('>x', ctx)).map((h) => h.key)).toEqual(['cmd']);
    expect((await svc.search('l:x', ctx)).map((h) => h.key)).toEqual(['led']);
    expect((await svc.search('x', ctx)).map((h) => h.key).sort()).toEqual(['cmd', 'led', 'un']);
  });

  it('streams progress: fast providers appear before slow ones finish', async () => {
    const slow: SearchProvider<object> = { id: 'slow', search: () => new Promise((r) => setTimeout(() => r([hit('slow', 'Slow', 0.9)]), 30)) };
    const { svc } = service([provider('fast', [hit('fast', 'Fast', 0.5)]), slow]);
    const updates: string[][] = [];
    const final = await svc.search('x', ctx, { onUpdate: (h) => updates.push(h.map((x) => x.key)) });
    expect(updates[0]).toEqual(['fast']); // local result first
    expect(updates.at(-1)).toEqual(['slow', 'fast']);
    expect(final.map((h) => h.key)).toEqual(['slow', 'fast']);
  });

  it('a failing provider does not blank the results from the others', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken: SearchProvider<object> = { id: 'server', search: () => Promise.reject(new Error('offline')) };
    const { svc } = service([broken, provider('ok', [hit('ok', 'Ok')])]);
    expect((await svc.search('x', ctx)).map((h) => h.key)).toEqual(['ok']);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('an aborted search returns nothing and stops reporting progress', async () => {
    const controller = new AbortController();
    const slow: SearchProvider<object> = { id: 'slow', search: () => new Promise((r) => setTimeout(() => r([hit('a', 'A')]), 20)) };
    const { svc } = service([slow]);
    const onUpdate = vi.fn();
    const pending = svc.search('x', ctx, { signal: controller.signal, onUpdate });
    controller.abort();
    expect(await pending).toEqual([]);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('passes the query, context and signal to providers', async () => {
    const search = vi.fn(() => []);
    const { svc } = service([{ id: 'p', scopes: ['command'], search }]);
    const controller = new AbortController();
    await svc.search('>trial bal', ctx, { signal: controller.signal });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ scope: 'command', text: 'trial bal', terms: ['trial', 'bal'] }), ctx, controller.signal);
  });

  describe('with nothing typed: suggestions', () => {
    it('shows favourites first, then what you use most — as Favourite / Recent', async () => {
      const { svc, recents } = service([]);
      recents.record(hit('used', 'Used'));
      recents.togglePinned(hit('fav', 'Fav'));
      const r = await svc.search('   ', ctx);
      expect(r.map((h) => [h.key, h.kind])).toEqual([['fav', 'Favourite'], ['used', 'Recent']]);
    });

    it('omits entries whose command can no longer run', async () => {
      const { svc, recents } = service([], undefined, () => false);
      recents.record(hit('gone', 'Gone'));
      expect(await svc.search('', ctx)).toEqual([]);
    });

    it('is empty for a brand-new user', async () => {
      expect(await service([]).svc.search('', ctx)).toEqual([]);
    });
  });
});

describe('commandProvider', () => {
  interface Ctx { allowed: boolean }
  const build = (commands: Command<Ctx>[]) => {
    const app: Ctx = { allowed: true };
    const registry = new CommandRegistry<Ctx>(() => app);
    for (const c of commands) registry.register(c);
    return { app, provider: commandProvider(registry) };
  };
  const run = () => undefined;
  const search = (p: SearchProvider<Ctx>, app: Ctx, text: string) => p.search(parseQuery(text), { app, scopes: [] }) as SearchHit[];

  it('finds commands by title, fuzzily, with highlight ranges and the command id to run', () => {
    const { app, provider } = build([{ id: 'report.trialBalance', title: 'Trial Balance', category: 'Report', badge: 'Phase 6', run }]);
    const [h] = search(provider, app, 'trb');
    expect(h).toMatchObject({ key: 'cmd:report.trialBalance', kind: 'Report', title: 'Trial Balance', badge: 'Phase 6', commandId: 'report.trialBalance' });
    expect(h?.ranges?.length).toBeGreaterThan(0);
  });

  it('finds commands through keywords and category, ranked below title matches', () => {
    const { app, provider } = build([
      { id: 'a', title: 'Create Ledger', category: 'Create', run },
      { id: 'b', title: 'Party Master', category: 'Create', keywords: ['ledger'], run },
    ]);
    const hits = search(provider, app, 'ledger').sort((x, y) => y.score - x.score);
    expect(hits.map((h) => h.commandId)).toEqual(['a', 'b']);
  });

  it('never offers hidden commands, contextual commands (no run), or unavailable ones', () => {
    const { app, provider } = build([
      { id: 'visible', title: 'Visible Thing', category: 'X', run },
      { id: 'hidden', title: 'Hidden Thing', category: 'X', hidden: true, run },
      { id: 'ctx', title: 'Contextual Thing', category: 'X' },
      { id: 'gated', title: 'Gated Thing', category: 'X', when: (c) => c.allowed, run },
    ]);
    expect(search(provider, app, 'thing').map((h) => h.commandId).sort()).toEqual(['gated', 'visible']);
    app.allowed = false;
    expect(search(provider, app, 'thing').map((h) => h.commandId)).toEqual(['visible']);
  });

  it('answers the > scope', () => {
    const { provider } = build([]);
    expect(provider.scopes).toEqual(['command']);
  });
});
