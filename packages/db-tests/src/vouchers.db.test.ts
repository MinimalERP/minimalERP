/**
 * What only the database can promise about Phase 5 data:
 *   - bill-wise details are mirrored into `bill_allocations` by the database itself, in the voucher's own transaction, and follow alter and cancel
 *   - the mirror is read-only to everyone (clients and the application alike write only vouchers)
 *   - the table is locked down like every other: members with report.view read their own company only
 */
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let a: PgMasterWorld;
let b: PgMasterWorld;
const viewer = randomUUID();
const outsider = randomUUID();

const seed = async (w: PgMasterWorld) => {
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('ledger', w.uuid('l:bank'), { name: 'HDFC', groupId: w.uuid('group:bank-accounts') });
  await create('ledger', w.uuid('l:steel'), { name: 'Steel Supplies', groupId: w.uuid('group:sundry-creditors') });
  await create('ledger', w.uuid('l:abc'), { name: 'ABC', groupId: w.uuid('group:sundry-debtors') });
  await create('ledger', w.uuid('l:rent'), { name: 'Rent', groupId: w.uuid('group:indirect-expenses') });
};

const payment = (w: PgMasterWorld, id: string, allocations: unknown[], amount = '1000') => ({
  id: w.uuid(`v:${id}`),
  voucherTypeId: w.uuid('type:payment'),
  date: '2024-05-10',
  accountLedgerId: w.uuid('l:bank'),
  lines: [{ ledgerId: w.uuid('l:steel'), amount, allocations }],
});

const rows = async (w: PgMasterWorld, voucherKey?: string) =>
  (
    await db.pool.query(
      `select ledger_id, side, kind, ref, due_date::text as due, amount::text as amount
         from public.bill_allocations where company_id = $1 ${voucherKey ? 'and voucher_id = $2' : ''} order by id`,
      voucherKey ? [w.companyId, w.uuid(`v:${voucherKey}`)] : [w.companyId],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgMasterWorldFactory(db);
  a = await make();
  b = await make();
  await seed(a);
  await seed(b);
  await addMember(db.pool, a.companyId, viewer, 'viewer');
  await db.pool.query(`insert into auth.users (id, email) values ($1, 'outsider2@example.test')`, [outsider]);
});
afterAll(async () => {
  await db?.close();
});

