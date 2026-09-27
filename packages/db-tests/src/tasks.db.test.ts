/**
 * The Gateway's tasks in the database: kept per company and read only by its members, changed by those with task.write (a viewer may
 * not), a new one for whoever adds it, a status only of its kind, notes dated and signed — and disposable: deleted at will, a closed one
 * gone a week after it closed, nothing in the audit log.
 */
import { PostgresBackend } from '@minimalerp/adapter-postgres';
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
const clerk = randomUUID();

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgMasterWorldFactory(db);
  a = await make();
  b = await make();
  await addMember(db.pool, a.companyId, viewer, 'viewer');
  await addMember(db.pool, a.companyId, clerk, 'clerk');
});
afterAll(async () => {
  await db?.close();
});

describe('tasks', () => {
  const id = randomUUID();
  const enquiry = randomUUID();

  it('a new task is for whoever adds it; people are the company’s own', async () => {
    const list = mustOk(await a.backend.applyTask(a.companyId, { op: 'create', id, kind: 'task', title: 'Call Kumar', dueDate: '2024-06-01' }));
    expect(list.tasks).toEqual([expect.objectContaining({ id, status: 'open', assignee: a.ownerId, dueDate: '2024-06-01', source: 'typed' })]);
    expect(list.people.map((p) => p.role)).toEqual(expect.arrayContaining(['owner', 'viewer', 'clerk']));
    const bs = mustOk(await b.backend.tasks(b.companyId));
    expect(bs.tasks).toHaveLength(0);
  });

  it('an enquiry: a status only of its kind, dated notes, closing stamps when; nothing goes to the audit log', async () => {
    mustOk(await a.backend.applyTask(a.companyId, { op: 'create', id: enquiry, kind: 'enquiry', title: 'Honeywell 14188', note: 'drawing received' }));
    expect((await a.backend.applyTask(a.companyId, { op: 'update', id: enquiry, status: 'done' })).ok).toBe(false);
    mustOk(await a.backend.applyTask(a.companyId, { op: 'note', id: enquiry, text: 'quote sent' }));
    const won = mustOk(await a.backend.applyTask(a.companyId, { op: 'update', id: enquiry, status: 'won' }));
    const e = won.tasks.find((t) => t.id === enquiry);
    expect(e?.status).toBe('won');
    expect(e?.doneAt).toBeTruthy();
    expect(e?.notes.map((n) => n.text)).toEqual(['drawing received', 'quote sent']);
    const audit = await db.pool.query(`select action from public.audit_log where entity_id = $1 order by id`, [enquiry]);
    expect(audit.rows).toHaveLength(0);
  });

  it('a clerk may keep tasks, a viewer only read them; a task is for someone of this company', async () => {
    const asClerk = new PostgresBackend(db.pool, { actorId: clerk });
    mustOk(await asClerk.applyTask(a.companyId, { op: 'note', id, text: 'rang, no answer' }));
    const asViewer = new PostgresBackend(db.pool, { actorId: viewer });
    expect(mustOk(await asViewer.tasks(a.companyId)).tasks.length).toBe(2);
    expect((await asViewer.applyTask(a.companyId, { op: 'note', id, text: 'x' })).ok).toBe(false);
    expect((await a.backend.applyTask(a.companyId, { op: 'update', id, assignee: b.ownerId })).ok).toBe(false);
  });

  it('members read their company’s tasks, nobody else’s', async () => {
    const seen = (user: string) => db.asRole('authenticated', user, async (c) => Number((await c.query(`select count(*)::int n from public.tasks where company_id = '${a.companyId}'`)).rows[0].n));
    expect(await seen(a.ownerId)).toBe(2);
    expect(await seen(b.ownerId)).toBe(0);
  });

  it('disposable: a task is deleted at will, and one closed over a week ago is gone the next time the list is read', async () => {
    const gone = randomUUID();
    mustOk(await a.backend.applyTask(a.companyId, { op: 'create', id: gone, kind: 'task', title: 'Throw away' }));
    expect(mustOk(await a.backend.applyTask(a.companyId, { op: 'delete', id: gone })).tasks.some((t) => t.id === gone)).toBe(false);
    await db.pool.query(`update public.tasks set done_at = now() - interval '8 days' where id = $1`, [enquiry]);
    expect(mustOk(await a.backend.tasks(a.companyId)).tasks.some((t) => t.id === enquiry)).toBe(false);
    expect((await db.pool.query(`select count(*)::int n from public.tasks where id = $1`, [enquiry])).rows[0]?.n).toBe(0);
  });
});
