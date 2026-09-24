import { describe, expect, it } from 'vitest';
import { localDate } from '../dates';
import { deterministicUuid } from '../ids';
import { prepareMasterCommand } from '../masters/commands';
import { seedCompany } from '../masters/seed';
import { itemsCsvTemplate, parseItemsCsv, resolveItemRow, serializeItemsCsv } from './items';

const newId = (n: string) => deterministicUuid(`csv-items|${n}`);

function world() {
  let masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
  const run = (kind: string, id: string, data: unknown) => {
    const r = prepareMasterCommand({ op: 'create', kind, id, data }, masters);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    masters = r.value.masters;
  };
  run('stockGroup', newId('group:raw'), { name: 'Raw Material' });
  return masters;
}

describe('parseItemsCsv', () => {
  it('reads a row into its columns, trimmed', () => {
    const rows = parseItemsCsv('name,code,alias,group,unit,hsn,gstRate,itemType\n Bolt , FG-1 ,, Raw Material , Nos , 7318 , 18 , finished ');
    expect(rows).toEqual([{ name: 'Bolt', code: 'FG-1', alias: '', group: 'Raw Material', unit: 'Nos', hsn: '7318', gstRate: '18', itemType: 'finished' }]);
  });
});

describe('resolveItemRow', () => {
  it('resolves group, unit and GST rate names against the masters', () => {
    const masters = world();
    const r = resolveItemRow({ name: 'Bolt', code: 'FG-1', alias: '', group: 'Raw Material', unit: 'Nos', hsn: '7318', gstRate: '18', itemType: 'finished' }, masters);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.name).toBe('Bolt');
      expect(r.data.unitId).toBe(masters.units.find((u) => u.symbol === 'Nos')?.id);
      expect(r.data.groupId).toBe(masters.stockGroups.find((g) => g.name === 'Raw Material')?.id);
      expect(r.data.gstRateId).toBe(masters.gstRates.find((g) => g.ratePercent === '18')?.id);
    }
  });

  it('an unresolved unit/group/gstRate name is reported, not guessed', () => {
    const masters = world();
    const r = resolveItemRow({ name: 'Bolt', code: '', alias: '', group: 'No Such Group', unit: 'Nope', hsn: '', gstRate: '99', itemType: 'finished' }, masters);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual(expect.arrayContaining([expect.stringContaining('No Such Group'), expect.stringContaining('Nope'), expect.stringContaining('99')]));
    }
  });

  it('the resolved data passes prepareMasterCommand, same as the app’s own Item screen', () => {
    const masters = world();
    const r = resolveItemRow({ name: 'Bolt', code: '', alias: '', group: '', unit: 'Nos', hsn: '', gstRate: '', itemType: 'finished' }, masters);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const prepared = prepareMasterCommand({ op: 'create', kind: 'stockItem', id: newId('bolt'), data: r.data }, masters);
      expect(prepared.ok).toBe(true);
    }
  });
});

describe('serializeItemsCsv', () => {
  it('round-trips through resolveItemRow back to the same command data', () => {
    let masters = world();
    const created = prepareMasterCommand({ op: 'create', kind: 'stockItem', id: newId('bolt'), data: { name: 'Bolt', groupId: masters.stockGroups[0]?.id, unitId: masters.units[0]?.id, hsn: '7318', itemType: 'finished' } }, masters);
    if (!created.ok) throw new Error(JSON.stringify(created.issues));
    masters = created.value.masters;

    const csv = serializeItemsCsv(masters.stockItems, masters);
    const [row] = parseItemsCsv(csv);
    expect(row?.name).toBe('Bolt');
    expect(row?.group).toBe('Raw Material');
    expect(row?.hsn).toBe('7318');
    const resolved = resolveItemRow(row as NonNullable<typeof row>, masters);
    expect(resolved.ok).toBe(true);
  });
});

describe('itemsCsvTemplate', () => {
  it('its example rows resolve against a fresh company’s masters', () => {
    const masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
    const rows = parseItemsCsv(itemsCsvTemplate());
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(resolveItemRow(row, masters).ok).toBe(true);
  });
});
