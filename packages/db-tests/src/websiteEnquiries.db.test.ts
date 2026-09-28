/**
 * The website's quote enquiries in the database: the public form (anon) may only add a new one; the people of the company the website
 * belongs to read them, a viewer only reads, anyone who keeps tasks moves the status, turns one into a Gateway enquiry, or deletes it.
 * Another company sees none of it.
 */
import { PostgresBackend } from '@minimalerp/adapter-postgres';
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let a: PgMasterWorld; // the website's company
let b: PgMasterWorld;
const viewer = randomUUID();

const insertSql = (row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return [`insert into public.website_enquiries (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row)] as const;
};
/** What the website's form does: an insert as anon, asking nothing back (the harness rolls it back, so the row is then kept as the server). */
const submit = async (row: Record<string, unknown>) => {
  const [sql, values] = insertSql(row);
  const n = await db.asRole('anon', null, async (c) => (await c.query(sql, values)).rowCount);
  expect(n).toBe(1);
  await db.pool.query(sql, values);
};

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgMasterWorldFactory(db);
  a = await make();
  b = await make();
  await addMember(db.pool, a.companyId, viewer, 'viewer');
  await db.pool.query('insert into public.website_enquiry_company (company_id) values ($1)', [a.companyId]);
});
afterAll(async () => {
  await db?.close();
});

describe('website enquiries', () => {
  it('the form may add a new enquiry, and nothing else', async () => {
    await submit({ name: 'Ravi', phone: '98765 43210', email: 'ravi@x.in', requirement: 'M12 × 50 SS 316, 1,000 sets', source: 'capability:fasteners/bolts', context: 'Hex bolts', attachment_path: '1-abc-drawing.pdf' });
    await submit({ name: 'Asha', phone: '9123456780', email: 'asha@y.in', requirement: 'CNC turned bush' });
    const denied = (sql: string) => db.asRole('anon', null, async (c) => c.query(sql)).then(() => undefined, (e: { code?: string }) => e.code);
    expect(await denied(`insert into public.website_enquiries (name, phone, email, requirement, status) values ('x', '1', 'x', 'x', 'won')`)).toBe('42501');
    expect(await denied('select 1 from public.website_enquiries')).toBe('42501');
    expect(await denied(`update public.website_enquiries set status = 'lost'`)).toBe('42501');
    expect(await denied('delete from public.website_enquiries')).toBe('42501');
    expect(await denied('truncate public.website_enquiries')).toBe('42501');
  });

  it('the website’s company reads them newest first; another company has none', async () => {
    const list = mustOk(await a.backend.websiteEnquiries(a.companyId));
    expect(list.site).toBe(true);
    expect(list.enquiries.map((e) => e.name)).toEqual(['Asha', 'Ravi']);
    expect(list.enquiries[1]).toMatchObject({ status: 'new', drawing: '1-abc-drawing.pdf', context: 'Hex bolts', source: 'capability:fasteners/bolts' });
    expect(mustOk(await b.backend.websiteEnquiries(b.companyId))).toEqual({ site: false, enquiries: [] });
    expect((await b.backend.websiteDrawing(b.companyId, list.enquiries[1]!.id)).ok).toBe(false);
    const seen = (user: string) => db.asRole('authenticated', user, async (c) => Number((await c.query('select count(*)::int n from public.website_enquiries')).rows[0].n));
    expect(await seen(a.ownerId)).toBe(2);
    expect(await seen(viewer)).toBe(2);
    expect(await seen(b.ownerId)).toBe(0);
  });

  it('a status, a Gateway enquiry made from one (once), and a viewer may only read', async () => {
    const ravi = mustOk(await a.backend.websiteEnquiries(a.companyId)).enquiries.find((e) => e.name === 'Ravi')!;
    expect(mustOk(await a.backend.websiteDrawing(a.companyId, ravi.id))).toBe('1-abc-drawing.pdf');
    const after = mustOk(await a.backend.applyWebsiteEnquiry(a.companyId, { op: 'status', id: ravi.id, status: 'contacted' }));
    expect(after.enquiries.find((e) => e.id === ravi.id)?.status).toBe('contacted');

    const converted = mustOk(await a.backend.applyWebsiteEnquiry(a.companyId, { op: 'convert', id: ravi.id }));
    const taskId = converted.enquiries.find((e) => e.id === ravi.id)?.taskId;
    const task = mustOk(await a.backend.tasks(a.companyId)).tasks.find((t) => t.id === taskId);
    expect(task).toMatchObject({ kind: 'enquiry', status: 'new', source: 'website', title: 'Ravi: Hex bolts', assignee: a.ownerId });
    expect(task?.notes[0]?.text).toBe('M12 × 50 SS 316, 1,000 sets · Phone 98765 43210 · ravi@x.in · drawing attached');
    expect((await a.backend.applyWebsiteEnquiry(a.companyId, { op: 'convert', id: ravi.id })).ok).toBe(false);

    const asViewer = new PostgresBackend(db.pool, { actorId: viewer });
    expect((await asViewer.applyWebsiteEnquiry(a.companyId, { op: 'status', id: ravi.id, status: 'won' })).ok).toBe(false);
    expect((await b.backend.applyWebsiteEnquiry(b.companyId, { op: 'status', id: ravi.id, status: 'won' })).ok).toBe(false);
  });

  it('deleting erases it from the database; its Gateway enquiry stays', async () => {
    const ravi = mustOk(await a.backend.websiteEnquiries(a.companyId)).enquiries.find((e) => e.name === 'Ravi')!;
    const left = mustOk(await a.backend.applyWebsiteEnquiry(a.companyId, { op: 'delete', id: ravi.id }));
    expect(left.enquiries.map((e) => e.name)).toEqual(['Asha']);
    expect((await db.pool.query('select count(*)::int n from public.website_enquiries where id = $1', [ravi.id])).rows[0].n).toBe(0);
    expect(mustOk(await a.backend.tasks(a.companyId)).tasks.some((t) => t.id === ravi.taskId)).toBe(true);
  });
});
