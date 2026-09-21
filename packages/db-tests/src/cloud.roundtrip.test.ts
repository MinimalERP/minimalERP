/**
 * The browser's online backend (SupabaseBooksBackend) run against the REAL Edge Function handler and a real database — the only thing
 * replaced is the network: `functions.invoke` calls the handler in-process, as a given user. This is the whole path a screen takes
 * when the books are online, minus HTTP and the JWT check.
 */
import { PostgresBackend, createPostingHandler } from '@minimalerp/adapter-postgres';
import { SupabaseBooksBackend, type SupabaseLike } from '@minimalerp/adapter-supabase';
import { asCompanyId } from '@minimalerp/domain';
import { payment } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgWorld, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgWorld;
const stranger = randomUUID();

const handler = createPostingHandler({
  authenticate: async (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
    return m?.[1] ? { userId: m[1] } : undefined;
  },
  gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
});

/** A Supabase client whose only working part is `functions.invoke`, wired straight to the handler as `userId`. */
const browserAs = (userId: string): SupabaseBooksBackend => {
  const client: SupabaseLike = {
    functions: {
      invoke: async (_name, { body }) => {
        const res = await handler(
          new Request('http://localhost/functions/v1/post-voucher', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${userId}` },
            body: JSON.stringify(body),
          }),
        );
        return { data: await res.json(), error: null };
      },
    },
    from: () => {
      throw new Error('the online backend never reads a table directly');
    },
  };
  return new SupabaseBooksBackend(client);
};

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgWorldFactory(db)();
  await db.pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [stranger, `${stranger}@example.test`]);
});
afterAll(async () => {
  await db?.close();
});

describe('the online backend, end to end', () => {
  it('opens the account’s company, posts a voucher, and reads it back the way the screens hold it (money as bigint)', async () => {
    const owner = browserAs(w.ownerId);
    const companyId = asCompanyId(w.companyId);

    const mine = await owner.companies();
    expect(mine.ok && mine.value.map((c) => c.id)).toEqual([w.companyId]);

    const masters = await owner.load(companyId);
    expect(masters.company.id).toBe(w.companyId);

    const posted = await owner.post({ companyId, draft: payment(w, { id: 'rt1', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, '250.75']] }).voucher });
    if (!posted.ok) throw new Error(JSON.stringify(posted.issues));

    const vouchers = await owner.list(companyId);
    const read = vouchers.find((v) => v.id === w.vid('rt1'));
    expect(read?.number).toBe('PAY/24-25/0001');
    const content = read?.content as unknown as { lines: { amount: unknown }[] };
    expect(content.lines[0]?.amount).toBe(25075n); // parsed back through the kind's schema, not left as the string "250.75"

    expect((await owner.get(companyId, w.vid('rt1')))?.number).toBe('PAY/24-25/0001');
    expect(await owner.get(companyId, w.vid('nothing-here'))).toBeUndefined();

    const lines = await owner.lines({ companyId, voucherId: w.vid('rt1') });
    expect(lines.map((l) => l.amount)).toEqual([25075n, 25075n]);
    expect(await owner.stockMovements({ companyId })).toEqual([]);
  });

  it('someone else’s books cannot be read: every read fails, saying only that it is not permitted', async () => {
    const other = browserAs(stranger);
    const companyId = asCompanyId(w.companyId);
    await expect(other.load(companyId)).rejects.toThrow(/Not permitted/);
    await expect(other.list(companyId)).rejects.toThrow(/Not permitted/);
    await expect(other.lines({ companyId })).rejects.toThrow(/Not permitted/);
    await expect(other.stockMovements({ companyId })).rejects.toThrow(/Not permitted/);
    const own = await other.companies();
    expect(own.ok && own.value).toEqual([]);
  });

  it('a new account creates its own company, and it is the only one it can make', async () => {
    const fresh = randomUUID();
    await db.pool.query(`insert into auth.users (id, email) values ($1, $2)`, [fresh, `${fresh}@example.test`]);
    const b = browserAs(fresh);

    const created = await b.createCompany({ name: 'Round Trip Traders', fyStart: '2024-04-01' });
    if (!created.ok) throw new Error(JSON.stringify(created.issues));
    const masters = await b.load(created.value.companyId);
    expect(masters.company.name).toBe('Round Trip Traders');
    expect(await b.list(created.value.companyId)).toEqual([]);

    const again = await b.createCompany({ name: 'Another', fyStart: '2024-04-01' });
    expect(again.ok).toBe(false);
  });
});
