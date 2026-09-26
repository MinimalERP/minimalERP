import {
  type CompanyId,
  type FinancialYearId,
  type Issue,
  type JournalLine,
  type MasterUsage,
  type Masters,
  type PostingPlan,
  type PreparedVoucher,
  type Result,
  type SeriesId,
  type StockMovement,
  type OrderLink,
  OrderBook,
  billRefProblems,
  ensureSystemLedgers,
  extractionSchema,
  type IntakeKind,
  localDate,
  orderDocOf,
  proposeFromExtraction,
  type Voucher,
  type VoucherId,
  type VoucherKindRegistry,
  IssueCode,
  StockBook,
  defaultVoucherKinds,
  fail,
  formatVoucherNumber,
  masterRecordName,
  createdRecords,
  prepareMasterCommand,
  issue,
  ok,
  planVoucher,
  prepareAlteration,
  prepareCancellation,
  resolveDraft,
  totalsOf,
  type LocalDate,
} from '@minimalerp/domain';
import type {
  ChangeFeed,
  MailSender,
  LedgerMailOrder,
  VoucherMailOrder,
  DocumentSender,
  InboxGateway,
  InboxItem,
  IntakeDocument,
  AlterRequest,
  CancelRequest,
  JournalQuery,
  JournalRepository,
  MasterGateway,
  MasterOutcome,
  MasterRequest,
  MastersRepository,
  PostOutcome,
  PostRequest,
  PostingGateway,
  OrderQuery,
  OrderRepository,
  StockQuery,
  StockRepository,
  VoucherChange,
  VoucherRepository,
} from '@minimalerp/ports';

/** A voucher as it stood before an alteration/cancellation (the audit trail's `voucher_revisions`). */
export interface RevisionRecord {
  readonly voucher: Voucher;
  readonly journal: readonly JournalLine[];
}

/**
 * The last line of defence, independent of the posting engine. The Postgres adapter enforces the
 * same thing with a deferred constraint trigger; here it runs immediately before state changes.
 */
export function assertCommitInvariants(lines: readonly JournalLine[]): Issue[] {
  const problems: Issue[] = [];
  const byVoucher = new Map<VoucherId, JournalLine[]>();
  for (const l of lines) {
    const bucket = byVoucher.get(l.voucherId) ?? [];
    bucket.push(l);
    byVoucher.set(l.voucherId, bucket);
    if (l.amount <= 0n) {
      problems.push(issue(IssueCode.PlanNonPositiveAmount, `Non-positive journal amount on voucher ${l.voucherId}`));
    }
  }
  for (const [voucherId, bucket] of byVoucher) {
    const { debit, credit } = totalsOf(bucket);
    if (debit !== credit) {
      problems.push(issue(IssueCode.PlanUnbalanced, `Voucher ${voucherId}: debit ${debit} ≠ credit ${credit}`));
    }
  }
  return problems;
}

/**
 * Everything that has changed this backend's state, in order. Replaying the entries into a fresh backend built
 * from the same starting masters reproduces it exactly (numbering and all), which is how demo mode persists
 * without a second serialisation format for the books.
 */
export type BackendLogEntry =
  | { readonly type: 'master'; readonly command: unknown }
  | { readonly type: 'post'; readonly draft: unknown }
  | { readonly type: 'alter'; readonly voucherId: VoucherId; readonly expectedVersion: number; readonly draft: unknown }
  | { readonly type: 'cancel'; readonly voucherId: VoucherId; readonly expectedVersion: number };

/** Bigint-safe JSON; key order is fixed by the draft schema, so equal drafts serialise equally. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));

/**
 * One company's books held in memory. It plays the role that the Edge Function + `post_voucher_atomic`
 * RPC play in production: validate → plan → number → commit, all-or-nothing, idempotent by voucher id.
 *
 * Every mutation is structured as "compute everything, verify, then apply with no failure points",
 * which is what makes each operation atomic here.
 */
