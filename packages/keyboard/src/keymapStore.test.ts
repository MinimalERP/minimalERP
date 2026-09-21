import { describe, expect, it, vi } from 'vitest';
import type { Chord } from './chord';
import type { BindingSpec } from './keymap';
import { KeymapStore, type StorageLike } from './keymapStore';

const defaults: BindingSpec[] = [
  { commandId: 'goto.open', chord: 'Alt+G' },
  { commandId: 'app.back', chord: 'Esc' },
  { commandId: 'voucher.new.sales', chord: 'F8' },
];

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}
const KEY = 'minimalerp.keymap.v1';

describe('KeymapStore', () => {
  it('starts from the defaults', () => {
    const s = new KeymapStore(defaults, memoryStorage());
    expect(s.keymap.chordsFor('goto.open')).toEqual(['Alt+G']);
    expect(s.overrides).toEqual({});
    expect(s.isCustomised('goto.open')).toBe(false);
  });

  it('assign: rebinds immediately, persists, and notifies', () => {
    const storage = memoryStorage();
    const s = new KeymapStore(defaults, storage);
    const listener = vi.fn();
    s.subscribe(listener);

    expect(s.assign('goto.open', 'alt+j')).toEqual({ ok: true, chord: 'Alt+J' });
    expect(s.keymap.chordsFor('goto.open')).toEqual(['Alt+J']);
    expect(s.keymap.bindingsFor('Alt+G' as Chord, [])).toEqual([]);
    expect(s.isCustomised('goto.open')).toBe(true);
    expect(JSON.parse(storage.data[KEY] as string)).toEqual({ 'goto.open': ['Alt+J'] });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('assign: survives a "reload" (a new store on the same storage)', () => {
    const storage = memoryStorage();
    new KeymapStore(defaults, storage).assign('goto.open', 'Alt+J');
    expect(new KeymapStore(defaults, storage).keymap.chordsFor('goto.open')).toEqual(['Alt+J']);
  });

  it('assign: REFUSES a chord another command already uses, naming it, and changes nothing', () => {
    const storage = memoryStorage();
    const s = new KeymapStore(defaults, storage);
    const r = s.assign('goto.open', 'F8');
    expect(r).toMatchObject({ ok: false, reason: 'conflict', conflictWith: 'voucher.new.sales' });
    expect(r.ok === false && r.message).toContain('voucher.new.sales');
    expect(s.keymap.chordsFor('goto.open')).toEqual(['Alt+G']);
    expect(storage.data[KEY]).toBeUndefined();
  });

  it('assign: allows re-assigning a command its own current chord', () => {
    const s = new KeymapStore(defaults, memoryStorage());
    expect(s.assign('goto.open', 'Alt+G').ok).toBe(true);
  });

  it('assign: refuses invalid text and typing keys', () => {
    const s = new KeymapStore(defaults, memoryStorage());
    expect(s.assign('goto.open', 'banana')).toMatchObject({ ok: false, reason: 'invalid' });
    const typing = s.assign('goto.open', 'x');
    expect(typing).toMatchObject({ ok: false, reason: 'invalid' });
    expect(typing.ok === false && typing.message).toMatch(/typing key/);
    expect(s.keymap.chordsFor('goto.open')).toEqual(['Alt+G']);
  });

  it('unbind removes every shortcut; reset restores the default; resetAll clears everything', () => {
    const storage = memoryStorage();
    const s = new KeymapStore(defaults, storage);
    s.assign('goto.open', 'Alt+J');
    s.unbind('voucher.new.sales');
    expect(s.keymap.chordsFor('voucher.new.sales')).toEqual([]);
    expect(s.isCustomised('voucher.new.sales')).toBe(true);

    s.reset('voucher.new.sales');
    expect(s.keymap.chordsFor('voucher.new.sales')).toEqual(['F8']);
    expect(s.isCustomised('voucher.new.sales')).toBe(false);

    s.resetAll();
    expect(s.keymap.chordsFor('goto.open')).toEqual(['Alt+G']);
    expect(storage.data[KEY]).toBeUndefined(); // nothing left to remember
  });

  it('reset of an uncustomised command does nothing (and does not notify)', () => {
    const s = new KeymapStore(defaults, memoryStorage());
    const listener = vi.fn();
    s.subscribe(listener);
    s.reset('goto.open');
    expect(listener).not.toHaveBeenCalled();
  });

  it('a chord freed by rebinding can be taken by another command', () => {
    const s = new KeymapStore(defaults, memoryStorage());
    s.assign('goto.open', 'Alt+J');
    expect(s.assign('voucher.new.sales', 'Alt+G').ok).toBe(true);
  });

  it.each(['{not json', '[1,2]', 'null', '"x"', '{"goto.open": "Alt+J"}', '{"goto.open": [1]}'])(
    'ignores corrupt stored data (%s) instead of failing to start',
    (raw) => {
      const s = new KeymapStore(defaults, memoryStorage({ [KEY]: raw }));
      expect(s.keymap.chordsFor('goto.open')).toEqual(['Alt+G']);
    },
  );

  it('keeps working when storage is unavailable or throws', () => {
    const broken: StorageLike = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('denied'); },
    };
    const s = new KeymapStore(defaults, broken);
    expect(s.assign('goto.open', 'Alt+J').ok).toBe(true);
    expect(s.keymap.chordsFor('goto.open')).toEqual(['Alt+J']);
  });

  it('works with no storage at all', () => {
    const s = new KeymapStore(defaults);
    expect(s.assign('goto.open', 'Alt+J').ok).toBe(true);
  });

  it('drops persisted chords that are no longer valid, reporting them as problems', () => {
    const s = new KeymapStore(defaults, memoryStorage({ [KEY]: JSON.stringify({ 'goto.open': ['x'] }) }));
    expect(s.problems.some((p) => p.kind === 'invalid-chord')).toBe(true);
  });
});
