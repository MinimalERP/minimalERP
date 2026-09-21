import {
  IssueCode,
  asCompanyId,
  asVoucherId,
  formatMoney,
  localDate,
  money,
} from '@minimalerp/domain';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { FilterBuilder, InvokeResult, QueryResult, SupabaseLike } from './client';
import { REQUEST_FAILED, SupabasePostingGateway } from './gateway';
import { PAGE_SIZE, SupabaseJournalRepository } from './journal';

const company = asCompanyId('11111111-1111-4111-8111-111111111111');
const voucherId = asVoucherId('22222222-2222-4222-8222-222222222222');

const voucherWire = {
  id: voucherId, companyId: company, voucherTypeId: 't', financialYearId: 'f', number: 'PAY/24-25/0001',
  date: '2024-05-10', status: 'posted', version: 1, revision: 0, content: { id: voucherId, voucherTypeId: 't', date: '2024-05-10' },
};
const lineWire = (amount: string, side: 'debit' | 'credit', no: number) => ({
  voucherId, lineNo: no, date: '2024-05-10', ledgerId: 'l1', side, amount, narration: null,
});

function fakeClient(reply: InvokeResult | (() => InvokeResult)) {
  const invoke = vi.fn(async (_name: string, _opts: { body: Record<string, unknown> }) => (typeof reply === 'function' ? reply() : reply));
  const client = { functions: { invoke }, from: () => { throw new Error('unused'); } } as unknown as SupabaseLike;
  return { client, invoke };
}

describe('SupabasePostingGateway', () => {
  it('post: sends INTENT only (company + draft), money as decimal strings, to the post-voucher function', async () => {
    const { client, invoke } = fakeClient({
      data: { ok: true, value: { voucher: voucherWire, journal: [lineWire('1234.56', 'debit', 1), lineWire('1234.56', 'credit', 2)], replayed: false } },
      error: null,
    });
    const draft = { id: voucherId, lines: [{ amount: money(123456n) }] }; // a browser draft holds bigint money
    const r = await new SupabasePostingGateway(client).post({ companyId: company, draft });

    expect(invoke).toHaveBeenCalledOnce();
    const [name, opts] = invoke.mock.calls[0]!;
    expect(name).toBe('post-voucher');
    expect(opts.body).toEqual({
      action: 'post',
      companyId: company,
      draft: { id: voucherId, lines: [{ amount: '1234.56' }] }, // bigint → string; never a JS number
    });
    expect(JSON.stringify(opts.body)).not.toContain('journal'); // the browser never sends journal lines

    if (!r.ok) throw new Error('expected ok');
    expect(r.value.voucher).toMatchObject({ number: 'PAY/24-25/0001', version: 1, date: '2024-05-10' });
    expect(r.value.plan.journal.map((l) => [l.side, l.amount])).toEqual([['debit', 123456n], ['credit', 123456n]]);
    expect(r.value.replayed).toBe(false);
  });

  it('alter and cancel send the voucher id and expected version', async () => {
    const { client, invoke } = fakeClient({
      data: { ok: true, value: { voucher: { ...voucherWire, status: 'cancelled', version: 2 } } },
      error: null,
    });
    const gw = new SupabasePostingGateway(client);
    const cancelled = await gw.cancel({ companyId: company, voucherId, expectedVersion: 1 });
    expect(invoke.mock.calls[0]![1].body).toEqual({ action: 'cancel', companyId: company, voucherId, expectedVersion: 1 });
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled');

    invoke.mockResolvedValueOnce({ data: { ok: true, value: { voucher: voucherWire, journal: [], replayed: false } }, error: null });
    await gw.alter({ companyId: company, voucherId, expectedVersion: 3, draft: { a: 1 } });
    expect(invoke.mock.calls[1]![1].body).toEqual({ action: 'alter', companyId: company, voucherId, expectedVersion: 3, draft: { a: 1 } });
  });

  it('a business refusal comes back as ordinary issues', async () => {
    const { client } = fakeClient({
      data: { ok: false, issues: [{ code: IssueCode.Unbalanced, message: 'Debit ≠ credit', path: 'entries' }] },
      error: null,
    });
    const r = await new SupabasePostingGateway(client).post({ companyId: company, draft: {} });
    expect(r).toEqual({ ok: false, issues: [{ code: IssueCode.Unbalanced, message: 'Debit ≠ credit', path: 'entries' }] });
  });

  it('a non-2xx reply (supabase-js error) is unwrapped: the server’s own issues are surfaced', async () => {
    const context = { json: async () => ({ ok: false, issues: [{ code: 'UNAUTHENTICATED', message: 'Sign in to continue' }] }) };
    const { client } = fakeClient({ data: null, error: { message: 'Edge Function returned a non-2xx status code', context } });
    const r = await new SupabasePostingGateway(client).post({ companyId: company, draft: {} });
    expect(r).toEqual({ ok: false, issues: [{ code: 'UNAUTHENTICATED', message: 'Sign in to continue' }] });
  });

  it('a network failure or non-JSON error becomes REQUEST_FAILED, never a thrown error or a silent success', async () => {
    const down = fakeClient({ data: null, error: { message: 'Failed to send a request to the Edge Function' } });
    expect(await new SupabasePostingGateway(down.client).post({ companyId: company, draft: {} })).toEqual({
      ok: false,
      issues: [{ code: REQUEST_FAILED, message: 'Failed to send a request to the Edge Function' }],
    });

    const html = fakeClient({ data: null, error: { message: 'bad gateway', context: { json: async () => { throw new Error('not json'); } } } });
    const r = await new SupabasePostingGateway(html.client).post({ companyId: company, draft: {} });
    expect(r.ok === false && r.issues[0]?.code).toBe(REQUEST_FAILED);
  });

  it('an unrecognisable success body is refused rather than trusted', async () => {
    const { client } = fakeClient({ data: '<html>proxy error</html>', error: null });
    const r = await new SupabasePostingGateway(client).post({ companyId: company, draft: {} });
    expect(r.ok === false && r.issues[0]?.code).toBe(REQUEST_FAILED);
  });
});

