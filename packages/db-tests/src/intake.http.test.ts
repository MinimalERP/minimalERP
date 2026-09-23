/**
 * The `intake` Edge Function's handler (ADR-0023), with real Requests against a real database and a stand-in reader (no Gemini in tests):
 *   - the add-on's sign-in sends a document; what the reader says is matched and queued in the AI Inbox — nothing is posted
 *   - the document is never stored: no table has it after the request
 *   - who may send, and what a reader's refusal (the free limit reached) looks like to the add-on
 */
import { PostgresBackend, createIntakeHandler } from '@minimalerp/adapter-postgres';
import type { DocumentReader } from '@minimalerp/ports';
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;
const bot = randomUUID();
const viewer = randomUUID();
const MARKER = 'UNIQUE-DOCUMENT-BYTES-7f3a';

/** What the reader "reads" next, and what it was given. */
let nextReading: unknown = {};
let readerRefuses: { code: string; message: string } | undefined;
const seen: unknown[] = [];
const reader: DocumentReader = {
  async read(input) {
    seen.push(input);
    return readerRefuses ? { ok: false, issues: [readerRefuses as never] } : { ok: true, value: nextReading };
  },
};

/** What the handler left running after it answered (the Edge Function keeps it alive with EdgeRuntime.waitUntil). */
const deferred: Promise<unknown>[] = [];
const handler = () =>
  createIntakeHandler({
    defer: (work) => void deferred.push(work),
    authenticate: async (req) => {
      const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
      return m?.[1] ? { userId: m[1] } : undefined;
    },
    gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
    reader,
    today: () => '2024-06-30',
  });

const send = async (body: unknown, user: string | null = bot) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user) headers['authorization'] = `Bearer ${user}`;
  const res = await handler()(new Request('http://localhost/functions/v1/intake', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; value?: { id: string; party?: string; notes: string[] }; issues?: { code: string }[] } };
};

const pdf = { mimeType: 'application/pdf', base64: Buffer.from(`%PDF-1.4 ${MARKER}`).toString('base64') };

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
  const create = async (kind: string, id: string, data: unknown) =>
    mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await create('stockItem', w.uuid('item:bolt'), { name: 'Hex Bolt M8', code: 'BLT-M8', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await create('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'] });
  await addMember(db.pool, w.companyId, bot, 'automation');
  await addMember(db.pool, w.companyId, viewer, 'viewer');
});
afterAll(async () => {
  await db?.close();
});

