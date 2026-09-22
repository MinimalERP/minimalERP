/**
 * @minimalerp/ports — interfaces only. The domain and UI depend on these; adapters implement them
 * (in-memory now, Supabase in Phase 2). Everything is async because real backends are.
 */
import type {
  CompanyId,
  MasterKind,
  MasterOp,
  JournalLine,
  LedgerId,
  LocalDate,
  Masters,
  OrderLink,
  PostingPlan,
  Result,
  StockItemId,
  StockMovement,
  Voucher,
  VoucherId,
} from '@minimalerp/domain';

export interface PostRequest {
  readonly companyId: CompanyId;
  /** The voucher draft as submitted (untrusted; parsed and validated by the engine). Its `id` is the idempotency key. */
  readonly draft: unknown;
}

export interface AlterRequest {
  readonly companyId: CompanyId;
  readonly voucherId: VoucherId;
  /** Optimistic-concurrency token: the `version` the caller last saw. */
  readonly expectedVersion: number;
  readonly draft: unknown;
}

export interface CancelRequest {
  readonly companyId: CompanyId;
  readonly voucherId: VoucherId;
  readonly expectedVersion: number;
}

export interface PostOutcome {
  readonly voucher: Voucher;
  readonly plan: PostingPlan;
  /** True when this exact voucher id + content had already been posted (a safe retry). */
  readonly replayed: boolean;
}

/**
 * The single write path into the books. Every implementation must be atomic (all of a voucher's
 * rows commit or none do) and must enforce Dr = Cr independently of the caller.
 * The UI never writes journal lines any other way.
 */
export interface PostingGateway {
  post(request: PostRequest): Promise<Result<PostOutcome>>;
  alter(request: AlterRequest): Promise<Result<PostOutcome>>;
  cancel(request: CancelRequest): Promise<Result<Voucher>>;
}

export interface MasterRequest {
  readonly companyId: CompanyId;
  /**
   * The master command as submitted (untrusted; parsed and validated by the master engine):
   * `{ op: 'create' | 'alter' | 'setActive', kind, id, data?, active? }`. Its `id` is the idempotency key.
   */
  readonly command: unknown;
}

export interface MasterOutcome {
  readonly kind: MasterKind;
  readonly op: MasterOp;
  readonly id: string;
  /** Display name of the record after the change, for confirmations and pickers. */
  readonly name: string;
  /** True when this create had already been applied (a safe retry). Nothing changed. */
  readonly replayed: boolean;
  /** Records this command also made (a party's ledgers), so the caller can act on them — post an opening balance to the new ledger. */
  readonly created: readonly { readonly kind: MasterKind; readonly id: string; readonly name: string }[];
}

/** A numbering series' running counter — the number it would allocate next. */
export interface SeriesStatus {
  readonly seriesId: string;
  readonly nextValue: number;
}

/**
 * The single write path into master data, mirroring PostingGateway: validate, apply, audit — all or nothing.
 * Clients reload masters through MastersRepository afterwards.
 */
export interface MasterGateway {
  execute(request: MasterRequest): Promise<Result<MasterOutcome>>;
  /** For the Numbering Series master's display and the "Next number" override — the current next_value, read-only. */
  seriesStatus(companyId: CompanyId, seriesId: string): Promise<Result<SeriesStatus>>;
}

export interface MastersRepository {
  load(companyId: CompanyId): Promise<Masters>;
}

export interface VoucherRepository {
  get(companyId: CompanyId, voucherId: VoucherId): Promise<Voucher | undefined>;
  list(companyId: CompanyId): Promise<readonly Voucher[]>;
}

export interface JournalQuery {
  readonly companyId: CompanyId;
  readonly from?: LocalDate | undefined;
  readonly to?: LocalDate | undefined;
  readonly ledgerId?: LedgerId | undefined;
  readonly voucherId?: VoucherId | undefined;
}

/** Read-only by design: there is no way to write the journal except through PostingGateway. */
export interface JournalRepository {
  lines(query: JournalQuery): Promise<readonly JournalLine[]>;
}

export interface StockQuery {
  readonly companyId: CompanyId;
  /** Only these items (the ones a change touches, or a report is about). Omitted: the whole company. */
  readonly itemIds?: readonly StockItemId[] | undefined;
}

/** The stock ledger, read-only like the journal: stock is written only by posting a voucher. */
export interface StockRepository {
  stockMovements(query: StockQuery): Promise<readonly StockMovement[]>;
}

export interface OrderQuery {
  readonly companyId: CompanyId;
  /** Only the deliveries against these sales orders. Omitted: every delivery in the company. */
  readonly orderIds?: readonly VoucherId[] | undefined;
}

/** The deliveries against sales-order lines, read-only: they are written only by posting a sales invoice. */
export interface OrderRepository {
  orderLinks(query: OrderQuery): Promise<readonly OrderLink[]>;
}

/** Who is signed in. Only what the app shows and keys per-person storage by; the server decides what they may do. */
export interface AuthSession {
  readonly userId: string;
  readonly email: string;
}

/**
 * Signing in and out. Failures come back as issues whose message is fit to show the person (wrong password, no such account…),
 * never as a thrown error. `onChange` fires when the session appears or goes (another tab signed out, the refresh token expired).
 */
export interface AuthGateway {
  session(): Promise<AuthSession | undefined>;
  signIn(email: string, password: string): Promise<Result<AuthSession>>;
  /** Emails a link that brings the person back to set a new password. (There is no sign-up: accounts are made by invitation.) */
  requestPasswordReset(email: string): Promise<Result<void>>;
  /** For the person who arrived by an invitation or reset link (they are signed in by it): choose the password they will sign in with. */
  setPassword(password: string): Promise<Result<AuthSession>>;
  signOut(): Promise<void>;
  onChange(listener: (session: AuthSession | undefined) => void): () => void;
}
