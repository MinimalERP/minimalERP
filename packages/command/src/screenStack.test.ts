import { describe, expect, it, vi } from 'vitest';
import { ScreenStack } from './screenStack';

describe('ScreenStack', () => {
  it('starts with its root screen', () => {
    const s = new ScreenStack('gateway');
    expect(s.top.screen).toBe('gateway');
    expect(s.depth).toBe(1);
  });

  it('push opens a screen on top; pop returns to the one beneath', () => {
    const s = new ScreenStack('gateway');
    s.push('masters');
    s.push('ledger');
    expect(s.all.map((f) => f.screen)).toEqual(['gateway', 'masters', 'ledger']);
    expect(s.pop()).toBe(true);
    expect(s.top.screen).toBe('masters');
    expect(s.pop()).toBe(true);
    expect(s.top.screen).toBe('gateway');
  });

  it('never pops the root — Esc on the Gateway does nothing', () => {
    const s = new ScreenStack('gateway');
    expect(s.pop()).toBe(false);
    expect(s.depth).toBe(1);
    expect(s.top.screen).toBe('gateway');
  });

  it('a screen keeps its state while others sit on top — Esc returns you to the SAME row', () => {
    const s = new ScreenStack('gateway');
    s.top.state.set('index', 3);
    s.push('masters');
    s.top.state.set('index', 1);
    s.pop();
    expect(s.top.state.get('index')).toBe(3);
  });

  it('each frame has its own state bag and a unique id', () => {
    const s = new ScreenStack('a');
    const first = s.top;
    const second = s.push('b');
    expect(first.id).not.toBe(second.id);
    first.state.set('x', 1);
    expect(second.state.has('x')).toBe(false);
  });

  it('notifies on every change', () => {
    const s = new ScreenStack('a');
    const listener = vi.fn();
    const off = s.subscribe(listener);
    s.push('b');
    s.pop();
    s.reset('c');
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    s.push('d');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('a failed pop does not notify', () => {
    const s = new ScreenStack('a');
    const listener = vi.fn();
    s.subscribe(listener);
    s.pop();
    expect(listener).not.toHaveBeenCalled();
  });

  describe('pushForResult — how "create a master from inside a voucher" (Alt+C) returns its answer', () => {
    it('resolves with the value the pushed screen closes with', async () => {
      const s = new ScreenStack('voucher');
      const pending = s.pushForResult<string>('create-ledger');
      expect(s.top.screen).toBe('create-ledger');
      s.pop('ledger-42'); // the create screen saved and returned the new id
      await expect(pending).resolves.toBe('ledger-42');
      expect(s.top.screen).toBe('voucher'); // …and we are back where we started
    });

    it('resolves undefined when cancelled (popped with no result)', async () => {
      const s = new ScreenStack('voucher');
      const pending = s.pushForResult<string>('create-ledger');
      s.pop();
      await expect(pending).resolves.toBeUndefined();
    });

    it('the screen underneath keeps its state through the whole round trip', async () => {
      const s = new ScreenStack('voucher');
      s.top.state.set('draft', { party: 'ABC', lines: 3 });
      const pending = s.pushForResult<string>('create-ledger');
      s.pop('new-id');
      await pending;
      expect(s.top.state.get('draft')).toEqual({ party: 'ABC', lines: 3 });
    });

    it('nested requests each get their own answer', async () => {
      const s = new ScreenStack('voucher');
      const outer = s.pushForResult<string>('create-ledger');
      const inner = s.pushForResult<string>('create-group');
      s.pop('group-1');
      s.pop('ledger-1');
      await expect(inner).resolves.toBe('group-1');
      await expect(outer).resolves.toBe('ledger-1');
    });

    it('a plain push has no waiting caller, so popping it with a value is harmless', () => {
      const s = new ScreenStack('a');
      s.push('b');
      expect(() => s.pop('ignored')).not.toThrow();
    });
  });

  describe('reset (used when the address changes)', () => {
    it('replaces the whole stack', () => {
      const s = new ScreenStack('gateway');
      s.push('a');
      s.push('b');
      s.reset('gateway', 'report');
      expect(s.all.map((f) => f.screen)).toEqual(['gateway', 'report']);
    });

    it('cancels anything still waiting for a result', async () => {
      const s = new ScreenStack('voucher');
      const pending = s.pushForResult<string>('create-ledger');
      s.reset('gateway');
      await expect(pending).resolves.toBeUndefined();
    });
  });

  it('replaceTop changes the screen but keeps the frame and its state', () => {
    const stack = new ScreenStack<string>('root');
    const frame = stack.push('payment');
    frame.state.set('draft', 42);
    let told = 0;
    stack.subscribe(() => told++);
    stack.replaceTop('journal');
    expect(stack.top.screen).toBe('journal');
    expect(stack.top.id).toBe(frame.id);
    expect(stack.top.state.get('draft')).toBe(42);
    expect(stack.depth).toBe(2);
    expect(told).toBe(1);
  });

  it('delivers a result before the UI is told to re-render, so the screen beneath is rebuilt with it', async () => {
    const stack = new ScreenStack<string>('root');
    const log: string[] = [];
    // A UI framework schedules its re-render as a microtask when told; model that.
    stack.subscribe(() => queueMicrotask(() => log.push('render')));
    const pending = stack.pushForResult<number>('child').then((r) => log.push(`result ${r}`));
    await Promise.resolve(); // let the push's own re-render happen
    log.length = 0;
    stack.pop(42);
    await pending;
    await Promise.resolve();
    expect(log).toEqual(['result 42', 'render']);
  });
});
