/**
 * Sending a voucher between the owner's companies (ADR-0025, step 3): "Send via ERP" puts it in the inbox of the company with the party's
 * GSTIN — only within the owner's own companies — matched against THAT company's masters; accepting posts it there and rejecting throws it
 * away, and the sender sees Sent / Accepted / Rejected.
 */
import { PostgresBackend, createPostingHandler } from '@minimalerp/adapter-postgres';
import { type CompanyId, IssueCode, gstinCheckChar } from '@minimalerp/domain';
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
const owner = randomUUID();
const stranger = randomUUID();
const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const MICRO = gstin('27AAACM1234C1Z');
const TOOLS = gstin('27AAACT5678D1Z');
const OUTSIDE = gstin('27AAACO9999E1Z');

const handler = createPostingHandler({
  authenticate: async (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
    return m?.[1] ? { userId: m[1] } : undefined;
  },
  gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
});
type Envelope<T = unknown> = { ok: true; value: T } | { ok: false; issues: { code: string; message: string }[] };
const call = async <T = unknown>(body: unknown, user = owner): Promise<Envelope<T>> => {
  const res = await handler(
    new Request('http://localhost/functions/v1/post-voucher', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${user}` },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as Envelope<T>;
};
const codes = (e: Envelope) => (e.ok ? [] : e.issues.map((i) => i.code));
const as = (user: string) => new PostgresBackend(db.pool, { actorId: user });

/** One of the owner's companies, with the other kept as a party by hand (by its GSTIN) and a bolt both call BLT-M8. */
async function company(name: string, own: string, other: { name: string; gstin: string }, user = owner) {
  const made = await call<{ companyId: string }>({ action: 'company-create', company: { name, fyStart: '2024-04-01', gstin: own } }, user);
  if (!made.ok) throw new Error(JSON.stringify(made.issues));
  const id = made.value.companyId as CompanyId;
  const b = as(user);
  const m = await b.load(id);
  const nos = m.units.find((u) => u.symbol === 'Nos')!.id;
  const ids = { company: id, party: randomUUID(), item: randomUUID(), bank: randomUUID() };
  const run = async (kind: string, rid: string, data: unknown) => mustOk(await b.execute({ companyId: id, command: { op: 'create', kind, id: rid, data } }));
  await run('party', ids.party, { name: other.name, roles: ['customer', 'vendor'], gstin: other.gstin });
  await run('stockItem', ids.item, { name: `${name} bolt`, code: 'BLT-M8', unitId: nos, itemType: 'finished', hsn: '7318' });
  const typeId = (base: string) => m.voucherTypes.find((t) => t.baseKind === base)!.id;
  return { ...ids, typeId, name };
}

let a: Awaited<ReturnType<typeof company>>;
let b: Awaited<ReturnType<typeof company>>;

const postPo = async (qty = '500') => {
  const r = await as(owner).post({
    companyId: a.company,
    draft: {
      id: randomUUID(),
      voucherTypeId: a.typeId('purchaseOrder'),
      date: '2024-06-01',
      partyId: a.party,
      partyDetails: { partyId: a.party, mailingName: 'Tools Division' },
      lines: [{ id: 'l1', itemId: a.item, qty, rate: '4.25', dueDate: '2024-06-20' }],
    },
  });
  return mustOk(r).voucher;
};
type Inbox = { items: { id: string; kind: string; mailFrom?: string; mailSubject?: string; proposal: { party: { partyId?: string }; reference?: string; lines: { itemId?: string; qty: string; rate: string; dueDate?: string }[] } }[] };
type Sent = { sent: { id: string; voucherId: string; number: string; toCompany: string; status: string; reason?: string; toNumber?: string }[] };

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  await db.pool.query(`insert into auth.users (id, email) values ($1, $2), ($3, $4)`, [owner, `${owner}@example.test`, stranger, `${stranger}@example.test`]);
  a = await company('Micro Components', MICRO, { name: 'Tools Division', gstin: TOOLS });
  b = await company('Tools Division', TOOLS, { name: 'Micro Components Pvt Ltd', gstin: MICRO });
  await company('Outsider Works', OUTSIDE, { name: 'Micro Components', gstin: MICRO }, stranger);
});
afterAll(async () => {
  await db?.close();
});

describe('Send via ERP', () => {
  let po: Awaited<ReturnType<typeof postPo>>;
  let inboxId: string;

  it('puts our purchase order in their inbox as a sales order, matched against their own books', async () => {
    po = await postPo();
    const sent = await call<{ id: string; toCompany: string; toKind: string }>({ action: 'exchange-send', companyId: a.company, voucherId: po.id });
    if (!sent.ok) throw new Error(JSON.stringify(sent.issues));
    expect(sent.value).toMatchObject({ toCompany: 'Tools Division', toKind: 'salesOrder' });
    inboxId = sent.value.id;

    const theirs = await call<Inbox>({ action: 'inbox', companyId: b.company });
    const item = theirs.ok ? theirs.value.items.find((i) => i.id === inboxId) : undefined;
    expect(item).toMatchObject({ kind: 'salesOrder', mailFrom: 'Micro Components · via ERP' });
    expect(item?.mailSubject).toContain(po.number);
    expect(item?.proposal.party.partyId).toBe(b.party); // their party with our GSTIN
    expect(item?.proposal.reference).toBe(po.number); // our PO is their customer PO
    expect(item?.proposal.lines).toMatchObject([{ itemId: b.item, qty: '500', rate: '4.25', dueDate: '2024-06-20' }]); // by the code they share
  });

  it('shows us Sent, and refuses to send the same voucher twice', async () => {
    const mine = await call<Sent>({ action: 'exchange-sent', companyId: a.company });
    expect(mine.ok && mine.value.sent.map((s) => [s.number, s.toCompany, s.status])).toEqual([[po.number, 'Tools Division', 'sent']]);
    expect(codes(await call({ action: 'exchange-send', companyId: a.company, voucherId: po.id }))).toEqual([IssueCode.ExchangeNotPossible]);
  });

  it('accepted there (posted under the inbox id), it is gone from their inbox and we see Accepted with their number', async () => {
    const order = mustOk(
      await as(owner).post({
        companyId: b.company,
        draft: {
          id: inboxId,
          voucherTypeId: b.typeId('salesOrder'),
          date: '2024-06-01',
          partyId: b.party,
          partyDetails: { partyId: b.party, mailingName: 'Micro Components Pvt Ltd' },
          reference: po.number,
          lines: [{ id: 'l1', itemId: b.item, qty: '500', rate: '4.25', dueDate: '2024-06-20' }],
        },
      }),
    ).voucher;
    const theirs = await call<Inbox>({ action: 'inbox', companyId: b.company });
    expect(theirs.ok && theirs.value.items.map((i) => i.id)).not.toContain(inboxId);
    const mine = await call<Sent>({ action: 'exchange-sent', companyId: a.company });
    expect(mine.ok && mine.value.sent[0]).toMatchObject({ status: 'accepted', toNumber: order.number });
  });

  it('rejected there, we see Rejected with their reason, and may send it again', async () => {
    const second = await postPo('20');
    const sent = await call<{ id: string }>({ action: 'exchange-send', companyId: a.company, voucherId: second.id });
    if (!sent.ok) throw new Error(JSON.stringify(sent.issues));
    expect((await call({ action: 'inbox-reject', companyId: b.company, id: sent.value.id, reason: 'Rate not agreed' })).ok).toBe(true);
    const mine = await call<Sent>({ action: 'exchange-sent', companyId: a.company });
    expect(mine.ok && mine.value.sent.find((s) => s.voucherId === second.id)).toMatchObject({ status: 'rejected', reason: 'Rate not agreed' });
    expect((await call({ action: 'exchange-send', companyId: a.company, voucherId: second.id })).ok).toBe(true);
  });
});

describe('only within the owner’s companies', () => {
  it('never to a company outside the group, even with the party’s GSTIN', async () => {
    const outsiderParty = randomUUID();
    mustOk(await as(owner).execute({ companyId: a.company, command: { op: 'create', kind: 'party', id: outsiderParty, data: { name: 'Outsider Works', roles: ['vendor'], gstin: OUTSIDE } } }));
    const po = mustOk(
      await as(owner).post({
        companyId: a.company,
        draft: {
          id: randomUUID(),
          voucherTypeId: a.typeId('purchaseOrder'),
          date: '2024-06-01',
          partyId: outsiderParty,
          partyDetails: { partyId: outsiderParty, mailingName: 'Outsider Works' },
          lines: [{ id: 'l1', itemId: a.item, qty: '1', rate: '1', dueDate: '2024-06-20' }],
        },
      }),
    ).voucher;
    const r = await call({ action: 'exchange-send', companyId: a.company, voucherId: po.id });
    expect(codes(r)).toEqual([IssueCode.ExchangeNotPossible]);
    expect(!r.ok && r.issues[0]?.message).toMatch(/None of your companies/);
  });

  it('the sending is refused to someone outside the sending company, and its record is invisible to them', async () => {
    const po = await postPo('3');
    expect(codes(await call({ action: 'exchange-send', companyId: a.company, voucherId: po.id }, stranger))).toEqual([IssueCode.PermissionDenied]);
    expect(codes(await call({ action: 'exchange-sent', companyId: a.company }, stranger))).toEqual([IssueCode.PermissionDenied]);
    const seen = await db.asRole('authenticated', stranger, async (c) => (await c.query('select id from public.exchange_documents')).rows.length);
    expect(seen).toBe(0);
    const ownerSees = await db.asRole('authenticated', owner, async (c) => (await c.query('select id from public.exchange_documents')).rows.length);
    expect(ownerSees).toBeGreaterThan(0);
  });
});
