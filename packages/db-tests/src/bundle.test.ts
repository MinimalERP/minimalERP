/**
 * The Edge Function ships as ONE bundled file. Prove that file is self-contained and works:
 * build it, load it as a plain ES module with no workspace packages resolvable, and post through it.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { PostgresBackend, createPostingHandler } from '@minimalerp/adapter-postgres';
import { payment } from '@minimalerp/testkit';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildFunctions } from '../../../tooling/build-functions.mjs';
import { pgWorldFactory, type PgWorld } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgWorld;
let bundlePath: string;

beforeAll(async () => {
  bundlePath = await buildFunctions();
  db = await createTestDb(inject('pgPort'));
  w = await pgWorldFactory(db)();
});
afterAll(async () => {
  await db?.close();
});

describe('supabase/functions/post-voucher/handler.bundle.js', () => {
  it('is built, and contains no unresolved imports of workspace packages or node built-ins', () => {
    expect(existsSync(bundlePath)).toBe(true);
    const source = readFileSync(bundlePath, 'utf8');
    const imports = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports, 'the bundle must not import anything at load time').toEqual([]);
    expect(source).not.toMatch(/@minimalerp\//);
    expect(source).not.toMatch(/from ["']node:/);
  });

  it('loads as a standalone ES module and serves a real posting against the database', async () => {
    const bundle = (await import(/* @vite-ignore */ pathToFileURL(bundlePath).href)) as {
      createPostingHandler: typeof createPostingHandler;
      PostgresBackend: typeof PostgresBackend;
    };
    expect(bundle.createPostingHandler).toBeTypeOf('function');

    const handler = bundle.createPostingHandler({
      authenticate: async () => ({ userId: w.ownerId }),
      gatewayFor: (actorId, requestId) => new bundle.PostgresBackend(db.pool, { actorId, requestId }),
    });
    const draft = payment(w, { id: 'bundled', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, '42.00']] }).voucher;
    const res = await handler(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { authorization: 'Bearer x', 'x-request-id': randomUUID() },
        body: JSON.stringify({ action: 'post', companyId: w.companyId, draft }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; value: { voucher: { number: string }; journal: { amount: string }[] } };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.value.voucher.number).toBe('PAY/24-25/0001');
    expect(body.value.journal.map((l) => l.amount)).toEqual(['42.00', '42.00']);
  });
});
