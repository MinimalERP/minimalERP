import { type CompanyId, type Result, IssueCode, fail, issue, ok } from '@minimalerp/domain';
import { Books, type BooksBackend, type BooksFactory, type CompanyChoice, type CompanyUser, type NewCompany, newCompanyIssues } from './books';
import type { SaveTracker } from './saving';
import type { KeyValueStore } from './store';

/** What the factory needs from the online backend beyond the books themselves: which companies are this account's, and making one. */
export interface CloudBackend extends BooksBackend {
  /** `open` names the company about to be opened, so the server can send its books along with the list. */
  companies(open?: CompanyId): Promise<Result<readonly CompanyChoice[]>>;
  createCompany(input: NewCompany): Promise<Result<{ readonly companyId: CompanyId }>>;
  companyUser(companyId: CompanyId): Promise<Result<CompanyUser | null>>;
  setCompanyUser(companyId: CompanyId, email: string): Promise<Result<CompanyUser | null>>;
}

export interface CloudFactoryOptions {
  readonly backend: CloudBackend;
  /** Where half-entered vouchers wait between visits. They are the person's own scratch work, so they stay on this device. */
  readonly drafts?: KeyValueStore | undefined;
  /** Shared for the account's session, so the saving overlay is the same object whenever the company is opened. */
  readonly saving?: SaveTracker | undefined;
  /** Which company was open last on this device, so the next visit opens it again. */
  readonly lastOpened?: { get(): string | undefined; set(companyId: string): void } | undefined;
}

/**
 * The companies that live online. They are not saved by the browser at all: opening one asks the server which companies this account
 * belongs to, and every change goes to the server, which validates and commits it. There is nothing to discard here (the browser holds
 * no copy), and no sample company (these are someone's real books). An account may have several companies; the one opened last on this
 * device is opened again, and the others are a switch away.
 */
export function createCloudFactory({ backend, drafts, saving, lastOpened }: CloudFactoryOptions): BooksFactory {
  const open = async (companyId: CompanyId): Promise<Books> => {
    const books = new Books(backend, companyId, await backend.load(companyId), drafts, saving);
    await books.loadData();
    lastOpened?.set(companyId);
    return books;
  };

  const roles = new Map<string, string>();
  const list = async (open?: CompanyId): Promise<readonly CompanyChoice[]> => {
    const listed = await backend.companies(open);
    if (!listed.ok) throw new Error(listed.issues.map((i) => i.message).join('; '));
    for (const c of listed.value) roles.set(c.id, c.role);
    return listed.value;
  };

  return {
    allowsDemo: false,

    /** Undefined when the account has no company yet (the person is then offered to create one). Throws when the server cannot be asked. */
    async restore() {
      const remembered = lastOpened?.get() as CompanyId | undefined;
      const companies = await list(remembered);
      const mine = companies.find((c) => c.id === remembered) ?? companies[0];
      return mine ? open(mine.id) : undefined;
    },

    companies: () => list(),
    open,
    roleOf: (companyId) => roles.get(companyId),
    companyUser: (companyId) => backend.companyUser(companyId),
    setCompanyUser: (companyId, email) => backend.setCompanyUser(companyId, email),

    async create(input: NewCompany) {
      const problems = newCompanyIssues(input);
      if (problems.length > 0) return fail<Books>(...problems);
      const created = await backend.createCompany(input);
      if (!created.ok) return created;
      roles.set(created.value.companyId, 'owner');
      try {
        return ok(await open(created.value.companyId));
      } catch (error) {
        // The company exists on the server; only opening it failed. Saying so beats offering to create it again.
        return fail(issue(IssueCode.UnsupportedOperation, `The company was created, but could not be opened: ${String(error instanceof Error ? error.message : error)}. Reload the page.`));
      }
    },
  };
}
