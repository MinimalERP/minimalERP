/**
 * Chords: a canonical text form for a key combination, e.g. "Alt+G", "Ctrl+A", "F8", "Shift+Tab".
 * Modifiers always appear in the order Ctrl, Alt, Shift, Meta; the key is last.
 *
 * Letters and digits are read from `event.code` (the physical key), NOT `event.key`, so shortcuts
 * behave the same on every keyboard layout and are not mangled by Alt/Option or AltGr producing
 * other characters. Named and function keys come from `event.key`.
 */
export type Chord = string & { readonly __brand: 'Chord' };

/** The parts of a KeyboardEvent we read. Plain objects satisfy it, so tests need no DOM. */
export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  getModifierState?(key: string): boolean;
}

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Pressing one of these on its own is never a chord. */
const LONE_MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock',
  'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'Dead', 'Unidentified', 'Process',
]);

const NAMED_KEYS: Record<string, string> = {
  Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', ' ': 'Space', Backspace: 'Backspace', Delete: 'Delete',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

const CODE_PUNCTUATION: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
};

const F_KEY = /^F([1-9]|1\d|2[0-4])$/;

function keyNameOf(e: KeyEventLike): string | undefined {
  if (LONE_MODIFIER_KEYS.has(e.key)) return undefined;
  if (F_KEY.test(e.key)) return e.key;
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (c === 'NumpadEnter') return 'Enter';
  const punct = CODE_PUNCTUATION[c];
  if (punct !== undefined) return punct;
  return NAMED_KEYS[e.key];
}

const assemble = (mods: ReadonlySet<Modifier>, key: string): Chord =>
  [...MODIFIERS.filter((m) => mods.has(m)), key].join('+') as Chord;

/** The chord a key event represents, or undefined for a lone modifier / unknown key. */
export function chordFromEvent(e: KeyEventLike): Chord | undefined {
  const key = keyNameOf(e);
  if (key === undefined) return undefined;

  // On Windows AltGr reports Ctrl+Alt. It is how people TYPE characters on many layouts — not a shortcut.
  const altGr = e.getModifierState?.('AltGraph') === true;
  const mods = new Set<Modifier>();
  if (e.ctrlKey && !altGr) mods.add('Ctrl');
  if (e.altKey && !altGr) mods.add('Alt');
  if (e.shiftKey) mods.add('Shift');
  if (e.metaKey) mods.add('Meta');
  return assemble(mods, key);
}

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', opt: 'Alt',
  shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', windows: 'Meta',
};

const KEY_ALIASES: Record<string, string> = {
  esc: 'Esc', escape: 'Esc', enter: 'Enter', return: 'Enter', tab: 'Tab', space: 'Space', spacebar: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
};

/** Parses user-typed text ("alt+g", "CTRL + A", "esc") into a canonical Chord; undefined if it is not a valid key. */
export function normalizeChord(text: string): Chord | undefined {
  const parts = text.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  const rawKey = parts.at(-1) as string;

  const mods = new Set<Modifier>();
  for (const part of parts.slice(0, -1)) {
    const m = MODIFIER_ALIASES[part.toLowerCase()];
    if (m === undefined) return undefined;
    mods.add(m);
  }

  const lower = rawKey.toLowerCase();
  let key: string | undefined = KEY_ALIASES[lower];
  if (key === undefined && F_KEY.test(rawKey.toUpperCase())) key = rawKey.toUpperCase();
  if (key === undefined && rawKey.length === 1) key = /[a-z]/i.test(rawKey) ? rawKey.toUpperCase() : rawKey;
  if (key === undefined) return undefined;
  // a lone modifier word ("Ctrl") is not a key
  if (MODIFIER_ALIASES[lower] !== undefined) return undefined;
  return assemble(mods, key);
}

export interface ChordParts {
  readonly modifiers: readonly string[];
  readonly key: string;
}

export function parseChord(chord: Chord): ChordParts {
  const parts = chord.split('+');
  // A chord whose key is "+" would end with an empty segment; we never generate one.
  return { modifiers: parts.slice(0, -1), key: parts.at(-1) ?? '' };
}

/**
 * A chord that would be typed as text. Binding one would make it impossible to type that character
 * anywhere, so keymaps refuse them. (Shift+letter is still printable.)
 */
export function isBarePrintable(chord: Chord): boolean {
  const { modifiers, key } = parseChord(chord);
  const hasCommandModifier = modifiers.some((m) => m === 'Ctrl' || m === 'Alt' || m === 'Meta');
  return !hasCommandModifier && (key.length === 1 || key === 'Space');
}

const REPEATABLE_KEYS = new Set(['Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Tab', 'Backspace', 'Delete']);

/** Holding the key should repeat the action (scrolling a list) — true only for unmodified navigation keys. */
export function isRepeatable(chord: Chord): boolean {
  const { modifiers, key } = parseChord(chord);
  return REPEATABLE_KEYS.has(key) && !modifiers.some((m) => m === 'Ctrl' || m === 'Alt' || m === 'Meta');
}
