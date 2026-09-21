import { describe, expect, it, vi } from 'vitest';
import { Keymap } from './keymap';
import { KeyboardManager } from './manager';
import { ScopeStack } from './scopes';

/** A KeyboardEvent stand-in that Node's EventTarget can dispatch. */
function keydown(init: { key: string; code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; isComposing?: boolean }) {
  return Object.assign(new Event('keydown', { cancelable: true, bubbles: true }), {
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, ...init,
  });
}
const AltG = () => keydown({ key: 'g', code: 'KeyG', altKey: true });
const F8 = (repeat = false) => keydown({ key: 'F8', code: 'F8', repeat });
const Esc = () => keydown({ key: 'Escape', code: 'Escape' });
const Down = (repeat = false) => keydown({ key: 'ArrowDown', code: 'ArrowDown', repeat });

function setup(defaults = [
  { commandId: 'goto.open', chord: 'Alt+G' },
  { commandId: 'sales.new', chord: 'F8' },
  { commandId: 'sales.switch', chord: 'F8', scope: 'screen:voucher' },
  { commandId: 'app.back', chord: 'Esc' },
  { commandId: 'nav.down', chord: 'Down' },
]) {
  const target = new EventTarget();
  const scopes = new ScopeStack();
  let keymap = Keymap.build(defaults).keymap;
  const handled = new Set<string>();
  const log: string[] = [];
  const dispatch = vi.fn((id: string) => {
    log.push(id);
    return handled.has(id);
  });
  const manager = new KeyboardManager({ target, scopes, keymap: () => keymap, dispatch });
  const stop = manager.start();
  return { target, scopes, manager, dispatch, handled, log, stop, setKeymap: (k: Keymap) => (keymap = k) };
}

