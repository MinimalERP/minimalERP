/** The little bit of storage a company needs (its saved state, and half-entered vouchers). IndexedDB in the browser, a Map in tests. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
