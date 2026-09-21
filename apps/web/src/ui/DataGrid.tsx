import type { ColumnSpec, GridQuery } from '@minimalerp/domain';
import { useEffect, useRef } from 'preact/hooks';

export interface DataGridProps<R> {
  readonly columns: readonly ColumnSpec<R>[];
  readonly rows: readonly R[];
  readonly rowKey: (row: R) => string;
  /** The cursor row and the column the keyboard is on (sort and filter act on it). */
  readonly activeRow: number;
  readonly activeCol: number;
  readonly query: GridQuery;
  readonly label: string;
  readonly rowClass?: ((row: R) => string) | undefined;
  /** Mouse: click a row / a header. (Keyboard goes through commands, not here.) */
  readonly onPickRow: (index: number) => void;
  readonly onPickColumn: (index: number) => void;
  readonly onSortColumn: (index: number) => void;
}

/** Rows drawn around the cursor: a long Day Book stays fast because only this many are in the page at once. */
const WINDOW = 160;
const ROW_H = 30;

const cell = <R,>(col: ColumnSpec<R>, row: R): string => {
  if (col.text) return col.text(row);
  const v = col.value(row);
  return v === null ? '' : String(v);
};

/**
 * The report grid. It draws the cursor, the active column and the sort arrows, and nothing else: sorting, filtering and moving are
 * commands the screen handles, so the same grid serves every report.
 */
export function DataGrid<R>(p: DataGridProps<R>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const start = Math.max(0, Math.min(p.activeRow - WINDOW / 2, Math.max(0, p.rows.length - WINDOW)));
  const end = Math.min(p.rows.length, start + WINDOW);

  useEffect(() => {
    const el = wrapRef.current?.querySelector('tr.selected');
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [p.activeRow, p.rows.length]);

  return (
    <div class="grid-wrap" ref={wrapRef}>
      <table class="data-grid" role="grid" aria-label={p.label} aria-rowcount={p.rows.length}>
        <thead>
          <tr>
            {p.columns.map((c, i) => {
              const sort = p.query.sort.find((k) => k.column === c.id);
              const filtered = p.query.filters[c.id] !== undefined;
              return (
                <th
                  key={c.id}
                  role="columnheader"
                  aria-sort={sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  class={`${i === p.activeCol ? 'active' : ''} ${c.align === 'right' ? 'num' : ''}`}
                  onClick={() => (i === p.activeCol ? p.onSortColumn(i) : p.onPickColumn(i))}
                >
                  {c.label}
                  {sort && <span class="sort-arrow" aria-hidden="true">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                  {filtered && <span class="filter-dot" title="filtered" aria-label="filtered"> ●</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {start > 0 && <tr aria-hidden="true" style={{ height: `${start * ROW_H}px` }} />}
          {p.rows.slice(start, end).map((row, k) => {
            const i = start + k;
            return (
              <tr
                key={p.rowKey(row)}
                role="row"
                aria-selected={i === p.activeRow}
                class={`${i === p.activeRow ? 'selected' : ''} ${p.rowClass?.(row) ?? ''}`}
                onClick={() => p.onPickRow(i)}
              >
                {p.columns.map((c, ci) => (
                  <td key={c.id} class={`${c.align === 'right' ? 'num' : ''} ${ci === p.activeCol && i === p.activeRow ? 'active-cell' : ''}`}>
                    {cell(c, row)}
                  </td>
                ))}
              </tr>
            );
          })}
          {end < p.rows.length && <tr aria-hidden="true" style={{ height: `${(p.rows.length - end) * ROW_H}px` }} />}
        </tbody>
      </table>
    </div>
  );
}
