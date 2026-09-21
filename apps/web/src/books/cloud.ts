import { type CompanyId, type Result, IssueCode, fail, issue, ok } from '@minimalerp/domain';
import { Books, type BooksBackend, type BooksFactory, type NewCompany, newCompanyIssues } from './books';
import type { KeyValueStore } from './store';

/** What the factory needs from the online backend beyond the books themselves: which company is this account's, and making it. */
export interface CloudBackend extends BooksBackend {
  companies(): Promise<Result<readonly { readonly id: CompanyId; readonly name: string }[]>>;
  createCompany(input: NewCompany): Promise<Result<{ readonly companyId: CompanyId }>>;
}

export interface CloudFactoryOptions {
  readonly backend: CloudBackend;
  /** Where half-entered vouchers wait between visits. They are the person's own scratch work, so they stay on this device. */
  readonly drafts?: KeyValueStore | undefined;
}

/**
 * The company that lives online. It is not saved by the browser at all: opening it asks the server which company this account owns,
 * and every change goes to the server, which validates and commits it. There is nothing to discard here (the browser holds no copy),
 * and no sample company (this is someone's real books).
 */
export function createCloudFactory({ backend, drafts }: CloudFactoryOptions): BooksFactory {
  const open = async (companyId: CompanyId): Promise<Books> => {
    const books = new Books(backend, companyId, await backend.load(companyId), drafts);
    await books.loadData();
    return books;
  };

  return {
    allowsDemo: false,

    /** Undefined when the account has no company yet (the person is then offered to create one). Throws when the server cannot be asked. */
    async restore() {
      const listed = await backend.companies();
      if (!listed.ok) throw new Error(listed.issues.map((i) => i.message).join('; '));
      const mine = listed.value[0];
      return mine ? open(mine.id) : undefined;
    },

    async create(input: NewCompany) {
      const problems = newCompanyIssues(input);
      if (problems.length > 0) return fail<Books>(...problems);
      const created = await backend.createCompany(input);
      if (!created.ok) return created;
      try {
        return ok(await open(created.value.companyId));
      } catch (error) {
        // The company exists on the server; only opening it failed. Saying so beats offering to create it again.
        return fail(issue(IssueCode.UnsupportedOperation, `The company was created, but could not be opened: ${String(error instanceof Error ? error.message : error)}. Reload the page.`));
      }
    },
  };
}
