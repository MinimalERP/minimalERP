import {
  type CompanyId,
  type JournalLine,
  type JournalLineWire,
  type Masters,
  type NewCompany,
  type Result,
  type StockMovement,
  type StockMovementWire,
  type Voucher,
  type VoucherId,
  type VoucherWire,
  type BaseKind,
  type IntakeKind,
  buildMasters,
  defaultVoucherKinds,
  journalLineFromWire,
  ok,
  proposalSchema,
  stockMovementFromWire,
  voucherFromWire,
} from '@minimalerp/domain';
import type { AlterRequest, CancelRequest, ChangeFeed, CompanyExchange, SentDocument, MailSender, VoucherMailOrder, PostOutcome, PostRequest, VoucherChange, DocumentSender, InboxGateway, InboxItem, IntakeDocument, JournalQuery, MastersRepository, StockQuery, StockRepository, VoucherRepository, JournalRepository } from '@minimalerp/ports';
import { SupabasePostingGateway } from './gateway';

/** What arrives with a change's own answer: the parts of the books the browser is about to reload. */
interface Fresh {
  readonly companyId: string;
  readonly masters?: { readonly core: unknown; readonly ledgers: unknown };
  readonly books?: { readonly vouchers: VoucherWire[]; readonly lines: JournalLineWire[]; readonly movements: StockMovementWire[] };
}

/** The delivered parts, each handed over once. */
interface Parts {
  masters: { readonly core: unknown; readonly ledgers: unknown };
  vouchers: VoucherWire[];
  lines: JournalLineWire[];
  movements: StockMovementWire[];
}
type Delivered = { readonly companyId: string; readonly at: number } & { -readonly [K in keyof Parts]: Parts[K] | undefined };

/**
 * How long a delivered part waits to be asked for. The reload follows the change within milliseconds, so this is only a guard: something
 * that arrived with an old change must not answer a much later question.
 */
const FRESH_MS = 5_000;

/**
 * The actions whose answers the server can send fresh books along with (see the function's contract). A voucher change (post, alter,
 * cancel) is not among them: its own answer already carries the voucher with its journal and stock rows, and the screens patch their copy
 * with just that (see `changeOf`) instead of taking the whole company again.
 */
const CHANGES = new Set(['master', 'companies', 'company-create']);

/** The one extra person of a company: their account's email, and since when. */
export interface CompanyUser {
  readonly email: string;
  readonly since: string;
}

/** A company's own Gmail script as the owner sees it: the address, and when it was set. */
export interface CompanyMail {
  readonly url: string;
  readonly updatedAt: string;
}

/** A company this account belongs to, and the account's role in it ('owner' for the companies it made). */
export interface CompanySummary {
  readonly id: CompanyId;
  readonly name: string;
  readonly role: string;
}

/**
 * The browser's whole backend when the books live online: posting and master changes (from the gateway it extends), and reading the
 * books back. Every call is one request to the `post-voucher` Edge Function, which checks the caller's permission before it answers —
 * the browser never reads a table directly, so what it may see is decided in one place.
 *
 * The port's reads return plain values, so a request that cannot be answered (offline, refused) throws; the callers already treat a
 * failed load as "could not open the books".
 */
