/**
 * The AI Inbox in the database (ADR-0023):
 *   - the add-on's `automation` sign-in can put proposals in, and can post nothing and reject nothing
 *   - accepting = posting the completed voucher under the item's id; the item is gone in the same transaction, and a refused post leaves it
 *   - rejecting deletes the item and leaves one short audit line (who, kind, mail subject) — not the proposal
 *   - only the proposal and one line of the mail are kept; members of another company see none of it
 */
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import { IssueCode, type Proposal } from '@minimalerp/domain';
import { codesOf, mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;
let other: PgMasterWorld;
const bot = randomUUID();
const clerk = randomUUID();

const as = (actorId: string) => new PostgresBackend(db.pool, { actorId });
const count = async (sql: string, values: unknown[] = []) => Number((await db.pool.query(sql, values)).rows[0]?.n);

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  kind: 'salesOrder',
  date: '2024-05-10',
  party: { partyId: w.uuid('party:acme'), name: 'Acme Ltd' },
  reference: 'PO-7781',
  lines: [
    { itemId: w.uuid('item:bolt'), text: 'Hex bolt M8', qty: '100', rate: '4.5', dueDate: '2024-05-31' },
    { text: 'SS washer M8 as per DRG-221', qty: '1000', rate: '1.2', dueDate: '2024-05-31' },
  ],
  bills: [],
  notes: [{ code: 'ITEM_UNMATCHED', message: '"SS washer M8 as per DRG-221" is not one of your items', path: 'lines.1.item' }],
  ...over,
});

const submit = (actor: string, over: Partial<Proposal> = {}, id = randomUUID()) =>
  as(actor).submitInbox({ companyId: w.companyId, id, proposal: proposal(over), mailSubject: 'PO 7781 – bolts', mailFrom: 'purchase@acme.example' });

/** The voucher a person makes of the proposal: the unmatched line now has an item. */
const accepted = (id: string) => ({
  id,
  voucherTypeId: w.uuid('type:salesOrder'),
  date: '2024-05-10',
  partyId: w.uuid('party:acme'),
  partyDetails: { partyId: w.uuid('party:acme'), mailingName: 'Acme Ltd' },
  reference: 'PO-7781',
  lines: [
    { id: 'a', itemId: w.uuid('item:bolt'), qty: '100', rate: '4.5', dueDate: '2024-05-31' },
    { id: 'b', itemId: w.uuid('item:washer'), qty: '1000', rate: '1.2', dueDate: '2024-05-31' },
  ],
});

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgMasterWorldFactory(db);
  w = await make();
  other = await make();
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', w.uuid('item:bolt'), { name: 'Hex Bolt M8', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('stockItem', w.uuid('item:washer'), { name: 'SS Washer M8', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
  await addMember(db.pool, w.companyId, bot, 'automation');
  await addMember(db.pool, w.companyId, clerk, 'clerk');
});
afterAll(async () => {
  await db?.close();
});

