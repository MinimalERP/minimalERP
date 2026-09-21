import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from './registry';
import type { Command } from './types';

interface Ctx {
  ok: boolean;
  log: string[];
}

function setup(commands: Command<Ctx>[] = []) {
  const ctx: Ctx = { ok: true, log: [] };
  const errors: [unknown, string][] = [];
  const registry = new CommandRegistry<Ctx>(() => ctx, (e, id) => errors.push([e, id]));
  for (const c of commands) registry.register(c);
  return { ctx, registry, errors };
}

const cmd = (id: string, extra: Partial<Command<Ctx>> = {}): Command<Ctx> => ({
  id, title: id, category: 'Test', run: (c) => void c.log.push(id), ...extra,
});

describe('registration', () => {
  it('registers and looks up commands', () => {
    const { registry } = setup([cmd('a'), cmd('b')]);
    expect(registry.get('a')?.title).toBe('a');
    expect(registry.get('zzz')).toBeUndefined();
    expect(registry.all().map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('refuses duplicate ids — two modules cannot both own a command', () => {
    const { registry } = setup([cmd('a')]);
    expect(() => registry.register(cmd('a'))).toThrow(/already registered/);
  });

  it('a module contributes commands, bindings, menu entries and providers together', () => {
    const { registry } = setup();
    const provider = { id: 'p', search: () => [] };
    registry.registerModule({
      id: 'accounting',
      commands: [cmd('report.tb'), cmd('report.daybook')],
      bindings: [{ commandId: 'report.tb', chord: 'Alt+T' }],
      menuSections: [{ id: 'reports', title: 'Reports', order: 2 }],
      menu: [
        { section: 'reports', commandId: 'report.daybook', order: 2 },
        { section: 'reports', commandId: 'report.tb', order: 1 },
      ],
      providers: [provider],
    });
    expect(registry.get('report.tb')).toBeDefined();
    expect(registry.defaultBindings()).toEqual([{ commandId: 'report.tb', chord: 'Alt+T' }]);
    expect(registry.providers()).toEqual([provider]);
    expect(registry.menu('reports').map((c) => c.id)).toEqual(['report.tb', 'report.daybook']); // by order
    expect(registry.menu('nope')).toEqual([]);
  });

  it('refuses the same module twice, and duplicate commands across modules', () => {
    const { registry } = setup();
    registry.registerModule({ id: 'm', commands: [cmd('x')] });
    expect(() => registry.registerModule({ id: 'm' })).toThrow(/already registered/);
    expect(() => registry.registerModule({ id: 'other', commands: [cmd('x')] })).toThrow(/already registered/);
  });

  it('menu sections are ordered, and menus omit commands that are unavailable', () => {
    const { registry, ctx } = setup();
    registry.registerModule({
      id: 'm',
      commands: [cmd('shown'), cmd('hidden', { when: (c) => c.ok })],
      menuSections: [{ id: 'b', title: 'B', order: 2 }, { id: 'a', title: 'A', order: 1 }],
      menu: [{ section: 'a', commandId: 'shown' }, { section: 'a', commandId: 'hidden' }],
    });
    expect(registry.menuSections().map((s) => s.id)).toEqual(['a', 'b']);
    expect(registry.menu('a').map((c) => c.id)).toEqual(['shown', 'hidden']);
    ctx.ok = false;
    expect(registry.menu('a').map((c) => c.id)).toEqual(['shown']);
  });

  it('notifies subscribers when commands are registered', () => {
    const { registry } = setup();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.register(cmd('a'));
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('run (the direct path: menus, search results, buttons)', () => {
  it('runs the command with the app context and arguments', () => {
    const run = vi.fn();
    const { registry, ctx } = setup([cmd('a', { run })]);
    expect(registry.run('a', { x: 1 })).toBe(true);
    expect(run).toHaveBeenCalledWith(ctx, { x: 1 });
  });

  it('does nothing for unknown commands, contextual commands (no run) and unavailable commands', () => {
    const { registry, ctx } = setup([cmd('ctx', { run: undefined as never }), cmd('gated', { when: (c) => c.ok })]);
    expect(registry.run('nope')).toBe(false);
    expect(registry.run('ctx')).toBe(false);
    ctx.ok = false;
    expect(registry.run('gated')).toBe(false);
    expect(ctx.log).toEqual([]);
  });

  it('a throwing command is reported, not propagated — it cannot break the caller', () => {
    const boom = new Error('boom');
    const { registry, errors } = setup([cmd('bad', { run: () => { throw boom; } })]);
    expect(() => registry.run('bad')).not.toThrow();
    expect(errors).toEqual([[boom, 'bad']]);
  });
});

describe('dispatch (the keyboard path)', () => {
  const info = (scopes: string[], modal = false, args?: unknown) => ({ scopes, modal, args });

  it('runs the command when no screen has a handler for it', () => {
    const { registry, ctx } = setup([cmd('goto')]);
    expect(registry.dispatch('goto', info(['screen:menu', 'global']))).toBe(true);
    expect(ctx.log).toEqual(['goto']);
  });

  it('returns false for a command that is unknown or purely contextual with nobody handling it', () => {
    const { registry } = setup([cmd('nav.down', { run: undefined as never })]);
    expect(registry.dispatch('nope', info(['global']))).toBe(false);
    expect(registry.dispatch('nav.down', info(['screen:menu']))).toBe(false); // → the key falls through to the browser
  });

  it('a screen’s handler supplies behaviour for a contextual command', () => {
    const { registry } = setup([cmd('nav.down', { run: undefined as never })]);
    const handler = vi.fn();
    registry.pushHandler('screen:menu', 'nav.down', handler);
    expect(registry.dispatch('nav.down', info(['screen:menu', 'global'], false, 'arg'))).toBe(true);
    expect(handler).toHaveBeenCalledWith('arg');
  });

  it('handlers only apply in their own scope', () => {
    const { registry } = setup([cmd('nav.down', { run: undefined as never })]);
    const handler = vi.fn();
    registry.pushHandler('screen:menu', 'nav.down', handler);
    expect(registry.dispatch('nav.down', info(['screen:report', 'global']))).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('an inner scope’s handler beats an outer one — the overlay’s "move down" wins over the menu’s', () => {
    const { registry } = setup([cmd('nav.down', { run: undefined as never })]);
    const menu = vi.fn();
    const overlay = vi.fn();
    registry.pushHandler('screen:menu', 'nav.down', menu);
    registry.pushHandler('overlay:goto', 'nav.down', overlay);
    registry.dispatch('nav.down', info(['overlay:goto', 'screen:menu']));
    expect(overlay).toHaveBeenCalledOnce();
    expect(menu).not.toHaveBeenCalled();
  });

  it('a handler that returns false passes the key to the next one out, then to the command itself', () => {
    const { registry, ctx } = setup([cmd('esc')]);
    const inner = vi.fn(() => false);
    const outer = vi.fn(() => undefined);
    registry.pushHandler('overlay', 'esc', inner);
    registry.pushHandler('screen', 'esc', outer);
    expect(registry.dispatch('esc', info(['overlay', 'screen']))).toBe(true);
    expect(inner).toHaveBeenCalled();
    expect(outer).toHaveBeenCalled();
    expect(ctx.log).toEqual([]); // the outer handler took it; the command's own run was not needed

    outer.mockReturnValue(false as never);
    expect(registry.dispatch('esc', info(['overlay', 'screen']))).toBe(true);
    expect(ctx.log).toEqual(['esc']); // everyone declined → the command's own behaviour
  });

  it('within one scope the most recently pushed handler wins, and disposing restores the previous', () => {
    const { registry } = setup([cmd('x', { run: undefined as never })]);
    const first = vi.fn();
    const second = vi.fn();
    registry.pushHandler('s', 'x', first);
    const dispose = registry.pushHandler('s', 'x', second);
    registry.dispatch('x', info(['s']));
    expect(second).toHaveBeenCalledOnce();
    dispose();
    registry.dispatch('x', info(['s']));
    expect(first).toHaveBeenCalledOnce();
  });

  it('after a handler is disposed the key stops being handled', () => {
    const { registry } = setup([cmd('x', { run: undefined as never })]);
    const dispose = registry.pushHandler('s', 'x', vi.fn());
    expect(registry.dispatch('x', info(['s']))).toBe(true);
    dispose();
    expect(registry.dispatch('x', info(['s']))).toBe(false);
  });

  describe('while a modal overlay is open', () => {
    it('blocks ordinary commands (F8 must not open a voucher UNDER the palette)', () => {
      const { registry, ctx } = setup([cmd('voucher.new.sales')]);
      expect(registry.dispatch('voucher.new.sales', info(['overlay:goto'], true))).toBe(false);
      expect(ctx.log).toEqual([]);
    });

    it('still allows commands marked allowInModal (Alt+G toggles the palette shut)', () => {
      const { registry, ctx } = setup([cmd('goto.open', { allowInModal: true })]);
      expect(registry.dispatch('goto.open', info(['overlay:goto'], true))).toBe(true);
      expect(ctx.log).toEqual(['goto.open']);
    });

    it('still runs the overlay’s own handlers', () => {
      const { registry } = setup([cmd('nav.down', { run: undefined as never })]);
      const handler = vi.fn();
      registry.pushHandler('overlay:goto', 'nav.down', handler);
      expect(registry.dispatch('nav.down', info(['overlay:goto'], true))).toBe(true);
      expect(handler).toHaveBeenCalled();
    });
  });

  it('respects when(): an unavailable command is not run by its key', () => {
    const { registry, ctx } = setup([cmd('gated', { when: (c) => c.ok })]);
    ctx.ok = false;
    expect(registry.dispatch('gated', info(['global']))).toBe(false);
  });

  it('a throwing handler is reported and counts as handled, so the key does not also reach the browser', () => {
    const { registry, errors } = setup([cmd('x', { run: undefined as never })]);
    const boom = new Error('handler blew up');
    registry.pushHandler('s', 'x', () => { throw boom; });
    expect(registry.dispatch('x', info(['s']))).toBe(true);
    expect(errors).toEqual([[boom, 'x']]);
  });
});

describe('availability (drives the status-bar hints)', () => {
  it('a command is available if a visible scope handles it, or it can run', () => {
    const { registry } = setup([cmd('runnable'), cmd('ctx', { run: undefined as never })]);
    expect(registry.isAvailable('runnable', ['global'], false)).toBe(true);
    expect(registry.isAvailable('ctx', ['screen:menu'], false)).toBe(false);
    registry.pushHandler('screen:menu', 'ctx', vi.fn());
    expect(registry.isAvailable('ctx', ['screen:menu'], false)).toBe(true);
    expect(registry.isAvailable('ctx', ['screen:other'], false)).toBe(false);
  });

  it('a modal hides ordinary commands from the hints', () => {
    const { registry } = setup([cmd('a'), cmd('b', { allowInModal: true })]);
    expect(registry.isAvailable('a', ['overlay'], true)).toBe(false);
    expect(registry.isAvailable('b', ['overlay'], true)).toBe(true);
  });

  it('notifies when handlers come and go', () => {
    const { registry } = setup();
    const listener = vi.fn();
    registry.subscribe(listener);
    const dispose = registry.pushHandler('s', 'x', vi.fn());
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('isRunnable reflects run + when', () => {
    const { registry, ctx } = setup([cmd('a', { when: (c) => c.ok }), cmd('ctx', { run: undefined as never })]);
    expect(registry.isRunnable('a')).toBe(true);
    expect(registry.isRunnable('ctx')).toBe(false);
    expect(registry.isRunnable('nope')).toBe(false);
    ctx.ok = false;
    expect(registry.isRunnable('a')).toBe(false);
  });
});
