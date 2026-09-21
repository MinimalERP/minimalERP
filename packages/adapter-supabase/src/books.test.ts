import { asCompanyId } from '@minimalerp/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseBooksBackend } from './books';
import type { InvokeResult, SupabaseLike } from './client';

const company = asCompanyId('11111111-1111-4111-8111-111111111111');

/** A client that answers every request with the next canned reply and remembers what it was sent. */
function client(replies: InvokeResult[]) {
  const sent: Record<string, unknown>[] = [];
  const invoke = vi.fn(async (_name: string, options: { body: Record<string, unknown> }) => {
    sent.push(options.body);
    return replies.shift() ?? { data: { ok: true, value: { vouchers: [], lines: [], movements: [] } }, error: null };
  });
  return { backend: new SupabaseBooksBackend({ functions: { invoke }, from: () => { throw new Error('unused'); } } as unknown as SupabaseLike), sent, invoke };
}

/** The answer to opening the books: the company list, with the books that would otherwise take four more requests. */
const opened = (companyId: string = company): InvokeResult => ({
  data: { ok: true, value: { companies: [{ id: companyId, name: 'Acme' }] }, fresh: { companyId, books: { vouchers: [], lines: [], movements: [] } } },
  error: null,
});

afterEach(() => vi.useRealTimers());

describe('what arrives with an answer, and when it may be used', () => {
  it('a change or an opening asks for the books to come with it; a plain read does not', async () => {
    const { backend, sent } = client([opened()]);
    await backend.companies();
    await backend.list(company); // served from what arrived
    await backend.lines({ companyId: company, voucherId: 'v' as never }); // not the whole journal: asks
    expect(sent[0]).toMatchObject({ action: 'companies', fresh: true });
    expect(sent[1]).toMatchObject({ action: 'lines' });
    expect(sent[1]).not.toHaveProperty('fresh');
  });

  it('serves each of the three books reads from it once, with no request', async () => {
    const { backend, invoke } = client([opened()]);
    await backend.companies();
    invoke.mockClear();
    await Promise.all([backend.list(company), backend.lines({ companyId: company }), backend.stockMovements({ companyId: company })]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('is used once: the same question asked again goes to the server', async () => {
    const { backend, invoke } = client([opened()]);
    await backend.companies();
    await backend.list(company);
    await backend.list(company);
    expect(invoke).toHaveBeenCalledTimes(2); // companies, then the second list
  });

  it('is not used for another company', async () => {
    const { backend, invoke } = client([opened()]);
    await backend.companies();
    await backend.list(asCompanyId('22222222-2222-4222-8222-222222222222'));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('goes stale: after five seconds it can no longer answer, so an old change never answers a much later question', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    const { backend, invoke } = client([opened()]);
    await backend.companies();
    vi.setSystemTime(new Date('2026-01-01T10:00:06Z'));
    await backend.list(company);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('a refused change leaves nothing behind to be used', async () => {
    const { backend, invoke } = client([{ data: { ok: false, issues: [{ code: 'X', message: 'no' }] }, error: null }]);
    await backend.companies();
    await backend.list(company);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
