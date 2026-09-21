/**
 * What only the database can promise about GST and TDS (Phase 9, ADR-0019):
 *   - a company that existed before GST gets each system ledger once — and running the step again adds none (the backfill is the migration's own SQL)
 *   - a company charges GST only when told to, and the switch survives a round trip through the database
 *   - an invoice's bill is mirrored at its total WITH tax, named as before
 *   - the tax and the TDS are ordinary journal lines: the voucher still balances by the database's own rule
 */
import { partyLedgerId, deriveGstHeader, gstinCheckChar } from '@minimalerp/domain';
import { mustOk } from '@minimalerp/testkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;

const KEYS = ['gst-output-cgst', 'gst-output-sgst', 'gst-output-igst', 'gst-input-cgst', 'gst-input-sgst', 'gst-input-igst', 'tds-receivable'];
const count = async (sql: string, values: unknown[] = []) => Number((await db.pool.query(sql, values)).rows[0]?.n);

/** The backfill statement of the Phase 9 migration, exactly as it runs on a real database. */
const backfill = (): string => {
  const file = readFileSync(join(__dirname, '../../../supabase/migrations/20260928000100_gst_tds_phase9.sql'), 'utf8');
  const start = file.indexOf('update public.ledgers l');
  const end = file.indexOf(';', file.indexOf('insert into public.ledgers'));
  return file.slice(start, end + 1);
};

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
});
afterAll(async () => {
  await db?.close();
});

describe('the system ledgers of a company that already existed', () => {
  it('are added once, each in its group, and a second run adds nothing', async () => {
    // a company as it was before this phase: none of the system ledgers
    await db.pool.query(`delete from public.ledgers where company_id = $1 and reserved_key = any($2::text[])`, [w.companyId, KEYS]);
    expect(await count(`select count(*) n from public.ledgers where company_id = $1 and reserved_key = any($2::text[])`, [w.companyId, KEYS])).toBe(0);

    await db.pool.query(backfill());
    const rows = (
      await db.pool.query(
        `select l.reserved_key, l.name, g.reserved_key as grp from public.ledgers l join public.account_groups g on g.id = l.group_id
          where l.company_id = $1 and l.reserved_key = any($2::text[]) order by l.reserved_key`,
        [w.companyId, KEYS],
      )
    ).rows;
    expect(rows).toEqual(
      [...KEYS].sort().map((k) => ({
        reserved_key: k,
        name: { 'gst-output-cgst': 'Output CGST', 'gst-output-sgst': 'Output SGST', 'gst-output-igst': 'Output IGST', 'gst-input-cgst': 'Input CGST', 'gst-input-sgst': 'Input SGST', 'gst-input-igst': 'Input IGST', 'tds-receivable': 'TDS Receivable' }[k],
        grp: k.startsWith('gst-output') ? 'duties-and-taxes' : 'loans-and-advances-asset',
      })),
    );

    const before = await count(`select count(*) n from public.ledgers where company_id = $1`, [w.companyId]);
    await db.pool.query(backfill());
    expect(await count(`select count(*) n from public.ledgers where company_id = $1`, [w.companyId])).toBe(before);
  });

  it('a company that had already made a ledger of that NAME keeps it, with its entries: it is adopted as the system ledger, not duplicated', async () => {
    await db.pool.query(`delete from public.ledgers where company_id = $1 and reserved_key = 'tds-receivable'`, [w.companyId]);
    await db.pool.query(
      `insert into public.ledgers (company_id, name, group_id) select $1, 'TDS Receivable', id from public.account_groups where company_id = $1 and reserved_key = 'current-assets'`,
      [w.companyId],
    );
    const mine = (await db.pool.query(`select id from public.ledgers where company_id = $1 and lower(name) = 'tds receivable'`, [w.companyId])).rows[0]?.id;
    await db.pool.query(backfill());
    const rows = (await db.pool.query(`select id, reserved_key from public.ledgers where company_id = $1 and lower(name) = 'tds receivable'`, [w.companyId])).rows;
    expect(rows).toEqual([{ id: mine, reserved_key: 'tds-receivable' }]); // the same ledger, now the system one
    await db.pool.query(backfill());
    expect(await count(`select count(*) n from public.ledgers where company_id = $1 and reserved_key = 'tds-receivable'`, [w.companyId])).toBe(1);
  });
});

describe('the switch and the bill', () => {
  it('a company does not charge GST until told to; the switch is stored with the company', async () => {
    expect((await w.backend.load(w.companyId)).company.chargeGst).toBeUndefined();
    expect(await count(`select count(*) n from public.companies where id = $1 and charge_gst = false`, [w.companyId])).toBe(1);
    const id = '27AABCD1234E1Z';
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'alter', kind: 'company', id: w.companyId, data: { name: 'X', gstin: id + gstinCheckChar(id), chargeGst: 'yes' } } }));
    expect((await w.backend.load(w.companyId)).company.chargeGst).toBe(true);
    expect(await count(`select count(*) n from public.companies where id = $1 and charge_gst = true`, [w.companyId])).toBe(1);
  });

  it('an invoice’s bill is its total with tax; the journal lines of the voucher balance', async () => {
    const create = async (kind: string, cid: string, data: unknown) => mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id: cid, data } }));
    await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
    await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'], stateCode: '27' });
    await create('ledger', w.uuid('ledger:sales'), { name: 'Sales', groupId: w.uuid('group:sales-accounts') });
    const main = (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
    mustOk(await w.backend.post({ companyId: w.companyId, draft: { id: w.uuid('v:open'), voucherTypeId: w.uuid('type:stockOpening'), date: '2024-04-01', itemId: w.uuid('item:bolt'), warehouseId: main, qty: '100', rate: '40' } }));
    const masters = await w.backend.load(w.companyId);
    const lines = [{ itemId: w.uuid('item:bolt'), warehouseId: main, qty: '10', rate: '100', gstRate: '18' }];
    const partyDetails = { partyId: w.uuid('party:acme'), mailingName: 'X' };
    const gst = deriveGstHeader(masters, 'sales', { partyId: w.uuid('party:acme'), partyDetails, lines });
    const v = mustOk(
      await w.backend.post({
        companyId: w.companyId,
        draft: { id: w.uuid('v:s1'), voucherTypeId: w.uuid('type:sales'), date: '2024-05-12', partyId: w.uuid('party:acme'), partyDetails, salesLedgerId: w.uuid('ledger:sales'), dueDate: '2024-06-11', lines, gst },
      }),
    ).voucher;
    const bill = (await db.pool.query(`select ledger_id, side, kind, ref, amount::text as amount from public.bill_allocations where voucher_id = $1`, [v.id])).rows;
    expect(bill).toEqual([{ ledger_id: partyLedgerId(w.uuid('party:acme') as never, 'customer'), side: 'debit', kind: 'new', ref: v.number, amount: '1180.00' }]);
    const t = (await db.pool.query(`select coalesce(sum(debit), 0)::text d, coalesce(sum(credit), 0)::text c, count(*)::int n from public.journal_lines where voucher_id = $1`, [v.id])).rows[0];
    expect(t).toEqual({ d: '1180.00', c: '1180.00', n: 4 });
  });
});
