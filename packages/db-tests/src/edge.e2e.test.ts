/**
 * END-TO-END through the real Edge Function file, on the real Deno runtime:
 *
 *   fetch ─► Deno.serve ─► supabase/functions/post-voucher/index.ts
 *              ├─ supabase-js auth.getUser ──► mock Auth server (stands in for GoTrue)
 *              └─ postgres.js ──► the real PostgreSQL with our migrations
 *
 * Not simulated: the Deno runtime, the function's own glue code, its `npm:` dependencies, the
 * bundle, the Postgres driver, and every SQL function. Simulated: only the Auth service that turns
 * a JWT into a user id (its answer is a fixed lookup here).
 * Skipped automatically if the Deno binary is not installed.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payment, journal } from '@minimalerp/testkit';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildFunctions } from '../../../tooling/build-functions.mjs';
import { PG_PASSWORD, PG_USER } from './harness/globalSetup';
import { addMember, pgWorldFactory, type PgWorld } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const denoAvailable = spawnSync('pnpm', ['exec', 'deno', '--version'], { cwd: root, shell: true }).status === 0;

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = netServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

let db: TestDb;
let w: PgWorld;
let authServer: Server;
let fn: ChildProcess;
let base: string;
let logs = '';
const clerk = crypto.randomUUID();

describe.skipIf(!denoAvailable)('post-voucher Edge Function on Deno', () => {
  beforeAll(async () => {
    await buildFunctions();
    db = await createTestDb(inject('pgPort'));
    w = await pgWorldFactory(db)();
    await addMember(db.pool, w.companyId, clerk, 'clerk');

    // Mock Auth: maps a bearer token to a user, like GoTrue's GET /auth/v1/user.
    const tokens = new Map([['token-owner', w.ownerId], ['token-clerk', clerk]]);
    authServer = createServer((req, res) => {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const userId = token ? tokens.get(token) : undefined;
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/auth/v1/user') && userId) {
        res.end(JSON.stringify({ id: userId, aud: 'authenticated', role: 'authenticated', email: `${userId}@example.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }));
      }
    });
    const authPort = await freePort();
    await new Promise<void>((r) => authServer.listen(authPort, '127.0.0.1', r));

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    fn = spawn('pnpm', ['exec', 'deno', 'run', '--config', 'supabase/functions/post-voucher/deno.json', '--no-lock', '--allow-net', '--allow-env', '--allow-read', '--no-prompt', 'supabase/functions/post-voucher/index.ts'], {
      cwd: root,
      shell: true,
      env: {
        ...process.env,
        DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`,
        SUPABASE_URL: `http://127.0.0.1:${authPort}`,
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
        SUPABASE_DB_URL: `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${inject('pgPort')}/${db.name}`,
      },
    });
    fn.stdout?.on('data', (d) => (logs += String(d)));
    fn.stderr?.on('data', (d) => (logs += String(d)));

    // wait until it answers (first run downloads the npm: dependencies)
    const deadline = Date.now() + 100_000;
    for (;;) {
      try {
        if ((await fetch(base, { method: 'OPTIONS' })).status === 204) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`function did not start:\n${logs}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 150_000);

  afterAll(async () => {
    if (fn?.pid) spawnSync('taskkill', ['/PID', String(fn.pid), '/T', '/F'], { shell: true });
    fn?.kill();
    await new Promise<void>((r) => (authServer ? authServer.close(() => r()) : r()));
    await db?.close();
  });

  const post = (body: unknown, token: string | null = 'token-owner') =>
    fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  it('posts a voucher: authenticated by supabase-js, validated in TypeScript, committed by the SQL function', async () => {
    const draft = payment(w, { id: 'edge1', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, '250.75']] }).voucher;
    const res = await post({ action: 'post', companyId: w.companyId, draft });
    const body = (await res.json()) as { ok: boolean; value: { voucher: { number: string; version: number }; journal: { amount: string }[]; replayed: boolean } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.value.voucher).toMatchObject({ number: 'PAY/24-25/0001', version: 1 });
    expect(body.value.journal.map((l) => l.amount)).toEqual(['250.75', '250.75']);

    // and it really is in the database, attributed to the authenticated user
    const row = await db.pool.query(`select created_by, status from public.vouchers where id = $1`, [w.vid('edge1')]);
    expect(row.rows[0]).toMatchObject({ created_by: w.ownerId, status: 'posted' });
    const audit = await db.pool.query(`select actor, request_id from public.audit_log where entity_id = $1`, [w.vid('edge1')]);
    expect(audit.rows[0]?.actor).toBe(w.ownerId);
    expect(audit.rows[0]?.request_id).toBeTruthy();
  });

  it('acts as the caller: a clerk is refused a journal by the permission check', async () => {
    const draft = journal(w, { id: 'edge2', date: '2024-05-10', entries: [[w.ledgers.rent, 'debit', '1'], [w.ledgers.creditor, 'credit', '1']] }).voucher;
    const res = await post({ action: 'post', companyId: w.companyId, draft }, 'token-clerk');
    const body = (await res.json()) as { ok: boolean; issues: { code: string }[] };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.issues[0]?.code).toBe('PERMISSION_DENIED');
  });

  it('rejects an unauthenticated caller and an unknown token with 401, touching nothing', async () => {
    const before = Number((await db.pool.query('select count(*)::int n from public.vouchers')).rows[0].n);
    expect((await post({ action: 'post', companyId: w.companyId, draft: {} }, null)).status).toBe(401);
    expect((await post({ action: 'post', companyId: w.companyId, draft: {} }, 'forged-token')).status).toBe(401);
    expect(Number((await db.pool.query('select count(*)::int n from public.vouchers')).rows[0].n)).toBe(before);
  });

  it('alters and cancels through the same function', async () => {
    const created = (await (await post({ action: 'post', companyId: w.companyId, draft: payment(w, { id: 'edge3', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, '5']] }).voucher })).json()) as { value: { voucher: { id: string } } };
    const id = created.value.voucher.id;
    const altered = (await (await post({ action: 'alter', companyId: w.companyId, voucherId: id, expectedVersion: 1, draft: payment(w, { id: 'edge3', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, '9']] }).voucher })).json()) as { ok: boolean; value: { voucher: { version: number } } };
    expect(altered.value.voucher.version).toBe(2);
    const cancelled = (await (await post({ action: 'cancel', companyId: w.companyId, voucherId: id, expectedVersion: 2 })).json()) as { value: { voucher: { status: string } } };
    expect(cancelled.value.voucher.status).toBe('cancelled');
  });

  it('answers the browser’s CORS preflight', async () => {
    const res = await fetch(base, { method: 'OPTIONS', headers: { origin: 'https://app.example.test' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('logged no errors while doing all of the above', () => {
    expect(logs).not.toMatch(/"level":"error"/);
  });
});