export class SupabaseBooksBackend
  extends SupabasePostingGateway
  implements MastersRepository, VoucherRepository, JournalRepository, StockRepository, InboxGateway, DocumentSender, ChangeFeed, MailSender, CompanyExchange
{
  private readonly kinds = defaultVoucherKinds();
  /** The masters of the last `load`, for turning stored vouchers back into what the screens hold (see `readable`). */
  private latest: Masters | undefined;
  /**
   * Every request is a network round trip (the slow part of using the books online), and after a change the screens reload what it touched.
   * So a change asks the server to send those parts with its answer (`fresh`), and the reads that follow are answered from here instead of
   * going out again. Each part is used once, only for the company it is about, and only if it is recent.
   */
  private delivered: Delivered | undefined;
  /** The voucher the last change left behind, read back like `list` reads it; handed over once by `changeOf`. */
  private lastChange: { readonly companyId: string; readonly change: VoucherChange } | undefined;

  override async post(request: PostRequest): Promise<Result<PostOutcome>> {
    return this.keep(request.companyId, await super.post(request));
  }

  override async alter(request: AlterRequest): Promise<Result<PostOutcome>> {
    return this.keep(request.companyId, await super.alter(request));
  }

  override async cancel(request: CancelRequest): Promise<Result<Voucher>> {
    const r = await super.cancel(request);
    this.lastChange = undefined;
    if (r.ok) {
      this.delivered = undefined; // what arrived before the change no longer answers anything
      const [voucher] = await this.readable(request.companyId, [r.value]);
      if (voucher) this.lastChange = { companyId: request.companyId, change: { voucher, lines: [], movements: [] } }; // a cancelled voucher has none
    }
    return r;
  }

  /** The voucher a change just made, with its journal and stock — once, and only for the company and voucher it is about. */
  async changeOf(companyId: CompanyId, voucherId: VoucherId): Promise<VoucherChange | undefined> {
    const last = this.lastChange;
    this.lastChange = undefined;
    return last && last.companyId === companyId && last.change.voucher.id === voucherId ? last.change : undefined;
  }

  private async keep(companyId: CompanyId, r: Result<PostOutcome>): Promise<Result<PostOutcome>> {
    this.lastChange = undefined;
    if (r.ok) {
      this.delivered = undefined; // what arrived before the change no longer answers anything
      const [voucher] = await this.readable(companyId, [r.value.voucher]);
      if (voucher) this.lastChange = { companyId, change: { voucher, lines: r.value.plan.journal, movements: r.value.plan.stock } };
    }
    return r;
  }

  /** The companies this account belongs to (none until the person creates theirs). The books that come with the answer are `open`'s, or the first's. */
  async companies(open?: CompanyId): Promise<Result<readonly CompanySummary[]>> {
    const r = await this.call({ action: 'companies', ...(open ? { companyId: open } : {}) });
    return r.ok ? ok((r.value as { companies: CompanySummary[] }).companies) : r;
  }

  /** Creates the account's company (the server seeds the chart of accounts and makes the caller its owner). */
  async createCompany(input: NewCompany): Promise<Result<{ readonly companyId: CompanyId }>> {
    const r = await this.call({ action: 'company-create', company: input });
    return r.ok ? ok(r.value as { companyId: CompanyId }) : r;
  }

  async load(companyId: CompanyId): Promise<Masters> {
    const delivered = this.take(companyId, 'masters');
    const value = delivered ?? ((await this.read({ action: 'load', companyId })) as { core: unknown; ledgers: unknown });
    this.latest = buildMasters(value.core, value.ledgers);
    return this.latest;
  }

  async list(companyId: CompanyId): Promise<readonly Voucher[]> {
    const delivered = this.take(companyId, 'vouchers');
    const wire = delivered ?? ((await this.read({ action: 'vouchers', companyId })) as { vouchers: VoucherWire[] }).vouchers;
    return this.readable(companyId, wire.map(voucherFromWire));
  }

  async get(companyId: CompanyId, voucherId: VoucherId): Promise<Voucher | undefined> {
    const value = (await this.read({ action: 'voucher', companyId, voucherId })) as { voucher: VoucherWire | null };
    return value.voucher === null ? undefined : (await this.readable(companyId, [voucherFromWire(value.voucher)]))[0];
  }

  async lines(query: JournalQuery): Promise<readonly JournalLine[]> {
    // Only the whole journal is delivered; a question about part of it (a ledger, a period, a voucher) goes to the server.
    const whole = query.from === undefined && query.to === undefined && query.ledgerId === undefined && query.voucherId === undefined;
    const delivered = whole ? this.take(query.companyId, 'lines') : undefined;
    const wire = delivered ?? ((await this.read({ action: 'lines', ...query })) as { lines: JournalLineWire[] }).lines;
    return wire.map(journalLineFromWire);
  }

  async stockMovements(query: StockQuery): Promise<readonly StockMovement[]> {
    const delivered = query.itemIds === undefined ? this.take(query.companyId, 'movements') : undefined;
    const wire = delivered ?? ((await this.read({ action: 'stock', ...query })) as { movements: StockMovementWire[] }).movements;
    return wire.map(stockMovementFromWire);
  }

  // ---- the AI Inbox (ADR-0023): always asked fresh, never delivered with a change ----

  async inbox(companyId: CompanyId): Promise<Result<readonly InboxItem[]>> {
    const r = await this.call({ action: 'inbox', companyId });
    if (!r.ok) return r;
    const items: InboxItem[] = [];
    for (const raw of (r.value as { items?: unknown[] }).items ?? []) {
      const item = raw as { id?: unknown; proposal?: unknown; mailSubject?: unknown; mailFrom?: unknown; createdAt?: unknown };
      const proposal = proposalSchema.safeParse(item.proposal);
      if (typeof item.id !== 'string' || !proposal.success) continue;
      items.push({
        id: item.id,
        kind: proposal.data.kind,
        proposal: proposal.data,
        ...(typeof item.mailSubject === 'string' ? { mailSubject: item.mailSubject } : {}),
        ...(typeof item.mailFrom === 'string' ? { mailFrom: item.mailFrom } : {}),
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      });
    }
    return ok(items);
  }

  /** Upload: the `intake` function reads it in the background (it answers at once). */
  async sendDocument(companyId: CompanyId, s: { readonly kind: IntakeKind; readonly document: IntakeDocument; readonly name?: string | undefined }): Promise<Result<{ readonly id: string }>> {
    const r = await this.call({ companyId, kind: s.kind, document: s.document, background: true, ...(s.name ? { mail: { subject: `Uploaded: ${s.name}`.slice(0, 200) } } : {}) }, 'intake');
    return r.ok ? ok({ id: String((r.value as { id?: unknown }).id ?? '') }) : r;
  }

  async rejectInbox(companyId: CompanyId, id: string, reason?: string): Promise<Result<void>> {
    const r = await this.call({ action: 'inbox-reject', companyId, id, ...(reason ? { reason } : {}) });
    return r.ok ? ok(undefined) : r;
  }

  /** The company's one extra person (ADR-0025), or null. Only the owner may ask. */
  async companyUser(companyId: CompanyId): Promise<Result<CompanyUser | null>> {
    const r = await this.call({ action: 'company-user', companyId });
    return r.ok ? ok((r.value as { user: CompanyUser | null }).user) : r;
  }

  /** Links the account with this email to the company as its one extra person; '' removes them. */
  async setCompanyUser(companyId: CompanyId, email: string): Promise<Result<CompanyUser | null>> {
    const r = await this.call({ action: 'company-user-set', companyId, email });
    return r.ok ? ok((r.value as { user: CompanyUser | null }).user) : r;
  }

  /** The company's own Gmail script (ADR-0025): its address, never its secret. Only the owner may ask. */
  async companyMail(companyId: CompanyId): Promise<Result<CompanyMail | null>> {
    const r = await this.call({ action: 'company-mail', companyId });
    return r.ok ? ok((r.value as { script: CompanyMail | null }).script) : r;
  }

  /** Sets it: a blank address removes it, a blank secret keeps the one set before. */
  async setCompanyMail(companyId: CompanyId, url: string, secret: string): Promise<Result<CompanyMail | null>> {
    const r = await this.call({ action: 'company-mail-set', companyId, url, secret });
    return r.ok ? ok((r.value as { script: CompanyMail | null }).script) : r;
  }

  /** Send via ERP (ADR-0025): the server finds the owner's company with the party's GSTIN and puts it in that company's inbox. */
  async sendToCompany(companyId: CompanyId, voucherId: VoucherId): Promise<Result<{ readonly toCompany: string; readonly toKind: string }>> {
    const r = await this.call({ action: 'exchange-send', companyId, voucherId });
    return r.ok ? ok(r.value as { toCompany: string; toKind: string }) : r;
  }

  /** What this company sent to the owner's other companies, and what became of each. */
  async sentToCompanies(companyId: CompanyId): Promise<Result<readonly SentDocument[]>> {
    const r = await this.call({ action: 'exchange-sent', companyId });
    return r.ok ? ok((r.value as { sent: SentDocument[] }).sent) : r;
  }

  /** Emails a voucher to its party through the company's Gmail (the server checks the addresses are that party's). */
  async sendVoucherMail(mail: VoucherMailOrder): Promise<Result<{ readonly sentTo: readonly string[] }>> {
    const r = await this.call({ action: 'send-mail', ...mail });
    return r.ok ? ok(r.value as { sentTo: string[] }) : r;
  }

  /** A change (and the opening of a company) asks for the parts of the books it touches to come with its answer. */
  protected override prepare(body: Record<string, unknown>): Record<string, unknown> {
    return CHANGES.has(String(body['action'])) ? { ...body, fresh: true } : body;
  }

  protected override received(fresh: unknown): void {
    const f = fresh as Fresh;
    if (typeof f?.companyId !== 'string') return;
    this.delivered = { companyId: f.companyId, at: Date.now(), masters: f.masters, vouchers: f.books?.vouchers, lines: f.books?.lines, movements: f.books?.movements };
  }

  /** Hands over a delivered part, once, if it is about this company and recent; otherwise undefined (and the caller asks the server). */
  private take<K extends keyof Parts>(companyId: string, part: K): Parts[K] | undefined {
    const d = this.delivered;
    if (!d || d.companyId !== companyId || Date.now() - d.at > FRESH_MS) return undefined;
    const value = d[part] as Parts[K] | undefined;
    (d as Record<keyof Parts, unknown>)[part] = undefined; // each part answers one question, then the next one goes to the server
    return value;
  }

  private async read(body: Record<string, unknown>): Promise<unknown> {
    const r = await this.call(body);
    if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
    return r.value;
  }

  /**
   * A voucher's content crosses the wire as JSON, with money as decimal strings. The screens hold it the way it was entered (money as
   * bigint), so it is read back through its kind's own schema — the parse that produced it in the first place. A voucher of a kind that is
   * not registered, or content that no longer parses, is returned as it came: reading never fails.
   */
  private async readable(companyId: CompanyId, vouchers: readonly Voucher[]): Promise<readonly Voucher[]> {
    if (vouchers.length === 0) return vouchers;
    const masters = this.latest?.company.id === companyId ? this.latest : await this.load(companyId);
    return vouchers.map((v) => {
      const base = masters.voucherType(v.voucherTypeId)?.baseKind;
      const kind = base === undefined ? undefined : this.kinds.get(base as BaseKind);
      const parsed = kind?.parse(v.content);
      return parsed?.ok ? { ...v, content: parsed.value } : v;
    });
  }
}
