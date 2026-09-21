import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type CompanyId, type NewCompany, IssueCode, asCompanyId, fail, issue, ok, seedCompany, deterministicUuid, localDate } from '@minimalerp/domain';
import { describe, expect, it, vi } from 'vitest';
import { BooksHost } from './books';
import { type CloudBackend, createCloudFactory } from './cloud';
import { createLocalFactory, memoryStore } from './local';

/**
 * A stand-in for the online backend: the in-memory backend holds the books (it enforces every rule, as the server does), and the two
 * account-level calls the factory needs — which company is mine, and make it — are played by this test.
 */
function fakeOnline(options: { existing?: boolean; listFails?: boolean } = {}) {
  const made = seedCompany({ name: 'Existing Co', fyStart: localDate('2024-04-01'), newId: (n) => deterministicUuid(`cloud-test|${n}`) });
  let mine: { id: CompanyId; name: string } | undefined = options.existing ? { id: asCompanyId(made.company.id), name: 'Existing Co' } : undefined;
  let backend = new MemoryBackend(made);
  const createCompany = vi.fn(async (input: NewCompany) => {
    if (mine) return fail(issue(IssueCode.UnsupportedOperation, 'This account already has a company'));
    const seeded = seedCompany({ name: input.name, fyStart: localDate(input.fyStart), newId: (n) => deterministicUuid(`created|${n}`) });
    backend = new MemoryBackend(seeded);
    mine = { id: asCompanyId(seeded.company.id), name: input.name };
    return ok({ companyId: mine.id });
  });
  const online = new Proxy({} as CloudBackend, {
    get: (_t, key: string) => {
      if (key === 'companies') {
        return async () => (options.listFails ? fail(issue('REQUEST_FAILED', 'offline')) : ok(mine ? [mine] : []));
      }
      if (key === 'createCompany') return createCompany;
      const member = (backend as unknown as Record<string, unknown>)[key];
      return typeof member === 'function' ? member.bind(backend) : member;
    },
  });
  return { online, createCompany };
}

describe('the online books factory', () => {
  it('opens the account’s existing company on restore, loaded and ready', async () => {
    const { online } = fakeOnline({ existing: true });
    const books = await createCloudFactory({ backend: online }).restore();
    expect(books?.masters.company.name).toBe('Existing Co');
  });

  it('restores nothing for an account with no company yet (the person is then offered to create one)', async () => {
    expect(await createCloudFactory({ backend: fakeOnline().online }).restore()).toBeUndefined();
  });

  it('cannot restore when the server cannot be asked — that is an error, not "you have no company"', async () => {
    const { online } = fakeOnline({ listFails: true });
    await expect(createCloudFactory({ backend: online }).restore()).rejects.toThrow(/offline/);
  });

  it('creates the company on the server, then opens it', async () => {
    const { online, createCompany } = fakeOnline();
    const r = await createCloudFactory({ backend: online }).create({ name: 'Acme Works', fyStart: '2024-04-01' });
    expect(r.ok && r.value.masters.company.name).toBe('Acme Works');
    expect(createCompany).toHaveBeenCalledOnce();
  });

  it('checks the details before asking the server, naming the field', async () => {
    const { online, createCompany } = fakeOnline();
    const r = await createCloudFactory({ backend: online }).create({ name: ' ', fyStart: 'soon' });
    expect(!r.ok && r.issues.map((i) => i.path).sort()).toEqual(['fyStart', 'name']);
    expect(createCompany).not.toHaveBeenCalled();
  });

  it('passes the server’s refusal on (one company per account)', async () => {
    const { online } = fakeOnline({ existing: true });
    const r = await createCloudFactory({ backend: online }).create({ name: 'Second', fyStart: '2024-04-01' });
    expect(!r.ok && r.issues[0]?.code).toBe(IssueCode.UnsupportedOperation);
  });
});

describe('what the host offers for online books', () => {
  it('no Close Company (the browser holds no copy to delete) and no demo company (these are real books)', () => {
    const host = new BooksHost(createCloudFactory({ backend: fakeOnline().online }));
    expect(host.canCreate).toBe(true);
    expect(host.canClose).toBe(false);
    expect(host.canLoadDemo).toBe(false);
  });

  it('the books kept in the browser still offer both, exactly as before', () => {
    const host = new BooksHost(createLocalFactory({ makeBackend: (m) => new MemoryBackend(m) as never, store: memoryStore() }));
    expect(host.canClose).toBe(true);
    expect(host.canLoadDemo).toBe(true);
  });

  it('closing does nothing online: the open company stays open', async () => {
    const { online } = fakeOnline({ existing: true });
    const factory = createCloudFactory({ backend: online });
    const host = new BooksHost(factory);
    host.adopt(await factory.restore());
    await host.close();
    expect(host.current?.masters.company.name).toBe('Existing Co');
  });
});