describe('submitting', () => {
  it('the automation sign-in puts a proposal in; the owner sees it exactly as it was sent', async () => {
    const id = randomUUID();
    mustOk(await submit(bot, {}, id));
    const items = mustOk(await w.backend.inbox(w.companyId));
    const item = items.find((i) => i.id === id);
    expect(item).toMatchObject({ id, kind: 'salesOrder', mailSubject: 'PO 7781 – bolts', mailFrom: 'purchase@acme.example' });
    expect(item?.proposal).toEqual(proposal());
  });

  it('the same id twice is one submission (a retry from the add-on)', async () => {
    const id = randomUUID();
    mustOk(await submit(bot, {}, id));
    mustOk(await submit(bot, {}, id));
    expect(await count('select count(*)::int as n from public.inbox_items where id = $1', [id])).toBe(1);
  });

  it('keeps only the proposal and one line of the mail: no document, no raw reading', async () => {
    const cols = (await db.pool.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'inbox_items' order by ordinal_position`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(['id', 'company_id', 'kind', 'proposal', 'mail_subject', 'mail_from', 'created_by', 'created_at']);
  });

  it('a clerk (who may not submit) and an outsider are refused', async () => {
    expect(codesOf(await submit(clerk))).toEqual([IssueCode.PermissionDenied]);
    expect(codesOf(await as(other.ownerId).submitInbox({ companyId: w.companyId, id: randomUUID(), proposal: proposal() }))).toEqual([IssueCode.PermissionDenied]);
  });

  it('a proposal that is not in the expected shape is refused before the database', async () => {
    expect(codesOf(await as(bot).submitInbox({ companyId: w.companyId, id: randomUUID(), proposal: { kind: 'journal' } as never }))).toEqual([IssueCode.SchemaInvalid]);
  });
});

describe('the automation sign-in posts nothing', () => {
  it('cannot post the voucher, nor reject the proposal', async () => {
    const id = randomUUID();
    mustOk(await submit(bot, {}, id));
    expect(codesOf(await as(bot).post({ companyId: w.companyId, draft: accepted(id) }))).toEqual([IssueCode.PermissionDenied]);
    expect(codesOf(await as(bot).rejectInbox(w.companyId, id))).toEqual([IssueCode.PermissionDenied]);
    expect(await count('select count(*)::int as n from public.inbox_items where id = $1', [id])).toBe(1);
  });
});

describe('accepting', () => {
  it('posts the completed voucher under the item id, and the item is gone', async () => {
    const id = randomUUID();
    mustOk(await submit(bot, {}, id));
    const posted = mustOk(await w.backend.post({ companyId: w.companyId, draft: accepted(id) }));
    expect(posted.voucher.id).toBe(id);
    expect(await count('select count(*)::int as n from public.inbox_items where id = $1', [id])).toBe(0);
    // accepting twice posts once
    expect(mustOk(await w.backend.post({ companyId: w.companyId, draft: accepted(id) })).replayed).toBe(true);
  });

  it('a refused post leaves the proposal waiting', async () => {
    const id = randomUUID();
    mustOk(await submit(bot, {}, id));
    const bad = { ...accepted(id), lines: [{ id: 'a', itemId: w.uuid('item:bolt'), qty: '100', rate: '4.5', dueDate: '2024-01-01' }] };
    expect(codesOf(await w.backend.post({ companyId: w.companyId, draft: bad }))).toEqual([IssueCode.SalesDocInvalid]);
    expect(await count('select count(*)::int as n from public.inbox_items where id = $1', [id])).toBe(1);
  });
});

describe('rejecting', () => {
  it('deletes the proposal and leaves one short audit line: who, which kind, which mail — not the proposal', async () => {
    const id = randomUUID();
    mustOk(await submit(bot, {}, id));
    mustOk(await as(clerk).rejectInbox(w.companyId, id, 'duplicate of PO 7780'));
    expect(await count('select count(*)::int as n from public.inbox_items where id = $1', [id])).toBe(0);
    const audit = (await db.pool.query(`select actor, action, before, after from public.audit_log where entity_id = $1`, [id])).rows;
    expect(audit).toEqual([{ actor: clerk, action: 'inbox.reject', before: { kind: 'salesOrder', subject: 'PO 7781 – bolts' }, after: { reason: 'duplicate of PO 7780' } }]);
    // rejecting again is not an error: it is simply no longer there
    mustOk(await as(clerk).rejectInbox(w.companyId, id));
  });

  it('needs the permission to post that kind: a clerk may reject a proposed purchase (they may post one), a viewer may reject nothing', async () => {
    const id = randomUUID();
    mustOk(await submit(bot, { kind: 'purchase', billNo: 'SS/1', lines: [{ text: 'MS sheet', qty: '1', rate: '1' }] }, id));
    mustOk(await as(clerk).rejectInbox(w.companyId, id)); // a clerk may post purchases
    const viewer = randomUUID();
    await addMember(db.pool, w.companyId, viewer, 'viewer');
    const id2 = randomUUID();
    mustOk(await submit(bot, {}, id2));
    expect(codesOf(await as(viewer).rejectInbox(w.companyId, id2))).toEqual([IssueCode.PermissionDenied]);
  });
});

describe('who sees the inbox', () => {
  it('a member of another company sees none of it, through the server or directly', async () => {
    mustOk(await submit(bot));
    expect(codesOf(await as(other.ownerId).inbox(w.companyId))).toEqual([IssueCode.PermissionDenied]);
    const direct = await db.asRole('authenticated', other.ownerId, async (c) => (await c.query('select count(*)::int as n from public.inbox_items')).rows[0]?.n);
    expect(direct).toBe(0);
    const own = await db.asRole('authenticated', w.ownerId, async (c) => (await c.query('select count(*)::int as n from public.inbox_items')).rows[0]?.n);
    expect(own).toBeGreaterThan(0);
  });
});
