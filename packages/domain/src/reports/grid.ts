/**
 * The report grid, as pure logic. A report is a list of ColumnSpecs plus its rows; sorting and filtering are generic and
 * driven ONLY by the column definitions (a whitelist: a query naming a column that does not exist, or is not sortable /
 * filterable, is ignored rather than trusted). That is what makes every report sortable and filterable by construction —
 * a new report cannot forget to be.
 */

export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'choice';
export type CellValue = string | number | bigint | null;

export interface ColumnSpec<R> {
  readonly id: string;
  readonly label: string;
  readonly type: ColumnType;
  readonly align?: 'left' | 'right';
  /** Default true. */
  readonly sortable?: boolean;
  /** Default true. */
  readonly filterable?: boolean;
  /** The raw value: what sorting and range filters compare. Money is bigint minor units, dates are ISO text. */
  value(row: R): CellValue;
  /** How the cell reads on screen (also what "contains" and the quick filter search). Defaults to the raw value. */
  text?(row: R): string;
  /** For `choice` columns: the options a filter may pick from. */
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
}

export type ColumnFilter =
  | { readonly kind: 'contains'; readonly text: string }
  /** Inclusive on both ends; either may be omitted. For number, money and date columns. */
  | { readonly kind: 'range'; readonly min?: CellValue | undefined; readonly max?: CellValue | undefined }
  | { readonly kind: 'in'; readonly values: readonly string[] }
  | { readonly kind: 'notIn'; readonly values: readonly string[] };

export interface SortKey {
  readonly column: string;
  readonly dir: 'asc' | 'desc';
}

export interface GridQuery {
  /** First key is the primary sort. */
  readonly sort: readonly SortKey[];
  readonly filters: Readonly<Record<string, ColumnFilter>>;
  /** Free text: every word must appear in some column of the row (case-insensitive). */
  readonly quick: string;
}

export const EMPTY_QUERY: GridQuery = { sort: [], filters: {}, quick: '' };

const cellText = <R>(col: ColumnSpec<R>, row: R): string => {
  if (col.text) return col.text(row);
  const v = col.value(row);
  return v === null ? '' : String(v);
};

/** Ordering of two cells of the same column. Nulls sort last in either direction (handled by the caller). */
export function compareCells(a: CellValue, b: CellValue): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const x = typeof a === 'bigint' ? Number(a) : Number(a);
  const y = typeof b === 'bigint' ? Number(b) : Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Drops everything the columns do not allow. The result is safe to apply. */
export function sanitizeQuery<R>(columns: readonly ColumnSpec<R>[], query: GridQuery): GridQuery {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const sort = query.sort.filter((k) => byId.get(k.column)?.sortable !== false && byId.has(k.column));
  const filters: Record<string, ColumnFilter> = {};
  for (const [id, f] of Object.entries(query.filters)) {
    if (byId.has(id) && byId.get(id)?.filterable !== false) filters[id] = f;
  }
  return { sort, filters, quick: query.quick };
}

function passes<R>(col: ColumnSpec<R>, filter: ColumnFilter, row: R): boolean {
  switch (filter.kind) {
    case 'contains': {
      const needle = filter.text.trim().toLowerCase();
      return needle === '' || cellText(col, row).toLowerCase().includes(needle);
    }
    case 'range': {
      const v = col.value(row);
      if (v === null) return filter.min === undefined && filter.max === undefined;
      if (filter.min !== undefined && filter.min !== null && compareCells(v, filter.min) < 0) return false;
      if (filter.max !== undefined && filter.max !== null && compareCells(v, filter.max) > 0) return false;
      return true;
    }
    case 'in': {
      if (filter.values.length === 0) return true;
      const v = col.value(row);
      return v !== null && filter.values.includes(String(v));
    }
    case 'notIn': {
      const v = col.value(row);
      return v === null || !filter.values.includes(String(v));
    }
  }
}

/**
 * Filters then sorts. Never adds, invents or changes a row; the sort is stable (equal rows keep their incoming order),
 * so applying the same query twice, or filters in any order, gives the same result.
 */
export function applyGridQuery<R>(rows: readonly R[], columns: readonly ColumnSpec<R>[], query: GridQuery): R[] {
  const q = sanitizeQuery(columns, query);
  const byId = new Map(columns.map((c) => [c.id, c]));
  const words = q.quick.toLowerCase().split(/\s+/).filter(Boolean);

  const kept: { row: R; at: number }[] = [];
  rows.forEach((row, at) => {
    for (const [id, filter] of Object.entries(q.filters)) {
      const col = byId.get(id) as ColumnSpec<R>;
      if (!passes(col, filter, row)) return;
    }
    if (words.length > 0) {
      const hay = columns.map((c) => cellText(c, row)).join('  ').toLowerCase();
      if (!words.every((w) => hay.includes(w))) return;
    }
    kept.push({ row, at });
  });

  if (q.sort.length > 0) {
    kept.sort((x, y) => {
      for (const key of q.sort) {
        const col = byId.get(key.column) as ColumnSpec<R>;
        const a = col.value(x.row);
        const b = col.value(y.row);
        if (a === null && b === null) continue;
        if (a === null) return 1; // empty cells last, whichever way it is sorted
        if (b === null) return -1;
        const c = compareCells(a, b);
        if (c !== 0) return key.dir === 'asc' ? c : -c;
      }
      return x.at - y.at; // stable
    });
  }
  return kept.map((k) => k.row);
}

/** Cycles a column's sort: none → ascending → descending → none. Other columns' keys are dropped (single-column sort from the keyboard). */
export function cycleSort(query: GridQuery, column: string): GridQuery {
  const current = query.sort.find((k) => k.column === column);
  const sort: SortKey[] = current === undefined ? [{ column, dir: 'asc' }] : current.dir === 'asc' ? [{ column, dir: 'desc' }] : [];
  return { ...query, sort };
}

export function withFilter(query: GridQuery, column: string, filter: ColumnFilter | undefined): GridQuery {
  const filters = { ...query.filters };
  if (filter === undefined) delete filters[column];
  else filters[column] = filter;
  return { ...query, filters };
}

export const hasActiveFilters = (query: GridQuery): boolean => Object.keys(query.filters).length > 0 || query.quick.trim() !== '';
