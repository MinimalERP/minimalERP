import {
  type CompanyId,
  type JournalLine,
  type LedgerRef,
  type MasterUsage,
  type Masters,
  type OrderLink,
  type Result,
  type StockMovement,
  type BaseKind,
  type Voucher,
  type VoucherId,
  type VoucherKindRegistry,
  IssueCode,
  NO_USAGE,
  OrderBook,
  StockBook,
  ZERO,
  draftToJson,
  defaultVoucherKinds,
  fail,
  formatMoney,
  issue,
  journalLineFromWire,
  jsonEqual,
  masterRecordName,
  createdRecords,
  orderDocOf,
  orderLinkFromWire,
  ok,
  parseMoney,
  parseQty,
  planVoucher,
  prepareAlteration,
  prepareCancellation,
  prepareMasterCommand,
  resolveDraft,
  voucherFromWire,
} from '@minimalerp/domain';
import type {
  AlterRequest,
  CancelRequest,
  JournalQuery,
  JournalRepository,
  MasterGateway,
  MasterOutcome,
  MasterRequest,
  MastersRepository,
  OrderQuery,
  OrderRepository,
  PostOutcome,
  PostRequest,
  PostingGateway,
  StockQuery,
  StockRepository,
  VoucherRepository,
} from '@minimalerp/ports';
import { issueFromDbError } from './errors';
import { buildMasters, ledgersFromJson, masterRecordToRow, mastersToSeed, mastersVersion } from './masters';
import type { Queryable } from './queryable';

type Row = Record<string, unknown>;

/** How many times a master change is re-checked when another one lands first. */
const MASTER_RETRIES = 12;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID.test(s);

const VOUCHER_COLUMNS =
  'id, company_id, voucher_type_id, financial_year_id, number, voucher_date::text as date, status, version, revision, content';

export interface PostgresBackendOptions {
  /** The authenticated user every operation is performed (and audited) as. */
  readonly actorId: string;
  readonly registry?: VoucherKindRegistry;
  /** Correlates this request with its audit_log rows. */
  readonly requestId?: string;
}

/** A prior state of an altered or cancelled voucher, from `voucher_revisions`. */
export interface VoucherRevision {
  readonly voucher: Voucher;
  readonly journal: readonly JournalLine[];
  readonly reason: 'alter' | 'cancel';
}

const text = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error(`Expected a string from the database, got ${JSON.stringify(v)}`);
  return v;
};

/**
 * The server-side posting service. It is what the Edge Function runs, and what integration tests
 * run against a real PostgreSQL. It does exactly what MemoryBackend does — same domain code for
 * validation and posting plans — but commits through the atomic SQL functions.
 *
 *   masters (JSON) ─► resolveDraft ─► permission ─► idempotency ─► planVoucher ─► post_voucher_atomic
 *
 * Business rules live in the domain; the database only enforces invariants, allocates numbers and
 * writes rows. Every write goes through one SQL function = one transaction.
 */
