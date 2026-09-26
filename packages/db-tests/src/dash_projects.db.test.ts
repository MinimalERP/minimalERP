/**
 * minimalDASH projects (migration 20261014000100_dash_projects.sql): one DASH for the owner, across all their companies, and all of its
 * data disposable — nothing in the books refers to it, so deleting it never touches the books.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgWorld, addMember, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgWorld;
const member = randomUUID();
const bot = randomUUID();
const stranger = randomUUID();

type Row = Record<string, unknown>;
const apply = async (actor: string, op: string, payload: object): Promise<Row> =>
  (await db.pool.query(`select public.dash_project_apply($1, $2, $3) as row`, [actor, op, JSON.stringify(payload)])).rows[0].row as Row;
const refused = async (actor: string, op: string, payload: object): Promise<string> => {
  try {
    await apply(actor, op, payload);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
};
const seen = (userId: string) => db.asRole('authenticated', userId, async (c) => (await c.query('select name from public.dash_projects order by name')).rows.map((r) => r.name as string));

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgWorldFactory(db)();
  await addMember(db.pool, w.companyId, member, 'accountant');
  await addMember(db.pool, w.companyId, bot, 'automation');
  await db.pool.query(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `${stranger}@example.test`]);
});
afterAll(async () => {
  await db?.close();
});

describe('projects', () => {
  let id: string;

  it('the owner creates one, recurring or one-time, and sees only their own', async () => {
    const p = await apply(w.ownerId, 'project.create', { name: '  Honeywell monthly  ', kind: 'recurring' });
    id = p['id'] as string;
    expect(p).toMatchObject({ name: 'Honeywell monthly', kind: 'recurring', owner_id: w.ownerId });
    await apply(w.ownerId, 'project.create', { name: 'Fixture for Acme', kind: 'one_time' });
    expect(await seen(w.ownerId)).toEqual(['Fixture for Acme', 'Honeywell monthly']);
    expect(await seen(member)).toEqual([]);
  });

  it('renames, changes the kind, and refuses a name already used (whatever its case) or none', async () => {
    expect(await apply(w.ownerId, 'project.rename', { id, name: 'Honeywell – monthly parts' })).toMatchObject({ name: 'Honeywell – monthly parts' });
    expect(await apply(w.ownerId, 'project.kind', { id, kind: 'one_time' })).toMatchObject({ kind: 'one_time' });
    expect(await refused(w.ownerId, 'project.rename', { id, name: 'FIXTURE FOR ACME' })).toBe('UNSUPPORTED_OPERATION');
    expect(await refused(w.ownerId, 'project.create', { name: '   ', kind: 'recurring' })).toBe('SCHEMA_INVALID');
    expect(await refused(w.ownerId, 'project.create', { name: 'X', kind: 'weekly' })).toBe('SCHEMA_INVALID');
  });

  it('is the owner’s alone: a company’s other people, the Gmail add-on and strangers can do nothing', async () => {
    for (const who of [member, bot, stranger]) {
      expect(await refused(who, 'project.create', { name: 'Mine', kind: 'recurring' })).toBe('PERMISSION_DENIED');
      expect(await refused(who, 'project.delete', { id })).toBe('PERMISSION_DENIED');
    }
  });

  it('deletes, leaving the books exactly as they were', async () => {
    const books = async () => (await db.pool.query(`select (select count(*) from public.vouchers) + (select count(*) from public.ledgers) + (select count(*) from public.audit_log) as n`)).rows[0].n;
    const before = await books();
    expect(await apply(w.ownerId, 'project.delete', { id })).toEqual({ id, deleted: true });
    expect(await seen(w.ownerId)).toEqual(['Fixture for Acme']);
    expect(await books()).toBe(before);
    expect(await refused(w.ownerId, 'project.rename', { id, name: 'Back' })).toBe('MASTER_NOT_FOUND');
  });
});

describe('DASH data is disposable', () => {
  it('no table of the books refers to a dash_* table: any of it can be deleted without touching the books', async () => {
    const r = await db.pool.query(
      `select c.conrelid::regclass::text as from_table, c.confrelid::regclass::text as to_table
         from pg_constraint c
        where c.contype = 'f' and c.confrelid::regclass::text like 'dash\\_%' and c.conrelid::regclass::text not like 'dash\\_%'`,
    );
    expect(r.rows).toEqual([]);
  });

  it('every table that refers to a project goes with it (on delete cascade)', async () => {
    const r = await db.pool.query(
      `select c.conrelid::regclass::text as t from pg_constraint c
        where c.contype = 'f' and c.confrelid = 'public.dash_projects'::regclass and c.confdeltype <> 'c'`,
    );
    expect(r.rows).toEqual([]);
  });
});
