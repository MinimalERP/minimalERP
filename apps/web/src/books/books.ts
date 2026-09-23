import {
  type CompanyId,
  type IntakeKind,
  type JournalLine,
  type LocalDate,
  type MasterKind,
  type Masters,
  type NewCompany,
  type OrderBook as OrderBookType,
  type Result,
  type StockBook as StockBookType,
  type Voucher,
  type VoucherId,
  IssueCode,
  asCompanyId,
  deterministicUuid,
  orderBookOf,
  StockBook,
  fail,
  issue,
  ledgerMovements,
  ok,
  seedCompany,
  localDate,
} from '@minimalerp/domain';
import type {
  DocumentSender,
  InboxGateway,
  InboxItem,
  JournalRepository,
  MasterGateway,
  MasterOutcome,
  MastersRepository,
  PostOutcome,
  PostingGateway,
  StockRepository,
  VoucherRepository,
} from '@minimalerp/ports';
import type { KeyValueStore } from './store';
import { SaveTracker } from './saving';

export { newCompanyIssues } from '@minimalerp/domain';
export type { NewCompany };

/** Everything the screens need from a backend: master commands, posting, and reading masters back. Adapters provide it. */
export interface BooksBackend extends MasterGateway, MastersRepository, PostingGateway, VoucherRepository, JournalRepository, StockRepository, InboxGateway, DocumentSender {}

/** A backend whose state can be saved as a log of changes and rebuilt from it (the in-browser demo backend). */
export interface LocalBackend extends BooksBackend {
  changes(): readonly unknown[];
  onChange(listener: (entry: unknown) => void): () => void;
  replay(entries: readonly unknown[]): Promise<Result<void>>;
  /** Adds the GST / TDS system ledgers a company saved before they existed does not have (idempotent). */
  ensureSystemLedgers?(): void;
}

/** What is stored to rebuild a company: the seed inputs and every change since. */
export interface SavedCompany extends NewCompany {
  /** Makes every seeded id unique to this company yet reproducible, so the change log replays onto the same ids. */
  readonly idSeed: string;
}

export function seedMasters(saved: SavedCompany, options: { systemLedgers?: boolean } = {}): Masters {
  return seedCompany({
    ...(options.systemLedgers === false ? { systemLedgers: false } : {}),
    name: saved.name,
    fyStart: localDate(saved.fyStart),
    gstin: saved.gstin,
    stateCode: saved.stateCode,
    address: saved.address,
    newId: (name) => deterministicUuid(`${saved.idSeed}|${name}`),
  });
}

/**
 * One open company. Holds the current master data and is the only thing screens call to change it: a command goes to
 * the backend (which validates and applies it atomically), and the snapshot is reloaded so every screen — pickers,
 * search, lists — sees the same thing.
 */
export class Books {
  private snapshot: Masters;
  private posted: readonly Voucher[] = [];
  private journal: readonly JournalLine[] = [];
  private stockBook: StockBookType = StockBook.empty;
  private orderCache: { readonly at: readonly Voucher[]; readonly masters: Masters; readonly book: OrderBookType } | undefined;
  private balanceCache: { at: readonly JournalLine[]; map: Map<string, bigint> } | undefined;
  private readonly listeners = new Set<() => void>();
  /** While > 0, changes do not reload and announce themselves one by one (see `bulk`). */
  private bulkDepth = 0;

  constructor(
    readonly backend: BooksBackend,
    readonly companyId: CompanyId,
    initial: Masters,
    /** Where half-entered vouchers are kept between visits (optional: without it they live only on screen). */
    private readonly draftStore?: KeyValueStore,
    /** Drives the saving overlay (`shell/SavingOverlay`) for every post/alter/cancel/master change. Shared across the app session by
     * whichever factory built this `Books` (so the overlay is the same object whether the company is closed and reopened, or a
     * demo is loaded), or its own if nothing is shared — a save is tracked either way. */
    readonly saving: SaveTracker = new SaveTracker(),
  ) {
    this.snapshot = initial;
  }