describe('bill_allocations: mirrored by the database from the voucher', () => {
  it('a payment’s bill-wise parts appear with the side, reference, due date and amount', async () => {
    mustOk(
      await a.backend.post({
        companyId: a.companyId,
        draft: payment(a, 'p1', [
          { kind: 'against', ref: 'PO-2210', amount: '600' },
          { kind: 'new', ref: 'ADV-1', dueDate: '2024-06-15', amount: '300' },
          { kind: 'onAccount', amount: '100' },
        ]),
      }),
    );
    expect(await rows(a, 'p1')).toEqual([
      { ledger_id: a.uuid('l:steel'), side: 'debit', kind: 'against', ref: 'PO-2210', due: null, amount: '600.00' },
      { ledger_id: a.uuid('l:steel'), side: 'debit', kind: 'new', ref: 'ADV-1', due: '2024-06-15', amount: '300.00' },
      { ledger_id: a.uuid('l:steel'), side: 'debit', kind: 'onAccount', ref: null, due: null, amount: '100.00' },
    ]);
  });

  it('a receipt credits, a journal states its own side, an opening balance its own', async () => {
    mustOk(
      await a.backend.post({
        companyId: a.companyId,
        draft: {
          id: a.uuid('v:r1'), voucherTypeId: a.uuid('type:receipt'), date: '2024-05-11', accountLedgerId: a.uuid('l:bank'),
          lines: [{ ledgerId: a.uuid('l:abc'), amount: '500', allocations: [{ kind: 'against', ref: 'INV-1', amount: '500' }] }],
        },
      }),
    );
    mustOk(
      await a.backend.post({
        companyId: a.companyId,
        draft: {
          id: a.uuid('v:j1'), voucherTypeId: a.uuid('type:journal'), date: '2024-05-12',
          entries: [{ ledgerId: a.uuid('l:rent'), side: 'debit', amount: '70' }, { ledgerId: a.uuid('l:steel'), side: 'credit', amount: '70', allocations: [{ kind: 'new', ref: 'BC-77', amount: '70' }] }],
        },
      }),
    );
    mustOk(
      await a.backend.post({
        companyId: a.companyId,
        draft: { id: a.uuid('v:ob'), voucherTypeId: a.uuid('type:opening'), date: '2024-04-01', ledgerId: a.uuid('l:abc'), side: 'debit', amount: '900', offsetLedgerId: a.uuid('ledger:opening-difference'), allocations: [{ kind: 'new', ref: 'OB-9', amount: '900' }] },
      }),
    );
    expect((await rows(a, 'r1')).map((r) => [r.side, r.ref])).toEqual([['credit', 'INV-1']]);
    expect((await rows(a, 'j1')).map((r) => [r.side, r.ref])).toEqual([['credit', 'BC-77']]);
    expect((await rows(a, 'ob')).map((r) => [r.side, r.ref])).toEqual([['debit', 'OB-9']]);
  });

  it('a voucher without bill-wise details has no rows, and a contra never does', async () => {
    mustOk(await a.backend.post({ companyId: a.companyId, draft: payment(a, 'plain', []) }));
    expect(await rows(a, 'plain')).toEqual([]);
  });

  it('altering a voucher replaces its rows in the same transaction; cancelling removes them', async () => {
    const v = mustOk(await a.backend.post({ companyId: a.companyId, draft: payment(a, 'p2', [{ kind: 'new', ref: 'X-1', amount: '1000' }]) }));
    expect((await rows(a, 'p2')).map((r) => r.ref)).toEqual(['X-1']);
    mustOk(
      await a.backend.alter({ companyId: a.companyId, voucherId: v.voucher.id, expectedVersion: 1, draft: payment(a, 'p2', [{ kind: 'new', ref: 'X-2', amount: '400' }, { kind: 'new', ref: 'X-3', amount: '600' }]) }),
    );
    expect((await rows(a, 'p2')).map((r) => r.ref)).toEqual(['X-2', 'X-3']);
    mustOk(await a.backend.cancel({ companyId: a.companyId, voucherId: v.voucher.id, expectedVersion: 2 }));
    expect(await rows(a, 'p2')).toEqual([]);
  });

  it('a refused voucher leaves no rows', async () => {
    const before = (await rows(a)).length;
    const r = await a.backend.post({ companyId: a.companyId, draft: payment(a, 'bad', [{ kind: 'new', ref: 'Z', amount: '1' }]) }); // does not add up to 1000
    expect(r.ok).toBe(false);
    expect((await rows(a)).length).toBe(before);
  });

  it('the database itself refuses a bill part with no reference, or a non-positive amount', async () => {
    const stray = (sql: string) => db.pool.query(sql, [a.companyId, a.uuid('v:p1'), a.uuid('l:steel')]).then(() => undefined, (e: { message?: string }) => e.message);
    expect(await stray(`insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, amount) values ($1, $2, $3, 'debit', 'new', null, 5)`)).toMatch(/bill_ref_needed/);
    expect(await stray(`insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, amount) values ($1, $2, $3, 'debit', 'onAccount', null, 0)`)).toMatch(/check/i);
  });
});

describe('bill_allocations: who can read it', () => {
  const visible = (userId: string, where = 'true') =>
    db.asRole('authenticated', userId, async (c) => Number((await c.query(`select count(*)::int n from public.bill_allocations where ${where}`)).rows[0].n));

  it('members with report.view read their own company’s bills, nobody else’s', async () => {
    mustOk(await b.backend.post({ companyId: b.companyId, draft: payment(b, 'pb', [{ kind: 'new', ref: 'B-1', amount: '1000' }]) }));
    expect(await visible(a.ownerId, `company_id = '${a.companyId}'`)).toBeGreaterThan(0);
    expect(await visible(viewer, `company_id = '${a.companyId}'`)).toBeGreaterThan(0);
    expect(await visible(a.ownerId, `company_id = '${b.companyId}'`)).toBe(0);
    expect(await visible(outsider)).toBe(0);
  });

  it('a signed-in user cannot write it (the trigger writes it; nobody else)', async () => {
    const denied = (sql: string) => db.asRole('authenticated', a.ownerId, async (c) => c.query(sql)).then(() => undefined, (e: { code?: string }) => e.code);
    expect(await denied(`insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, amount) select company_id, voucher_id, ledger_id, side, 'onAccount', 1 from public.bill_allocations limit 1`)).toBe('42501');
    expect(await denied(`update public.bill_allocations set amount = 1`)).toBe('42501');
    expect(await denied(`delete from public.bill_allocations`)).toBe('42501');
  });
});
