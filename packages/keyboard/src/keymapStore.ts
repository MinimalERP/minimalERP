import { type Chord, isBarePrintable, normalizeChord } from './chord';
import { type BindingSpec, Keymap, type KeymapProblem, type Overrides } from './keymap';

/** The subset of Web Storage we use, so tests can pass a plain object. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AssignResult =
  | { readonly ok: true; readonly chord: Chord }
  | { readonly ok: false; readonly reason: 'invalid' | 'conflict'; readonly message: string; readonly conflictWith?: string };

const STORAGE_KEY = 'minimalerp.keymap.v1';

/**
 * Holds the defaults plus the user's overrides (persisted), and exposes the effective Keymap.
 * This is the single source for "which key does what" — the settings screen edits it, the
 * KeyboardManager reads it on every keystroke, so a change takes effect immediately.
 */
export class KeymapStore {
  private overridesNow: Overrides = {};
  private built: { keymap: Keymap; problems: KeymapProblem[] };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly defaults: readonly BindingSpec[],
    private readonly storage?: StorageLike,
    private readonly storageKey: string = STORAGE_KEY,
  ) {
    this.overridesNow = this.load();
    this.built = Keymap.build(defaults, this.overridesNow);
  }

  get keymap(): Keymap {
    return this.built.keymap;
  }

  get problems(): readonly KeymapProblem[] {
    return this.built.problems;
  }

  get overrides(): Overrides {
    return this.overridesNow;
  }

  isCustomised(commandId: string): boolean {
    return Object.hasOwn(this.overridesNow, commandId);
  }

  /** Makes `chord` the shortcut for `commandId` (replacing its other chords). Refuses invalid or conflicting chords. */
  assign(commandId: string, chordText: string): AssignResult {
    const chord = normalizeChord(chordText);
    if (chord === undefined) return { ok: false, reason: 'invalid', message: `"${chordText}" is not a key combination` };
    if (isBarePrintable(chord)) {
      return { ok: false, reason: 'invalid', message: `${chord} is a typing key — add Ctrl, Alt or use a function key` };
    }

    const candidate = Keymap.build(this.defaults, { ...this.overridesNow, [commandId]: [chord] });
    const clash = candidate.problems.find(
      (p) => p.kind === 'conflict' && p.chord === chord && p.commands.includes(commandId),
    );
    if (clash && clash.kind === 'conflict') {
      const other = clash.commands.find((c) => c !== commandId);
      return {
        ok: false, reason: 'conflict',
        message: `${chord} is already used${other ? ` by ${other}` : ''}`,
        ...(other === undefined ? {} : { conflictWith: other }),
      };
    }
    this.set({ ...this.overridesNow, [commandId]: [chord] });
    return { ok: true, chord };
  }

  /** Removes every shortcut from the command (it stays reachable from menus and Go To). */
  unbind(commandId: string): void {
    this.set({ ...this.overridesNow, [commandId]: [] });
  }

  /** Restores the command's default shortcut(s). */
  reset(commandId: string): void {
    if (!this.isCustomised(commandId)) return;
    const { [commandId]: _removed, ...rest } = this.overridesNow;
    this.set(rest);
  }

  resetAll(): void {
    this.set({});
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private set(next: Overrides): void {
    this.overridesNow = next;
    this.built = Keymap.build(this.defaults, next);
    try {
      if (Object.keys(next).length === 0) this.storage?.removeItem(this.storageKey);
      else this.storage?.setItem(this.storageKey, JSON.stringify(next));
    } catch {
      /* storage unavailable (private mode, quota): the change still applies for this session */
    }
    for (const l of [...this.listeners]) l();
  }

  private load(): Overrides {
    try {
      const raw = this.storage?.getItem(this.storageKey);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string[]> = {};
      for (const [id, chords] of Object.entries(parsed)) {
        if (Array.isArray(chords) && chords.every((c) => typeof c === 'string')) out[id] = chords as string[];
      }
      return out;
    } catch {
      return {}; // corrupt or unavailable: fall back to defaults rather than failing to start
    }
  }
}