  /** Opening stock for an item in a godown (a safe replay if asked twice). */
  postOpeningStock(itemId: string, warehouseId: string, qty: string, rate: string): Promise<Result<{ number: string }>> {
    return postOpeningStockFor(this, itemId, warehouseId, qty, rate);
  }

  /** Every voucher, in the order it was created (Day Book, ledgers and pickers read these). */
  get vouchers(): readonly Voucher[] {
    return this.posted;
  }

  /** Every journal line in the books. */
  get lines(): readonly JournalLine[] {
    return this.journal;
  }

  /** Every stock movement in the books, read as a book: positions, valuation, ledgers and shortfalls (derived, never stored). */
  get stock(): StockBookType {
    return this.stockBook;
  }

  /** What has been ordered and delivered: the posted sales orders and the deliveries of the posted invoices (derived, never stored). */
  get orders(): OrderBookType {
    if (this.orderCache?.at !== this.posted || this.orderCache.masters !== this.snapshot) {
      this.orderCache = { at: this.posted, masters: this.snapshot, book: orderBookOf(this.posted, this.snapshot) };
    }
    return this.orderCache.book;
  }

  voucher(id: string): Voucher | undefined {
    return this.posted.find((v) => v.id === id);
  }

  /** A ledger's balance, signed, debit positive. Derived from the journal, never stored. */
  balanceOf(ledgerId: string): bigint {
    if (this.balanceCache?.at !== this.journal) {
      const map = new Map<string, bigint>();
      for (const [id, m] of ledgerMovements(this.journal)) map.set(id, m.closing);
      this.balanceCache = { at: this.journal, map };
    }
    return this.balanceCache.map.get(ledgerId) ?? 0n;
  }

  /** Loads vouchers and journal lines. Called when a company opens and after every change to the books. */
  async loadData(): Promise<void> {
    const [vouchers, lines, movements] = await Promise.all([
      this.backend.list(this.companyId),
      this.backend.lines({ companyId: this.companyId }),
      this.backend.stockMovements({ companyId: this.companyId }),
    ]);
    this.posted = vouchers;
    this.journal = lines;
    this.stockBook = new StockBook(movements);
  }

  /** Posts a new voucher (the draft's id is its idempotency key). */
  async post(draft: unknown): Promise<Result<PostOutcome>> {
    return this.saving.track(async () => {
      const result = await this.backend.post({ companyId: this.companyId, draft });
      if (result.ok && !result.value.replayed) await this.reloadAfterChange();
      return result;
    });
  }

  async alter(voucherId: string, expectedVersion: number, draft: unknown): Promise<Result<PostOutcome>> {
    return this.saving.track(async () => {
      const result = await this.backend.alter({ companyId: this.companyId, voucherId: voucherId as VoucherId, expectedVersion, draft });
      if (result.ok) await this.reloadAfterChange();
      return result;
    });
  }

  async cancel(voucherId: string, expectedVersion: number): Promise<Result<Voucher>> {
    return this.saving.track(async () => {
      const result = await this.backend.cancel({ companyId: this.companyId, voucherId: voucherId as VoucherId, expectedVersion });
      if (result.ok) await this.reloadAfterChange();
      return result;
    });
  }

  private async reloadAfterChange(): Promise<void> {
    if (this.bulkDepth > 0) return;
    await this.loadData();
    for (const l of [...this.listeners]) l();
  }

  // ---- drafts: a half-entered voucher survives a reload ----

  async loadDraft(key: string): Promise<unknown> {
    try {
      return await this.draftStore?.get(`draft:${this.companyId}:${key}`);
    } catch {
      return undefined;
    }
  }

  async saveDraft(key: string, value: unknown): Promise<void> {
    try {
      await this.draftStore?.set(`draft:${this.companyId}:${key}`, value);
    } catch {
      /* a draft is a convenience; failing to keep one must never stop data entry */
    }
  }