describe('KeyboardManager', () => {
  it('runs the bound command and consumes the key when it is handled', () => {
    const t = setup();
    t.handled.add('goto.open');
    const e = AltG();
    t.target.dispatchEvent(e);
    expect(t.log).toEqual(['goto.open']);
    expect(e.defaultPrevented).toBe(true);
  });

  it('LEAVES THE KEY ALONE when nothing handled it (typing, caret movement, browser shortcuts keep working)', () => {
    const t = setup();
    const e = AltG();
    t.target.dispatchEvent(e);
    expect(t.log).toEqual(['goto.open']);
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores keys nobody bound, without consulting anything', () => {
    const t = setup();
    t.target.dispatchEvent(keydown({ key: 'q', code: 'KeyQ' }));
    t.target.dispatchEvent(keydown({ key: 'Shift', code: 'ShiftLeft' }));
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('tries the most specific scope’s meaning first, and falls back to the global one', () => {
    const t = setup();
    const pop = t.scopes.push({ id: 'screen:voucher', layer: 'screen' });
    t.target.dispatchEvent(F8());
    expect(t.log).toEqual(['sales.switch', 'sales.new']); // neither handled: both tried, inner first

    t.log.length = 0;
    t.handled.add('sales.switch');
    const e = F8();
    t.target.dispatchEvent(e);
    expect(t.log).toEqual(['sales.switch']); // inner handled it: the outer meaning never ran
    expect(e.defaultPrevented).toBe(true);

    pop();
    t.log.length = 0;
    t.target.dispatchEvent(F8());
    expect(t.log).toEqual(['sales.new']); // left the voucher: only the global meaning
  });

  it('passes the active scopes and modal flag to dispatch', () => {
    const t = setup();
    t.scopes.push({ id: 'global', layer: 'global' });
    t.scopes.push({ id: 'overlay:goto', layer: 'overlay', modal: true });
    t.target.dispatchEvent(Esc());
    expect(t.dispatch).toHaveBeenCalledWith('app.back', { chord: 'Esc', scopes: ['overlay:goto'], modal: true });
  });

  it('a keymap change takes effect on the very next keystroke', () => {
    const t = setup();
    t.handled.add('goto.open');
    t.setKeymap(Keymap.build([{ commandId: 'goto.open', chord: 'Alt+J' }]).keymap);
    t.target.dispatchEvent(AltG());
    expect(t.log).toEqual([]);
    t.target.dispatchEvent(keydown({ key: 'j', code: 'KeyJ', altKey: true }));
    expect(t.log).toEqual(['goto.open']);
  });

  describe('holding a key down', () => {
    it('repeats list-navigation keys', () => {
      const t = setup();
      t.handled.add('nav.down');
      for (let i = 0; i < 3; i++) t.target.dispatchEvent(Down(i > 0));
      expect(t.log).toEqual(['nav.down', 'nav.down', 'nav.down']);
    });

    it('does NOT repeat commands like F8 — but still swallows the repeat so the browser does not act on it', () => {
      const t = setup();
      t.handled.add('sales.new');
      t.target.dispatchEvent(F8(false));
      const repeat = F8(true);
      t.target.dispatchEvent(repeat);
      t.target.dispatchEvent(F8(true));
      expect(t.log).toEqual(['sales.new']);
      expect(repeat.defaultPrevented).toBe(true);
    });
  });

  it('leaves keys alone while an IME is composing', () => {
    const t = setup();
    t.handled.add('goto.open');
    const e = keydown({ key: 'g', code: 'KeyG', altKey: true, isComposing: true });
    t.target.dispatchEvent(e);
    expect(t.log).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('stops listening when stopped', () => {
    const t = setup();
    t.stop();
    t.target.dispatchEvent(AltG());
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('listens in the CAPTURE phase, so it sees keys before any element can', () => {
    const outer = new EventTarget();
    const order: string[] = [];
    const scopes = new ScopeStack();
    const m = new KeyboardManager({
      target: outer,
      scopes,
      keymap: () => Keymap.build([{ commandId: 'x', chord: 'F2' }]).keymap,
      dispatch: () => (order.push('manager'), false),
    });
    m.start();
    outer.addEventListener('keydown', () => order.push('bubble'));
    outer.dispatchEvent(keydown({ key: 'F2', code: 'F2' }));
    expect(order).toEqual(['manager', 'bubble']);
  });

  describe('capturing a new shortcut', () => {
    it('resolves with the next chord, and that key triggers nothing', async () => {
      const t = setup();
      t.handled.add('goto.open');
      const pending = t.manager.captureNext();
      expect(t.manager.capturing).toBe(true);
      const e = AltG();
      t.target.dispatchEvent(e);
      await expect(pending).resolves.toBe('Alt+G');
      expect(t.dispatch).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(true);
      expect(t.manager.capturing).toBe(false);
    });

    it('waits through a lone modifier press for the real key', async () => {
      const t = setup();
      const pending = t.manager.captureNext();
      t.target.dispatchEvent(keydown({ key: 'Alt', code: 'AltLeft', altKey: true }));
      expect(t.manager.capturing).toBe(true);
      t.target.dispatchEvent(keydown({ key: 'j', code: 'KeyJ', altKey: true }));
      await expect(pending).resolves.toBe('Alt+J');
    });

    it('Esc cancels', async () => {
      const t = setup();
      const pending = t.manager.captureNext();
      t.target.dispatchEvent(Esc());
      await expect(pending).resolves.toBeNull();
      expect(t.dispatch).not.toHaveBeenCalled();
    });

    it('starting a second capture cancels the first', async () => {
      const t = setup();
      const first = t.manager.captureNext();
      const second = t.manager.captureNext();
      await expect(first).resolves.toBeNull();
      t.target.dispatchEvent(AltG());
      await expect(second).resolves.toBe('Alt+G');
    });

    it('cancelCapture resolves null and resumes normal dispatch', async () => {
      const t = setup();
      t.handled.add('goto.open');
      const pending = t.manager.captureNext();
      t.manager.cancelCapture();
      await expect(pending).resolves.toBeNull();
      t.target.dispatchEvent(AltG());
      expect(t.log).toEqual(['goto.open']);
    });
  });
});

describe('ScopeStack', () => {
  it('orders by LAYER, not by push order — children mount before parents in a component tree', () => {
    const s = new ScopeStack();
    s.push({ id: 'screen:menu', layer: 'screen' }); // a child mounted first…
    s.push({ id: 'global', layer: 'global' }); // …then the app root
    expect(s.snapshot().ids).toEqual(['screen:menu', 'global']);
  });

  it('within a layer, the most recently pushed is innermost', () => {
    const s = new ScopeStack();
    s.push({ id: 'a', layer: 'region' });
    s.push({ id: 'b', layer: 'region' });
    expect(s.snapshot().ids).toEqual(['b', 'a']);
  });

  it('overlay > region > screen > global', () => {
    const s = new ScopeStack();
    for (const layer of ['overlay', 'global', 'region', 'screen'] as const) s.push({ id: layer, layer });
    expect(s.snapshot().ids).toEqual(['overlay', 'region', 'screen', 'global']);
  });

  it('a modal scope hides everything beneath it, global included', () => {
    const s = new ScopeStack();
    s.push({ id: 'global', layer: 'global' });
    s.push({ id: 'screen:menu', layer: 'screen' });
    const pop = s.push({ id: 'overlay:goto', layer: 'overlay', modal: true });
    expect(s.snapshot()).toMatchObject({ ids: ['overlay:goto'], modal: true });
    pop();
    expect(s.snapshot()).toMatchObject({ ids: ['screen:menu', 'global'], modal: false });
  });

  it('a non-modal overlay still shows what is beneath it', () => {
    const s = new ScopeStack();
    s.push({ id: 'global', layer: 'global' });
    s.push({ id: 'tip', layer: 'overlay' });
    expect(s.snapshot().ids).toEqual(['tip', 'global']);
  });

  it('disposing twice is harmless', () => {
    const s = new ScopeStack();
    const pop = s.push({ id: 'a', layer: 'screen' });
    pop();
    pop();
    expect(s.snapshot().ids).toEqual([]);
  });

  it('notifies subscribers on change, and returns a stable snapshot between changes', () => {
    const s = new ScopeStack();
    const listener = vi.fn();
    const off = s.subscribe(listener);
    const pop = s.push({ id: 'a', layer: 'screen' });
    const snap = s.snapshot();
    expect(s.snapshot()).toBe(snap);
    pop();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    s.push({ id: 'b', layer: 'screen' });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
