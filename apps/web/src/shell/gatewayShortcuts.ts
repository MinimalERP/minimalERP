import type { StorageLike } from '@minimalerp/keyboard';

const STORAGE_KEY = 'minimalerp.gateway-shortcuts.v1';
export const DEFAULT_GATEWAY_SHORTCUTS = ['voucher.new.sales', 'report.salesOrders'] as const;

/** User-selected command links shown in the Gateway's small Shortcuts panel. */
export class GatewayShortcutsStore {
  private selected: string[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage?: StorageLike) {
    this.selected = this.read();
  }

  get ids(): readonly string[] {
    return this.selected;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  set(ids: readonly string[]): void {
    this.selected = [...new Set(ids)];
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.selected));
    } catch {
      // The shortcuts still work for this session when browser storage is blocked.
    }
    for (const listener of [...this.listeners]) listener();
  }

  private read(): string[] {
    try {
      const saved = this.storage?.getItem(STORAGE_KEY);
      if (saved !== null && saved !== undefined) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) return [...new Set(parsed)];
      }
    } catch {
      // Fall back to the two useful starter links when storage is unavailable or malformed.
    }
    return [...DEFAULT_GATEWAY_SHORTCUTS];
  }
}
