/**
 * MinimalCAD's rows in the database: a stock item's CAD files — any number per item, each with its own name, saved over by id, read by the
 * company's people and changed only by those who may change masters — and a person's own drawings with their one autosave slot. A browser
 * reads both through row-level security and can write neither; the `cad` Edge Function calls these functions as the signed-in person.
 */
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
const bracket = randomUUID();
const doc = (n: number) => JSON.stringify({ entities: Array.from({ length: n }, (_, i) => ({ type: 'line', start: { x: 0, y: i }, end: { x: 10, y: i } })), constraints: [] });

/** The issue a function refuses with (its code), or undefined when it went through. */
const refusal = async (sql: string, values: unknown[]): Promise<string | undefined> => {
  try {
    await db.pool.query(sql, values);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
};
const saveFile = (actor: string, company: string, item: string | null, id: string | null, name: string, document = doc(2)) =>
  db.pool.query(`select public.cad_item_file_save($1, $2, $3, $4, $5, $6::jsonb) as r`, [actor, company, item, id, name, document]).then((r) => r.rows[0].r as { id: string; name: string });
const SAVE = `select public.cad_item_file_save($1, $2, $3, $4, $5, $6::jsonb)`;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgMasterWorldFactory(db);
  a = await make();
  b = await make();
  await addMember(db.pool, a.companyId, viewer, 'viewer');
  mustOk(await a.backend.execute({ companyId: a.companyId, command: { op: 'create', kind: 'stockItem', id: bracket, data: { name: 'L Bracket', code: '101027520', unitId: a.uuid('unit:Nos'), itemType: 'finished' } } }));
});
afterAll(async () => {
  await db?.close();
});

