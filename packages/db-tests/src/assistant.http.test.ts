/**
 * The `assistant` Edge Function's handler (the floating assistant, v1), with real Requests against a real database and a stand-in model
 * (no Gemini in tests): the stand-in calls the look-up named in the question and answers with what it got back.
 *   - look-ups read the books AS THE SIGNED-IN PERSON: a look-up their role may not use answers "not permitted", never data
 *   - taught facts are kept in the books; a viewer cannot teach; they reach the next question's instructions
 *   - another company's books are never reachable
 */
import { createAssistantHandler, PostgresBackend } from '@minimalerp/adapter-postgres';
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { addMember } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;
const viewer = randomUUID();
const limited = randomUUID();
const stranger = randomUUID();

/** What the model was told last (its instructions). */
let lastSystem = '';

/**
 * A stand-in model: a question `call <tool> <json args>` runs that look-up and answers with its result as JSON; any other question is
 * answered "general answer". Two look-ups in one question: `call a {…} ; call b {…}`.
 */
const chat = {
  async ask(r: { system: string; history: readonly { role: string; text: string }[]; callTool: (n: string, a: Record<string, unknown>) => Promise<unknown> }) {
    lastSystem = r.system;
    const q = r.history.at(-1)?.text ?? '';
    const calls = [...q.matchAll(/call (\w+) (\{[^}]*\})/g)];
    if (calls.length === 0) return { ok: true as const, value: { text: 'general answer', toolsUsed: [] } };
    const results: unknown[] = [];
    for (const c of calls) results.push(await r.callTool(c[1] as string, JSON.parse(c[2] as string) as Record<string, unknown>));
    return { ok: true as const, value: { text: JSON.stringify(results.length === 1 ? results[0] : results), toolsUsed: calls.map((c) => c[1] as string) } };
  },
};

const handler = () =>
  createAssistantHandler({
    authenticate: async (req) => {
      const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
      return m?.[1] ? { userId: m[1] } : undefined;
    },
    gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
    chat,
    today: () => '2026-09-26',
  });

const ask = async (question: string, user: string | null = w.ownerId, companyId: string = w.companyId, screen?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user) headers['authorization'] = `Bearer ${user}`;
  const res = await handler()(new Request('http://localhost/functions/v1/assistant', { method: 'POST', headers, body: JSON.stringify({ companyId, messages: [{ role: 'user', text: question }], ...(screen ? { screen } : {}) }) }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; value?: { answer: string; sources: string[] }; issues?: { code: string; message: string }[] } };
};
const result = (r: Awaited<ReturnType<typeof ask>>) => JSON.parse(r.body.value?.answer ?? 'null') as Record<string, unknown>;

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
  mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind: 'stockItem', id: w.uuid('item:blank'), data: { name: '14188- Orifice Blank,90', code: '14188', unitId: w.uuid('unit:Nos'), itemType: 'raw' } } }));
  mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind: 'stockItem', id: w.uuid('item:v1'), data: { name: '14188-1 - PLT,ORIF,24.0MM', code: '14188-1', unitId: w.uuid('unit:Nos'), itemType: 'trading' } } }));
  await addMember(db.pool, w.companyId, viewer, 'viewer');
  // a role that may see the masters, and nothing else
  await db.pool.query(`insert into public.app_roles (role) values ('lookonly') on conflict do nothing`);
  await db.pool.query(`insert into public.role_permissions (role, permission) values ('lookonly', 'master.view') on conflict do nothing`);
  await db.pool.query(`insert into auth.users (id, email) values ($1, $2)`, [limited, `${limited}@example.test`]);
  await db.pool.query(`insert into public.company_members (company_id, user_id, role) values ($1, $2, 'lookonly')`, [w.companyId, limited]);
  await db.pool.query(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `${stranger}@example.test`]);
});
afterAll(async () => {
  await db?.close();
});

describe('asking the assistant', () => {
  it('a look-up answers from the books, and the answer says where it came from', async () => {
    const r = await ask('call stock {"item":"14188"}');
    expect(r.body.ok).toBe(true);
    expect(result(r)).toMatchObject({ found: true, code: '14188', inStock: '0 Nos' });
    expect(r.body.value?.sources).toEqual(['stock']);
    expect(lastSystem).toContain('Never guess');
  });

  it('a general question needs no look-up, and carries no "from ERP" source', async () => {
    const r = await ask('density of SS304?');
    expect(r.body.value).toEqual({ answer: 'general answer', sources: [], facts: 0 });
  });

  it('what is on screen goes into the instructions, read from the books', async () => {
    await ask('what is this?', w.ownerId, w.companyId, { type: 'master', kind: 'stockItem', id: w.uuid('item:v1') });
    expect(lastSystem).toContain('Stock item 14188-1 — 14188-1 - PLT,ORIF,24.0MM');
  });

  it("a look-up the person's role may not use is refused to the model — never the data", async () => {
    const r = await ask('call stock {"item":"14188"}', limited);
    expect(result(r)).toEqual({ error: 'Not permitted: this sign-in may not see that (report.view)' });
    expect(result(await ask('call find_items {"query":"14188"}', limited))).toMatchObject({ found: 2 });
  });

  it('someone not in the company, or no sign-in, gets nothing', async () => {
    expect((await ask('call stock {"item":"14188"}', stranger)).body).toMatchObject({ ok: false, issues: [{ code: 'PERMISSION_DENIED' }] });
    expect((await ask('hi', null)).status).toBe(401);
  });
});

describe('teaching the assistant', () => {
  it('a taught fact is kept in the books and reaches the next question; forgetting removes it', async () => {
    const taught = result(await ask('call remember {"fact":"We keep 50 blanks of 14188."}'));
    expect(taught).toEqual({ saved: true, number: 1 });
    await ask('anything');
    expect(lastSystem).toContain('1. We keep 50 blanks of 14188.');
    const { rows } = await db.pool.query(`select text from public.assistant_facts where company_id = $1`, [w.companyId]);
    expect(rows).toEqual([{ text: 'We keep 50 blanks of 14188.' }]);

    expect(result(await ask('call forget {"number":"1"}'))).toEqual({ forgotten: true, text: 'We keep 50 blanks of 14188.' });
    await ask('anything');
    expect(lastSystem).toContain('You have not been taught anything yet.');
  });

  it('a viewer may ask but not teach', async () => {
    const r = result(await ask('call remember {"fact":"Something."}', viewer));
    expect(r).toMatchObject({ saved: false });
    const { rows } = await db.pool.query(`select count(*)::int as n from public.assistant_facts where company_id = $1`, [w.companyId]);
    expect(rows[0]).toEqual({ n: 0 });
  });
});
