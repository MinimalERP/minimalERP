/**
 * The Edge Function's request handler, driven with real Request objects against a real database.
 * (The function file itself is a few lines of glue; this is where its behaviour is decided.)
 */
import { PostgresBackend, createPostingHandler } from '@minimalerp/adapter-postgres';
import { IssueCode, journalLineFromWire, voucherFromWire, type JournalLineWire, type VoucherWire } from '@minimalerp/domain';
import { journal, payment } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { type PgWorld, addMember, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgWorld;
const clerk = randomUUID();
const errors: { error: unknown; requestId: string }[] = [];

// Stand-in for JWT verification: the bearer token IS the user id. (Production verifies the Supabase JWT.)
const handler = () =>
  createPostingHandler({
    authenticate: async (req) => {
      const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
      return m?.[1] ? { userId: m[1] } : undefined;
    },
    gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
    onError: (error, requestId) => void errors.push({ error, requestId }),
  });

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgWorldFactory(db)();
  await addMember(db.pool, w.companyId, clerk, 'clerk');
});
afterAll(async () => {
  await db?.close();
});

const call = (body: unknown, opts: { user?: string | null; method?: string; headers?: Record<string, string>; raw?: string } = {}) => {
  const h = handler();
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.user !== null) headers['authorization'] = `Bearer ${opts.user ?? w.ownerId}`;
  return h(
    new Request('http://localhost/functions/v1/post-voucher', {
      method: opts.method ?? 'POST',
      headers,
      ...(opts.method === 'GET' ? {} : { body: opts.raw ?? JSON.stringify(body) }),
    }),
  );
};

const pay = (id: string, amount = '10.50') =>
  payment(w, { id, date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, amount]] });

type Wire = { ok: true; value: { voucher: VoucherWire; journal: JournalLineWire[]; replayed: boolean } } | { ok: false; issues: { code: string; message: string; path?: string }[] };
const json = async (res: Response) => (await res.json()) as Wire;

describe('post', () => {
  it('posts a voucher: 200, money as decimal STRINGS, and a body the domain can parse back exactly', async () => {
    const res = await call({ action: 'post', companyId: w.companyId, draft: pay('h1', '1234.56').voucher });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await json(res);
    if (!body.ok) throw new Error(JSON.stringify(body.issues));
    expect(body.value.replayed).toBe(false);
    expect(body.value.voucher).toMatchObject({ number: 'PAY/24-25/0001', status: 'posted', version: 1, date: '2024-05-10' });
    expect(body.value.journal.map((l) => l.amount)).toEqual(['1234.56', '1234.56']);
    expect(body.value.journal.every((l) => typeof l.amount === 'string')).toBe(true);

    // round-trips through the shared wire format with no precision loss
    expect(body.value.journal.map((l) => journalLineFromWire(l).amount)).toEqual([123456n, 123456n]);
    expect(voucherFromWire(body.value.voucher).id).toBe(w.vid('h1'));
  });

  it('a retry of the same request is safe: 200, replayed, same number', async () => {
    const draft = pay('h2').voucher;
    const first = await json(await call({ action: 'post', companyId: w.companyId, draft }));
    const again = await json(await call({ action: 'post', companyId: w.companyId, draft }));
    if (!first.ok || !again.ok) throw new Error('expected both ok');
    expect(again.value.replayed).toBe(true);
    expect(again.value.voucher.number).toBe(first.value.voucher.number);
  });

  it('a business refusal is HTTP 200 with the issues, exactly as the domain reports them', async () => {
    const bad = journal(w, { id: 'h3', date: '2024-05-10', entries: [[w.ledgers.rent, 'debit', '2'], [w.ledgers.creditor, 'credit', '1']] });
    const res = await call({ action: 'post', companyId: w.companyId, draft: bad.voucher });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.issues.map((i) => i.code)).toContain(IssueCode.Unbalanced);
  });

  it('acts as the signed-in user: a clerk is refused a journal, allowed a payment', async () => {
    const j = await json(await call({ action: 'post', companyId: w.companyId, draft: journal(w, { id: 'h4', date: '2024-05-10', entries: [[w.ledgers.rent, 'debit', '1'], [w.ledgers.creditor, 'credit', '1']] }).voucher }, { user: clerk }));
    expect(j.ok).toBe(false);
    if (!j.ok) expect(j.issues[0]?.code).toBe(IssueCode.PermissionDenied);

    const p = await json(await call({ action: 'post', companyId: w.companyId, draft: pay('h5').voucher }, { user: clerk }));
    expect(p.ok).toBe(true);
  });

  it('tags the audit log with the request id from the x-request-id header', async () => {
    await call({ action: 'post', companyId: w.companyId, draft: pay('h6').voucher }, { headers: { 'x-request-id': 'trace-abc-123' } });
    const r = await db.pool.query(`select request_id from public.audit_log where entity_id = $1`, [w.vid('h6')]);
    expect(r.rows[0]?.request_id).toBe('trace-abc-123');
  });
});

