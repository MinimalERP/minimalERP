/**
 * A print layout per company (ADR-0025, step 4): its own HTML layouts and pictures, read by everyone who sees its vouchers, changed by
 * whoever may change its masters, and never another company's.
 */
import { PostgresBackend, createPostingHandler } from '@minimalerp/adapter-postgres';
import { IssueCode } from '@minimalerp/domain';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgWorld, addMember, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let a: PgWorld;
let b: PgWorld;
const viewer = randomUUID();

const handler = createPostingHandler({
  authenticate: async (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
    return m?.[1] ? { userId: m[1] } : undefined;
  },
  gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
});
type Layouts = { templates: Record<string, string>; images: Record<string, string> };
type Envelope = { ok: true; value: Layouts } | { ok: false; issues: { code: string; message: string }[] };
const call = async (user: string, body: Record<string, unknown>): Promise<Envelope> => {
  const res = await handler(
    new Request('http://localhost/functions/v1/post-voucher', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${user}` },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as Envelope;
};
const codes = (e: Envelope) => (e.ok ? [] : e.issues.map((i) => i.code));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  const make = pgWorldFactory(db);
  a = await make();
  b = await make();
  await addMember(db.pool, a.companyId, viewer, 'viewer');
});
afterAll(async () => {
  await db?.close();
});

describe('a company’s print layouts', () => {
  it('are empty to begin with: the built-in layout prints', async () => {
    const r = await call(a.ownerId, { action: 'print-layout', companyId: a.companyId });
    expect(r).toEqual({ ok: true, value: { templates: {}, images: {} } });
  });

  it('are set whole, with a logo, and come back as set', async () => {
    const layouts = { templates: { invoice: '<h1>{{company.name}}</h1>', 'invoice.purchaseOrder': '<h1>PO</h1>' }, images: { logo: PNG } };
    const r = await call(a.ownerId, { action: 'print-layout-set', companyId: a.companyId, ...layouts });
    expect(r).toEqual({ ok: true, value: layouts });
    expect(await call(viewer, { action: 'print-layout', companyId: a.companyId })).toEqual({ ok: true, value: layouts }); // everyone prints with them
  });

  it('are another company’s own: this one is untouched, and its owner cannot read or change this one', async () => {
    expect(await call(b.ownerId, { action: 'print-layout', companyId: b.companyId })).toEqual({ ok: true, value: { templates: {}, images: {} } });
    expect(codes(await call(b.ownerId, { action: 'print-layout', companyId: a.companyId }))).toEqual([IssueCode.PermissionDenied]);
    expect(codes(await call(b.ownerId, { action: 'print-layout-set', companyId: a.companyId, templates: {}, images: {} }))).toEqual([IssueCode.PermissionDenied]);
    const seen = await db.asRole('authenticated', b.ownerId, async (c) => (await c.query('select company_id from public.company_print_layouts')).rows.length);
    expect(seen).toBe(0);
  });

  it('cannot be changed by someone who may only look', async () => {
    expect(codes(await call(viewer, { action: 'print-layout-set', companyId: a.companyId, templates: {}, images: {} }))).toEqual([IssueCode.PermissionDenied]);
  });

  it('refuses an unknown layout name and a picture that is not an image', async () => {
    const badName = await call(a.ownerId, { action: 'print-layout-set', companyId: a.companyId, templates: { report: 'x' }, images: {} });
    expect(codes(badName)).toEqual([IssueCode.SchemaInvalid]);
    const badImage = await call(a.ownerId, { action: 'print-layout-set', companyId: a.companyId, templates: {}, images: { logo: 'data:text/html;base64,PHNjcmlwdD4=' } });
    expect(codes(badImage)).toEqual([IssueCode.SchemaInvalid]);
  });
});
