/**
 * One-time (written) invoice lines through the real posting path: the bill the database mirrors includes them, and no stock row is written
 * for them.
 */
import { mustOk } from '@minimalerp/testkit';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
  await create('party', w.uuid('party:steel'), { name: 'Steel Supplier', roles: ['vendor'] });
  await create('ledger', w.uuid('ledger:sales'), { name: 'Sales', groupId: w.uuid('group:sales-accounts') });
  await create('ledger', w.uuid('ledger:purchases'), { name: 'Purchases', groupId: w.uuid('group:purchase-accounts') });
});
afterAll(async () => {
  await db?.close();
});

const rows = async (sql: string, v: unknown[]) => (await db.pool.query(sql, v)).rows;

describe('a written line on an invoice, posted', () => {
  it('a sales invoice of written lines only: the customer owes the total, nothing leaves stock', async () => {
    const posted = mustOk(
      await w.backend.post({
        companyId: w.companyId,
        draft: {
          id: w.uuid('v:inv'), voucherTypeId: w.uuid('type:sales'), date: '2024-05-10', partyId: w.uuid('party:acme'),
          partyDetails: { partyId: w.uuid('party:acme'), mailingName: 'Acme Ltd' }, salesLedgerId: w.uuid('ledger:sales'), dueDate: '2024-06-09',
          lines: [
            { description: 'Machining charges – job 44', unit: 'Nos', qty: '2', rate: '2500' },
            { description: 'Packing', qty: '1', rate: '150.50' },
          ],
        },
      }),
    );
    expect(await rows(`select side, kind, amount::text as amount from public.bill_allocations where voucher_id = $1`, [posted.voucher.id])).toEqual([{ side: 'debit', kind: 'new', amount: '5150.50' }]);
    expect(await rows(`select count(*)::int as n from public.stock_movements where voucher_id = $1`, [posted.voucher.id])).toEqual([{ n: 0 }]);
    // and it reads back as written
    const back = await w.backend.get(w.companyId, posted.voucher.id);
    expect((back?.content as unknown as { lines: { description?: string; unit?: string }[] }).lines[0]).toMatchObject({ description: 'Machining charges – job 44', unit: 'Nos' });
  });

  it("a purchase invoice with a written line raises the supplier's bill", async () => {
    const posted = mustOk(
      await w.backend.post({
        companyId: w.companyId,
        draft: {
          id: w.uuid('v:pur'), voucherTypeId: w.uuid('type:purchase'), date: '2024-05-12', partyId: w.uuid('party:steel'),
          partyDetails: { partyId: w.uuid('party:steel'), mailingName: 'Steel Supplier' }, purchaseLedgerId: w.uuid('ledger:purchases'), billNo: 'FRT-9', dueDate: '2024-06-11',
          lines: [{ description: 'Freight to Chakan', qty: '1', rate: '1200' }],
        },
      }),
    );
    expect(await rows(`select side, kind, ref, amount::text as amount from public.bill_allocations where voucher_id = $1`, [posted.voucher.id])).toEqual([{ side: 'credit', kind: 'new', ref: 'FRT-9', amount: '1200.00' }]);
    expect(await rows(`select count(*)::int as n from public.stock_movements where voucher_id = $1`, [posted.voucher.id])).toEqual([{ n: 0 }]);
  });
});