export class MemoryBackend
  implements
    PostingGateway,
    MasterGateway,
    MastersRepository,
    VoucherRepository,
    JournalRepository,
    StockRepository,
    OrderRepository,
    InboxGateway,
    DocumentSender,
    ChangeFeed,
    MailSender
{
  private readonly vouchers = new Map<VoucherId, Voucher>();
  private readonly journalByVoucher = new Map<VoucherId, readonly JournalLine[]>();
  private readonly stockByVoucher = new Map<VoucherId, readonly StockMovement[]>();
  private bookCache: { readonly at: number; readonly book: StockBook } | undefined;
  private stockVersion = 0;
  private readonly linksByVoucher = new Map<VoucherId, readonly OrderLink[]>();
  private readonly counters = new Map<SeriesId, number>();
  private readonly revisions = new Map<VoucherId, RevisionRecord[]>();
  private readonly log: BackendLogEntry[] = [];
  private readonly listeners = new Set<(entry: BackendLogEntry) => void>();
  /** The AI Inbox. Books kept in this browser have no add-on sending documents, so it stays empty unless a test puts proposals in. */
  private readonly inboxItems = new Map<string, InboxItem>();

  constructor(
    private masters: Masters,
    private readonly registry: VoucherKindRegistry = defaultVoucherKinds(),
  ) {}

  // ---- seeding hooks and the change log ----

  /** Puts a proposal in the inbox, as the `intake` function does online (tests, and the e2e suite). */
  putInbox(item: InboxItem): void {
    this.inboxItems.set(item.id, item);
  }

  // ---- the AI Inbox (ADR-0023) ----

  async inbox(companyId: CompanyId): Promise<Result<readonly InboxItem[]>> {
    const wrongCompany = this.checkCompany(companyId);
    if (wrongCompany) return wrongCompany;
    return ok([...this.inboxItems.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  /** Books kept in this browser have no server to read a document (a PDF, a photo) with — but an `extraction`
   *  already IS the reading (a CSV row turned into one directly, needing no AI at all), so that one case works offline too. */
  async sendDocument(companyId: CompanyId, s: { readonly kind: IntakeKind; readonly document: IntakeDocument; readonly name?: string | undefined }): Promise<Result<{ readonly id: string }>> {
    const wrongCompany = this.checkCompany(companyId);
    if (wrongCompany) return wrongCompany;
    if (!('extraction' in s.document)) {
      return fail(issue(IssueCode.UnsupportedOperation, 'Reading documents needs the online books: sign in to the company online'));
    }
    const extraction = extractionSchema.safeParse(s.document.extraction);
    if (!extraction.success) return fail(issue(IssueCode.SchemaInvalid, 'The extraction is not in the expected shape', 'document'));
    const today = localDate(new Date().toISOString().slice(0, 10));
    const proposal = proposeFromExtraction(s.kind, extraction.data, { masters: this.masters, vouchers: [...this.vouchers.values()], orders: this.orderBook(), today });
    const id = (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
    this.putInbox({ id, kind: s.kind, proposal, mailSubject: s.name ? `Uploaded: ${s.name}`.slice(0, 200) : undefined, createdAt: new Date().toISOString() });
    return ok({ id });
  }

  async rejectInbox(companyId: CompanyId, id: string): Promise<Result<void>> {
    const wrongCompany = this.checkCompany(companyId);
    if (wrongCompany) return wrongCompany;
    this.inboxItems.delete(id);
    return ok(undefined);
  }

  setMasters(masters: Masters): void {
    this.masters = masters;
  }

  lockThrough(financialYearId: FinancialYearId, date: LocalDate | undefined): void {
    this.masters = this.masters.withLockedThrough(financialYearId, date);
  }

  /** Every state change so far, oldest first. */
  changes(): readonly BackendLogEntry[] {
    return this.log;
  }

  /** Called after each change is applied (not for retries that changed nothing). Returns an unsubscribe. */
  onChange(listener: (entry: BackendLogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-applies logged changes in order. Stops at the first refusal, which means the log does not match this backend's starting point. */
  /** Adds the system ledgers (GST, TDS) a saved company does not have yet — once, by reserved key, adopting a same-named ledger it already made. */
  ensureSystemLedgers(): void {
    this.masters = ensureSystemLedgers(this.masters);
  }

  async replay(entries: readonly BackendLogEntry[]): Promise<Result<void>> {
    const companyId = this.masters.company.id;
    for (const [i, e] of entries.entries()) {
      const r =
        e.type === 'master'
          ? await this.execute({ companyId, command: e.command })
          : e.type === 'post'
            ? await this.post({ companyId, draft: e.draft })
            : e.type === 'alter'
              ? await this.alter({ companyId, voucherId: e.voucherId, expectedVersion: e.expectedVersion, draft: e.draft })
              : await this.cancel({ companyId, voucherId: e.voucherId, expectedVersion: e.expectedVersion });
      if (!r.ok) {
        return { ok: false, issues: [issue(IssueCode.SchemaInvalid, `Saved change #${i + 1} no longer applies: ${r.issues[0]?.message ?? 'refused'}`), ...r.issues] };
      }
    }
    return ok(undefined);
  }

  // ---- ports: MasterGateway ----

  async execute(request: MasterRequest): Promise<Result<MasterOutcome>> {
    const wrongCompany = this.checkCompany(request.companyId);
    if (wrongCompany) return wrongCompany;

    const prepared = prepareMasterCommand(request.command, this.masters, this.usage());
    if (!prepared.ok) return prepared;

    const { change, changes, masters } = prepared.value;
    if (!change.replayed) {
      // ---- apply: no failure points below this line ----
      this.masters = masters;
      if (change.op === 'advanceSeries') {
        const requested = Number((request.command as { data?: { nextValue?: unknown } } | null)?.data?.nextValue);
        this.counters.set(change.id as SeriesId, requested);
      }
      this.record({ type: 'master', command: request.command });
    }
    return ok({ kind: change.kind, op: change.op, id: change.id, name: masterRecordName(change.after), replayed: change.replayed, created: createdRecords(changes) });
  }

  // ---- ports: MastersRepository / VoucherRepository / JournalRepository ----

  async load(companyId: CompanyId): Promise<Masters> {
    this.requireCompany(companyId);
    return this.masters;
  }

  async get(_companyId: CompanyId, voucherId: VoucherId): Promise<Voucher | undefined> {
    return this.vouchers.get(voucherId);
  }

  async list(_companyId: CompanyId): Promise<readonly Voucher[]> {
    return [...this.vouchers.values()];
  }

  /** The stock ledger, read back (the whole company, or only some items). */
  async stockMovements(query: StockQuery): Promise<readonly StockMovement[]> {
    this.requireCompany(query.companyId);
    const only = query.itemIds === undefined ? undefined : new Set<string>(query.itemIds);
    const all: StockMovement[] = [];
    for (const movements of this.stockByVoucher.values()) for (const m of movements) if (only === undefined || only.has(m.itemId)) all.push(m);
    return all;
  }

  /** Books kept in this browser have no mail server: emailing needs the online books. */
  async sendVoucherMail(_mail: VoucherMailOrder): Promise<Result<{ readonly sentTo: readonly string[] }>> {
    return fail(issue(IssueCode.MailNotSetUp, 'Emailing needs the online books: sign in to send from your Gmail'));
  }

  async sendLedgerMail(_mail: LedgerMailOrder): Promise<Result<{ readonly sentTo: readonly string[] }>> {
    return fail(issue(IssueCode.MailNotSetUp, 'Emailing needs the online books: sign in to send from your Gmail'));
  }

  /** What one change left behind: the voucher, its journal lines and its stock movements (see ChangeFeed). */
  async changeOf(companyId: CompanyId, voucherId: VoucherId): Promise<VoucherChange | undefined> {
    this.requireCompany(companyId);
    const voucher = this.vouchers.get(voucherId);
    if (!voucher) return undefined;
    return { voucher, lines: this.journalByVoucher.get(voucherId) ?? [], movements: this.stockByVoucher.get(voucherId) ?? [] };
  }

  /** The stock book as it stands: every posted voucher's movements (a cancelled voucher has none). Rebuilt only when stock changed. */
  private stockBook(): StockBook {
    if (this.bookCache?.at !== this.stockVersion) {
      const all: StockMovement[] = [];
      for (const movements of this.stockByVoucher.values()) all.push(...movements);
      this.bookCache = { at: this.stockVersion, book: new StockBook(all) };
    }
    return (this.bookCache as { book: StockBook }).book;
  }

  /** The deliveries against sales-order lines, read back (every one, or only those against some orders). */
  async orderLinks(query: OrderQuery): Promise<readonly OrderLink[]> {
    this.requireCompany(query.companyId);
    const only = query.orderIds === undefined ? undefined : new Set<string>(query.orderIds);
    const all: OrderLink[] = [];
    for (const links of this.linksByVoucher.values()) for (const l of links) if (only === undefined || only.has(l.orderId)) all.push(l);
    return all;
  }

  /** The order book as it stands: the posted sales and purchase orders and every delivery / receipt made against them (a cancelled invoice has none). */
  private orderBook(): OrderBook {
    const docs = [];
    for (const v of this.vouchers.values()) {
      const base = this.masters.voucherType(v.voucherTypeId)?.baseKind;
      if (v.status !== 'posted' || (base !== 'salesOrder' && base !== 'purchaseOrder')) continue;
      const doc = orderDocOf(v, base === 'salesOrder' ? 'sales' : 'purchase');
      if (doc) docs.push(doc);
    }
    const links: OrderLink[] = [];
    for (const l of this.linksByVoucher.values()) links.push(...l);
    return new OrderBook(docs, links);
  }

  private setLinks(voucherId: VoucherId, links: readonly OrderLink[]): void {
    if (links.length === 0) this.linksByVoucher.delete(voucherId);
    else this.linksByVoucher.set(voucherId, links);
  }

  private setStock(voucherId: VoucherId, movements: readonly StockMovement[]): void {
    if (movements.length === 0 && !this.stockByVoucher.has(voucherId)) return;
    if (movements.length === 0) this.stockByVoucher.delete(voucherId);
    else this.stockByVoucher.set(voucherId, movements);
    this.stockVersion++;
  }

  async lines(query: JournalQuery): Promise<readonly JournalLine[]> {
    const all: JournalLine[] = [];
    for (const lines of this.journalByVoucher.values()) all.push(...lines);
    return all
      .filter((l) => query.ledgerId === undefined || l.ledgerId === query.ledgerId)
      .filter((l) => query.voucherId === undefined || l.voucherId === query.voucherId)
      .filter((l) => query.from === undefined || l.date >= query.from)
      .filter((l) => query.to === undefined || l.date <= query.to)
      .sort((a, b) => a.date.localeCompare(b.date) || a.voucherId.localeCompare(b.voucherId) || a.lineNo - b.lineNo);
  }

  /** Audit trail: every prior state of a voucher, oldest first. */
  history(voucherId: VoucherId): readonly RevisionRecord[] {
    return this.revisions.get(voucherId) ?? [];
  }

  // ---- ports: PostingGateway ----

  async post(request: PostRequest): Promise<Result<PostOutcome>> {
    const wrongCompany = this.checkCompany(request.companyId);
    if (wrongCompany) return wrongCompany;

    const masters = this.masters;
    const resolved = resolveDraft(request.draft, masters, this.registry);
    if (!resolved.ok) return resolved;

    // Idempotency comes before validation so a retry after a later period lock still succeeds.
    const existing = this.vouchers.get(resolved.value.draft.id);
    if (existing) {
      if (canonical(existing.content) === canonical(resolved.value.draft)) {
        return ok({
          voucher: existing,
          plan: {
            journal: this.journalByVoucher.get(existing.id) ?? [],
            stock: this.stockByVoucher.get(existing.id) ?? [],
            links: this.linksByVoucher.get(existing.id) ?? [],
          },
          replayed: true,
        });
      }
      return fail(
        issue(IssueCode.IdempotencyConflict, `Voucher id ${existing.id} was already used for a different voucher`, 'id'),
      );
    }

    const prepared = planVoucher(resolved.value, masters, this.stockBook(), this.orderBook());
    if (!prepared.ok) return prepared;
    const duplicate = billRefProblems(prepared.value.voucherType.baseKind, prepared.value.draft, masters, [...this.vouchers.values()]);
    if (duplicate.length > 0) return { ok: false, issues: duplicate };

    const series = masters.seriesFor(prepared.value.voucherType.id, prepared.value.financialYear.id);
    if (!series) {
      return fail(
        issue(
          IssueCode.NumberingSeriesMissing,
          `No numbering series for "${prepared.value.voucherType.name}" in ${prepared.value.financialYear.label}`,
        ),
      );
    }
    const sequence = this.counters.get(series.id) ?? series.startAt;

    const voucher: Voucher = {
      id: prepared.value.draft.id,
      companyId: masters.company.id,
      voucherTypeId: prepared.value.voucherType.id,
      financialYearId: prepared.value.financialYear.id,
      number: formatVoucherNumber(series, sequence),
      date: prepared.value.draft.date,
      status: 'posted',
      version: 1,
      revision: 0,
      content: prepared.value.draft,
    };

    const violations = assertCommitInvariants(prepared.value.plan.journal);
    if (violations.length > 0) return { ok: false, issues: violations };

    // ---- apply: no failure points below this line ----
    this.counters.set(series.id, sequence + 1);
    this.vouchers.set(voucher.id, voucher);
    this.journalByVoucher.set(voucher.id, prepared.value.plan.journal);
    this.setStock(voucher.id, prepared.value.plan.stock);
    this.setLinks(voucher.id, prepared.value.plan.links);
    this.inboxItems.delete(voucher.id); // an accepted proposal is posted under its own id: it leaves the inbox with the post
    this.record({ type: 'post', draft: request.draft });
    return ok({ voucher, plan: prepared.value.plan, replayed: false });
  }

  async alter(request: AlterRequest): Promise<Result<PostOutcome>> {
    const wrongCompany = this.checkCompany(request.companyId);
    if (wrongCompany) return wrongCompany;

    const existing = this.vouchers.get(request.voucherId);
    if (!existing) return fail(notFound(request.voucherId));

    const prepared: Result<PreparedVoucher> = prepareAlteration({
      existing,
      input: request.draft,
      expectedVersion: request.expectedVersion,
      masters: this.masters,
      registry: this.registry,
      stock: this.stockBook(),
      orders: this.orderBook(),
    });
    if (!prepared.ok) return prepared;
    const duplicate = billRefProblems(prepared.value.voucherType.baseKind, prepared.value.draft, this.masters, [...this.vouchers.values()], existing.id);
    if (duplicate.length > 0) return { ok: false, issues: duplicate };

    const violations = assertCommitInvariants(prepared.value.plan.journal);
    if (violations.length > 0) return { ok: false, issues: violations };

    const updated: Voucher = {
      ...existing,
      date: prepared.value.draft.date,
      content: prepared.value.draft,
      version: existing.version + 1,
      revision: existing.revision + 1,
    };

    // ---- apply ----
    this.recordRevision(existing);
    this.vouchers.set(updated.id, updated);
    this.journalByVoucher.set(updated.id, prepared.value.plan.journal);
    this.setStock(updated.id, prepared.value.plan.stock);
    this.setLinks(updated.id, prepared.value.plan.links);
    this.record({ type: 'alter', voucherId: request.voucherId, expectedVersion: request.expectedVersion, draft: request.draft });
    const plan: PostingPlan = prepared.value.plan;
    return ok({ voucher: updated, plan, replayed: false });
  }

  async cancel(request: CancelRequest): Promise<Result<Voucher>> {
    const wrongCompany = this.checkCompany(request.companyId);
    if (wrongCompany) return wrongCompany;

    const existing = this.vouchers.get(request.voucherId);
    if (!existing) return fail(notFound(request.voucherId));

    const allowed = prepareCancellation(existing, request.expectedVersion, this.masters, this.stockBook(), this.orderBook());
    if (!allowed.ok) return allowed;

    const cancelled: Voucher = { ...existing, status: 'cancelled', version: existing.version + 1 };

    // ---- apply ----
    this.recordRevision(existing);
    this.vouchers.set(cancelled.id, cancelled);
    this.journalByVoucher.set(cancelled.id, []);
    this.setStock(cancelled.id, []);
    this.setLinks(cancelled.id, []);
    this.record({ type: 'cancel', voucherId: request.voucherId, expectedVersion: request.expectedVersion });
    return ok(cancelled);
  }

  // ---- internals ----

  private record(entry: BackendLogEntry): void {
    this.log.push(entry);
    for (const l of this.listeners) l(entry);
  }

  /** Facts about the books that master rules need but the master data alone cannot say. */
  private usage(): MasterUsage {
    const ledgersWithEntries = new Set<string>();
    for (const lines of this.journalByVoucher.values()) for (const l of lines) ledgersWithEntries.add(l.ledgerId);
    const voucherTypesInUse = new Set<string>();
    const seriesInUse = new Set<string>();
    for (const v of this.vouchers.values()) {
      voucherTypesInUse.add(v.voucherTypeId);
      const series = this.masters.seriesFor(v.voucherTypeId, v.financialYearId);
      if (series) seriesInUse.add(series.id);
    }
    const seriesNextValue = new Map(this.masters.series.map((s) => [s.id as string, this.counters.get(s.id) ?? s.startAt]));
    return { ledgersWithEntries, voucherTypesInUse, seriesInUse, seriesNextValue };
  }

  /** The current next number a numbering series would allocate — for the browser to show, and to default a manual override to a no-op. */
  async seriesStatus(_companyId: CompanyId, seriesId: string): Promise<Result<{ readonly seriesId: string; readonly nextValue: number }>> {
    const nextValue = this.usage().seriesNextValue.get(seriesId);
    return nextValue === undefined ? fail(issue(IssueCode.MasterNotFound, 'No numbering series with that id')) : ok({ seriesId, nextValue });
  }

  private recordRevision(voucher: Voucher): void {
    const trail = this.revisions.get(voucher.id) ?? [];
    trail.push({ voucher, journal: this.journalByVoucher.get(voucher.id) ?? [] });
    this.revisions.set(voucher.id, trail);
  }

  private requireCompany(companyId: CompanyId): void {
    if (companyId !== this.masters.company.id) {
      throw new Error(`MemoryBackend holds company ${this.masters.company.id}, not ${companyId}`);
    }
  }

  private checkCompany(companyId: CompanyId): Result<never> | undefined {
    return companyId === this.masters.company.id
      ? undefined
      : fail(issue(IssueCode.CompanyMismatch, `This backend does not hold company ${companyId}`));
  }
}

const notFound = (id: VoucherId): Issue => issue(IssueCode.VoucherNotFound, `Voucher ${id} not found`);