// Driver portability note: JSON and dates are sent as TEXT and cast in SQL (`$n::text::jsonb`). Sending a
// string to a `jsonb` parameter works with node-postgres but is double-encoded by postgres.js (used by the
// Deno Edge Function), and dates are coerced through JS Date. Text in, cast in the database: same on every driver.
export class PostgresBackend
  implements PostingGateway, MasterGateway, MastersRepository, VoucherRepository, JournalRepository, StockRepository, OrderRepository
{
  private readonly registry: VoucherKindRegistry;

  constructor(
    protected readonly db: Queryable,
    protected readonly options: PostgresBackendOptions,
  ) {
    this.registry = options.registry ?? defaultVoucherKinds();
  }

  // ---- ports: PostingGateway ----

  async post(request: PostRequest): Promise<Result<PostOutcome>> {
    const core = await this.loadCore(request.companyId);
    if (!core) return fail(companyMismatch(request.companyId));

    const resolved = resolveDraft(request.draft, core, this.registry);
    if (!resolved.ok) return resolved;
    const { draft, voucherType, kind } = resolved.value;

    if (!isUuid(draft.id)) return fail(issue(IssueCode.SchemaInvalid, 'Voucher id must be a UUID', 'id'));

    const denied = await this.denyUnless(request.companyId, `voucher.${voucherType.baseKind}.post`);
    if (denied) return denied;

    // Idempotency comes before validation, so a retry after a later period lock still succeeds.
    const existing = await this.fetchVoucher(request.companyId, draft.id);
    if (existing) {
      if (existing.voucherTypeId === voucherType.id && jsonEqual(draftToJson(existing.content), draftToJson(draft))) {
        return ok({
          voucher: existing,
          plan: {
            journal: await this.journalOf(request.companyId, existing),
            stock: await this.stockOf(request.companyId, existing.id),
            links: await this.linksOf(request.companyId, existing.id),
          },
          replayed: true,
        });
      }
      return fail(issue(IssueCode.IdempotencyConflict, `Voucher id ${draft.id} was already used for a different voucher`, 'id'));
    }

    const masters = await this.withLedgers(core, kind.ledgerRefs(draft));
    const stock = await this.stockBook(request.companyId, kind.stockItems(draft));
    const orders = await this.orderBook(request.companyId, kind.orderIds(draft));
    const prepared = planVoucher(resolved.value, masters, stock, orders);
    if (!prepared.ok) return prepared;

    const rpc = await this.rpc(
      'select public.post_voucher_atomic($1::uuid, $2::uuid, $3, $4::text::jsonb, $5::text::jsonb, $6::text::jsonb, $7::text::jsonb) as r',
      [
        this.options.actorId,
        request.companyId,
        this.options.requestId ?? null,
        JSON.stringify({
          id: draft.id,
          voucher_type_id: voucherType.id,
          financial_year_id: prepared.value.financialYear.id,
          date: draft.date,
          content: draftToJson(draft),
        }),
        JSON.stringify(prepared.value.plan.journal.map(journalLineToRpc)),
        JSON.stringify(prepared.value.plan.stock.map(stockLineToRpc)),
        JSON.stringify(prepared.value.plan.links.map(linkToRpc)),
      ],
    );
    return rpc.ok ? ok(await this.readableOutcome(outcomeFromRpc(rpc.value))) : rpc;
  }

  async alter(request: AlterRequest): Promise<Result<PostOutcome>> {
    const core = await this.loadCore(request.companyId);
    if (!core) return fail(companyMismatch(request.companyId));

    const existing = isUuid(request.voucherId) ? await this.fetchVoucher(request.companyId, request.voucherId) : undefined;
    if (!existing) return fail(issue(IssueCode.VoucherNotFound, `Voucher ${request.voucherId} not found`));

    const base = core.voucherType(existing.voucherTypeId)?.baseKind ?? 'unknown';
    const denied = await this.denyUnless(request.companyId, `voucher.${base}.alter`);
    if (denied) return denied;

    const resolved = resolveDraft(request.draft, core, this.registry);
    if (!resolved.ok) return resolved;

    const masters = await this.withLedgers(core, resolved.value.kind.ledgerRefs(resolved.value.draft));
    // The items the new draft touches AND the ones the voucher touches now: replacing it must not leave a later day short.
    const own = await this.stockOf(request.companyId, existing.id);
    const stock = await this.stockBook(request.companyId, [...resolved.value.kind.stockItems(resolved.value.draft), ...own.map((m) => m.itemId)]);
    const orders = await this.orderBook(request.companyId, resolved.value.kind.orderIds(resolved.value.draft));
    const prepared = prepareAlteration({
      existing,
      input: request.draft,
      expectedVersion: request.expectedVersion,
      masters,
      registry: this.registry,
      stock,
      orders,
    });
    if (!prepared.ok) return prepared;

    const rpc = await this.rpc(
      'select public.alter_voucher_atomic($1::uuid, $2::uuid, $3, $4::uuid, $5::int, $6::text::jsonb, $7::text::jsonb, $8::text::jsonb, $9::text::jsonb) as r',
      [
        this.options.actorId,
        request.companyId,
        this.options.requestId ?? null,
        existing.id,
        request.expectedVersion,
        JSON.stringify({
          id: existing.id,
          voucher_type_id: prepared.value.voucherType.id,
          financial_year_id: prepared.value.financialYear.id,
          date: prepared.value.draft.date,
          content: draftToJson(prepared.value.draft),
        }),
        JSON.stringify(prepared.value.plan.journal.map(journalLineToRpc)),
        JSON.stringify(prepared.value.plan.stock.map(stockLineToRpc)),
        JSON.stringify(prepared.value.plan.links.map(linkToRpc)),
      ],
    );
    return rpc.ok ? ok(await this.readableOutcome(outcomeFromRpc(rpc.value))) : rpc;
  }

  async cancel(request: CancelRequest): Promise<Result<Voucher>> {
    const core = await this.loadCore(request.companyId);
    if (!core) return fail(companyMismatch(request.companyId));

    const existing = isUuid(request.voucherId) ? await this.fetchVoucher(request.companyId, request.voucherId) : undefined;
    if (!existing) return fail(issue(IssueCode.VoucherNotFound, `Voucher ${request.voucherId} not found`));

    const base = core.voucherType(existing.voucherTypeId)?.baseKind ?? 'unknown';
    const denied = await this.denyUnless(request.companyId, `voucher.${base}.cancel`);
    if (denied) return denied;

    const own = await this.stockOf(request.companyId, existing.id);
    const stock = await this.stockBook(request.companyId, own.map((m) => m.itemId));
    const orders = await this.orderBook(request.companyId, [existing.id]);
    const allowed = prepareCancellation(existing, request.expectedVersion, core, stock, orders);
    if (!allowed.ok) return allowed;

    const rpc = await this.rpc(
      'select public.cancel_voucher_atomic($1::uuid, $2::uuid, $3, $4::uuid, $5::int) as r',
      [this.options.actorId, request.companyId, this.options.requestId ?? null, existing.id, request.expectedVersion],
    );
    return rpc.ok ? ok(await this.readable(outcomeFromRpc(rpc.value).voucher)) : rpc;
  }

  // ---- ports: MasterGateway ----

  /**
   * Validate a master command with the SAME domain code the browser runs, then commit it through master_apply.
   * Validation reads a snapshot of the company's masters, so the commit names the snapshot's version; if another change
   * landed in between, the database refuses (MASTERS_CHANGED) and this reloads and validates again. Net effect: master
   * changes behave as if they were serialised per company, with no transaction held open across a network round trip.
   */
  async execute(request: MasterRequest): Promise<Result<MasterOutcome>> {
    if (!isUuid(request.companyId)) return fail(companyMismatch(request.companyId));

    const targetId = (request.command as { id?: unknown } | null)?.id;
    let permitted = false;
    for (let attempt = 0; attempt < MASTER_RETRIES; attempt++) {
      const loaded = await this.loadCoreJson(request.companyId);
      if (!loaded) return fail(companyMismatch(request.companyId));
      if (!permitted) {
        const denied = await this.denyUnless(request.companyId, 'master.write');
        if (denied) return denied;
        permitted = true;
      }
      const ledgers = await this.db.query('select public.load_ledgers_json($1::uuid, null) as l', [request.companyId]);
      const masters = buildMasters(loaded, ledgers.rows[0]?.['l']);
      const usage = await this.usageOf(request.companyId, typeof targetId === 'string' ? targetId : undefined);

      const prepared = prepareMasterCommand(request.command, masters, usage);
      if (!prepared.ok) return prepared;
      const { change, changes } = prepared.value;
      const outcome: MasterOutcome = {
        kind: change.kind,
        op: change.op,
        id: change.id,
        name: masterRecordName(change.after),
        replayed: change.replayed,
        created: createdRecords(changes),
      };
      if (change.replayed) return ok(outcome);
      if (changes.some((c) => !isUuid(c.id))) return fail(issue(IssueCode.SchemaInvalid, 'A master record id must be a UUID', 'id'));

      // A numbering series' next number: its own function, its own audit action — not the generic per-table upsert
      // (next_value is not even a column master_apply's upsert is allowed to touch), and no masters_version bump —
      // nothing else's validated snapshot goes stale because of this.
      if (change.op === 'advanceSeries') {
        const requested = Number((request.command as { data?: { nextValue?: unknown } } | null)?.data?.nextValue);
        const advanced = await this.rpc('select public.series_advance($1::uuid, $2::uuid, $3, $4::uuid, $5::bigint) as r', [
          this.options.actorId,
          request.companyId,
          this.options.requestId ?? null,
          change.id,
          requested,
        ]);
        return advanced.ok ? ok(outcome) : advanced;
      }

      // One record, or a party and its ledgers: all are written in the one transaction, in order.
      const applied = await this.applyMaster(request.companyId, mastersVersion(loaded), {
        changes: changes.map((c) => ({ kind: c.kind, op: c.op, id: c.id, row: masterRecordToRow(c.kind, c.after) })),
      });
      if (applied.ok) return ok(outcome);
      if (applied.issues[0]?.code !== IssueCode.MastersChanged) return applied;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 30)); // let the winner finish, then look again
    }
    return fail(issue(IssueCode.MastersChanged, 'Too many changes were made at once. Please try again.'));
  }

  /**
   * Creates a company from a seeded chart of accounts (see seedCompany in the domain) in one transaction; the actor
   * becomes its owner. This is what onboarding calls; tests use it to make a company.
   */
  async createCompany(masters: Masters): Promise<Result<{ companyId: CompanyId }>> {
    try {
      await this.db.query('select public.company_seed($1::uuid, $2, $3::text::jsonb) as r', [
        this.options.actorId,
        this.options.requestId ?? null,
        JSON.stringify(mastersToSeed(masters)),
      ]);
      return ok({ companyId: masters.company.id });
    } catch (e) {
      const known = issueFromDbError(e);
      if (known) return fail(known);
      throw e;
    }
  }

  // ---- ports: MastersRepository / VoucherRepository / JournalRepository ----

  async load(companyId: CompanyId): Promise<Masters> {
    const core = await this.loadCore(companyId);
    if (!core) throw new Error(`Unknown company ${companyId}`);
    const r = await this.db.query('select public.load_ledgers_json($1::uuid, null) as l', [companyId]);
    return core.with({ ledgers: ledgersFromJson(r.rows[0]?.['l'], companyId) });
  }

  /** The companies the actor belongs to, oldest first (what the browser opens on sign-in). */
  async companiesOf(): Promise<readonly { readonly id: string; readonly name: string }[]> {
    const r = await this.db.query(
      `select c.id, c.name
         from public.companies c join public.company_members m on m.company_id = c.id
        where m.user_id = $1::uuid
        order by c.created_at, c.id`,
      [this.options.actorId],
    );
    return r.rows.map((row) => ({ id: text(row['id']), name: text(row['name']) }));
  }

  /** Whether the actor holds a permission in a company (false for a company that does not exist, or that they are not in). */
  async can(companyId: string, permission: string): Promise<boolean> {
    if (!isUuid(companyId)) return false;
    const r = await this.db.query('select public.actor_can($1::uuid, $2::uuid, $3) as ok', [this.options.actorId, companyId, permission]);
    return r.rows[0]?.['ok'] === true;
  }

  /** The masters as the JSON the database hands over: the browser rebuilds the same snapshot from it with buildMasters. */
  async loadJson(companyId: string): Promise<{ readonly core: unknown; readonly ledgers: unknown } | undefined> {
    const core = await this.loadCoreJson(companyId as CompanyId);
    if (!core) return undefined;
    const r = await this.db.query('select public.load_ledgers_json($1::uuid, null) as l', [companyId]);
    return { core, ledgers: r.rows[0]?.['l'] };
  }

  async get(companyId: CompanyId, voucherId: VoucherId): Promise<Voucher | undefined> {
    return isUuid(voucherId) ? this.fetchVoucher(companyId, voucherId) : undefined;
  }

  async list(companyId: CompanyId): Promise<readonly Voucher[]> {
    if (!isUuid(companyId)) return [];
    const r = await this.db.query(
      `select ${VOUCHER_COLUMNS} from public.vouchers where company_id = $1::uuid order by created_at, id`,
      [companyId],
    );
    return Promise.all(r.rows.map((row) => this.readable(voucherFromRow(row))));
  }

  async lines(query: JournalQuery): Promise<readonly JournalLine[]> {
    if (!isUuid(query.companyId)) return [];
    const where = ['company_id = $1::uuid'];
    const values: unknown[] = [query.companyId];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace('$?', `$${values.length}`));
    };
    if (query.ledgerId !== undefined) {
      if (!isUuid(query.ledgerId)) return [];
      add('ledger_id = $?::uuid', query.ledgerId);
    }
    if (query.voucherId !== undefined) {
      if (!isUuid(query.voucherId)) return [];
      add('voucher_id = $?::uuid', query.voucherId);
    }
    if (query.from !== undefined) add('entry_date >= $?::text::date', query.from);
    if (query.to !== undefined) add('entry_date <= $?::text::date', query.to);

    const r = await this.db.query(
      `select voucher_id, line_no, entry_date::text as entry_date, ledger_id, debit::text as debit, credit::text as credit, narration
         from public.journal_lines
        where ${where.join(' and ')}
        order by entry_date, voucher_id, line_no`,
      values,
    );
    return r.rows.map(journalLineFromRow);
  }

  /** The stock ledger (the whole company, or only some items), in the order the book reads it. */
  async stockMovements(query: StockQuery): Promise<readonly StockMovement[]> {
    if (!isUuid(query.companyId)) return [];
    const items = query.itemIds === undefined ? undefined : query.itemIds.filter(isUuid);
    if (items !== undefined && items.length === 0) return [];
    const r = await this.db.query(
      `select voucher_id, line_no, entry_date::text as entry_date, item_id, warehouse_id, direction, qty::text as qty, value::text as value
         from public.stock_movements
        where company_id = $1::uuid ${items === undefined ? '' : 'and item_id = any($2::text::uuid[])'}
        order by entry_date, voucher_id, line_no`,
      items === undefined ? [query.companyId] : [query.companyId, `{${items.join(',')}}`],
    );
    return r.rows.map(stockFromRow);
  }

  /** The deliveries against sales-order lines (every one, or only those against some orders), in the order they were made. */
  async orderLinks(query: OrderQuery): Promise<readonly OrderLink[]> {
    if (!isUuid(query.companyId)) return [];
    const orders = query.orderIds === undefined ? undefined : query.orderIds.filter(isUuid);
    if (orders !== undefined && orders.length === 0) return [];
    const r = await this.db.query(
      `select voucher_id, line_no, entry_date::text as entry_date, order_id, order_line_id, item_id, qty::text as qty
         from public.voucher_links
        where company_id = $1::uuid
          ${orders === undefined ? '' : 'and order_id = any($2::text::uuid[])'}
        order by entry_date, voucher_id, line_no`,
      orders === undefined ? [query.companyId] : [query.companyId, `{${orders.join(',')}}`],
    );
    return r.rows.map(linkFromRow);
  }

  /** Every prior state of a voucher, oldest first — the audit trail behind alter and cancel. */
  async revisionsOf(companyId: CompanyId, voucherId: VoucherId): Promise<readonly VoucherRevision[]> {
    if (!isUuid(companyId) || !isUuid(voucherId)) return [];
    const r = await this.db.query(
      `select reason, snapshot from public.voucher_revisions where company_id = $1::uuid and voucher_id = $2::uuid order by id`,
      [companyId, voucherId],
    );
    return Promise.all(
      r.rows.map(async (row) => {
        const snapshot = row['snapshot'] as { voucher: Row; journal: Row[] };
        const parts = outcomeFromRpc({ replayed: false, voucher: snapshot.voucher, journal: snapshot.journal });
        return { voucher: await this.readable(parts.voucher), journal: parts.plan.journal, reason: row['reason'] as 'alter' | 'cancel' };
      }),
    );
  }

  // ---- internals ----

  /** voucher type id → base kind (a voucher type never changes its base kind, so this is asked of the database once per type). */
  private readonly baseKinds = new Map<string, string>();

  private async baseKindOf(voucherTypeId: string): Promise<string | undefined> {
    const known = this.baseKinds.get(voucherTypeId);
    if (known !== undefined) return known;
    if (!isUuid(voucherTypeId)) return undefined;
    const r = await this.db.query('select base_kind from public.voucher_types where id = $1::uuid', [voucherTypeId]);
    const base = r.rows[0]?.['base_kind'];
    if (typeof base !== 'string') return undefined;
    this.baseKinds.set(voucherTypeId, base);
    return base;
  }

  /**
   * A voucher as the rest of the system holds it. Its content is stored as JSON, where money is decimal text ("400.00"); everything that reads a
   * voucher back (openBills, Outstanding, the party ageing, the voucher lists) does arithmetic on amounts that are bigints, exactly as the memory
   * backend keeps them. So the stored content is read back through the voucher kind's OWN schema — the parse that produced it in the first place —
   * which turns every money field back into a bigint and leaves quantities, rates and text as they are. A voucher of a kind that is not registered,
   * or content that no longer parses, is returned as stored: reading never fails.
   */
  private async readable(voucher: Voucher): Promise<Voucher> {
    const base = await this.baseKindOf(voucher.voucherTypeId);
    const kind = base === undefined ? undefined : this.registry.get(base as BaseKind);
    if (!kind) return voucher;
    const parsed = kind.parse(voucher.content);
    return parsed.ok ? { ...voucher, content: parsed.value } : voucher;
  }

  private async readableOutcome(outcome: PostOutcome): Promise<PostOutcome> {
    return { ...outcome, voucher: await this.readable(outcome.voucher) };
  }

  /** Everything except ledgers (a company can have tens of thousands; posting loads only those it references). */
  private async loadCore(companyId: CompanyId): Promise<Masters | undefined> {
    const core = await this.loadCoreJson(companyId);
    return core ? buildMasters(core, []) : undefined;
  }

  /** The raw JSON (it also carries the masters' version). Undefined if the company does not exist. */
  private async loadCoreJson(companyId: CompanyId): Promise<Row | undefined> {
    if (!isUuid(companyId)) return undefined;
    const r = await this.db.query('select public.load_masters_json($1::uuid) as m', [companyId]);
    const core = r.rows[0]?.['m'] as Row | null | undefined;
    if (!core || core['company'] === null) return undefined;
    return core;
  }

  /** What the books already say about one record: enough for the rules that protect records in use. */
  private async usageOf(companyId: CompanyId, id: string | undefined): Promise<MasterUsage> {
    if (id === undefined || !isUuid(id)) return NO_USAGE;
    const r = await this.db.query('select public.master_usage_json($1::uuid, $2::uuid) as u', [companyId, id]);
    const u = (r.rows[0]?.['u'] ?? {}) as {
      ledger_has_entries?: boolean;
      voucher_type_in_use?: boolean;
      series_in_use?: boolean;
      series_next_value?: number | string | null;
    };
    return {
      ledgersWithEntries: new Set(u.ledger_has_entries ? [id] : []),
      voucherTypesInUse: new Set(u.voucher_type_in_use ? [id] : []),
      seriesInUse: new Set(u.series_in_use ? [id] : []),
      seriesNextValue: new Map(u.series_next_value === null || u.series_next_value === undefined ? [] : [[id, Number(u.series_next_value)]]),
    };
  }

  /** The current next number a numbering series would allocate — for the browser to show, and to default a manual override to a no-op. */
  async seriesStatus(companyId: CompanyId, seriesId: string): Promise<Result<{ readonly seriesId: string; readonly nextValue: number }>> {
    if (!isUuid(companyId) || !isUuid(seriesId)) return fail(issue(IssueCode.MasterNotFound, 'No numbering series with that id'));
    const denied = await this.denyUnless(companyId, 'master.view');
    if (denied) return denied;
    const usage = await this.usageOf(companyId, seriesId);
    const nextValue = usage.seriesNextValue.get(seriesId);
    return nextValue === undefined ? fail(issue(IssueCode.MasterNotFound, 'No numbering series with that id')) : ok({ seriesId, nextValue });
  }

  private async applyMaster(companyId: CompanyId, expectedVersion: number, change: Row): Promise<Result<Row>> {
    try {
      const r = await this.db.query('select public.master_apply($1::uuid, $2::uuid, $3, $4::bigint, $5::text::jsonb) as r', [
        this.options.actorId,
        companyId,
        this.options.requestId ?? null,
        expectedVersion,
        JSON.stringify(change),
      ]);
      return ok((r.rows[0]?.['r'] ?? {}) as Row);
    } catch (e) {
      const known = issueFromDbError(e);
      if (known) return fail(known);
      // 23505 unique_violation: the database's own uniqueness rules are the last word on names and codes.
      if ((e as { code?: unknown } | null)?.code === '23505') {
        return fail(issue(IssueCode.NameTaken, 'That name or code is already in use'));
      }
      throw e;
    }
  }

  private async withLedgers(core: Masters, refs: readonly LedgerRef[]): Promise<Masters> {
    // The system ledgers (the GST heads, TDS Receivable, the opening difference) are found by reserved key, not named on a draft: always load them.
    const reserved = await this.db.query('select id from public.ledgers where company_id = $1::uuid and reserved_key is not null', [core.company.id]);
    const ids = [...new Set([...refs.map((r) => r.ledgerId), ...reserved.rows.map((r) => String(r['id']))].filter(isUuid))];
    if (ids.length === 0) return core;
    const r = await this.db.query('select public.load_ledgers_json($1::uuid, $2::text::jsonb) as l', [
      core.company.id,
      JSON.stringify(ids),
    ]);
    return core.with({ ledgers: ledgersFromJson(r.rows[0]?.['l'], core.company.id) });
  }

  private async fetchVoucher(companyId: CompanyId, voucherId: string): Promise<Voucher | undefined> {
    const r = await this.db.query(
      `select ${VOUCHER_COLUMNS} from public.vouchers where company_id = $1::uuid and id = $2::uuid`,
      [companyId, voucherId],
    );
    const row = r.rows[0];
    return row ? this.readable(voucherFromRow(row)) : undefined;
  }

  /** The book of just these items (what a change must be checked against). */
  private async stockBook(companyId: CompanyId, itemIds: readonly string[]): Promise<StockBook> {
    const items = [...new Set(itemIds)];
    if (items.length === 0) return StockBook.empty;
    return new StockBook(await this.stockMovements({ companyId, itemIds: items as never }));
  }

  /** The book of just these orders (what a change must be checked against): their documents and every delivery made against them. */
  private async orderBook(companyId: CompanyId, orderIds: readonly string[]): Promise<OrderBook> {
    const ids = [...new Set(orderIds)].filter(isUuid);
    if (ids.length === 0) return OrderBook.empty;
    const docs = await this.db.query(
      `select ${VOUCHER_COLUMNS}, (select t.base_kind from public.voucher_types t where t.id = voucher_type_id) as order_kind from public.vouchers
        where company_id = $1::uuid and id = any($2::text::uuid[]) and status = 'posted'
          and voucher_type_id in (select id from public.voucher_types where company_id = $1::uuid and base_kind in ('salesOrder', 'purchaseOrder'))`,
      [companyId, `{${ids.join(',')}}`],
    );
    const orders = docs.rows.flatMap((row) => {
      const doc = orderDocOf(voucherFromRow(row), row['order_kind'] === 'purchaseOrder' ? 'purchase' : 'sales');
      return doc ? [doc] : [];
    });
    return new OrderBook(orders, await this.orderLinks({ companyId, orderIds: ids as never }));
  }

  /** The deliveries one invoice makes. */
  private async linksOf(companyId: CompanyId, voucherId: string): Promise<readonly OrderLink[]> {
    const r = await this.db.query(
      `select voucher_id, line_no, entry_date::text as entry_date, order_id, order_line_id, item_id, qty::text as qty
         from public.voucher_links where company_id = $1::uuid and voucher_id = $2::uuid order by line_no`,
      [companyId, voucherId],
    );
    return r.rows.map(linkFromRow);
  }

  private async stockOf(companyId: CompanyId, voucherId: string): Promise<readonly StockMovement[]> {
    const r = await this.db.query(
      `select voucher_id, line_no, entry_date::text as entry_date, item_id, warehouse_id, direction, qty::text as qty, value::text as value
         from public.stock_movements where company_id = $1::uuid and voucher_id = $2::uuid order by line_no`,
      [companyId, voucherId],
    );
    return r.rows.map(stockFromRow);
  }

  private async journalOf(companyId: CompanyId, voucher: Voucher): Promise<readonly JournalLine[]> {
    return this.lines({ companyId, voucherId: voucher.id });
  }

  private async denyUnless(companyId: CompanyId, permission: string): Promise<Result<never> | undefined> {
    const r = await this.db.query('select public.actor_can($1::uuid, $2::uuid, $3) as ok', [
      this.options.actorId,
      companyId,
      permission,
    ]);
    return r.rows[0]?.['ok'] === true
      ? undefined
      : fail(issue(IssueCode.PermissionDenied, `Not permitted: ${permission}`));
  }

  /** Runs one atomic SQL function. Recognised error codes become Issues; anything else propagates. */
  private async rpc(sql: string, values: readonly unknown[]): Promise<Result<Row>> {
    try {
      const r = await this.db.query(sql, values);
      const result = r.rows[0]?.['r'];
      if (result === null || typeof result !== 'object') throw new Error('Posting function returned nothing');
      return ok(result as Row);
    } catch (e) {
      const known = issueFromDbError(e);
      if (known) return fail(known);
      throw e;
    }
  }
}

