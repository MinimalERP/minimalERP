import { type Chord, isBarePrintable, normalizeChord } from './chord';

/** A default binding as a module declares it. `scope` omitted = active everywhere. */
export interface BindingSpec {
  readonly commandId: string;
  readonly chord: string;
  readonly scope?: string | undefined;
}

export interface Binding {
  readonly commandId: string;
  readonly chord: Chord;
  readonly scope?: string | undefined;
  readonly source: 'default' | 'user';
}

/** Per command: the chords that REPLACE its defaults. An empty list means "unbound". */
export type Overrides = Readonly<Record<string, readonly string[]>>;

export type KeymapProblem =
  | { readonly kind: 'invalid-chord'; readonly commandId: string; readonly chord: string; readonly reason: string }
  | {
      readonly kind: 'conflict';
      readonly chord: Chord;
      readonly scope?: string | undefined;
      readonly commands: readonly string[];
      readonly winner: string;
    };

/**
 * The effective keymap: pure data mapping chords to command ids, optionally per scope. It never runs
 * anything — the KeyboardManager asks it which commands a chord could mean *here*, most specific first.
 */
export class Keymap {
  private constructor(
    private readonly byChord: ReadonlyMap<Chord, readonly Binding[]>,
    private readonly byCommand: ReadonlyMap<string, readonly Binding[]>,
    private readonly defaultsByCommand: ReadonlyMap<string, readonly Binding[]>,
  ) {}

  static build(
    defaults: readonly BindingSpec[],
    overrides: Overrides = {},
  ): { keymap: Keymap; problems: KeymapProblem[] } {
    const problems: KeymapProblem[] = [];

    const parse = (commandId: string, raw: string, scope: string | undefined, source: Binding['source']): Binding | undefined => {
      const chord = normalizeChord(raw);
      if (chord === undefined) {
        problems.push({ kind: 'invalid-chord', commandId, chord: raw, reason: 'not a recognised key combination' });
        return undefined;
      }
      if (isBarePrintable(chord)) {
        problems.push({
          kind: 'invalid-chord', commandId, chord: raw,
          reason: 'a plain character key cannot be a shortcut — it could no longer be typed',
        });
        return undefined;
      }
      return { commandId, chord, scope, source };
    };

    const defaultBindings: Binding[] = [];
    for (const d of defaults) {
      const b = parse(d.commandId, d.chord, d.scope, 'default');
      if (b) defaultBindings.push(b);
    }
    const defaultsByCommand = new Map<string, Binding[]>();
    for (const b of defaultBindings) defaultsByCommand.set(b.commandId, [...(defaultsByCommand.get(b.commandId) ?? []), b]);

    // An override replaces all of a command's defaults, and inherits the scope of its first default.
    const effective: Binding[] = defaultBindings.filter((b) => !Object.hasOwn(overrides, b.commandId));
    for (const [commandId, chords] of Object.entries(overrides)) {
      const scope = defaultsByCommand.get(commandId)?.[0]?.scope;
      for (const raw of chords) {
        const b = parse(commandId, raw, scope, 'user');
        if (b) effective.push(b);
      }
    }

    // Two different commands on the same chord in the same scope: the user's choice wins, else the first declared.
    const groups = new Map<string, Binding[]>();
    for (const b of effective) {
      const k = `${b.scope ?? '*'}|${b.chord}`;
      groups.set(k, [...(groups.get(k) ?? []), b]);
    }
    const kept: Binding[] = [];
    for (const group of groups.values()) {
      const commands = [...new Set(group.map((b) => b.commandId))];
      if (commands.length === 1) {
        kept.push(group[0] as Binding);
        continue;
      }
      const winner = (group.find((b) => b.source === 'user') ?? group[0]) as Binding;
      problems.push({ kind: 'conflict', chord: winner.chord, scope: winner.scope, commands, winner: winner.commandId });
      kept.push(winner);
    }

    const byChord = new Map<Chord, Binding[]>();
    const byCommand = new Map<string, Binding[]>();
    for (const b of kept) {
      byChord.set(b.chord, [...(byChord.get(b.chord) ?? []), b]);
      byCommand.set(b.commandId, [...(byCommand.get(b.commandId) ?? []), b]);
    }
    return { keymap: new Keymap(byChord, byCommand, defaultsByCommand), problems };
  }

  /**
   * Bindings that could fire for `chord` given the active scopes (innermost first):
   * scoped bindings, nearest scope first, then bindings that apply everywhere.
   */
  bindingsFor(chord: Chord, activeScopeIds: readonly string[]): Binding[] {
    const candidates = this.byChord.get(chord) ?? [];
    const scoped = candidates
      .filter((b) => b.scope !== undefined && activeScopeIds.includes(b.scope))
      .sort((a, b) => activeScopeIds.indexOf(a.scope as string) - activeScopeIds.indexOf(b.scope as string));
    return [...scoped, ...candidates.filter((b) => b.scope === undefined)];
  }

  bindingsOf(commandId: string): readonly Binding[] {
    return this.byCommand.get(commandId) ?? [];
  }

  chordsFor(commandId: string): Chord[] {
    return this.bindingsOf(commandId).map((b) => b.chord);
  }

  defaultChordsFor(commandId: string): Chord[] {
    return (this.defaultsByCommand.get(commandId) ?? []).map((b) => b.chord);
  }

  /** The scope a command's shortcut lives in (from its default binding), if any. */
  scopeOf(commandId: string): string | undefined {
    return this.defaultsByCommand.get(commandId)?.[0]?.scope;
  }

  all(): Binding[] {
    return [...this.byCommand.values()].flat();
  }
}
