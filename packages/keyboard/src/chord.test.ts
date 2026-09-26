import { describe, expect, it } from 'vitest';
import { type Chord, type KeyEventLike, chordFromEvent, isBarePrintable, isRepeatable, keyEventInitOf, normalizeChord, parseChord } from './chord';

const ev = (init: Partial<KeyEventLike> & { key: string; code: string }): KeyEventLike => ({
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init,
});

describe('chordFromEvent', () => {
  it.each([
    [{ key: 'g', code: 'KeyG', altKey: true }, 'Alt+G'],
    [{ key: 'a', code: 'KeyA', ctrlKey: true }, 'Ctrl+A'],
    [{ key: 'F8', code: 'F8' }, 'F8'],
    [{ key: 'F12', code: 'F12' }, 'F12'],
    [{ key: 'Escape', code: 'Escape' }, 'Esc'],
    [{ key: 'Enter', code: 'Enter' }, 'Enter'],
    [{ key: 'Tab', code: 'Tab', shiftKey: true }, 'Shift+Tab'],
    [{ key: 'ArrowDown', code: 'ArrowDown' }, 'Down'],
    [{ key: 'PageUp', code: 'PageUp' }, 'PageUp'],
    [{ key: 'Delete', code: 'Delete', ctrlKey: true }, 'Ctrl+Delete'],
    [{ key: '1', code: 'Digit1', altKey: true }, 'Alt+1'],
    [{ key: '1', code: 'Numpad1' }, '1'],
    [{ key: 'Enter', code: 'NumpadEnter' }, 'Enter'],
    [{ key: '/', code: 'Slash', ctrlKey: true }, 'Ctrl+/'],
    [{ key: ' ', code: 'Space', ctrlKey: true }, 'Ctrl+Space'],
  ])('%j → %s', (init, expected) => {
    expect(chordFromEvent(ev(init))).toBe(expected);
  });

  it('always writes modifiers in the order Ctrl, Alt, Shift, Meta', () => {
    expect(chordFromEvent(ev({ key: 'g', code: 'KeyG', metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+Shift+Meta+G');
  });

  it('reads letters from the PHYSICAL key, so Option/AltGr characters and other layouts do not matter', () => {
    // macOS Option+G types "©"; the physical key is still KeyG
    expect(chordFromEvent(ev({ key: '©', code: 'KeyG', altKey: true }))).toBe('Alt+G');
    expect(chordFromEvent(ev({ key: 'g', code: 'KeyG', altKey: true, shiftKey: true }))).toBe('Alt+Shift+G');
  });

  it('returns nothing for a lone modifier or an unknown key', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified']) {
      expect(chordFromEvent(ev({ key, code: key }))).toBeUndefined();
    }
    expect(chordFromEvent(ev({ key: 'MediaPlayPause', code: 'MediaPlayPause' }))).toBeUndefined();
  });

  it('treats AltGr (reported as Ctrl+Alt on Windows) as typing, not as a shortcut', () => {
    const altGr = ev({ key: 'ł', code: 'KeyL', ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' });
    expect(chordFromEvent(altGr)).toBe('L'); // no Ctrl/Alt: a bare, typeable key
    expect(isBarePrintable(chordFromEvent(altGr) as Chord)).toBe(true);
  });
});

describe('normalizeChord', () => {
  it.each([
    ['alt+g', 'Alt+G'], ['ALT+G', 'Alt+G'], ['CTRL + A', 'Ctrl+A'], ['control+a', 'Ctrl+A'], ['option+g', 'Alt+G'],
    ['esc', 'Esc'], ['Escape', 'Esc'], ['f8', 'F8'], ['F24', 'F24'], ['shift+tab', 'Shift+Tab'],
    ['shift+ctrl+a', 'Ctrl+Shift+A'], ['ctrl+alt+shift+meta+f12', 'Ctrl+Alt+Shift+Meta+F12'],
    ['enter', 'Enter'], ['return', 'Enter'], ['del', 'Delete'], ['arrowup', 'Up'], ['pgdn', 'PageDown'], ['ctrl+space', 'Ctrl+Space'],
    ['ctrl+/', 'Ctrl+/'], ['cmd+k', 'Meta+K'], ['Alt+G', 'Alt+G'], ['alt+alt+g', 'Alt+G'],
  ])('%j → %s', (text, expected) => {
    expect(normalizeChord(text)).toBe(expected);
  });

  it.each(['', '   ', 'foo', 'alt+', 'ctrl', 'alt+ctrl', 'bogus+g', 'f25', 'f0', 'alt+foo'])('rejects %j', (text) => {
    expect(normalizeChord(text)).toBeUndefined();
  });

  it('round-trips with chordFromEvent', () => {
    const chord = chordFromEvent(ev({ key: 'g', code: 'KeyG', altKey: true }));
    expect(normalizeChord(chord as string)).toBe(chord);
  });
});

describe('parseChord / isBarePrintable / isRepeatable', () => {
  it('splits modifiers from the key', () => {
    expect(parseChord('Ctrl+Shift+A' as Chord)).toEqual({ modifiers: ['Ctrl', 'Shift'], key: 'A' });
    expect(parseChord('F8' as Chord)).toEqual({ modifiers: [], key: 'F8' });
  });

  it.each(['A', 'a', '1', '/', 'Space', 'Shift+A', 'Shift+1'])('%s is a typing key — it cannot be a shortcut', (c) => {
    expect(isBarePrintable(c as Chord)).toBe(true);
  });

  it.each(['F8', 'Esc', 'Enter', 'Tab', 'Shift+Tab', 'Up', 'Ctrl+A', 'Alt+G', 'Ctrl+Space', 'Delete'])('%s may be a shortcut', (c) => {
    expect(isBarePrintable(c as Chord)).toBe(false);
  });

  it('only unmodified navigation keys repeat when held', () => {
    for (const c of ['Up', 'Down', 'PageDown', 'Tab', 'Shift+Tab', 'Backspace']) expect(isRepeatable(c as Chord), c).toBe(true);
    for (const c of ['Alt+G', 'F5', 'Enter', 'Esc', 'Ctrl+Up', 'F8']) expect(isRepeatable(c as Chord), c).toBe(false);
  });
});

describe('keyEventInitOf — a tap on a drawn shortcut presses it', () => {
  it('spells every kind of chord so that chordFromEvent reads the same chord back', () => {
    for (const c of ['Alt+C', 'Ctrl+A', 'Esc', 'Enter', 'F8', 'Shift+Tab', 'Alt+2', 'Ctrl+Alt+Up', 'Alt+/', 'Space']) {
      const init = keyEventInitOf(c as Chord);
      expect(init).toBeDefined();
      expect(chordFromEvent(init as KeyEventLike)).toBe(c);
    }
  });
});
