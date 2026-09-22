import { type Masters, type Result, asCompanyId, ok } from '@minimalerp/domain';
import type { KeyValueStore } from './store';
import { Books, type BooksFactory, type LocalBackend, type NewCompany, type SavedCompany, newCompanyIssues, seedMasters } from './books';
import type { SaveTracker } from './saving';

export type { KeyValueStore };

export function memoryStore(): KeyValueStore & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, structuredClone(value)),
    delete: async (key) => void data.delete(key),
  };
}

interface Stored {
  readonly version: 1;
  readonly company: SavedCompany;
  readonly log: readonly unknown[];
}

const KEY = 'company';

export interface LocalFactoryOptions {
  /** Builds the backend for a company's starting masters. The composition root chooses which one. */
  readonly makeBackend: (masters: Masters) => LocalBackend;
  readonly store: KeyValueStore;
  readonly newIdSeed?: () => string;
  /** Shared across every company this factory opens, so the saving overlay is the same object across a close/reopen. */
  readonly saving?: SaveTracker | undefined;
}

/**
 * A company that lives in this browser: a backend built from the seed, saved as "the seed plus every change".
 * On the next visit the changes are replayed onto a freshly seeded backend and everything — numbers, balances — is
 * exactly as it was. (The same `Books` API sits on Supabase later; nothing above this file knows the difference.)
 */
export function createLocalFactory(options: LocalFactoryOptions): BooksFactory {
  const { makeBackend, store, saving } = options;
  const newSeed = options.newIdSeed ?? (() => crypto.randomUUID());

  const open = async (saved: SavedCompany, log: readonly unknown[]): Promise<Result<Books>> => {
    // A company gets the GST / TDS system ledgers from its seed. One saved BEFORE they existed may have made a ledger of the same name by hand, which
    // the seed's own would then collide with on replay: so if the history does not replay, it is replayed onto a seed without them, and they are
    // added afterwards — once, by reserved key, adopting the ledger the person made. (Adding them is not a change to the log: it happens on every open.)
    let masters = seedMasters(saved);
    let backend = makeBackend(masters);
    let replayed = await backend.replay(log);
    if (!replayed.ok && backend.ensureSystemLedgers) {
      masters = seedMasters(saved, { systemLedgers: false });
      backend = makeBackend(masters);
      replayed = await backend.replay(log);
      if (replayed.ok) backend.ensureSystemLedgers?.();
    }
    if (!replayed.ok) return replayed;

    // Save after every change. Writes are queued so a slow one never overtakes a later one.
    let queue: Promise<unknown> = Promise.resolve();
    backend.onChange(() => {
      queue = queue
        .then(() => store.set(KEY, { version: 1, company: saved, log: backend.changes() } satisfies Stored))
        .catch((error: unknown) => console.error('Could not save the company', error));
    });

    const companyId = asCompanyId(masters.company.id);
    const books = new Books(backend, companyId, await backend.load(companyId), store, saving);
    await books.loadData();
    return ok(books);
  };

  return {
    async restore() {
      const stored = (await store.get(KEY)) as Stored | undefined;
      if (!stored || stored.version !== 1) return undefined;
      const result = await open(stored.company, stored.log);
      if (!result.ok) {
        console.error('The saved company could not be reopened', result.issues);
        return undefined;
      }
      return result.value;
    },

    async create(input: NewCompany) {
      const problems = newCompanyIssues(input);
      if (problems.length > 0) return { ok: false, issues: problems } as const;
      const saved: SavedCompany = {
        name: input.name.trim().replace(/\s+/g, ' '),
        fyStart: input.fyStart,
        gstin: input.gstin?.trim() ? input.gstin.trim().toUpperCase() : undefined,
        stateCode: input.stateCode?.trim() || undefined,
        address: input.address?.trim() || undefined,
        idSeed: newSeed(),
      };
      const result = await open(saved, []);
      if (result.ok) await store.set(KEY, { version: 1, company: saved, log: [] } satisfies Stored);
      return result;
    },

    async discard() {
      await store.delete(KEY);
    },
  };
}