/** A fake PostgREST builder that records the query and serves rows page by page. */
function fakeJournal(rows: Record<string, unknown>[]) {
  const calls: string[] = [];
  const builder = (range: [number, number] = [0, PAGE_SIZE - 1]): FilterBuilder => {
    const self: FilterBuilder = {
      eq: (c, v) => (calls.push(`eq ${c}=${String(v)}`), self),
      gte: (c, v) => (calls.push(`gte ${c}=${String(v)}`), self),
      lte: (c, v) => (calls.push(`lte ${c}=${String(v)}`), self),
      order: (c, o) => (calls.push(`order ${c} ${o?.ascending === false ? 'desc' : 'asc'}`), self),
      range: (from, to) => (range = [from, to], calls.push(`range ${from}-${to}`), self),
      then: (ok, err) => Promise.resolve<QueryResult>({ data: rows.slice(range[0], range[1] + 1), error: null }).then(ok, err),
    };
    return self;
  };
  const selects: string[] = [];
  const client = { functions: { invoke: vi.fn() }, from: () => ({ select: (cols: string) => (selects.push(cols), builder()) }) } as unknown as SupabaseLike;
  return { client, calls, selects };
}

describe('SupabaseJournalRepository', () => {
  const row = (i: number, debit: string, credit: string) => ({
    voucher_id: voucherId, line_no: i, entry_date: '2024-05-10', ledger_id: 'l1', debit, credit, narration: i === 1 ? 'note' : null,
  });

  it('reads amounts as TEXT (never JSON numbers) and maps them to exact bigint money', async () => {
    const { client, selects } = fakeJournal([row(1, '9007199254740993.01', '0.00'), row(2, '0.00', '9007199254740993.01')]);
    const lines = await new SupabaseJournalRepository(client).lines({ companyId: company });

    expect(selects[0]).toContain('debit:debit::text');
    expect(selects[0]).toContain('credit:credit::text');
    expect(lines.map((l) => [l.side, l.amount])).toEqual([['debit', 900719925474099301n], ['credit', 900719925474099301n]]);
    expect(formatMoney(lines[0]!.amount)).toBe('9007199254740993.01');
    expect(lines[0]).toMatchObject({ voucherId, lineNo: 1, date: '2024-05-10', narration: 'note' });
    expect(lines[1]?.narration).toBeUndefined();
  });

  it('pushes every filter into the query and orders deterministically', async () => {
    const { client, calls } = fakeJournal([]);
    await new SupabaseJournalRepository(client).lines({
      companyId: company, ledgerId: 'L' as never, voucherId, from: localDate('2024-04-01'), to: localDate('2024-06-30'),
    });
    expect(calls).toEqual([
      `eq company_id=${company}`, 'eq ledger_id=L', `eq voucher_id=${voucherId}`, 'gte entry_date=2024-04-01', 'lte entry_date=2024-06-30',
      'order entry_date asc', 'order voucher_id asc', 'order line_no asc', `range 0-${PAGE_SIZE - 1}`,
    ]);
  });

  it('pages through more rows than one request returns, and stops at the first short page', async () => {
    const total = PAGE_SIZE * 2 + 5;
    const rows = Array.from({ length: total }, (_, i) => row(i + 1, '1.00', '0.00'));
    const { client, calls } = fakeJournal(rows);
    const lines = await new SupabaseJournalRepository(client).lines({ companyId: company });

    expect(lines).toHaveLength(total);
    expect(calls.filter((c) => c.startsWith('range'))).toEqual([
      `range 0-${PAGE_SIZE - 1}`, `range ${PAGE_SIZE}-${2 * PAGE_SIZE - 1}`, `range ${2 * PAGE_SIZE}-${3 * PAGE_SIZE - 1}`,
    ]);
  });

  it('an exact multiple of the page size costs one extra (empty) request, and still terminates', async () => {
    const { client, calls } = fakeJournal(Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1, '1.00', '0.00')));
    expect(await new SupabaseJournalRepository(client).lines({ companyId: company })).toHaveLength(PAGE_SIZE);
    expect(calls.filter((c) => c.startsWith('range'))).toHaveLength(2);
  });

  it('surfaces a read error instead of returning a partial journal', async () => {
    const failing = {
      functions: { invoke: vi.fn() },
      from: () => ({ select: () => { const b: FilterBuilder = { eq: () => b, gte: () => b, lte: () => b, order: () => b, range: () => b, then: (ok, err) => Promise.resolve<QueryResult>({ data: null, error: { message: 'permission denied for table journal_lines' } }).then(ok, err) }; return b; } }),
    } as unknown as SupabaseLike;
    await expect(new SupabaseJournalRepository(failing).lines({ companyId: company })).rejects.toThrow(/permission denied/);
  });
});

describe('compatibility with the real supabase-js client', () => {
  // No network: building a query does not send it, and `functions.invoke` is only referenced.
  const real = createClient('http://localhost:54321', 'anon-key');

  it('exposes functions.invoke', () => {
    expect(typeof real.functions.invoke).toBe('function');
  });

  it('provides every query-builder method the journal repository chains', () => {
    const q = real.from('journal_lines').select('a').eq('company_id', 'x').gte('entry_date', 'x').lte('entry_date', 'x')
      .order('entry_date', { ascending: true }).range(0, 9);
    expect(typeof q.then).toBe('function'); // awaitable, like FilterBuilder
    expect(q.eq).toBeTypeOf('function');
  });
});