function companyMismatch(companyId: string) {
  return issue(IssueCode.CompanyMismatch, `Company ${companyId} not found`);
}

function journalLineToRpc(l: JournalLine): Row {
  return {
    ledger_id: l.ledgerId,
    side: l.side,
    amount: formatMoney(l.amount),
    narration: l.narration ?? null,
  };
}

function stockLineToRpc(m: StockMovement): Row {
  return {
    item_id: m.itemId,
    warehouse_id: m.warehouseId,
    direction: m.direction,
    qty: qtyToText(m.qty),
    value: m.value === undefined ? null : formatMoney(m.value),
  };
}

function linkToRpc(l: OrderLink): Row {
  return { line_no: l.lineNo, order_id: l.orderId, order_line_id: l.orderLineId, item_id: l.itemId, qty: qtyToText(l.qty) };
}

function linkFromRow(row: Row): OrderLink {
  return orderLinkFromWire({
    voucherId: text(row['voucher_id']),
    lineNo: Number(row['line_no']),
    date: text(row['entry_date']),
    orderId: text(row['order_id']),
    orderLineId: text(row['order_line_id']),
    itemId: text(row['item_id']),
    qty: text(row['qty']),
  });
}

const qtyToText = (q: bigint): string => `${q / 10_000n}.${(q % 10_000n).toString().padStart(4, '0')}`;