describe('sending a document to the ERP', () => {
  it('reads it, matches it and queues the proposal — for the one company the sign-in belongs to', async () => {
    nextReading = { partyName: 'ACME LIMITED', date: '12/06/2024', poNumber: 'PO-55', lines: [{ code: 'BLT-M8', qty: '100', rate: '4.5' }, { description: 'Washer as per DRG-1', qty: '100', rate: '1' }] };
    const r = await send({ kind: 'salesOrder', document: pdf, mail: { subject: 'PO 55', from: 'buyer@acme.example' } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.value?.party).toBe('Acme Ltd');
    expect(r.body.value?.notes).toEqual([expect.stringContaining('Washer as per DRG-1')]);

    const items = mustOk(await w.backend.inbox(w.companyId));
    const item = items.find((i) => i.id === r.body.value?.id);
    expect(item?.mailSubject).toBe('PO 55');
    expect(item?.proposal).toMatchObject({ kind: 'salesOrder', date: '2024-06-12', reference: 'PO-55', party: { partyId: w.uuid('party:acme') } });
    expect(item?.proposal.lines.map((l) => l.itemId ?? l.text)).toEqual([w.uuid('item:bolt'), 'Washer as per DRG-1']);
    // the reader was told whose documents these are (so it never takes our own name for the party)
    expect(seen.at(-1)).toMatchObject({ kind: 'salesOrder', ownCompany: w.seed.company.name });
    // …and nothing was posted
    expect(Number((await db.pool.query('select count(*)::int as n from public.vouchers where company_id = $1', [w.companyId])).rows[0].n)).toBe(0);
  });

  it('the document itself is stored nowhere', async () => {
    nextReading = { partyName: 'Acme Ltd', lines: [] };
    mustOk({ ok: true, value: (await send({ kind: 'salesOrder', document: pdf })).body });
    const tables = (await db.pool.query(`select table_name from information_schema.tables where table_schema = 'public'`)).rows.map((r) => r.table_name as string);
    for (const t of tables) {
      const hit = await db.pool.query(`select count(*)::int as n from public.${t} x where x::text like $1 or x::text like $2`, [`%${MARKER}%`, `%${pdf.base64.slice(0, 24)}%`]);
      expect(hit.rows[0].n, `table ${t}`).toBe(0);
    }
  });

  it('a reader refusal (the free limit reached) comes back as the reader said it, and nothing is queued', async () => {
    const before = mustOk(await w.backend.inbox(w.companyId)).length;
    readerRefuses = { code: 'READER_BUSY', message: 'Gemini’s free limit was reached for now: try again in a minute' };
    const r = await send({ kind: 'purchase', document: pdf });
    readerRefuses = undefined;
    expect(r.body).toEqual({ ok: false, issues: [{ code: 'READER_BUSY', message: expect.stringContaining('try again') }] });
    expect(mustOk(await w.backend.inbox(w.companyId)).length).toBe(before);
  });

  it('a reading in the wrong shape is refused, not queued half-made', async () => {
    nextReading = 'just some words';
    const r = await send({ kind: 'purchase', document: pdf });
    expect(r.body.issues?.[0]?.code).toBe('DOCUMENT_UNREADABLE');
  });
});

describe('in the background (what the Gmail panel uses: it may wait only ~30 s)', () => {
  it('answers at once; the proposal arrives when the reading is done', async () => {
    nextReading = { partyName: 'Acme Ltd', poNumber: 'PO-BG-1', lines: [{ code: 'BLT-M8', qty: '5', rate: '4.5' }] };
    const r = await send({ kind: 'salesOrder', document: pdf, mail: { subject: 'PO BG 1' }, background: true });
    expect(r.body).toEqual({ ok: true, value: { id: expect.any(String), kind: 'salesOrder', background: true } });
    await Promise.all(deferred.splice(0));
    const item = mustOk(await w.backend.inbox(w.companyId)).find((i) => i.id === r.body.value?.id);
    expect(item?.proposal.reference).toBe('PO-BG-1');
  });

  it('a reading that still fails (Gemini busy) leaves an item that says so — the person learns to send it again', async () => {
    readerRefuses = { code: 'READER_UNAVAILABLE', message: 'Gemini is busy (503): try again in a minute' };
    const r = await send({ kind: 'purchase', document: pdf, mail: { subject: 'Bill 77' }, background: true });
    await Promise.all(deferred.splice(0));
    readerRefuses = undefined;
    const item = mustOk(await w.backend.inbox(w.companyId)).find((i) => i.id === r.body.value?.id);
    expect(item?.mailSubject).toBe('Bill 77');
    expect(item?.proposal).toMatchObject({ kind: 'purchase', lines: [], party: {} });
    expect(item?.proposal.notes).toEqual([{ code: 'READ_FAILED', message: expect.stringContaining('Send the mail again') }]);
  });
});

describe('who may send', () => {
  it('not signed in: 401; a viewer or a stranger: refused before anything is read', async () => {
    const reads = seen.length;
    expect((await send({ kind: 'salesOrder', document: pdf }, null)).status).toBe(401);
    expect((await send({ kind: 'salesOrder', document: pdf }, viewer)).body.issues?.[0]?.code).toBe('PERMISSION_DENIED');
    expect((await send({ kind: 'salesOrder', document: pdf, companyId: w.companyId }, randomUUID())).body.issues?.[0]?.code).toBe('PERMISSION_DENIED');
    expect(seen.length).toBe(reads);
  });

  it('a malformed request is 400', async () => {
    expect((await send({ kind: 'journal', document: pdf })).status).toBe(400);
    expect((await send({ kind: 'salesOrder' })).status).toBe(400);
  });
});
