/**
 * The daily report through the `post-voucher` handler (ADR-0023): the add-on's sign-in asks for it without naming the company, and gets
 * the mail and the sheet rows — due items with their due dates and the customer's PO among them. A stranger gets nothing.
 */
import { PostgresBackend, createPostingHandler } from '@minimalerp/adapter-postgres';
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;
const bot = randomUUID();

const call = async (body: unknown, user: string) => {
  const h = createPostingHandler({
    authenticate: async (req) => {
      const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
      return m?.[1] ? { userId: m[1] } : undefined;
    },
    gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
  });
  const res = await h(new Request('http://localhost/functions/v1/post-voucher', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${user}` }, body: JSON.stringify(body) }));
  return (await res.json()) as { ok: boolean; value?: { subject: string; html: string; sheetRows: unknown[][]; dueItemRows: string[][] }; issues?: { code: string }[] };
};

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', w.uuid('item:bolt'), { name: 'Hex Bolt M8', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
  mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: {
        id: w.uuid('v:so'), voucherTypeId: w.uuid('type:salesOrder'), date: '2024-06-01', partyId: w.uuid('party:acme'),
        partyDetails: { partyId: w.uuid('party:acme'), mailingName: 'Acme Ltd' }, reference: 'ACME/PO/42',
        lines: [
          { id: 'a', itemId: w.uuid('item:bolt'), qty: '300', rate: '5', dueDate: '2024-06-05' },
          { id: 'b', itemId: w.uuid('item:bolt'), qty: '200', rate: '5', dueDate: '2024-06-13' },
        ],
      },
    }),
  );
  await addMember(db.pool, w.companyId, bot, 'automation');
});
afterAll(async () => {
  await db?.close();
});

describe('the daily report', () => {
  it('the add-on gets the mail and the rows for its company, with each due item, its due date and the customer PO', async () => {
    const r = await call({ action: 'digest', asOn: '2024-06-10' }, bot);
    expect(r.ok).toBe(true);
    expect(r.value?.subject).toContain('daily report 10-06-2024');
    expect(r.value?.subject).toContain('1 item late');
    expect(r.value?.html).toContain('ACME/PO/42');
    expect(r.value?.dueItemRows).toEqual([
      ['2024-06-10', '2024-06-05', 'ACME/PO/42', 'Acme Ltd', 'Hex Bolt M8', '300 Nos', expect.any(String), '5 days late'],
      ['2024-06-10', '2024-06-13', 'ACME/PO/42', 'Acme Ltd', 'Hex Bolt M8', '200 Nos', expect.any(String), 'due'],
    ]);
  });

  it('a stranger — signed in, member of nothing — is refused', async () => {
    const stranger = randomUUID();
    await db.pool.query(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `${stranger}@example.test`]);
    expect((await call({ action: 'digest' }, stranger)).issues?.[0]?.code).toBe('PERMISSION_DENIED');
    expect((await call({ action: 'digest', companyId: w.companyId }, stranger)).issues?.[0]?.code).toBe('PERMISSION_DENIED');
  });
});
