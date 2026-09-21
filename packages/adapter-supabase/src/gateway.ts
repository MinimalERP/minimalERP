import {
  type Issue,
  type Result,
  type Voucher,
  fail,
  failWith,
  issue,
  journalLineFromWire,
  orderLinkFromWire,
  stockMovementFromWire,
  ok,
  voucherFromWire,
  type JournalLineWire,
  type OrderLinkWire,
  type StockMovementWire,
  type VoucherWire,
} from '@minimalerp/domain';
import type {
  AlterRequest,
  CancelRequest,
  MasterGateway,
  MasterOutcome,
  MasterRequest,
  PostOutcome,
  PostRequest,
  PostingGateway,
} from '@minimalerp/ports';
import type { SupabaseError, SupabaseLike } from './client';

/** Not a domain rule: the request never got a business answer (network down, function crashed…). */
export const REQUEST_FAILED = 'REQUEST_FAILED';

const FUNCTION = 'post-voucher';

type Envelope =
  | { ok: true; value: unknown }
  | { ok: false; issues: readonly Issue[] };

const isEnvelope = (v: unknown): v is Envelope =>
  typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';

/**
 * The browser's PostingGateway: it does not write anything itself. It sends the draft to the
 * `post-voucher` Edge Function, which validates, plans and commits atomically with the caller's
 * identity. The browser never sends journal lines — only intent.
 */
export class SupabasePostingGateway implements PostingGateway, MasterGateway {
  /**
   * `region` pins where the function runs (Supabase's `x-region` header), e.g. 'ap-northeast-1'. Left alone, Supabase runs it at the edge
   * nearest the caller — which is far from the database for anyone not near it, and a change makes about ten database queries: from India to a
   * Tokyo database that was 5 s to open the books, all of it crossing regions. Set it to the project's own region.
   */
  constructor(
    private readonly client: SupabaseLike,
    private readonly options: { readonly region?: string | undefined } = {},
  ) {}

  async post(request: PostRequest): Promise<Result<PostOutcome>> {
    const r = await this.call({ action: 'post', companyId: request.companyId, draft: request.draft });
    return r.ok ? ok(outcomeFromWire(r.value)) : r;
  }

  async alter(request: AlterRequest): Promise<Result<PostOutcome>> {
    const r = await this.call({
      action: 'alter',
      companyId: request.companyId,
      voucherId: request.voucherId,
      expectedVersion: request.expectedVersion,
      draft: request.draft,
    });
    return r.ok ? ok(outcomeFromWire(r.value)) : r;
  }

  async cancel(request: CancelRequest): Promise<Result<Voucher>> {
    const r = await this.call({
      action: 'cancel',
      companyId: request.companyId,
      voucherId: request.voucherId,
      expectedVersion: request.expectedVersion,
    });
    return r.ok ? ok(voucherFromWire((r.value as { voucher: VoucherWire }).voucher)) : r;
  }

  /** Master-data commands (create / alter / activate) go through the same function: validated and committed on the server. */
  async execute(request: MasterRequest): Promise<Result<MasterOutcome>> {
    const r = await this.call({ action: 'master', companyId: request.companyId, command: request.command });
    return r.ok ? ok(r.value as MasterOutcome) : r;
  }

  /** Sends a command and unwraps the { ok, value | issues } envelope. */
  protected async call(body: Record<string, unknown>): Promise<Result<unknown>> {
    const { data, error } = await this.client.functions.invoke(FUNCTION, {
      body: bigintSafe(this.prepare(body)) as Record<string, unknown>,
      ...(this.options.region ? { headers: { 'x-region': this.options.region } } : {}),
    });

    if (error) return failWith(await issuesFromError(error));
    if (!isEnvelope(data)) return fail(issue(REQUEST_FAILED, 'The server sent an unexpected response'));
    if (!data.ok) return failWith(data.issues);
    const fresh = (data as { fresh?: unknown }).fresh;
    if (fresh !== undefined) this.received(fresh);
    return ok(data.value);
  }

  /** Lets a subclass add to what is sent (the plain gateway sends exactly the command). */
  protected prepare(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  /** Called with what the server sent along with an answer (see `fresh` in the function's contract). The plain gateway has no use for it. */
  protected received(_fresh: unknown): void {
    /* nothing to keep */
  }
}

/** Drafts held in the browser use bigint for money; JSON cannot carry bigint, so send decimal strings. */
function bigintSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const negative = value < 0n;
    const abs = negative ? -value : value;
    return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  }
  if (Array.isArray(value)) return value.map(bigintSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintSafe(v)]));
  }
  return value;
}

/**
 * supabase-js reports any non-2xx as an error carrying the raw Response. Our function returns
 * the same { ok:false, issues } envelope for those (401, 400, 500), so surface those issues.
 */
async function issuesFromError(error: SupabaseError): Promise<readonly Issue[]> {
  const response = error.context as { json?: () => Promise<unknown> } | undefined;
  if (response && typeof response.json === 'function') {
    try {
      const body = await response.json();
      if (isEnvelope(body) && !body.ok && body.issues.length > 0) return body.issues;
    } catch {
      /* not JSON — fall through */
    }
  }
  return [issue(REQUEST_FAILED, error.message)];
}

function outcomeFromWire(value: unknown): PostOutcome {
  const v = value as { voucher: VoucherWire; journal: JournalLineWire[]; stock?: StockMovementWire[]; links?: OrderLinkWire[]; replayed: boolean };
  return {
    voucher: voucherFromWire(v.voucher),
    plan: {
      journal: v.journal.map(journalLineFromWire),
      stock: (v.stock ?? []).map(stockMovementFromWire),
      links: (v.links ?? []).map(orderLinkFromWire),
    },
    replayed: v.replayed,
  };
}
