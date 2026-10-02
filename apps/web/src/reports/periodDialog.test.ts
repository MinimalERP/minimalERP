import { deterministicUuid, localDate, prepareMasterCommand, seedCompany } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { periodFields, readPeriod } from './periodDialog';

// a company that began in 2026-27 and has added 2025-26 before it
const base = seedCompany({ name: 'Works', fyStart: localDate('2026-04-01'), newId: (n) => deterministicUuid(`period|${n}`) });
const added = prepareMasterCommand({ op: 'create', kind: 'financialYear', id: deterministicUuid('period|fy-25'), data: { start: '2025-04-01' } }, base);
if (!added.ok) throw new Error(added.issues[0]?.message);
const masters = added.value.masters;
const current = { start: '2026-04-01', end: '2027-03-31' };
const thisYear = { from: '2026-04-01', to: '2027-03-31' };

describe('the Period dialog (F2): a financial year or two dates', () => {
  it('shows the year the period is, then the dates', () => {
    expect(periodFields(masters, thisYear, false).map((f) => [f.key, f.value])).toEqual([['fy', '2026-27'], ['from', '1-Apr-2026'], ['to', '31-Mar-2027']]);
    expect(periodFields(masters, { from: '2026-05-01', to: '2026-05-31' }, false)[0]?.value).toBe('');
    expect(periodFields(masters, { from: '2026-04-01', to: '2026-09-30' }, true).map((f) => [f.key, f.value])).toEqual([['fy', '2026-27'], ['to', '30-Sep-2026']]);
  });

  it('a year typed, as "25-26" or "2025-26", gives that whole year; the Balance Sheet its last day', () => {
    const fields = periodFields(masters, thisYear, false);
    for (const typed of ['25-26', '2025-26']) {
      expect(readPeriod(masters, { fy: typed, from: '1-Apr-2026', to: '31-Mar-2027' }, fields, thisYear, false, current).period).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    }
    const sheet = { from: '2026-04-01', to: '2026-09-30' };
    expect(readPeriod(masters, { fy: '25-26', to: '30-Sep-2026' }, periodFields(masters, sheet, true), sheet, true, current).period).toEqual({ from: '2026-04-01', to: '2026-03-31' });
  });

  it('dates typed win over the year left as it was, and are read inside that year', () => {
    const lastYear = { from: '2025-04-01', to: '2026-03-31' };
    const fields = periodFields(masters, lastYear, false); // fy shows 2025-26
    expect(readPeriod(masters, { fy: '2025-26', from: '1-10', to: '31-12' }, fields, lastYear, false, current).period).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(readPeriod(masters, { fy: '', from: '1-6-26', to: '30-6-26' }, fields, lastYear, false, current).period).toEqual({ from: '2026-06-01', to: '2026-06-30' });
  });

  it('refuses a year the company does not have, and dates out of order', () => {
    const fields = periodFields(masters, thisYear, false);
    expect(readPeriod(masters, { fy: '22-23', from: '1-Apr-2026', to: '31-Mar-2027' }, fields, thisYear, false, current).errors).toHaveProperty('fy');
    expect(readPeriod(masters, { fy: '', from: '30-6-26', to: '1-6-26' }, fields, thisYear, false, current).errors).toEqual({ to: 'The end is before the start' });
  });
});
