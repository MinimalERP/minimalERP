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
  buildMasters,
  defaultVoucherKinds,
  journalLineFromWire,
  ok,
  stockMovementFromWire,
  voucherFromWire,
} from '@minimalerp/domain';
import type { JournalQuery, MastersRepository, StockQuery, StockRepository, VoucherRepository, JournalRepository } from '@minimalerp/ports';
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

/** The actions whose answers the server can send fresh books along with (see the function's contract). */
const CHANGES = new Set(['post', 'alter', 'cancel', 'master', 'companies', 'company-create']);

/** A company this account belongs to. */
export interface CompanySummary {
  readonly id: CompanyId;
  readonly name: string;
}

/**
 * The browser's whole backend when the books live online: posting and master changes (from the gateway it extends), and reading the
 * books back. Every call is one request to the `post-voucher` Edge Function, which checks the caller's permission before it answers —
 * the browser never reads a table directly, so what it may see is decided in one place.
 *
 * The port's reads return plain values, so a request that cannot be answered (offline, refused) throws; the callers already treat a
 * failed load as "could not open the books".
 */
export class SupabaseBooksBackend extends SupabasePostingGateway implements MastersRepository, VoucherRepository, JournalRepository, StockRepository {
  private readonly kinds = defaultVoucherKinds();
  /** The masters of the last `load`, for turning stored vouchers back into what the screens hold (see `readable`). */
  private latest: Masters | undefined;
  /**
   * Every request is a network round trip (the slow part of using the books online), and after a change the screens reload what it touched.
   * So a change asks the server to send those parts with its answer (`fresh`), and the reads that follow are answered from here instead of
   * going out again. Each part is used once, only for the company it is about, and only if it is recent.
   */
  private delivered: Delivered | undefined;

  /** The companies this account belongs to (none until the person creates theirs). */
  async companies(): Promise<Result<readonly CompanySummary[]>> {
    const r = await this.call({ action: 'companies' });
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
