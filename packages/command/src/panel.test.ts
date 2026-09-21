import { describe, expect, it } from 'vitest';
import { panelEntries } from './panel';
import { CommandRegistry } from './registry';
import type { Command } from './types';

const on = (...types: string[]) => types;

function setup() {
  const registry = new CommandRegistry<object>(() => ({}));
  const commands: Command<object>[] = [
    { id: 'entry.date', title: 'Date', category: 'x', panel: { label: 'Date', group: 'Actions', order: 10, on: on('voucher', 'report'), labelOn: { report: 'Period' } } },
    { id: 'entry.accept', title: 'Accept', category: 'x', panel: { label: 'Accept', group: 'Actions', order: 11, on: on('voucher') } },
    { id: 'type.payment', title: 'Payment', category: 'x', panel: { label: 'Payment', group: 'Voucher type', order: 20, on: on('voucher') } },
    { id: 'grid.sort', title: 'Sort', category: 'x', panel: { label: 'Sort', group: 'Report', order: 40, on: on('report') } },
    { id: 'close', title: 'Close', category: 'x', panel: { label: 'Close', group: 'Window', order: 0, on: on('voucher', 'report'), keyOf: 'back' }, run: () => undefined },
    { id: 'plain', title: 'No panel entry', category: 'x', statusBar: { label: 'Plain' } },
  ];
  for (const c of commands) registry.register(c);
  const chords: Record<string, string> = { 'entry.date': 'F2', 'entry.accept': 'Ctrl+A', back: 'Esc' }; // "close" shows the key of "back"
  return { registry, chordFor: (id: string) => chords[id] };
}

const idle = { ids: ['global'], modal: false };

describe('panelEntries', () => {
  it('lists only the commands declared for that screen type, in order, with their live keys', () => {
    const { registry, chordFor } = setup();
    const voucher = panelEntries(registry, chordFor, 'voucher', idle);
    expect(voucher.map((e) => [e.id, e.chord])).toEqual([
      ['close', 'Esc'],
      ['entry.date', 'F2'],
      ['entry.accept', 'Ctrl+A'],
      ['type.payment', undefined],
    ]);
    expect(panelEntries(registry, chordFor, 'report', idle).map((e) => e.id)).toEqual(['close', 'entry.date', 'grid.sort']);
    expect(panelEntries(registry, chordFor, 'menu', idle)).toEqual([]); // the Gateway and menus have no panel
  });

  it('an entry that hides when unavailable is left out (not greyed) until a screen supplies it — "New Sales Voucher" belongs to ONE list among all the reports', () => {
    const registry = new CommandRegistry<object>(() => ({}));
    registry.register({ id: 'list.new.sales', title: 'New Sales', category: 'x', panel: { label: 'New Sales Voucher', group: 'Actions', order: 5, on: ['report'], hideWhenUnavailable: true } });
    registry.register({ id: 'grid.sort', title: 'Sort', category: 'x', panel: { label: 'Sort', group: 'Report', order: 40, on: ['report'] } });
    const active = { ids: ['screen:report'], modal: false };
    expect(panelEntries(registry, () => undefined, 'report', active).map((e) => e.id)).toEqual(['grid.sort']);
    const off = registry.pushHandler('screen:report', 'list.new.sales', () => true);
    expect(panelEntries(registry, () => undefined, 'report', active).map((e) => [e.id, e.enabled])).toEqual([['list.new.sales', true], ['grid.sort', false]]);
    off();
  });

  it('renames an entry for one screen type', () => {
    const { registry, chordFor } = setup();
    expect(panelEntries(registry, chordFor, 'voucher', idle).find((e) => e.id === 'entry.date')?.label).toBe('Date');
    expect(panelEntries(registry, chordFor, 'report', idle).find((e) => e.id === 'entry.date')?.label).toBe('Period');
  });

  it('marks where a new group starts', () => {
    const { registry, chordFor } = setup();
    expect(panelEntries(registry, chordFor, 'voucher', idle).map((e) => [e.id, e.startsGroup])).toEqual([
      ['close', false],
      ['entry.date', true],
      ['entry.accept', false],
      ['type.payment', true],
    ]);
  });

  it('is enabled exactly when the screen in front supplies a handler (or the command can run itself)', () => {
    const { registry, chordFor } = setup();
    const enabled = () => Object.fromEntries(panelEntries(registry, chordFor, 'voucher', { ids: ['screen:voucher', 'global'], modal: false }).map((e) => [e.id, e.enabled]));
    expect(enabled()).toEqual({ close: true, 'entry.date': false, 'entry.accept': false, 'type.payment': false });
    const off = registry.pushHandler('screen:voucher', 'entry.accept', () => true);
    expect(enabled()['entry.accept']).toBe(true);
    off();
    expect(enabled()['entry.accept']).toBe(false); // the screen left this mode: greyed again
  });

  it('a handler in a screen that is not in front does not count', () => {
    const { registry, chordFor } = setup();
    registry.pushHandler('screen:voucher', 'entry.accept', () => true);
    const entries = panelEntries(registry, chordFor, 'voucher', { ids: ['overlay:goto', 'global'], modal: true });
    expect(entries.find((e) => e.id === 'entry.accept')?.enabled).toBe(false);
  });

  it('goes grey under a modal overlay, except what may run there', () => {
    const { registry, chordFor } = setup();
    registry.pushHandler('screen:voucher', 'entry.date', () => true);
    const under = panelEntries(registry, chordFor, 'voucher', { ids: ['overlay:party-details', 'global'], modal: true });
    expect(under.every((e) => !e.enabled)).toBe(true);
  });

  it('follows a remapped key and shows an unbound command without a key cap (still clickable)', () => {
    const { registry } = setup();
    const remapped = panelEntries(registry, (id) => (id === 'entry.accept' ? 'F9' : undefined), 'voucher', idle);
    expect(remapped.find((e) => e.id === 'entry.accept')?.chord).toBe('F9');
    expect(remapped.find((e) => e.id === 'entry.date')?.chord).toBeUndefined();
  });
});
