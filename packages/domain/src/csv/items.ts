import { csvOf, parseCsvRecords } from './format';
import { ITEM_TYPES, type ItemType } from '../masters/records';
import type { Masters } from '../masters/masters';
import type { StockItem } from '../masters/records';

/** One row of the native Items CSV — minimalERP's own field names, not any external format. `group`, `unit` and
 *  `gstRate` are human-readable (a stock group's name, a unit's symbol, a GST rate's percent), not ids: the
 *  importer resolves them against the company's own masters. */
export interface ItemRow {
  readonly name: string;
  readonly code: string;
  readonly alias: string;
  readonly group: string;
  readonly unit: string;
  readonly hsn: string;
  readonly gstRate: string;
  readonly itemType: string;
}

const COLUMNS = ['name', 'code', 'alias', 'group', 'unit', 'hsn', 'gstRate', 'itemType'] as const;

export function parseItemsCsv(text: string): ItemRow[] {
  return parseCsvRecords(text).map((r) => ({
    name: (r['name'] ?? '').trim(),
    code: (r['code'] ?? '').trim(),
    alias: (r['alias'] ?? '').trim(),
    group: (r['group'] ?? '').trim(),
    unit: (r['unit'] ?? '').trim(),
    hsn: (r['hsn'] ?? '').trim(),
    gstRate: (r['gstRate'] ?? '').trim(),
    itemType: (r['itemType'] ?? '').trim(),
  }));
}

/** A sample file to start from: the header plus two example rows (delete them before importing). `group` is
 *  left blank since a new company has no stock groups; `unit` and `gstRate` match the seeded masters. */
export function itemsCsvTemplate(): string {
  return csvOf([
    [...COLUMNS],
    ['Bolt M8 x 25', 'BLT-825', '', '', 'Nos', '7318', '18', 'trading'],
    ['Machining charges', 'SRV-01', '', '', 'Nos', '998898', '18', 'service'],
  ]);
}

/** The same columns `parseItemsCsv` reads — a true round trip. */
export function serializeItemsCsv(items: readonly StockItem[], masters: Masters): string {
  return csvOf([
    [...COLUMNS],
    ...items.map((i) => [
      i.name,
      i.code ?? '',
      i.alias ?? '',
      (i.groupId ? masters.stockGroup(i.groupId)?.name : undefined) ?? '',
      masters.unit(i.unitId)?.symbol ?? '',
      i.hsn ?? '',
      (i.gstRateId ? masters.gstRate(i.gstRateId)?.ratePercent : undefined) ?? '',
      i.itemType,
    ]),
  ]);
}

export interface ResolvedItemRow {
  readonly ok: true;
  /** The `stockItem` master command's `data` — ids already resolved, ready for `prepareMasterCommand`. */
  readonly data: { name: string; code?: string; alias?: string; groupId: string | null; unitId: string; hsn?: string; gstRateId: string | null; itemType: string };
}
export interface UnresolvedItemRow {
  readonly ok: false;
  readonly errors: string[];
}

/** Resolves one row's human-readable `group`/`unit`/`gstRate` names against the company's masters, into the ids
 *  the `stockItem` master command actually takes. Does not itself validate the result — `prepareMasterCommand`
 *  (the same engine the app's own master screens use) does that, so the two never disagree about what's valid. */
export function resolveItemRow(row: ItemRow, masters: Masters): ResolvedItemRow | UnresolvedItemRow {
  const errors: string[] = [];
  if (row.name === '') errors.push('name is required');
  const unit = row.unit === '' ? undefined : masters.units.find((u) => u.symbol.toLowerCase() === row.unit.toLowerCase());
  if (row.unit === '') errors.push('unit is required');
  else if (!unit) errors.push(`no unit called "${row.unit}"`);
  let groupId: string | null = null;
  if (row.group !== '') {
    const group = masters.stockGroups.find((g) => g.name.toLowerCase() === row.group.toLowerCase());
    if (!group) errors.push(`no stock group called "${row.group}"`);
    else groupId = group.id;
  }
  let gstRateId: string | null = null;
  if (row.gstRate !== '') {
    const rate = masters.gstRates.find((r) => r.ratePercent === row.gstRate);
    if (!rate) errors.push(`no GST rate of ${row.gstRate}%`);
    else gstRateId = rate.id;
  }
  const itemType = row.itemType === '' ? 'trading' : row.itemType;
  if (!ITEM_TYPES.includes(itemType as ItemType)) errors.push(`itemType must be one of ${ITEM_TYPES.join(', ')}`);
  if (errors.length > 0 || !unit) return { ok: false, errors };
  return {
    ok: true,
    data: {
      name: row.name,
      ...(row.code !== '' ? { code: row.code } : {}),
      ...(row.alias !== '' ? { alias: row.alias } : {}),
      groupId,
      unitId: unit.id,
      ...(row.hsn !== '' ? { hsn: row.hsn } : {}),
      gstRateId,
      itemType,
    },
  };
}
