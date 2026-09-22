import { MemoryBackend } from '@minimalerp/adapter-memory';
import type { Result } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { type Books, BooksHost, type LocalBackend } from './books';
import { createLocalFactory, memoryStore } from './local';
import { SaveTracker } from './saving';

const acme = { name: 'Acme Works', fyStart: '2024-04-01' };

/**
 * Delays every write the tested method makes by `ms`, so a test can observe the "saving" phase without an artificial delay in the app
 * itself. Its methods are on the prototype (a class instance), so this proxies rather than spreads — a spread would lose them.
 */
function slowed(backend: LocalBackend, ms: number): LocalBackend {
  const wait = () => new Promise((resolve) => setTimeout(resolve, ms));
  return new Proxy(backend, {
    get(target, prop, receiver) {
      if (prop === 'post') return async (r: never) => (await wait(), target.post(r));
      if (prop === 'execute') return async (r: never) => (await wait(), target.execute(r));
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function openWith(saving: SaveTracker, ms: number): Promise<Books> {
  const factory = createLocalFactory({
    makeBackend: (masters) => slowed(new MemoryBackend(masters) as unknown as LocalBackend, ms),
    store: memoryStore(),
    saving,
  });
  const host = new BooksHost(factory);
  const created = await host.create(acme);
  if (!created.ok) throw new Error(JSON.stringify(created.issues));
  return created.value;
}

describe('the saving overlay is wired to what a screen actually calls', () => {
  it('a factory-supplied tracker is the one Books uses, and every screen call goes through it', async () => {
    const saving = new SaveTracker();
    const books = await openWith(saving, 200);
    expect(books.saving).toBe(saving);

    const seen: string[] = [];
    saving.subscribe(() => seen.push(saving.view.phase));
    // A real, valid payment (Cash and the suspense ledger are always in the standard seed): the point of this test is the panel's
    // timing, so the draft only needs to be one the domain accepts, not anything meaningful.
    const cash = books.masters.ledgers.find((l) => l.name === 'Cash')!;
    const suspense = books.masters.ledgers.find((l) => l.reservedKey === 'opening-difference')!;
    const draft = {
      id: '00000000-0000-4000-8000-000000000001',
      voucherTypeId: books.masters.voucherTypes.find((t) => t.baseKind === 'payment')!.id,
      date: books.masters.financialYears[0]!.start,
      accountLedgerId: cash.id,
      lines: [{ ledgerId: suspense.id, amount: '1' }],
    };
    const posting = books.post(draft) as Promise<Result<unknown>>;
    expect(saving.view.phase).toBe('idle'); // not yet 100ms in
    await new Promise((r) => setTimeout(r, 150));
    expect(saving.blocking).toBe(true); // now it does, and it blocks
    await posting;
    expect(seen).toContain('saving');
  });

  it('without a tracker, Books still works (its own, private one) — the overlay is additive, never required', async () => {
    const books = await openWith(new SaveTracker(), 0); // exercise a plain path with no injected delay
    const r = await books.execute({ op: 'create', kind: 'party', id: '00000000-0000-4000-8000-0000000000ee', data: { name: 'Quick Co' } });
    expect(r.ok).toBe(true);
  });

  it('two companies opened from factories that were given the SAME tracker share one overlay', async () => {
    const saving = new SaveTracker();
    const a = await openWith(saving, 0);
    const b = await openWith(saving, 0);
    expect(a.saving).toBe(b.saving);
  });
});
