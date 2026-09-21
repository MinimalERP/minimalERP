/** The audit trail and revision history written by the posting functions. */
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import { IssueCode } from '@minimalerp/domain';
import { codesOf, journal, mustOk, payment } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgWorld, addMember, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let make: ReturnType<typeof pgWorldFactory>;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  make = pgWorldFactory(db);
});
afterAll(async () => {
  await db?.close();
});

const auditOf = async (w: PgWorld) =>
  (await db.pool.query(`select action, actor, entity_type, entity_id, before, after, request_id from public.audit_log where company_id = $1 order by id`, [w.companyId])).rows;

const pay = (w: PgWorld, id: string, amount = '10', date = '2024-05-10') =>
  payment(w, { id, date, account: w.ledgers.bank, lines: [[w.ledgers.rent, amount]] });

const service = (w: PgWorld, requestId?: string, actorId = w.ownerId) =>
  new PostgresBackend(db.pool, { actorId, ...(requestId ? { requestId } : {}) });

describe('audit log', () => {
  it('records who posted what, when, under which request', async () => {
    const w = await make();
    const out = mustOk(await service(w, 'req-123').post({ companyId: w.companyId, draft: pay(w, 'p1').voucher }));

    const [row, ...rest] = await auditOf(w);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      action: 'voucher.post',
      actor: w.ownerId,
      entity_type: 'voucher',
      entity_id: out.voucher.id,
      request_id: 'req-123',
      before: null,
    });
    expect(row?.after).toMatchObject({ number: 'PAY/24-25/0001', date: '2024-05-10', version: 1 });
  });

  it('attributes actions to the actual user, and stamps the voucher’s creator', async () => {
    const w = await make();
    const clerk = randomUUID();
    await addMember(db.pool, w.companyId, clerk, 'clerk');
    const out = mustOk(await service(w, undefined, clerk).post({ companyId: w.companyId, draft: pay(w, 'p1').voucher }));

    expect((await auditOf(w))[0]?.actor).toBe(clerk);
    const v = await db.pool.query('select created_by from public.vouchers where id = $1', [out.voucher.id]);
    expect(v.rows[0]?.created_by).toBe(clerk);
  });

  it('records alteration with before and after, and snapshots the previous version', async () => {
    const w = await make();
    const be = service(w, 'req-alter');
    const first = mustOk(await be.post({ companyId: w.companyId, draft: pay(w, 'p1', '10').voucher }));
    mustOk(await be.alter({ companyId: w.companyId, voucherId: first.voucher.id, expectedVersion: 1, draft: pay(w, 'p1', '25', '2024-05-12').voucher }));

    const rows = await auditOf(w);
    expect(rows.map((r) => r.action)).toEqual(['voucher.post', 'voucher.alter']);
    expect(rows[1]?.before).toMatchObject({ date: '2024-05-10', version: 1 });
    expect(rows[1]?.after).toMatchObject({ date: '2024-05-12', version: 2 });
    expect(rows[1]?.request_id).toBe('req-alter');

    const [rev, ...more] = await be.revisionsOf(w.companyId, first.voucher.id);
    expect(more).toEqual([]);
    expect(rev).toMatchObject({ reason: 'alter' });
    expect(rev?.voucher).toMatchObject({ version: 1, revision: 0, date: '2024-05-10' });
    expect(rev?.journal.map((l) => l.amount)).toEqual([1000n, 1000n]); // the ORIGINAL ₹10.00, preserved
  });

  it('keeps the full history across alterations and cancellation, oldest first', async () => {
    const w = await make();
    const be = service(w);
    const p = mustOk(await be.post({ companyId: w.companyId, draft: pay(w, 'p1', '1').voucher }));
    mustOk(await be.alter({ companyId: w.companyId, voucherId: p.voucher.id, expectedVersion: 1, draft: pay(w, 'p1', '2').voucher }));
    mustOk(await be.alter({ companyId: w.companyId, voucherId: p.voucher.id, expectedVersion: 2, draft: pay(w, 'p1', '3').voucher }));
    mustOk(await be.cancel({ companyId: w.companyId, voucherId: p.voucher.id, expectedVersion: 3 }));

    const history = await be.revisionsOf(w.companyId, p.voucher.id);
    expect(history.map((h) => [h.reason, h.voucher.version])).toEqual([['alter', 1], ['alter', 2], ['cancel', 3]]);
    expect(history.map((h) => h.journal[0]?.amount)).toEqual([100n, 200n, 300n]);
    expect((await auditOf(w)).map((r) => r.action)).toEqual(['voucher.post', 'voucher.alter', 'voucher.alter', 'voucher.cancel']);
  });

  it('writes nothing for refused operations or for idempotent replays', async () => {
    const w = await make();
    const be = service(w);
    const draft = pay(w, 'p1').voucher;
    mustOk(await be.post({ companyId: w.companyId, draft }));
    const n = (await auditOf(w)).length;

    mustOk(await be.post({ companyId: w.companyId, draft })); // replay
    expect(codesOf(await be.post({ companyId: w.companyId, draft: journal(w, { id: 'bad', date: '2024-05-10', entries: [[w.ledgers.rent, 'debit', '2'], [w.ledgers.creditor, 'credit', '1']] }).voucher }))).toContain(IssueCode.Unbalanced);
    expect(codesOf(await be.cancel({ companyId: w.companyId, voucherId: w.vid('missing'), expectedVersion: 1 }))).toEqual([IssueCode.VoucherNotFound]);

    expect((await auditOf(w)).length).toBe(n);
  });

  it('is invisible across companies: company B’s log never contains company A’s activity', async () => {
    const [a, b] = [await make(), await make()];
    mustOk(await service(a).post({ companyId: a.companyId, draft: pay(a, 'p1').voucher }));
    expect(await auditOf(b)).toEqual([]);
  });
});

describe('amounts survive the whole round trip exactly', () => {
  it('a value above 2^53 minor units is stored, journalled and returned to the paisa', async () => {
    const w = await make();
    const big = '9007199254740993.01'; // 900,719,925,474,099,301 paise — a JS number would round this
    const out = mustOk(
      await service(w).post({ companyId: w.companyId, draft: payment(w, { id: 'big', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, big]] }).voucher }),
    );
    expect(out.plan.journal.map((l) => l.amount)).toEqual([900719925474099301n, 900719925474099301n]);
    const stored = await db.pool.query(`select debit::text d, credit::text c from public.journal_lines where voucher_id = $1 order by line_no`, [out.voucher.id]);
    expect(stored.rows.map((r) => r.d)).toEqual([big, '0.00']);
    expect((await w.backend.lines({ companyId: w.companyId })).map((l) => l.amount)).toEqual([900719925474099301n, 900719925474099301n]);
  });

  it('a value beyond the column’s capacity is refused, never silently truncated', async () => {
    const w = await make();
    const tooBig = '99999999999999999.99'; // 10^17: exceeds numeric(18,2)
    const r = await service(w).post({ companyId: w.companyId, draft: payment(w, { id: 'huge', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, tooBig]] }).voucher });
    expect(codesOf(r)).toContain(IssueCode.AmountTooLarge); // a clean refusal — not a database error
    expect(await w.backend.list(w.companyId)).toEqual([]);
  });
});
