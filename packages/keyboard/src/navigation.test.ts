import { describe, expect, it } from 'vitest';
import { FormNavigator, type GridModel, GridNavigator, moveIndex } from './navigation';

describe('moveIndex', () => {
  it('moves one row and clamps at the ends', () => {
    expect(moveIndex(2, 5, 'down')).toBe(3);
    expect(moveIndex(4, 5, 'down')).toBe(4);
    expect(moveIndex(2, 5, 'up')).toBe(1);
    expect(moveIndex(0, 5, 'up')).toBe(0);
  });

  it('wraps when asked (menus wrap, long reports do not)', () => {
    expect(moveIndex(4, 5, 'down', { wrap: true })).toBe(0);
    expect(moveIndex(0, 5, 'up', { wrap: true })).toBe(4);
  });

  it('pages, first and last', () => {
    expect(moveIndex(0, 50, 'pageDown', { pageSize: 10 })).toBe(10);
    expect(moveIndex(45, 50, 'pageDown', { pageSize: 10 })).toBe(49);
    expect(moveIndex(5, 50, 'pageUp', { pageSize: 10 })).toBe(0);
    expect(moveIndex(20, 50, 'first')).toBe(0);
    expect(moveIndex(20, 50, 'last')).toBe(49);
  });

  it('an empty list stays at 0; a single row stays put', () => {
    for (const m of ['up', 'down', 'pageUp', 'pageDown', 'first', 'last'] as const) {
      expect(moveIndex(0, 0, m)).toBe(0);
      expect(moveIndex(0, 1, m, { wrap: true })).toBe(0);
    }
  });
});

describe('FormNavigator', () => {
  const fields = ['date', 'account', 'particular', 'amount', 'narration'];

  it('Enter/Tab walk forward, Shift+Tab walks back, and the end is reported', () => {
    const f = new FormNavigator(fields);
    expect(f.first()).toEqual({ kind: 'field', id: 'date' });
    expect(f.next('date')).toEqual({ kind: 'field', id: 'account' });
    expect(f.next('narration')).toEqual({ kind: 'end' }); // the form is complete: accept?
    expect(f.prev('account')).toEqual({ kind: 'field', id: 'date' });
    expect(f.prev('date')).toEqual({ kind: 'start' });
    expect(f.last()).toEqual({ kind: 'field', id: 'narration' });
  });

  it('skips fields that are disabled — auto-filled, or hidden by a condition', () => {
    const disabled = new Set(['date', 'particular']);
    const f = new FormNavigator(fields, (id) => !disabled.has(id));
    expect(f.first()).toEqual({ kind: 'field', id: 'account' }); // date is skipped
    expect(f.next('account')).toEqual({ kind: 'field', id: 'amount' }); // particular is skipped
    expect(f.prev('amount')).toEqual({ kind: 'field', id: 'account' });
  });

  it('re-evaluates enabled-ness every time, so conditions can change as the user types', () => {
    let hasGst = false;
    const f = new FormNavigator(['party', 'gstin', 'amount'], (id) => id !== 'gstin' || hasGst);
    expect(f.next('party')).toEqual({ kind: 'field', id: 'amount' });
    hasGst = true;
    expect(f.next('party')).toEqual({ kind: 'field', id: 'gstin' });
  });

  it('a trailing run of disabled fields is the end', () => {
    const f = new FormNavigator(['a', 'b', 'c'], (id) => id === 'a');
    expect(f.next('a')).toEqual({ kind: 'end' });
  });

  it('starting from an unknown field goes to the first enabled one', () => {
    expect(new FormNavigator(fields).next('ghost')).toEqual({ kind: 'field', id: 'date' });
  });

  it('an entirely disabled form has nowhere to go', () => {
    const f = new FormNavigator(fields, () => false);
    expect(f.first()).toEqual({ kind: 'end' });
    expect(f.last()).toEqual({ kind: 'start' });
  });
});

describe('GridNavigator', () => {
  const grid = (rows: string[][], opts: Partial<GridModel> = {}) =>
    new GridNavigator({
      cols: 3,
      rowCount: () => rows.length,
      isRowEmpty: (r) => (rows[r] ?? []).every((c) => c === ''),
      ...opts,
    });

  it('Enter moves right along a row', () => {
    const g = grid([['Rent', '100', 'x']]);
    expect(g.enter({ row: 0, col: 0 })).toEqual({ kind: 'move', pos: { row: 0, col: 1 } });
  });

  it('Enter at the end of a row drops to the start of the next', () => {
    const g = grid([['a', '1', 'x'], ['b', '2', 'y']]);
    expect(g.enter({ row: 0, col: 2 })).toEqual({ kind: 'move', pos: { row: 1, col: 0 } });
  });

  it('Enter at the end of the LAST filled row adds a new row', () => {
    const g = grid([['a', '1', 'x']]);
    expect(g.enter({ row: 0, col: 2 })).toEqual({ kind: 'add-row', pos: { row: 1, col: 0 } });
  });

  it('Enter on the first cell of an EMPTY row exits the grid — "I am done entering lines"', () => {
    const g = grid([['a', '1', 'x'], ['', '', '']]);
    expect(g.enter({ row: 1, col: 0 })).toEqual({ kind: 'exit' });
  });

  it('but Enter on the first cell of a filled row just moves on', () => {
    const g = grid([['a', '1', 'x']]);
    expect(g.enter({ row: 0, col: 0 }).kind).toBe('move');
  });

  it('skips disabled cells, e.g. a computed amount column', () => {
    const g = grid([['a', 'b', 'c'], ['d', 'e', 'f']], { isCellEnabled: (_r, c) => c !== 1 });
    expect(g.enter({ row: 0, col: 0 })).toEqual({ kind: 'move', pos: { row: 0, col: 2 } });
    expect(g.enter({ row: 0, col: 2 })).toEqual({ kind: 'move', pos: { row: 1, col: 0 } });
  });

  it('arrows move within bounds and stay at the edges', () => {
    const g = grid([['a', 'b', 'c'], ['d', 'e', 'f']]);
    expect(g.arrow({ row: 0, col: 1 }, 'down')).toEqual({ kind: 'move', pos: { row: 1, col: 1 } });
    expect(g.arrow({ row: 0, col: 1 }, 'up')).toEqual({ kind: 'stay' });
    expect(g.arrow({ row: 1, col: 2 }, 'right')).toEqual({ kind: 'stay' });
    expect(g.arrow({ row: 1, col: 2 }, 'left')).toEqual({ kind: 'move', pos: { row: 1, col: 1 } });
    expect(g.arrow({ row: 1, col: 0 }, 'down')).toEqual({ kind: 'stay' });
  });

  it('horizontal arrows skip disabled cells; vertical arrows land on an enabled cell', () => {
    // column 1 is disabled everywhere except row 0
    const g = grid([['a', 'b', 'c'], ['d', 'e', 'f']], { isCellEnabled: (r, c) => c !== 1 || r === 0 });
    expect(g.arrow({ row: 1, col: 0 }, 'right')).toEqual({ kind: 'move', pos: { row: 1, col: 2 } });
    expect(g.arrow({ row: 0, col: 1 }, 'down')).toEqual({ kind: 'move', pos: { row: 1, col: 0 } });
  });
});
