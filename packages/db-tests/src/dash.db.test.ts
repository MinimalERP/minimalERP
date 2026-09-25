/**
 * minimalDASH in the ERP's database (migration 20261009000100_dash.sql):
 *   - every change goes through dash_apply, which checks dash.edit: a viewer and a non-member can change nothing
 *   - the Gmail add-on (automation) may file mails and readings
 *   - a mail thread is one job, a mail filed again refreshes its entry, a drawing number is one part (whatever its case)
 *   - members read their company's jobs through RLS, never another company's
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;
let other: PgMasterWorld;
const bot = randomUUID();
const viewer = randomUUID();
const outsider = randomUUID();

type Row = Record<string, unknown>;

async function apply(actor: string, op: string, payload: object, company = w.companyId): Promise<Row> {
  const r = await db.pool.query(`select public.dash_apply($1, $2, $3, $4) as row`, [actor, company, op, JSON.stringify(payload)]);
  return r.rows[0].row as Row;
}

/** The raise_issue code of a refused change. */
async function refused(actor: string, op: string, payload: object, company = w.companyId): Promise<string> {
  try {
    await apply(actor, op, payload, company);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
}

const visible = (userId: string, table: string, companyId: string) =>
  db.asRole('authenticated', userId, async (c) =>
    Number((await c.query(`select count(*)::int as n from public.${table} where company_id = $1`, [companyId])).rows[0].n),
  );

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgMasterWorldFactory(db);
  w = await make();
  other = await make();
  await addMember(db.pool, w.companyId, bot, 'automation');
  await addMember(db.pool, w.companyId, viewer, 'viewer');
  await db.pool.query(`insert into auth.users (id, email) values ($1, 'outsider@example.test')`, [outsider]);
});
afterAll(async () => {
  await db?.close();
});

describe('who may change what', () => {
  it('the owner and the add-on make jobs; a viewer and a non-member are refused', async () => {
    expect((await apply(w.ownerId, 'job.create', { title: 'Fuel BF localization', customer: 'Honeywell' }))['title']).toBe('Fuel BF localization');
    expect((await apply(bot, 'job.create', { title: 'From Gmail' }))['created_by']).toBe(bot);
    expect(await refused(viewer, 'job.create', { title: 'x' })).toBe('PERMISSION_DENIED');
    expect(await refused(outsider, 'job.create', { title: 'x' })).toBe('PERMISSION_DENIED');
  });

  it('a member of one company cannot touch another company', async () => {
    expect(await refused(w.ownerId, 'job.create', { title: 'x' }, other.companyId)).toBe('PERMISSION_DENIED');
    const theirs = await apply(other.ownerId, 'job.create', { title: 'Theirs' }, other.companyId);
    expect(await refused(w.ownerId, 'job.update', { id: theirs['id'], title: 'Mine now' })).toBe('NOT_FOUND');
  });

  it('an unknown operation is refused', async () => {
    expect(await refused(w.ownerId, 'job.delete', {})).toBe('UNSUPPORTED_OPERATION');
  });
});

describe('jobs, mails and parts', () => {
  it('a Gmail conversation is one job: "New job" pressed twice gives the same job', async () => {
    const a = await apply(bot, 'job.create', { title: 'Bushes', gmail_thread_id: 'thread-1' });
    const b = await apply(bot, 'job.create', { title: 'Bushes again', gmail_thread_id: 'thread-1' });
    expect(b['id']).toBe(a['id']);
    expect(b['title']).toBe('Bushes');
  });

  it('job.update changes only the fields given; a due date can be cleared', async () => {
    const job = await apply(w.ownerId, 'job.create', { title: 'Shafts', customer: 'Acme' });
    await apply(w.ownerId, 'job.update', { id: job['id'], due_date: '2026-10-10', whose_move: 'vendor' });
    const changed = await apply(w.ownerId, 'job.update', { id: job['id'], due_date: null });
    expect(changed).toMatchObject({ title: 'Shafts', customer: 'Acme', whose_move: 'vendor', due_date: null });
  });

  it('the same mail filed twice in a job refreshes its entry instead of doubling it', async () => {
    const job = await apply(bot, 'job.create', { title: 'Covers' });
    const mail = { job_id: job['id'], who: 'customer', summary: 'RFQ', gmail_message_id: 'msg-1@example', body: 'first' };
    const first = await apply(bot, 'event.add', mail);
    const again = await apply(bot, 'event.add', { ...mail, body: 'with files', file_links: [{ name: 'a.pdf', url: 'https://drive/a' }] });
    expect(again['id']).toBe(first['id']);
    expect(again).toMatchObject({ body: 'with files', summary: 'RFQ', file_links: [{ name: 'a.pdf', url: 'https://drive/a' }] });
    const n = await db.pool.query(`select count(*)::int as n from public.dash_events where job_id = $1`, [job['id']]);
    expect(n.rows[0].n).toBe(1);
  });

  it('a drawing number is one part however it is written; a new reading fills blanks and never empties a value', async () => {
    const job = await apply(bot, 'job.create', { title: 'Valve' });
    await apply(bot, 'part.save', { job_id: job['id'], drawing_no: 'mo-sh-024', name: 'Shaft', rev: '01', material: '12L14' });
    const p = await apply(bot, 'part.save', { job_id: job['id'], drawing_no: 'MO-SH-024', rev: '02', material: '', finish: 'Zinc' });
    expect(p).toMatchObject({ drawing_no: 'MO-SH-024', name: 'Shaft', rev: '02', material: '12L14', finish: 'Zinc' });
    const n = await db.pool.query(`select count(*)::int as n from public.dash_parts where job_id = $1`, [job['id']]);
    expect(n.rows[0].n).toBe(1);
  });

  it('an entry cannot be filed under another company’s job', async () => {
    const theirs = await apply(other.ownerId, 'job.create', { title: 'Theirs' }, other.companyId);
    await expect(apply(w.ownerId, 'event.add', { job_id: theirs['id'], who: 'note', summary: 'sneaky' })).rejects.toThrow(/foreign key/);
  });
});

describe('reading', () => {
  it('members read their own company’s jobs (a viewer too); nobody reads another company’s', async () => {
    expect(await visible(w.ownerId, 'dash_jobs', w.companyId)).toBeGreaterThan(0);
    expect(await visible(viewer, 'dash_events', w.companyId)).toBeGreaterThan(0);
    expect(await visible(w.ownerId, 'dash_jobs', other.companyId)).toBe(0);
    expect(await visible(outsider, 'dash_parts', w.companyId)).toBe(0);
  });
});
