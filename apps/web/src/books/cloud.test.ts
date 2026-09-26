import { MemoryBackend } from '@minimalerp/adapter-memory';
import { type CompanyId, type NewCompany, IssueCode, asCompanyId, fail, issue, ok, seedCompany, deterministicUuid, localDate } from '@minimalerp/domain';
import { describe, expect, it, vi } from 'vitest';
import { BooksHost } from './books';
import { type CloudBackend, createCloudFactory } from './cloud';
import { createLocalFactory, memoryStore } from './local';

/**
 * A stand-in for the online backend: an in-memory backend per company holds the books (it enforces every rule, as the server does), and
 * the account-level calls the factory needs — which companies are mine, and make one — are played by this test.
 */
function fakeOnline(options: { existing?: boolean; listFails?: boolean; ownsNone?: boolean } = {}) {
  const backends = new Map<string, MemoryBackend>();
  const mine: { id: CompanyId; name: string; role: string }[] = [];
  const add = (name: string, role = 'owner') => {
    const seeded = seedCompany({ name, fyStart: localDate('2024-04-01'), newId: (n) => deterministicUuid(`cloud-test|${name}|${n}`) });
    backends.set(seeded.company.id, new MemoryBackend(seeded));
    mine.push({ id: asCompanyId(seeded.company.id), name, role });
    return asCompanyId(seeded.company.id);
  };
  if (options.existing) add('Existing Co', options.ownsNone ? 'member' : 'owner');
  const createCompany = vi.fn(async (input: NewCompany) => {
    if (mine.length > 0 && !mine.some((c) => c.role === 'owner')) return fail(issue(IssueCode.UnsupportedOperation, 'Only the owner of the books can create a company'));
    return ok({ companyId: add(input.name) });
  });
  const setCompanyUser = vi.fn(async (_id: CompanyId, email: string) => ok(email ? { email, since: '2026-09-26' } : null));
  const companies = vi.fn(async (_open?: CompanyId) => (options.listFails ? fail(issue('REQUEST_FAILED', 'offline')) : ok([...mine])));
  // Every books call names its company, either as the first argument or as `companyId` on it: route it to that company's backend.
  const backendOf = (arg: unknown) => backends.get(typeof arg === 'string' ? arg : String((arg as { companyId?: string } | undefined)?.companyId));
  const online = new Proxy({} as CloudBackend, {
    get: (_t, key: string) => {
      if (key === 'companies') return companies;
      if (key === 'createCompany') return createCompany;
      if (key === 'setCompanyUser') return setCompanyUser;
      // only what the in-memory backend really has (the books ask `backend.printLayout?.(…)` for what it may not)
      if (typeof (MemoryBackend.prototype as unknown as Record<string, unknown>)[key] !== 'function') return undefined;
      return (...args: unknown[]) => {
        const backend = backendOf(args[0]) ?? [...backends.values()][0]!;
        return (backend as unknown as Record<string, (...a: unknown[]) => unknown>)[key]!(...args);
      };
    },
  });
  return { online, createCompany, companies, add, setCompanyUser };
}

function remembered(initial?: string) {
  let value = initial;
  return {
    get: () => value,
    set: (id: string) => void (value = id),
    get value() {
      return value;
    },
  };
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

  it('passes the server’s refusal on (someone given access to a company cannot make one)', async () => {
    const { online } = fakeOnline({ existing: true, ownsNone: true });
    const r = await createCloudFactory({ backend: online }).create({ name: 'Second', fyStart: '2024-04-01' });
    expect(!r.ok && r.issues[0]?.code).toBe(IssueCode.UnsupportedOperation);
  });
});

describe('several companies online', () => {
  it('opens the company opened last on this device, asking the server for its books with the list', async () => {
    const { online, add, companies } = fakeOnline({ existing: true });
    const second = add('Second Co');
    const last = remembered(second);
    const books = await createCloudFactory({ backend: online, lastOpened: last }).restore();
    expect(books?.masters.company.name).toBe('Second Co');
    expect(companies).toHaveBeenCalledWith(second);
  });

  it('opens the first company when the remembered one is not (or no longer) the account’s', async () => {
    const { online } = fakeOnline({ existing: true });
    const books = await createCloudFactory({ backend: online, lastOpened: remembered('gone') }).restore();
    expect(books?.masters.company.name).toBe('Existing Co');
  });

  it('switches to another company and remembers it', async () => {
    const { online, add } = fakeOnline({ existing: true });
    const second = add('Second Co');
    const last = remembered();
    const host = new BooksHost(createCloudFactory({ backend: online, lastOpened: last }));
    await host.restore();
    expect(host.canSwitch).toBe(true);
    expect((await host.companies()).map((c) => c.name)).toEqual(['Existing Co', 'Second Co']);
    await host.switchTo(second);
    expect(host.current?.masters.company.name).toBe('Second Co');
    expect(last.value).toBe(second);
  });

  it('creates another company while one is open, and opens it', async () => {
    const { online } = fakeOnline({ existing: true });
    const host = new BooksHost(createCloudFactory({ backend: online }));
    await host.restore();
    const r = await host.create({ name: 'Third Co', fyStart: '2024-04-01' });
    expect(r.ok).toBe(true);
    expect(host.current?.masters.company.name).toBe('Third Co');
  });

  it('the owner may set the company’s user; the company’s user may not, nor switch or create companies', async () => {
    const owned = fakeOnline({ existing: true });
    const host = new BooksHost(createCloudFactory({ backend: owned.online }));
    await host.restore();
    expect(host.ownsOpenCompany).toBe(true);
    expect(host.canManageUser).toBe(true);
    const r = await host.setCompanyUser('helper@example.test');
    expect(r.ok && r.value?.email).toBe('helper@example.test');
    expect(owned.setCompanyUser).toHaveBeenCalledWith(host.current?.masters.company.id, 'helper@example.test');

    const theirs = new BooksHost(createCloudFactory({ backend: fakeOnline({ existing: true, ownsNone: true }).online }));
    await theirs.restore();
    expect(theirs.ownsOpenCompany).toBe(false);
    expect(theirs.canManageUser).toBe(false);
  });

  it('the books kept in the browser stay one company: no switching', () => {
    const host = new BooksHost(createLocalFactory({ makeBackend: (m) => new MemoryBackend(m) as never, store: memoryStore() }));
    expect(host.canSwitch).toBe(false);
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
