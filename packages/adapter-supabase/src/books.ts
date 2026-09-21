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
    const value = (await this.read({ action: 'load', companyId })) as { core: unknown; ledgers: unknown };
    this.latest = buildMasters(value.core, value.ledgers);
    return this.latest;
  }

  async list(companyId: CompanyId): Promise<readonly Voucher[]> {
    const value = (await this.read({ action: 'vouchers', companyId })) as { vouchers: VoucherWire[] };
    return this.readable(companyId, value.vouchers.map(voucherFromWire));
  }

  async get(companyId: CompanyId, voucherId: VoucherId): Promise<Voucher | undefined> {
    const value = (await this.read({ action: 'voucher', companyId, voucherId })) as { voucher: VoucherWire | null };
    return value.voucher === null ? undefined : (await this.readable(companyId, [voucherFromWire(value.voucher)]))[0];
  }

  async lines(query: JournalQuery): Promise<readonly JournalLine[]> {
    const value = (await this.read({ action: 'lines', ...query })) as { lines: JournalLineWire[] };
    return value.lines.map(journalLineFromWire);
  }

  async stockMovements(query: StockQuery): Promise<readonly StockMovement[]> {
    const value = (await this.read({ action: 'stock', ...query })) as { movements: StockMovementWire[] };
    return value.movements.map(stockMovementFromWire);
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