  async clearDraft(key: string): Promise<void> {
    try {
      await this.draftStore?.delete(`draft:${this.companyId}:${key}`);
    } catch {
      /* see saveDraft */
    }
  }

  get masters(): Masters {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    this.snapshot = await this.backend.load(this.companyId);
    for (const l of [...this.listeners]) l();
  }

  /**
   * Runs many changes (loading a demo company, an import) and reloads and announces ONCE at the end, instead of after every one.
   * Each change is still validated and committed on its own; only the screens' refresh is deferred.
   */
  async bulk<T>(work: () => Promise<T>): Promise<T> {
    this.bulkDepth++;
    try {
      return await work();
    } finally {
      this.bulkDepth--;
      if (this.bulkDepth === 0) {
        this.snapshot = await this.backend.load(this.companyId);
        await this.loadData();
        for (const l of [...this.listeners]) l();
      }
    }
  }

  /** Create, alter or (de)activate a master. On success the snapshot is already updated when this resolves. */
  async execute(command: unknown): Promise<Result<MasterOutcome>> {
    return this.saving.track(async () => {
      const result = await this.backend.execute({ companyId: this.companyId, command });
      if (result.ok && !result.value.replayed && this.bulkDepth === 0) await this.refresh();
      return result;
    });
  }

  // ---- the AI Inbox (ADR-0023): proposals made from documents a person sent from Gmail ----

  /** The proposals waiting, oldest first. Always asked of the backend (another person may have accepted one a moment ago). */
  inbox(): Promise<Result<readonly InboxItem[]>> {
    return this.backend.inbox(this.companyId);
  }

  /** Upload: sends a file to be read into a proposal (it appears in the inbox a little later). */
  sendDocument(kind: IntakeKind, document: { mimeType: string; base64: string }, name?: string): Promise<Result<{ readonly id: string }>> {
    return this.backend.sendDocument(this.companyId, { kind, document, name });
  }

  /** Throws a proposal away. (Accepting one is posting the voucher made from it under its id — `post`.) */
  rejectInbox(id: string, reason?: string): Promise<Result<void>> {
    return this.saving.track(() => this.backend.rejectInbox(this.companyId, id, reason));
  }

  /** A numbering series' current next number — for the Numbering Series display, and to default the override to a no-op. */
  seriesStatus(seriesId: string): Promise<Result<{ readonly seriesId: string; readonly nextValue: number }>> {
    return this.backend.seriesStatus(this.companyId, seriesId);
  }

  /** Moves a numbering series' next number forward (never back — see `seriesAdvanceIssues`). Equal to the current value is a no-op. */
  advanceSeriesNext(seriesId: string, nextValue: number): Promise<Result<MasterOutcome>> {
    return this.execute({ op: 'advanceSeries', kind: 'numberingSeries', id: seriesId, data: { nextValue } });
  }

  /**
   * Sets a ledger's opening balance by posting the `opening` voucher for it. The voucher id is derived from the ledger,
   * so asking twice is a safe replay rather than a second balance.
   */
  async postOpening(ledgerId: string, side: 'debit' | 'credit', amount: string, allocations?: readonly unknown[]): Promise<Result<{ number: string }>> {
    const m = this.snapshot;
    const type = m.voucherTypes.find((t) => t.baseKind === 'opening');
    const offset = m.openingDifferenceLedger();
    const year = m.financialYears[0];
    if (!type || !offset || !year) {
      return fail(issue(IssueCode.OpeningInvalid, 'This company is not set up for opening balances'));
    }
    const posted = await this.post({
        id: deterministicUuid(`opening|${ledgerId}`),
        voucherTypeId: type.id,
        date: year.start satisfies LocalDate,
        ledgerId,
        side,
        amount,
        offsetLedgerId: offset.id,
        ...(allocations && allocations.length > 0 ? { allocations } : {}),
    });
    return posted.ok ? ok({ number: posted.value.voucher.number }) : posted;
  }
}

