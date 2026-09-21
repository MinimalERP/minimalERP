import type { KeyValueStore } from './local';

const STORE = 'kv';

/**
 * A key-value store on IndexedDB (structured clone keeps `bigint` intact, which JSON would not).
 * Returns undefined when IndexedDB is unavailable (some private windows): the app then works, it just does not remember.
 */
export function indexedDbStore(name = 'minimalerp'): KeyValueStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;

  let opened: Promise<IDBDatabase> | undefined;
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
    }));

  const run = async <T,>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const database = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  };

  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: async (key, value) => void (await run('readwrite', (s) => s.put(value, key))),
    delete: async (key) => void (await run('readwrite', (s) => s.delete(key))),
  };
}