function stockFromRow(row: Row): StockMovement {
  const value = row['value'];
  return {
    voucherId: text(row['voucher_id']) as VoucherId,
    lineNo: Number(row['line_no']),
    date: text(row['entry_date']) as StockMovement['date'],
    itemId: text(row['item_id']) as StockMovement['itemId'],
    warehouseId: text(row['warehouse_id']) as StockMovement['warehouseId'],
    direction: text(row['direction']) as StockMovement['direction'],
    qty: parseQty(text(row['qty'])) ?? (0n as never),
    ...(typeof value === 'string' ? { value: parseMoney(value) ?? ZERO } : {}),
  };
}

function voucherFromRow(row: Row): Voucher {
  return voucherFromWire({
    id: text(row['id']),
    companyId: text(row['company_id']),
    voucherTypeId: text(row['voucher_type_id']),
    financialYearId: text(row['financial_year_id']),
    number: text(row['number']),
    date: text(row['date']),
    status: text(row['status']) as Voucher['status'],
    version: Number(row['version']),
    revision: Number(row['revision']),
    content: row['content'],
  });
}

function journalLineFromRow(row: Row): JournalLine {
  const debit = parseMoney(text(row['debit'])) ?? ZERO;
  const credit = parseMoney(text(row['credit'])) ?? ZERO;
  const narration = row['narration'];
  return journalLineFromWire({
    voucherId: text(row['voucher_id']),
    lineNo: Number(row['line_no']),
    date: text(row['entry_date']),
    ledgerId: text(row['ledger_id']),
    side: debit > 0n ? 'debit' : 'credit',
    amount: formatMoney(debit > 0n ? debit : credit),
    narration: typeof narration === 'string' ? narration : null,
  });
}

