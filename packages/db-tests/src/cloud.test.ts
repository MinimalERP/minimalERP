/**
 * What the browser needs from the Edge Function to run the books ONLINE: listing and creating a company, and reading the books back.
 * The reads run as the service role (they bypass row-level security), so the important tests here are the refusals: a signed-in
 * stranger — an invited user with a company of their own, or nobody's member at all — must learn nothing about someone else's books.
 */
import { PostgresBackend, createPostingHandler } from '@minimalerp/adapter-postgres';
import { IssueCode, buildMasters, journalLineFromWire, voucherFromWire, type JournalLineWire, type VoucherWire } from '@minimalerp/domain';
import { payment } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgWorld, addMember, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgWorld;
const viewer = randomUUID();
const newcomer = randomUUID(); // signed in, belongs to no company yet
const other = randomUUID(); // signed in, creates a company of their own

// Stand-in for JWT verification: the bearer token IS the user id.
const handler = createPostingHandler({
  authenticate: async (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
    return m?.[1] ? { userId: m[1] } : undefined;
  },
  gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
});

type Envelope<T = unknown> = { ok: true; value: T } | { ok: false; issues: { code: string; message: string; path?: string }[] };

const call = async <T = unknown>(body: unknown, user: string | null = w.ownerId): Promise<{ status: number; body: Envelope<T> }> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user !== null) headers['authorization'] = `Bearer ${user}`;
  const res = await handler(new Request('http://localhost/functions/v1/post-voucher', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Envelope<T> };
};

const codes = (e: Envelope) => (e.ok ? [] : e.issues.map((i) => i.code));

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgWorldFactory(db)();
  await addMember(db.pool, w.companyId, viewer, 'viewer');
  for (const id of [newcomer, other]) await db.pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [id, `${id}@example.test`]);
  // one posted voucher, so there is a journal to read
  const posted = await call({ action: 'post', companyId: w.companyId, draft: payment(w, { id: 'c1', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, '99.00']] }).voucher });
  if (!posted.body.ok) throw new Error(JSON.stringify(posted.body.issues));
});
afterAll(async () => {
  await db?.close();
});

describe('companies', () => {
  it('lists the caller’s own company and no one else’s', async () => {
    const mine = await call<{ companies: { id: string; name: string }[] }>({ action: 'companies' });
    expect(mine.body.ok && mine.body.value.companies.map((c) => c.id)).toEqual([w.companyId]);

    const stranger = await call<{ companies: unknown[] }>({ action: 'companies' }, newcomer);
    expect(stranger.body.ok && stranger.body.value.companies).toEqual([]);
  });

  it('needs a signed-in user', async () => {
    const r = await call({ action: 'companies' }, null);
    expect(r.status).toBe(401);
  });
});

