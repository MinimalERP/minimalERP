import type { SearchHit } from './types';

/** The subset of Web Storage we use, so tests can pass a plain object. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What is remembered about a result: enough to show and run it again without asking any provider. */
export interface RecentEntry {
  readonly key: string;
  readonly kind: string;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly badge?: string | undefined;
  readonly commandId: string;
  readonly args?: unknown;
  readonly count: number;
  readonly lastUsed: number;
  readonly pinned: boolean;
}

const DAY = 86_400_000;
const HALF_LIFE_DAYS = 14;

/**
 * Recently used and pinned ("favourite") results, ranked by FRECENCY: how often × how recently.
 * Something used a lot last week outranks something used once today, and a habit fades over a
 * couple of weeks if you stop. Persisted, so it survives reloads.
 */
export class RecentStore {
  private entries: RecentEntry[];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage?: StorageLike,
    private readonly now: () => number = Date.now,
    private readonly max = 60,
    private readonly storageKey = 'minimalerp.recents.v1',
  ) {
    this.entries = this.load();
  }

  record(hit: SearchHit): void {
    const existing = this.entries.find((e) => e.key === hit.key);
    const next: RecentEntry = {
      key: hit.key, kind: hit.kind, title: hit.title, subtitle: hit.subtitle, badge: hit.badge,
      commandId: hit.commandId, args: hit.args,
      count: (existing?.count ?? 0) + 1,
      lastUsed: this.now(),
      pinned: existing?.pinned ?? false,
    };
    this.replace(next);
  }

  togglePinned(hit: SearchHit): boolean {
    const existing = this.entries.find((e) => e.key === hit.key);
    const pinned = !(existing?.pinned ?? false);
    this.replace({
      key: hit.key, kind: hit.kind, title: hit.title, subtitle: hit.subtitle, badge: hit.badge,
      commandId: hit.commandId, args: hit.args,
      count: existing?.count ?? 0,
      lastUsed: existing?.lastUsed ?? this.now(),
      pinned,
    });
    return pinned;
  }

  isPinned(key: string): boolean {
    return this.entries.find((e) => e.key === key)?.pinned ?? false;
  }

  /** 0..1. Grows with use (with diminishing returns) and halves every two weeks of disuse. */
  frecency(key: string): number {
    const e = this.entries.find((x) => x.key === key);
    if (!e || e.count === 0) return 0;
    const usage = Math.min(1, Math.log2(1 + e.count) / Math.log2(21));
    const ageDays = Math.max(0, (this.now() - e.lastUsed) / DAY);
    return usage * 0.5 ** (ageDays / HALF_LIFE_DAYS);
  }

  pinned(): RecentEntry[] {
    return this.entries.filter((e) => e.pinned).sort((a, b) => b.lastUsed - a.lastUsed);
  }

  recents(limit = 10): RecentEntry[] {
    return this.entries
      .filter((e) => !e.pinned && e.count > 0)
      .sort((a, b) => this.frecency(b.key) - this.frecency(a.key))
      .slice(0, limit);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private replace(entry: RecentEntry): void {
    const rest = this.entries.filter((e) => e.key !== entry.key);
    // Keep pinned entries always; trim the least-used unpinned ones beyond `max`.
    const merged = [entry, ...rest];
    const keep = merged.filter((e) => e.pinned);
    const others = merged.filter((e) => !e.pinned).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, this.max);
    this.entries = [...keep, ...others];
    this.save();
    for (const l of [...this.listeners]) l();
  }

  private save(): void {
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(this.entries));
    } catch {
      /* storage unavailable: recents just do not persist */
    }
  }

  private load(): RecentEntry[] {
    try {
      const raw = this.storage?.getItem(this.storageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is RecentEntry =>
          e !== null && typeof e === 'object' && typeof e.key === 'string' && typeof e.commandId === 'string' &&
          typeof e.title === 'string' && typeof e.kind === 'string' && typeof e.count === 'number' &&
          typeof e.lastUsed === 'number' && typeof e.pinned === 'boolean',
      );
    } catch {
      return [];
    }
  }
}
