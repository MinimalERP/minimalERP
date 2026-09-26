/**
 * Emailing a voucher to its party (`send-mail` on the post-voucher function): only to that party's own addresses, only for someone who may
 * see the voucher, through THAT company's own Gmail script (mocked here; ADR-0025), with an audit line — and never the script's secret in
 * an answer.
 */
import { createPostingHandler, PostgresBackend, type MailScript, type OutgoingMail, type MailResult } from '@minimalerp/adapter-postgres';
import { mustOk } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgMasterWorld, pgMasterWorldFactory } from './harness/pgMasterWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgMasterWorld;
let quoteId: string;
const outsider = randomUUID();

const authenticate = async (req: Request) => {
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
  return m?.[1] ? { userId: m[1] } : undefined;
};
const SCRIPT = { url: 'https://script.google.com/macros/s/AKfy-company-one_1/exec', secret: 'company-one-secret' };
const handlerWith = (sendMail?: (m: OutgoingMail, script: MailScript) => Promise<MailResult>) =>
  createPostingHandler({ authenticate, gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }), ...(sendMail ? { sendMail } : {}) });

const ask = async (handler: ReturnType<typeof createPostingHandler>, userId: string, body: Record<string, unknown>) => {
  const res = await handler(
    new Request('http://localhost/functions/v1/post-voucher', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userId}` },
      body: JSON.stringify({ action: 'send-mail', companyId: w.companyId, voucherId: quoteId, subject: 'Quotation', body: 'Dear Acme,\nPlease find it attached.', ...body }),
    }),
  );
  return { text: await res.clone().text(), json: (await res.json()) as { ok: boolean; value?: { sentTo: string[] }; issues?: { code: string; message: string }[] } };
};
const pdf = { name: 'QT-0001-signed.pdf', base64: Buffer.from('%PDF-1.4 signed').toString('base64') };
const sheet = { name: 'rates.xlsx', base64: Buffer.from('PK sheet').toString('base64') };

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgMasterWorldFactory(db)();
  await db.pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [outsider, `${outsider}@example.test`]);
  const run = async (kind: string, id: string, data: unknown) => mustOk(await w.backend.execute({ companyId: w.companyId, command: { op: 'create', kind, id, data } }));
  await run('stockItem', w.uuid('item:bolt'), { name: 'Bolt', unitId: w.uuid('unit:Nos'), itemType: 'finished' });
  await run('party', w.uuid('party:acme'), { name: 'Acme Ltd', roles: ['customer'], email: 'sales@acme.in, accounts@acme.in' });
  await run('party', w.uuid('party:other'), { name: 'Other Co', roles: ['customer'], email: 'buyer@other.in' });
  mustOk(await w.backend.setCompanyMail(w.companyId, SCRIPT.url, SCRIPT.secret));
  quoteId = randomUUID();
  mustOk(
    await w.backend.post({
      companyId: w.companyId,
      draft: {
        id: quoteId,
        voucherTypeId: w.uuid('type:quotation'),
        date: '2024-05-01',
        partyId: w.uuid('party:acme'),
        partyDetails: { partyId: w.uuid('party:acme'), mailingName: 'Acme Ltd' },
        lines: [{ id: 'a', itemId: w.uuid('item:bolt'), qty: '10', rate: '55' }],
      },
    }),
  );
});
afterAll(async () => {
  await db?.close();
});

describe('emailing a voucher to its party', () => {
  it('goes to the party’s own addresses through the Gmail script, in the voucher’s style, with the PDF — and is audited', async () => {
    const sent: OutgoingMail[] = [];
    const via: MailScript[] = [];
    const r = await ask(handlerWith(async (m, s) => (sent.push(m), via.push(s), { ok: true })), w.ownerId, { to: ['sales@acme.in', 'ACCOUNTS@acme.in'], attachments: [pdf, sheet] });
    expect(via).toEqual([SCRIPT]); // this company's own Gmail
    expect(r.json).toEqual({ ok: true, value: { sentTo: ['sales@acme.in', 'ACCOUNTS@acme.in'] } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['sales@acme.in', 'ACCOUNTS@acme.in'], subject: 'Quotation', text: 'Dear Acme,\nPlease find it attached.', attachments: [pdf, sheet] });
    expect(sent[0]!.html).toContain('Consolas'); // the typewriter font of the print
    expect(sent[0]!.html).toMatch(/QT\/[^<]*0001/); // the document summary, from the voucher itself
    expect(sent[0]!.html).toContain('Please find it attached.');
    const audit = await db.pool.query(`select after from public.audit_log where entity_id = $1 and action = 'voucher.mail'`, [quoteId]);
    expect(audit.rows.map((x) => x['after'])).toEqual([{ to: ['sales@acme.in', 'ACCOUNTS@acme.in'] }]); // who, never the message or the file
  });

  it('refuses an address that is not the voucher’s party’s — another party’s included — and sends nothing', async () => {
    const sent: OutgoingMail[] = [];
    const r = await ask(handlerWith(async (m) => (sent.push(m), { ok: true })), w.ownerId, { to: ['sales@acme.in', 'buyer@other.in'] });
    expect(r.json.ok).toBe(false);
    expect(r.json.issues?.map((i) => i.code)).toContain('MAIL_INVALID');
    expect(r.json.issues?.[0]?.message).toContain('buyer@other.in');
    expect(sent).toEqual([]);
  });

  it('refuses a file type that is not a document (an .exe), and more than 10 files', async () => {
    const send = handlerWith(async () => ({ ok: true }));
    const exe = await ask(send, w.ownerId, { to: ['sales@acme.in'], attachments: [pdf, { name: 'setup.exe', base64: 'AA==' }] });
    expect(exe.json.issues?.[0]?.message).toContain('setup.exe');
    const many = await ask(send, w.ownerId, { to: ['sales@acme.in'], attachments: Array.from({ length: 11 }, (_, i) => ({ ...pdf, name: `p${i}.pdf` })) });
    expect(many.json.ok).toBe(false);
  });

  it('refuses someone outside the company', async () => {
    const r = await ask(handlerWith(async () => ({ ok: true })), outsider, { to: ['sales@acme.in'] });
    expect(r.json.issues?.map((i) => i.code)).toEqual(['PERMISSION_DENIED']);
  });

  it('says so when emailing is not set up, and when Gmail refuses', async () => {
    expect((await ask(handlerWith(), w.ownerId, { to: ['sales@acme.in'] })).json.issues?.map((i) => i.code)).toEqual(['MAIL_NOT_SET_UP']);
    mustOk(await w.backend.setCompanyMail(w.companyId, '', ''));
    const none = await ask(handlerWith(async () => ({ ok: true })), w.ownerId, { to: ['sales@acme.in'] });
    expect(none.json.issues?.map((i) => i.code)).toEqual(['MAIL_NOT_SET_UP']);
    expect(none.json.issues?.[0]?.message).toContain('Company Gmail');
    mustOk(await w.backend.setCompanyMail(w.companyId, SCRIPT.url, SCRIPT.secret));
    const failed = await ask(handlerWith(async () => ({ ok: false, message: 'Service invoked too many times for one day: email.' })), w.ownerId, { to: ['sales@acme.in'] });
    expect(failed.json.issues?.map((i) => i.code)).toEqual(['MAIL_FAILED']);
    expect(failed.json.issues?.[0]?.message).toContain('too many times');
  });

  it('the company’s own templates are stored and come back when the books are opened', async () => {
    const m = await w.backend.load(w.companyId);
    mustOk(
      await w.backend.execute({
        companyId: w.companyId,
        command: { op: 'alter', kind: 'company', id: w.companyId, data: { name: m.company.name, emailTemplates: { quotation: { subject: 'Our quote {number}', body: 'Hello {party}' } } } },
      }),
    );
    expect((await w.backend.load(w.companyId)).company.emailTemplates).toEqual({ quotation: { subject: 'Our quote {number}', body: 'Hello {party}' } });
  });

  it('never answers with the script’s secret', async () => {
    const r = await ask(handlerWith(async () => ({ ok: true })), w.ownerId, { to: ['sales@acme.in'], secret: 'should-not-echo' });
    expect(r.text).not.toContain('should-not-echo');
  });
});

describe('each company’s own Gmail script', () => {
  const settings = (userId: string, body: Record<string, unknown>) =>
    handlerWith()(
      new Request('http://localhost/functions/v1/post-voucher', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${userId}` },
        body: JSON.stringify({ companyId: w.companyId, ...body }),
      }),
    ).then(async (res) => ({ text: await res.clone().text(), json: (await res.json()) as { ok: boolean; value?: { script: { url: string } | null }; issues?: { code: string; message: string }[] } }));

  it('shows the owner the address, never the secret', async () => {
    const r = await settings(w.ownerId, { action: 'company-mail' });
    expect(r.json.value?.script?.url).toBe(SCRIPT.url);
    expect(r.text).not.toContain(SCRIPT.secret);
  });

  it('keeps the secret when only the address changes, and refuses an address that is not a Gmail script', async () => {
    const moved = 'https://script.google.com/macros/s/AKfy-company-one_2/exec';
    const r = await settings(w.ownerId, { action: 'company-mail-set', url: moved, secret: '' });
    expect(r.json.value?.script?.url).toBe(moved);
    expect(await w.backend.mailScriptOf(w.companyId)).toEqual({ url: moved, secret: SCRIPT.secret });
    const bad = await settings(w.ownerId, { action: 'company-mail-set', url: 'https://evil.example/steal', secret: 'whatever-secret' });
    expect(bad.json.issues?.map((i) => i.code)).toEqual(['SCHEMA_INVALID']);
    mustOk(await w.backend.setCompanyMail(w.companyId, SCRIPT.url, SCRIPT.secret));
  });

  it('is the owner’s to set: the company’s own user, and anyone outside, are refused', async () => {
    const helper = randomUUID();
    await db.pool.query(`insert into auth.users (id, email) values ($1, $2)`, [helper, `${helper}@example.test`]);
    await db.pool.query(`insert into public.company_members (company_id, user_id, role) values ($1, $2, 'member')`, [w.companyId, helper]);
    for (const user of [helper, outsider]) {
      expect((await settings(user, { action: 'company-mail' })).json.issues?.map((i) => i.code)).toEqual(['PERMISSION_DENIED']);
      expect((await settings(user, { action: 'company-mail-set', url: SCRIPT.url, secret: 'mine-now-123' })).json.issues?.map((i) => i.code)).toEqual(['PERMISSION_DENIED']);
    }
    expect(await w.backend.mailScriptOf(w.companyId)).toEqual(SCRIPT);
  });

  it('is not readable through row-level security by the company’s own user, nor by anyone outside; the owner reads it', async () => {
    const seen = (userId: string) => db.asRole('authenticated', userId, async (c) => (await c.query('select url from public.company_mail_scripts')).rows.length);
    expect(await seen(outsider)).toBe(0);
    const helper = (await db.pool.query(`select user_id from public.company_members where company_id = $1 and role = 'member'`, [w.companyId])).rows[0]?.['user_id'] as string;
    expect(await seen(helper)).toBe(0);
    expect(await seen(w.ownerId)).toBe(1);
  });
});