/** `{ replayed, voucher: {...snake_case}, journal: [...] }` as returned by the SQL functions. */
function outcomeFromRpc(r: Row): PostOutcome {
  const v = r['voucher'] as Row;
  const voucher = voucherFromWire({
    id: text(v['id']),
    companyId: text(v['company_id']),
    voucherTypeId: text(v['voucher_type_id']),
    financialYearId: text(v['financial_year_id']),
    number: text(v['number']),
    date: text(v['date']),
    status: text(v['status']) as Voucher['status'],
    version: Number(v['version']),
    revision: Number(v['revision']),
    content: v['content'],
  });
  const journal = (r['journal'] as Row[]).map((l) =>
    journalLineFromWire({
      voucherId: voucher.id,
      lineNo: Number(l['line_no']),
      date: voucher.date,
      ledgerId: text(l['ledger_id']),
      side: text(l['side']) as 'debit' | 'credit',
      amount: text(l['amount']),
      narration: typeof l['narration'] === 'string' ? l['narration'] : null,
    }),
  );
  const stock = ((r['stock'] as Row[] | undefined) ?? []).map((s) =>
    stockFromRow({
      voucher_id: voucher.id,
      line_no: s['line_no'],
      entry_date: voucher.date,
      item_id: s['item_id'],
      warehouse_id: s['warehouse_id'],
      direction: s['direction'],
      qty: s['qty'],
      value: s['value'],
    }),
  );
  const links = ((r['links'] as Row[] | undefined) ?? []).map((k) =>
    linkFromRow({
      voucher_id: voucher.id,
      line_no: k['line_no'],
      entry_date: voucher.date,
      order_id: k['order_id'],
      order_line_id: k['order_line_id'],
      item_id: k['item_id'],
      qty: k['qty'],
    }),
  );
  return { voucher, plan: { journal, stock, links }, replayed: r['replayed'] === true };
}