/**
 * Sets an item's opening stock by posting the `stockOpening` voucher for it. Like a ledger's opening balance the voucher id is derived
 * from what it is for, so asking twice is a safe replay rather than a second lot of stock.
 */
export async function postOpeningStockFor(
  books: Books,
  itemId: string,
  warehouseId: string,
  qty: string,
  rate: string,
): Promise<Result<{ number: string }>> {
  const m = books.masters;
  const type = m.voucherTypes.find((t) => t.baseKind === 'stockOpening');
  const year = m.financialYears[0];
  if (!type || !year) return fail(issue(IssueCode.OpeningInvalid, 'This company is not set up for opening stock'));
  const posted = await books.post({
    id: deterministicUuid(`opening-stock|${itemId}|${warehouseId}`),
    voucherTypeId: type.id,
    date: year.start satisfies LocalDate,
    itemId,
    warehouseId,
    qty,
    rate,
  });
  return posted.ok ? ok({ number: posted.value.voucher.number }) : posted;
}

/** Builds and restores companies. The composition root supplies it (it knows which backend and which storage). */
export interface BooksFactory {
  /** The company saved from a previous visit, if any. */
  restore(): Promise<Books | undefined>;
  create(input: NewCompany): Promise<Result<Books>>;
  /** Forget the saved company (start over). Absent when the company is not the browser's to delete (the online books). */
  discard?(): Promise<void>;
  /** Whether the sample company may be loaded. False for the online books: it would fill someone's real books with make-believe. */
  readonly allowsDemo?: boolean;
}

/**
 * Where the open company lives. The app starts with none (or the one restored from the last visit); creating or loading
 * one notifies everything that depends on it — the menus, Go To, the top bar.
 */
export class BooksHost {
  private books: Books | undefined;
  private readonly listeners = new Set<() => void>();
  private stopWatching: (() => void) | undefined;

  constructor(private readonly factory?: BooksFactory) {}

  get current(): Books | undefined {
    return this.books;
  }

  get canCreate(): boolean {
    return this.factory !== undefined;
  }

  /** Whether the company can be deleted from here (the browser's own copy can; online books are not deleted from a screen). */
  get canClose(): boolean {
    return this.factory?.discard !== undefined;
  }

  get canLoadDemo(): boolean {
    return this.factory !== undefined && this.factory.allowsDemo !== false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Called once at startup, before the first render. */
  async restore(): Promise<void> {
    if (!this.factory) return;
    try {
      this.adopt(await this.factory.restore());
    } catch (error) {
      console.error('Could not restore the saved company', error);
    }
  }

  async create(input: NewCompany): Promise<Result<Books>> {
    if (!this.factory) return fail(issue(IssueCode.UnsupportedOperation, 'Creating a company is not available here'));
    if (this.books) return fail(issue(IssueCode.UnsupportedOperation, 'A company is already open'));
    const result = await this.factory.create(input);
    if (result.ok) this.adopt(result.value);
    return result;
  }

  async close(): Promise<void> {
    if (!this.factory?.discard) return;
    await this.factory.discard();
    this.adopt(undefined);
  }

  /** Adopts an already-built company (used by tests and by demo loading). */
  adopt(books: Books | undefined): void {
    this.stopWatching?.();
    this.books = books;
    // Master changes must reach anything showing them (Go To reads the snapshot on demand; screens re-render on this).
    this.stopWatching = books?.subscribe(() => this.notify());
    this.notify();
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

export const companyIdOf = (masters: Masters): CompanyId => asCompanyId(masters.company.id);

/** Human label for a master kind's list screen ("Ledgers", "Stock Items"). */
export const PLURALS: Readonly<Record<MasterKind, string>> = {
  group: 'Groups',
  ledger: 'Ledgers',
  party: 'Parties',
  unit: 'Units',
  stockGroup: 'Stock Groups',
  stockItem: 'Stock Items',
  warehouse: 'Warehouses',
  gstRate: 'GST Rates',
  voucherType: 'Voucher Types',
  numberingSeries: 'Numbering Series',
  company: 'Company',
};

