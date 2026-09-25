/**
 * @minimalerp/ports — interfaces only. The domain and UI depend on these; adapters implement them
 * (in-memory now, Supabase in Phase 2). Everything is async because real backends are.
 */
import type {
  CompanyId,
  Extraction,
  MasterKind,
  MasterOp,
  JournalLine,
  LedgerId,
  LocalDate,
  Masters,
  IntakeKind,
  OrderLink,
  PostingPlan,
  Proposal,
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

/** A voucher emailed to its party through the company's Gmail (the attachment is the PDF the person chose, e.g. one they signed). */
export interface VoucherMailOrder {
  readonly companyId: CompanyId;
  readonly voucherId: VoucherId;
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachment?: { readonly name: string; readonly base64: string } | undefined;
}

export interface MailSender {
  sendVoucherMail(mail: VoucherMailOrder): Promise<Result<{ readonly sentTo: readonly string[] }>>;
}

/** One voucher as it stands after a change, with its journal lines and stock movements (none once cancelled). */
export interface VoucherChange {
  readonly voucher: Voucher;
  readonly lines: readonly JournalLine[];
  readonly movements: readonly StockMovement[];
}

/**
 * What a change touched, so the screens can patch their copy of the books instead of reloading all of it. Undefined when the backend
 * cannot say cheaply (then the caller reloads everything, as before).
 */
export interface ChangeFeed {
  changeOf(companyId: CompanyId, voucherId: VoucherId): Promise<VoucherChange | undefined>;
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

/** One proposal waiting in the AI Inbox (ADR-0023): what a sent document was read as, and one line of the mail it came in. */
export interface InboxItem {
  readonly id: string;
  readonly kind: IntakeKind;
  readonly proposal: Proposal;
  readonly mailSubject?: string | undefined;
  readonly mailFrom?: string | undefined;
  /** ISO timestamp. */
  readonly createdAt: string;
}

export interface InboxSubmission {
  readonly companyId: CompanyId;
  /** A fresh UUID: it becomes the voucher's id when the proposal is accepted, so it can only ever be posted once. */
  readonly id: string;
  readonly proposal: Proposal;
  readonly mailSubject?: string | undefined;
  readonly mailFrom?: string | undefined;
}

/**
 * The AI Inbox. Accepting is not here: it is an ordinary post (PostingGateway) of the voucher a person completed, under the item's id —
 * posting it removes the item. Rejecting throws the proposal away.
 */
/**
 * Sending a document to the AI Inbox from the ERP itself (Upload: a PDF from WhatsApp or a portal, a photo of a paper bill) — the same
 * reading and matching as the Gmail panel. Answered at once; the proposal appears when the reading is done.
 */
export interface DocumentSender {
  sendDocument(companyId: CompanyId, s: { readonly kind: IntakeKind; readonly document: IntakeDocument; readonly name?: string | undefined }): Promise<Result<{ readonly id: string }>>;
}

export interface InboxGateway {
  inbox(companyId: CompanyId): Promise<Result<readonly InboxItem[]>>;
  rejectInbox(companyId: CompanyId, id: string, reason?: string): Promise<Result<void>>;
}

/** A document a person chose to send to the ERP: a PDF or an image (base64), or the text of a mail — something an
 *  actual reader (Gemini) must read. */
export type ReadableDocument = { readonly mimeType: string; readonly base64: string } | { readonly text: string };

/** `ReadableDocument`, or — for a bulk CSV import — an `Extraction` already built directly from a spreadsheet
 *  row, needing no reading at all. Never stored as sent — read (or, for the last case, used as-is), then gone. */
export type IntakeDocument = ReadableDocument | { readonly extraction: Extraction };

/**
 * Reads a document into the extraction shape (`extractionSchema` in the domain) — the raw answer, which the caller parses. Failures a person
 * should see (the reader is busy, the document could not be read) come back as issues, never thrown. Never asked to read an `extraction` —
 * the caller already has one for that case.
 */
export interface DocumentReader {
  read(input: { readonly kind: IntakeKind; readonly ownCompany: string; readonly document: ReadableDocument }): Promise<Result<unknown>>;
}