describe('alter and cancel', () => {
  it('alters with the expected version, and cancels', async () => {
    const posted = await json(await call({ action: 'post', companyId: w.companyId, draft: pay('a1', '5').voucher }));
    if (!posted.ok) throw new Error('post failed');
    const id = posted.value.voucher.id;

    const altered = await json(await call({ action: 'alter', companyId: w.companyId, voucherId: id, expectedVersion: 1, draft: pay('a1', '7').voucher }));
    if (!altered.ok) throw new Error(JSON.stringify(altered.issues));
    expect(altered.value.voucher).toMatchObject({ version: 2, revision: 1 });
    expect(altered.value.journal.map((l) => l.amount)).toEqual(['7.00', '7.00']);

    const cancelled = await json(await call({ action: 'cancel', companyId: w.companyId, voucherId: id, expectedVersion: 2 }));
    if (!cancelled.ok) throw new Error(JSON.stringify(cancelled.issues));
    expect(cancelled.value.voucher.status).toBe('cancelled');
  });

  it('reports a stale version as an issue, not an error', async () => {
    const posted = await json(await call({ action: 'post', companyId: w.companyId, draft: pay('a2').voucher }));
    if (!posted.ok) throw new Error('post failed');
    const r = await json(await call({ action: 'cancel', companyId: w.companyId, voucherId: posted.value.voucher.id, expectedVersion: 99 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe(IssueCode.VersionConflict);
  });
});

describe('what is rejected before reaching the books', () => {
  it('401 without a signed-in user', async () => {
    const res = await call({ action: 'post', companyId: w.companyId, draft: {} }, { user: null });
    expect(res.status).toBe(401);
    expect((await json(res)).ok).toBe(false);
  });

  it('405 for anything but POST', async () => {
    expect((await call({}, { method: 'GET' })).status).toBe(405);
  });

  it('400 for a body that is not JSON', async () => {
    expect((await call(undefined, { raw: '{not json' })).status).toBe(400);
  });

  it.each([
    ['unknown action', { action: 'delete', companyId: 'x' }],
    ['missing companyId', { action: 'post', draft: {} }],
    ['alter without expectedVersion', { action: 'alter', companyId: 'x', voucherId: 'y', draft: {} }],
    ['non-integer expectedVersion', { action: 'cancel', companyId: 'x', voucherId: 'y', expectedVersion: 1.5 }],
    ['a JSON array', []],
    ['null', null],
  ])('400 for %s', async (_name, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    const parsed = await json(res);
    expect(parsed.ok).toBe(false);
  });

  it('nothing malformed ever reached the database', async () => {
    const before = Number((await db.pool.query('select count(*)::int n from public.audit_log')).rows[0].n);
    await call({ action: 'delete' });
    await call(undefined, { raw: '<<<' });
    expect(Number((await db.pool.query('select count(*)::int n from public.audit_log')).rows[0].n)).toBe(before);
  });
});

describe('CORS and failures', () => {
  it('answers the browser’s preflight', async () => {
    const res = await call(undefined, { method: 'OPTIONS', user: null });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('every response carries the CORS headers', async () => {
    const res = await call({ action: 'post', companyId: w.companyId, draft: pay('c1').voucher });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('an unexpected failure is a 500 that leaks nothing, and is reported to the host with its request id', async () => {
    errors.length = 0;
    const boom = createPostingHandler({
      authenticate: async () => ({ userId: w.ownerId }),
      gatewayFor: () => ({
        post: async () => { throw new Error('connection string postgres://user:s3cret@db/prod exploded'); },
        alter: async () => { throw new Error('x'); },
        cancel: async () => { throw new Error('x'); },
        execute: async () => { throw new Error('x'); },
      }),
      onError: (error, requestId) => void errors.push({ error, requestId }),
    });
    const res = await boom(
      new Request('http://x/', {
        method: 'POST',
        headers: { authorization: 'Bearer u', 'x-request-id': 'req-boom' },
        body: JSON.stringify({ action: 'post', companyId: w.companyId, draft: {} }),
      }),
    );
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('postgres://');
    expect(text).toContain('req-boom'); // the client can quote this to support
    expect(errors).toHaveLength(1);
    expect(errors[0]?.requestId).toBe('req-boom');
    expect((errors[0]?.error as Error).message).toContain('s3cret'); // …but the host DOES get the real error to log
  });

  it('an unrecognised database error propagates as a 500 rather than being mistaken for a business rule', async () => {
    const spy = vi.fn();
    const h = createPostingHandler({
      authenticate: async () => ({ userId: w.ownerId }),
      gatewayFor: () => new PostgresBackend({ query: async () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); } }, { actorId: w.ownerId }),
      onError: spy,
    });
    const res = await h(new Request('http://x/', { method: 'POST', headers: { authorization: 'Bearer u' }, body: JSON.stringify({ action: 'post', companyId: w.companyId, draft: {} }) }));
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledOnce();
  });
});
