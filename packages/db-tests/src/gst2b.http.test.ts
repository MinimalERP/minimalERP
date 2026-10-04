/**
 * The "GST matched" tag of a purchase voucher (`gst-match` / `gst-matches` on the post-voucher function): an audit line per purchase found in
 * a GSTR-2B period — only posted purchase vouchers of that company, only by someone who may post, and read back as voucher → period.
 */
import { createPostingHandler, PostgresBackend } from '@minimalerp/adapter-postgres';
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;
let purchaseId: string;
let orderId: string;
const outsider = randomUUID();

const authenticate = async (req: Request) => {
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
  return m?.[1] ? { userId: m[1] } : undefined;
};
const ask = async (userId: string, body: Record<string, unknown>) => {
  const handler = createPostingHandler({ authenticate, gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }) });
  const res = await handler(
    new Request('http://localhost/functions/v1/post-voucher', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userId}` },
      body: JSON.stringify({ companyId: w.companyId, ...body }),
    }),
  );
  return (await res.json()) as { ok: boolean; value?: { tagged?: number; matches?: Record<string, string> }; issues?: { code: string }[] };
};

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
  await db.pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [outsider, `${outsider}@example.test`]);
  const create = async (kind: string, id: string, data: unknown) => mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('party', w.uuid('party:steel'), { name: 'Steel Supplier', roles: ['vendor'] });
  await create('ledger', w.uuid('ledger:purchases'), { name: 'Purchases', groupId: w.uuid('group:purchase-accounts') });
  const main = (await w.backend.load(w.companyId)).warehouses[0]?.id as string;
  const who = { partyId: w.uuid('party:steel'), partyDetails: { partyId: w.uuid('party:steel'), mailingName: 'Steel Supplier' } };
  purchaseId = randomUUID();
  orderId = randomUUID();
  mustOk(await w.backend.post({ companyId: w.companyId, draft: { id: orderId, voucherTypeId: w.uuid('type:purchaseOrder'), date: '2024-05-01', ...who, lines: [{ id: 'a', itemId: w.uuid('item:bolt'), qty: '100', rate: '10', dueDate: '2024-05-20' }] } }));
  mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: { id: purchaseId, voucherTypeId: w.uuid('type:purchase'), date: '2024-05-12', ...who, purchaseLedgerId: w.uuid('ledger:purchases'), billNo: 'SS/889', dueDate: '2024-06-11', lines: [{ itemId: w.uuid('item:bolt'), warehouseId: main, qty: '60', rate: '10' }] },
    }),
  );
});
afterAll(async () => {
  await db?.close();
});

describe('tagging purchases “GST matched”', () => {
  it('tags the posted purchase vouchers in the list and nothing else, and reads the tags back by voucher', async () => {
    expect((await ask(w.ownerId, { action: 'gst-matches' })).value).toEqual({ matches: {} });
    // the order is not a purchase invoice; the random id is no voucher of this company
    const r = await ask(w.ownerId, { action: 'gst-match', period: '052024', voucherIds: [purchaseId, orderId, randomUUID()] });
    expect(r).toEqual({ ok: true, value: { tagged: 1 } });
    expect((await ask(w.ownerId, { action: 'gst-matches' })).value).toEqual({ matches: { [purchaseId]: '052024' } });
    const audit = await db.pool.query(`select after from public.audit_log where entity_id = $1 and action = 'voucher.gstMatched'`, [purchaseId]);
    expect(audit.rows.map((x) => x['after'])).toEqual([{ period: '052024' }]);
  });

  it('a later tag is the one shown', async () => {
    expect((await ask(w.ownerId, { action: 'gst-match', period: '062024', voucherIds: [purchaseId] })).value).toEqual({ tagged: 1 });
    expect((await ask(w.ownerId, { action: 'gst-matches' })).value).toEqual({ matches: { [purchaseId]: '062024' } });
  });

  it('someone outside the company can neither tag nor read; a period that is not MMYYYY is refused', async () => {
    const tag = await ask(outsider, { action: 'gst-match', period: '052024', voucherIds: [purchaseId] });
    expect(tag.ok).toBe(false);
    expect(tag.issues?.[0]?.code).toBe('PERMISSION_DENIED');
    expect((await ask(outsider, { action: 'gst-matches' })).ok).toBe(false);
    expect((await ask(w.ownerId, { action: 'gst-match', period: 'June', voucherIds: [purchaseId] })).ok).toBe(false);
  });
});
