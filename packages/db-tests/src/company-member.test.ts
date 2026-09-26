/**
 * One extra person per company (ADR-0025, step 2): the owner links an account (made in Supabase) to a company by its email; that person
 * then has full use of that company, and of nothing else — not the owner's other companies, not managing access, not creating companies.
 */
import { PostgresBackend, createPostingHandler } from '@minimalerp/adapter-postgres';
import { IssueCode } from '@minimalerp/domain';
import { payment } from '@minimalerp/testkit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type PgWorld, pgWorldFactory } from './harness/pgWorld';
import { type TestDb, createTestDb } from './harness/testDb';

let db: TestDb;
let w: PgWorld;
let second: string; // the owner's other company
const helper = randomUUID();
const helperEmail = `Helper.${helper.slice(0, 8)}@Example.test`;
const other = randomUUID();
const otherEmail = `other.${other.slice(0, 8)}@example.test`;

const handler = createPostingHandler({
  authenticate: async (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
    return m?.[1] ? { userId: m[1] } : undefined;
  },
  gatewayFor: (actorId, requestId) => new PostgresBackend(db.pool, { actorId, requestId }),
});

type Envelope<T = unknown> = { ok: true; value: T } | { ok: false; issues: { code: string; message: string }[] };
const call = async <T = unknown>(body: unknown, user: string = w.ownerId): Promise<Envelope<T>> => {
  const res = await handler(
    new Request('http://localhost/functions/v1/post-voucher', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${user}` },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as Envelope<T>;
};
const codes = (e: Envelope) => (e.ok ? [] : e.issues.map((i) => i.code));
type User = { user: { email: string; since: string } | null };

beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
  w = await pgWorldFactory(db)();
  await db.pool.query(`insert into auth.users (id, email) values ($1, $2), ($3, $4)`, [helper, helperEmail.toLowerCase(), other, otherEmail]);
  const made = await call<{ companyId: string }>({ action: 'company-create', company: { name: 'Second Works', fyStart: '2024-04-01' } });
  if (!made.ok) throw new Error(JSON.stringify(made.issues));
  second = made.value.companyId;
});
afterAll(async () => {
  await db?.close();
});

describe('the company’s one extra person', () => {
  it('has none to begin with', async () => {
    const r = await call<User>({ action: 'company-user', companyId: w.companyId });
    expect(r.ok && r.value.user).toBeNull();
  });

  it('refuses an email with no account, naming where to make it', async () => {
    const r = await call({ action: 'company-user-set', companyId: w.companyId, email: 'nobody@example.test' });
    expect(codes(r)).toEqual([IssueCode.MasterNotFound]);
    expect(!r.ok && r.issues[0]?.message).toMatch(/Supabase/);
  });

  it('links the account by its email (any case), and they see that company — only that one', async () => {
    const r = await call<User>({ action: 'company-user-set', companyId: w.companyId, email: ` ${helperEmail} ` });
    expect(r.ok && r.value.user?.email).toBe(helperEmail.toLowerCase());
    const theirs = await call<{ companies: { id: string; role: string }[] }>({ action: 'companies' }, helper);
    expect(theirs.ok && theirs.value.companies.map((c) => [c.id, c.role])).toEqual([[w.companyId, 'member']]);
  });

  it('gives them full use of that company: they post, read and change masters', async () => {
    const posted = await call({ action: 'post', companyId: w.companyId, draft: payment(w, { id: 'm1', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, '10']] }).voucher }, helper);
    expect(codes(posted)).toEqual([]);
    expect((await call({ action: 'load', companyId: w.companyId }, helper)).ok).toBe(true);
    expect((await call({ action: 'vouchers', companyId: w.companyId }, helper)).ok).toBe(true);
  });

  it('shows them nothing of the owner’s other company', async () => {
    for (const action of ['load', 'vouchers', 'inbox', 'lines', 'stock']) {
      const r = await call({ action, companyId: second }, helper);
      expect(r.ok, action).toBe(false);
    }
    const posted = await call({ action: 'post', companyId: second, draft: payment(w, { id: 'm2', date: '2024-05-10', account: w.ledgers.bank, lines: [[w.ledgers.rent, '10']] }).voucher }, helper);
    expect(posted.ok).toBe(false);
  });

  it('does not let them manage access or create companies', async () => {
    expect(codes(await call({ action: 'company-user', companyId: w.companyId }, helper))).toEqual([IssueCode.PermissionDenied]);
    expect(codes(await call({ action: 'company-user-set', companyId: w.companyId, email: otherEmail }, helper))).toEqual([IssueCode.PermissionDenied]);
    const created = await call({ action: 'company-create', company: { name: 'Sneaky Co', fyStart: '2024-04-01' } }, helper);
    expect(codes(created)).toEqual([IssueCode.UnsupportedOperation]);
  });

  it('refuses to make the same person the user of a second company', async () => {
    const r = await call({ action: 'company-user-set', companyId: second, email: helperEmail });
    expect(codes(r)).toEqual([IssueCode.UnsupportedOperation]);
    expect(!r.ok && r.issues[0]?.message).toMatch(/another company/);
  });

  it('refuses the owner’s own account', async () => {
    const owner = await db.pool.query(`select email from auth.users where id = $1`, [w.ownerId]);
    const r = await call({ action: 'company-user-set', companyId: w.companyId, email: String(owner.rows[0]?.email) });
    expect(codes(r)).toEqual([IssueCode.UnsupportedOperation]);
  });

  it('is one person: a new email replaces the old, who then sees nothing', async () => {
    const r = await call<User>({ action: 'company-user-set', companyId: w.companyId, email: otherEmail });
    expect(r.ok && r.value.user?.email).toBe(otherEmail);
    const members = await db.pool.query(`select user_id from public.company_members where company_id = $1 and role = 'member'`, [w.companyId]);
    expect(members.rows.map((x) => x.user_id)).toEqual([other]);
    const gone = await call<{ companies: unknown[] }>({ action: 'companies' }, helper);
    expect(gone.ok && gone.value.companies).toEqual([]);
  });

  it('a blank email removes them, and the change is in the audit log', async () => {
    const r = await call<User>({ action: 'company-user-set', companyId: w.companyId, email: '' });
    expect(r.ok && r.value.user).toBeNull();
    const audit = await db.pool.query(`select count(*)::int as n from public.audit_log where company_id = $1 and action = 'company.member'`, [w.companyId]);
    expect(audit.rows[0]?.n).toBe(3);
  });
});

describe('the member role', () => {
  it('holds every permission the owner holds except company.admin (later migrations must give both)', async () => {
    const r = await db.pool.query(
      `(select permission from public.role_permissions where role = 'owner' and permission <> 'company.admin'
        except select permission from public.role_permissions where role = 'member')
       union all
       (select permission from public.role_permissions where role = 'member'
        except select permission from public.role_permissions where role = 'owner')`,
    );
    expect(r.rows).toEqual([]);
    const admin = await db.pool.query(`select 1 from public.role_permissions where role = 'member' and permission = 'company.admin'`);
    expect(admin.rows).toEqual([]);
  });
});