describe('creating a company', () => {
  it('seeds it, makes the caller its owner, and it then opens like any other', async () => {
    const created = await call<{ companyId: string }>({ action: 'company-create', company: { name: '  Acme   Traders ', fyStart: '2024-04-01' } }, other);
    if (!created.body.ok) throw new Error(JSON.stringify(created.body.issues));
    const id = created.body.value.companyId;

    const role = await db.pool.query(`select role from public.company_members where company_id = $1 and user_id = $2`, [id, other]);
    expect(role.rows[0]?.role).toBe('owner');

    const listed = await call<{ companies: { id: string; name: string }[] }>({ action: 'companies' }, other);
    expect(listed.body.ok && listed.body.value.companies).toEqual([{ id, name: 'Acme Traders' }]);

    const loaded = await call<{ core: unknown; ledgers: unknown }>({ action: 'load', companyId: id }, other);
    if (!loaded.body.ok) throw new Error(JSON.stringify(loaded.body.issues));
    const masters = buildMasters(loaded.body.value.core, loaded.body.value.ledgers);
    expect(masters.company.name).toBe('Acme Traders');
    expect(masters.financialYears[0]?.label).toBe('2024-25');
  });

  it('is one company per account: a second attempt is refused and nothing is created', async () => {
    const before = await db.pool.query(`select count(*)::int as n from public.companies`);
    const again = await call({ action: 'company-create', company: { name: 'Second Co', fyStart: '2024-04-01' } }, other);
    expect(codes(again.body)).toEqual([IssueCode.UnsupportedOperation]);
    const after = await db.pool.query(`select count(*)::int as n from public.companies`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('checks the details on the server too, naming the field', async () => {
    const r = await call({ action: 'company-create', company: { name: '   ', fyStart: 'not a date', gstin: '123' } }, newcomer);
    expect(r.body.ok).toBe(false);
    if (!r.body.ok) expect(r.body.issues.map((i) => i.path).sort()).toEqual(['fyStart', 'gstin', 'name']);
    const none = await call<{ companies: unknown[] }>({ action: 'companies' }, newcomer);
    expect(none.body.ok && none.body.value.companies).toEqual([]);
  });
});

describe('reading the books', () => {
  it('a member reads the masters, the vouchers, the journal and the stock, in shapes the domain parses back', async () => {
    const loaded = await call<{ core: unknown; ledgers: unknown }>({ action: 'load', companyId: w.companyId });
    if (!loaded.body.ok) throw new Error(JSON.stringify(loaded.body.issues));
    expect(buildMasters(loaded.body.value.core, loaded.body.value.ledgers).company.id).toBe(w.companyId);

    const vouchers = await call<{ vouchers: VoucherWire[] }>({ action: 'vouchers', companyId: w.companyId });
    if (!vouchers.body.ok) throw new Error(JSON.stringify(vouchers.body.issues));
    expect(vouchers.body.value.vouchers.map((v) => voucherFromWire(v).id)).toContain(w.vid('c1'));

    const lines = await call<{ lines: JournalLineWire[] }>({ action: 'lines', companyId: w.companyId, voucherId: w.vid('c1') });
    if (!lines.body.ok) throw new Error(JSON.stringify(lines.body.issues));
    expect(lines.body.value.lines.map((l) => journalLineFromWire(l).amount)).toEqual([9900n, 9900n]);

    const stock = await call<{ movements: unknown[] }>({ action: 'stock', companyId: w.companyId });
    expect(stock.body.ok && stock.body.value.movements).toEqual([]);

    const one = await call<{ voucher: VoucherWire | null }>({ action: 'voucher', companyId: w.companyId, voucherId: w.vid('c1') });
    expect(one.body.ok && one.body.value.voucher?.number).toBe('PAY/24-25/0001');
  });

  it('a viewer reads too (they hold every view permission)', async () => {
    const r = await call({ action: 'vouchers', companyId: w.companyId }, viewer);
    expect(r.body.ok).toBe(true);
  });

  const reads = (companyId: string) => [
    { action: 'load', companyId },
    { action: 'vouchers', companyId },
    { action: 'voucher', companyId, voucherId: randomUUID() },
    { action: 'lines', companyId },
    { action: 'stock', companyId },
  ];

  it.each(['load', 'vouchers', 'voucher', 'lines', 'stock'])(
    'a signed-in stranger is refused %s on someone else’s company, and is told nothing about it',
    async (action) => {
      const body = reads(w.companyId).find((r) => r.action === action)!;
      for (const user of [newcomer, other]) {
        const r = await call(body, user);
        expect(r.status).toBe(200);
        expect(codes(r.body)).toEqual([IssueCode.PermissionDenied]);
        expect(JSON.stringify(r.body)).not.toContain(w.companyId);
      }
    },
  );

  it('an unknown company id is refused exactly like a real one the caller is not in', async () => {
    const real = await call({ action: 'load', companyId: w.companyId }, newcomer);
    const unknown = await call({ action: 'load', companyId: randomUUID() }, newcomer);
    const malformed = await call({ action: 'load', companyId: 'not-a-uuid' }, newcomer);
    expect(codes(unknown.body)).toEqual(codes(real.body));
    expect(codes(malformed.body)).toEqual(codes(real.body));
    expect(unknown.body).toEqual({ ...(real.body as object) });
  });

  it('no read works without signing in', async () => {
    for (const body of reads(w.companyId)) expect((await call(body, null)).status).toBe(401);
  });
});
