/**
 * Scopes say "where the user is", so the same key can mean different things in different places
 * (F8 = open a Sales voucher from the Gateway, but switch to Sales while inside a voucher).
 *
 * Layers are ordered global < screen < region < overlay. Order is by LAYER first, then by when a scope
 * was pushed — never by mount order alone — because in a component tree children mount before parents,
 * and a global scope registered by the app root would otherwise land on top of everything.
 */
export type ScopeLayer = 'global' | 'screen' | 'region' | 'overlay';

const RANK: Record<ScopeLayer, number> = { global: 0, screen: 1, region: 2, overlay: 3 };

export interface ScopeSpec {
  readonly id: string;
  readonly layer: ScopeLayer;
  /** A modal scope hides everything beneath it — including the global scope — while it is open. */
  readonly modal?: boolean;
}

export interface ActiveScopes {
  /** Innermost first. Ends at (and includes) the first modal scope, if any. */
  readonly scopes: readonly ScopeSpec[];
  readonly ids: readonly string[];
  readonly modal: boolean;
}

interface Entry {
  readonly spec: ScopeSpec;
  readonly seq: number;
}

export class ScopeStack {
  private entries: Entry[] = [];
  private seq = 0;
  private readonly listeners = new Set<() => void>();
  private cached: ActiveScopes = { scopes: [], ids: [], modal: false };

  /** Activates a scope; returns the function that deactivates it. */
  push(spec: ScopeSpec): () => void {
    const entry: Entry = { spec, seq: this.seq++ };
    this.entries.push(entry);
    this.recompute();
    return () => {
      const i = this.entries.indexOf(entry);
      if (i === -1) return;
      this.entries.splice(i, 1);
      this.recompute();
    };
  }

  /** The current active scopes. The same object is returned until something changes. */
  snapshot(): ActiveScopes {
    return this.cached;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private recompute(): void {
    const ordered = [...this.entries].sort(
      (a, b) => RANK[b.spec.layer] - RANK[a.spec.layer] || b.seq - a.seq,
    );
    const scopes: ScopeSpec[] = [];
    let modal = false;
    for (const { spec } of ordered) {
      scopes.push(spec);
      if (spec.modal) {
        modal = true;
        break;
      }
    }
    this.cached = { scopes, ids: scopes.map((s) => s.id), modal };
    for (const l of [...this.listeners]) l();
  }
}