describe('a stock item’s CAD files', () => {
  it('an item holds several files, each with its own name; a second file of the same name is refused', async () => {
    const part = await saveFile(a.ownerId, a.companyId, bracket, null, 'Part');
    const drawing = await saveFile(a.ownerId, a.companyId, bracket, null, '  Drawing rev B ');
    expect(drawing.name).toBe('Drawing rev B');
    expect(part.id).not.toBe(drawing.id);
    expect(await refusal(SAVE, [a.ownerId, a.companyId, bracket, null, 'Part', doc(1)])).toBe('MASTER_NAME_TAKEN');
    const rows = await db.pool.query(`select name from public.item_cad_files where item_id = $1 order by name`, [bracket]);
    expect(rows.rows.map((r) => r.name)).toEqual(['Drawing rev B', 'Part']);
  });

  it('saving by its id writes over that file (no version is kept) and may rename it', async () => {
    const file = await saveFile(a.ownerId, a.companyId, bracket, null, 'Flat pattern', doc(1));
    await saveFile(a.ownerId, a.companyId, null, file.id, 'Flat pattern', doc(5));
    const renamed = await saveFile(a.ownerId, a.companyId, null, file.id, 'Flat pattern 3mm', doc(5));
    expect(renamed).toMatchObject({ id: file.id, name: 'Flat pattern 3mm' });
    const row = await db.pool.query(`select jsonb_array_length(document -> 'entities') as n, updated_by from public.item_cad_files where id = $1`, [file.id]);
    expect(row.rows[0]).toMatchObject({ n: 5, updated_by: a.ownerId });
    expect(await refusal(SAVE, [a.ownerId, a.companyId, null, file.id, 'Part', doc(1)])).toBe('MASTER_NAME_TAKEN'); // another file of this item
    expect(await refusal(SAVE, [a.ownerId, a.companyId, null, randomUUID(), 'Gone', doc(1)])).toBe('MASTER_NOT_FOUND');
  });

  it('only those who may change masters save or delete; never into another company; never something that is not a drawing', async () => {
    expect(await refusal(SAVE, [viewer, a.companyId, bracket, null, 'By viewer', doc(1)])).toBe('PERMISSION_DENIED');
    expect(await refusal(SAVE, [b.ownerId, a.companyId, bracket, null, 'By outsider', doc(1)])).toBe('PERMISSION_DENIED');
    expect(await refusal(SAVE, [b.ownerId, b.companyId, bracket, null, 'Other company', doc(1)])).toBe('MASTER_NOT_FOUND'); // the item is not B's
    expect(await refusal(SAVE, [a.ownerId, a.companyId, bracket, null, '', doc(1)])).toBe('SCHEMA_INVALID');
    expect(await refusal(SAVE, [a.ownerId, a.companyId, bracket, null, 'Not a drawing', '[1,2]'])).toBe('SCHEMA_INVALID');
    const part = (await db.pool.query(`select id from public.item_cad_files where item_id = $1 and name = 'Part'`, [bracket])).rows[0].id as string;
    expect(await refusal(`select public.cad_item_file_delete($1, $2, $3)`, [viewer, a.companyId, part])).toBe('PERMISSION_DENIED');
    await db.pool.query(`select public.cad_item_file_delete($1, $2, $3)`, [b.ownerId, b.companyId, part]); // B's owner, B's company: A's file is not there to delete
    expect((await db.pool.query(`select 1 from public.item_cad_files where id = $1`, [part])).rowCount).toBe(1);
    await db.pool.query(`select public.cad_item_file_delete($1, $2, $3)`, [a.ownerId, a.companyId, part]);
    expect((await db.pool.query(`select 1 from public.item_cad_files where id = $1`, [part])).rowCount).toBe(0);
  });

  it('the company’s people read them (a viewer too); another company’s do not; a browser can write nothing', async () => {
    const count = (user: string) => db.asRole('authenticated', user, async (c) => Number((await c.query(`select count(*)::int as n from public.item_cad_files`)).rows[0].n));
    expect(await count(a.ownerId)).toBeGreaterThan(0);
    expect(await count(viewer)).toBeGreaterThan(0);
    expect(await count(b.ownerId)).toBe(0);
    const write = await db.asRole('authenticated', a.ownerId, async (c) => {
      try {
        await c.query(`update public.item_cad_files set name = 'x'`);
        return 'written';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(write).toMatch(/permission denied/);
    const call = await db.asRole('authenticated', a.ownerId, async (c) => {
      try {
        await c.query(SAVE, [a.ownerId, a.companyId, bracket, null, 'Direct', doc(1)]);
        return 'called';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(call).toMatch(/permission denied/);
  });

  it('deleting the item takes its files with it', async () => {
    const gone = randomUUID();
    mustOk(await a.backend.execute({ companyId: a.companyId, command: { op: 'create', kind: 'stockItem', id: gone, data: { name: 'Scrap part', unitId: a.uuid('unit:Nos'), itemType: 'finished' } } }));
    await saveFile(a.ownerId, a.companyId, gone, null, 'Part');
    await db.pool.query(`delete from public.stock_items where id = $1`, [gone]);
    expect((await db.pool.query(`select 1 from public.item_cad_files where item_id = $1`, [gone])).rowCount).toBe(0);
  });
});

describe('a person’s own drawings in MinimalCAD', () => {
  const save = (actor: string, id: string | null, name: string, autosave = false, document = doc(1)) =>
    db.pool.query(`select public.cad_drawing_save($1, $2, $3, $4::jsonb, $5) as r`, [actor, id, name, document, autosave]).then((r) => r.rows[0].r as { id: string; name: string });

  it('saved, saved over, renamed and deleted — by their owner only', async () => {
    const d = await save(a.ownerId, null, 'Fixture plate');
    await save(a.ownerId, d.id, 'ignored on save-over', false, doc(4));
    expect(await refusal(`select public.cad_drawing_save($1, $2, $3, $4::jsonb, false)`, [b.ownerId, d.id, 'x', doc(1)])).toBe('MASTER_NOT_FOUND');
    await db.pool.query(`select public.cad_drawing_rename($1, $2, $3)`, [a.ownerId, d.id, 'Fixture plate B']);
    expect(await refusal(`select public.cad_drawing_rename($1, $2, $3)`, [b.ownerId, d.id, 'Stolen'])).toBe('MASTER_NOT_FOUND');
    const row = await db.pool.query(`select name, jsonb_array_length(document -> 'entities') as n from public.cad_drawings where id = $1`, [d.id]);
    expect(row.rows[0]).toMatchObject({ name: 'Fixture plate B', n: 4 });
    await db.pool.query(`select public.cad_drawing_delete($1, $2, false)`, [b.ownerId, d.id]);
    expect((await db.pool.query(`select 1 from public.cad_drawings where id = $1`, [d.id])).rowCount).toBe(1);
    await db.pool.query(`select public.cad_drawing_delete($1, $2, false)`, [a.ownerId, d.id]);
    expect((await db.pool.query(`select 1 from public.cad_drawings where id = $1`, [d.id])).rowCount).toBe(0);
  });

  it('one autosave slot each: written over every time, cleared on request, and never another person’s', async () => {
    const first = await save(a.ownerId, null, '', true, doc(1));
    const second = await save(a.ownerId, null, '', true, doc(3));
    expect(second.id).toBe(first.id);
    await save(b.ownerId, null, '', true, doc(2));
    const mine = await db.asRole('authenticated', a.ownerId, async (c) => (await c.query(`select jsonb_array_length(document -> 'entities') as n from public.cad_drawings where is_autosave`)).rows);
    expect(mine).toEqual([{ n: 3 }]); // row-level security: only their own
    await db.pool.query(`select public.cad_drawing_delete($1, null, true)`, [a.ownerId]);
    expect((await db.pool.query(`select 1 from public.cad_drawings where owner_id = $1 and is_autosave`, [a.ownerId])).rowCount).toBe(0);
    expect((await db.pool.query(`select 1 from public.cad_drawings where owner_id = $1 and is_autosave`, [b.ownerId])).rowCount).toBe(1);
  });
});
