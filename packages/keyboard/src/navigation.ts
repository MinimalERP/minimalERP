/**
 * Pure navigation models. They decide WHERE focus should go; the UI just follows.
 * No DOM, no framework — so every keyboard rule is unit-tested without a browser.
 */

// ---------------------------------------------------------------------------------------------
// Lists (menus, search results, report rows)
// ---------------------------------------------------------------------------------------------
export type ListMove = 'up' | 'down' | 'pageUp' | 'pageDown' | 'first' | 'last';

export interface ListMoveOptions {
  /** Up on the first row goes to the last, and vice versa. Menus wrap; long reports do not. */
  readonly wrap?: boolean;
  readonly pageSize?: number;
}

/** The index a list cursor moves to. An empty list has nowhere to go and stays at 0. */
export function moveIndex(index: number, count: number, move: ListMove, options: ListMoveOptions = {}): number {
  if (count <= 0) return 0;
  const last = count - 1;
  const page = Math.max(1, options.pageSize ?? 10);
  const clamp = (n: number) => Math.min(last, Math.max(0, n));
  switch (move) {
    case 'up':
      return index <= 0 ? (options.wrap ? last : 0) : clamp(index - 1);
    case 'down':
      return index >= last ? (options.wrap ? 0 : last) : clamp(index + 1);
    case 'pageUp':
      return clamp(index - page);
    case 'pageDown':
      return clamp(index + page);
    case 'first':
      return 0;
    case 'last':
      return last;
  }
}

// ---------------------------------------------------------------------------------------------
// Forms: an ordered set of fields. Enter/Tab = next, Shift+Tab = previous.
// Disabled fields (conditional, or auto-filled from defaults) are skipped.
// ---------------------------------------------------------------------------------------------
export type FieldMove =
  | { readonly kind: 'field'; readonly id: string }
  | { readonly kind: 'start' }
  | { readonly kind: 'end' };

export class FormNavigator {
  constructor(
    private readonly fields: readonly string[],
    private readonly isEnabled: (fieldId: string) => boolean = () => true,
  ) {}

  first(): FieldMove {
    return this.scan(0, 1, { kind: 'end' });
  }

  last(): FieldMove {
    return this.scan(this.fields.length - 1, -1, { kind: 'start' });
  }

  /** The next enabled field after `from`, or `end` (the form is complete: time to accept). */
  next(from: string): FieldMove {
    const i = this.fields.indexOf(from);
    return i === -1 ? this.first() : this.scan(i + 1, 1, { kind: 'end' });
  }

  /** The previous enabled field before `from`, or `start` if there is none. */
  prev(from: string): FieldMove {
    const i = this.fields.indexOf(from);
    return i === -1 ? this.first() : this.scan(i - 1, -1, { kind: 'start' });
  }

  private scan(from: number, step: 1 | -1, none: FieldMove): FieldMove {
    for (let i = from; i >= 0 && i < this.fields.length; i += step) {
      const id = this.fields[i] as string;
      if (this.isEnabled(id)) return { kind: 'field', id };
    }
    return none;
  }
}

// ---------------------------------------------------------------------------------------------
// Grids (voucher line items). The Tally rhythm:
//   Enter moves right; at the end of a row it drops to the next row;
//   at the end of the LAST row it adds a new row — unless the row is empty, which means "I'm done".
// ---------------------------------------------------------------------------------------------
export interface GridPos {
  readonly row: number;
  readonly col: number;
}

export type GridMove =
  | { readonly kind: 'move'; readonly pos: GridPos }
  | { readonly kind: 'add-row'; readonly pos: GridPos }
  | { readonly kind: 'exit' }
  | { readonly kind: 'stay' };

export interface GridModel {
  readonly cols: number;
  rowCount(): number;
  isRowEmpty(row: number): boolean;
  isCellEnabled?(row: number, col: number): boolean;
}

export type GridDirection = 'up' | 'down' | 'left' | 'right';

export class GridNavigator {
  constructor(private readonly model: GridModel) {}

  private enabled(row: number, col: number): boolean {
    return this.model.isCellEnabled?.(row, col) ?? true;
  }

  private firstEnabledCol(row: number): number {
    for (let c = 0; c < this.model.cols; c++) if (this.enabled(row, c)) return c;
    return 0;
  }

  /** What Enter does from `pos`. */
  enter(pos: GridPos): GridMove {
    // Enter on the first cell of an empty row ends the list.
    if (pos.col === 0 && this.model.isRowEmpty(pos.row)) return { kind: 'exit' };

    for (let c = pos.col + 1; c < this.model.cols; c++) {
      if (this.enabled(pos.row, c)) return { kind: 'move', pos: { row: pos.row, col: c } };
    }
    if (pos.row + 1 < this.model.rowCount()) {
      return { kind: 'move', pos: { row: pos.row + 1, col: this.firstEnabledCol(pos.row + 1) } };
    }
    return this.model.isRowEmpty(pos.row)
      ? { kind: 'exit' }
      : { kind: 'add-row', pos: { row: pos.row + 1, col: this.firstEnabledCol(pos.row + 1) } };
  }

  /** Arrow-key movement; stays put at the edges. */
  arrow(pos: GridPos, direction: GridDirection): GridMove {
    const rows = this.model.rowCount();
    if (direction === 'up' || direction === 'down') {
      const row = pos.row + (direction === 'up' ? -1 : 1);
      if (row < 0 || row >= rows) return { kind: 'stay' };
      const col = this.enabled(row, pos.col) ? pos.col : this.firstEnabledCol(row);
      return { kind: 'move', pos: { row, col } };
    }
    const step = direction === 'left' ? -1 : 1;
    for (let c = pos.col + step; c >= 0 && c < this.model.cols; c += step) {
      if (this.enabled(pos.row, c)) return { kind: 'move', pos: { row: pos.row, col: c } };
    }
    return { kind: 'stay' };
  }
}
