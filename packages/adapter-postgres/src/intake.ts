import {
  type CompanyId,
  type Issue,
  type Masters,
  type Result,
  type Voucher,
  INTAKE_KINDS,
  IssueCode,
  extractionSchema,
  issue,
  localDate,
  orderBookOf,
  proposeFromExtraction,
} from '@minimalerp/domain';
import type { DocumentReader, InboxSubmission } from '@minimalerp/ports';
import { z } from 'zod';

/**
 * The core of the `intake` Edge Function (ADR-0023): a person chose a document in Gmail and pressed "Send to ERP → Sales Order" (or the
 * Upload button in the AI Inbox). This reads it, matches what it says against the company's masters, and puts the PROPOSAL in the inbox —
 * nothing is posted. The document is held only for this request: it goes to the reader, and is gone; it is never logged or stored.
 *
 *   POST { kind, document: { mimeType, base64 } | { text }, mail?: { subject?, from? }, companyId? }
 *   200  { ok: true, value: { id, kind, party?, notes } }        what was queued, for the add-on to say
 *   200  { ok: false, issues }                                   refused (permission, unreadable document, the reader busy…)
 *   400 malformed · 401 not signed in · 405 wrong method · 413 too large · 500 unexpected
 * `companyId` may be left out by a sign-in that belongs to one company (the add-on's).
 */

/** What the handler needs from the server-side backend (PostgresBackend is one). */
export interface IntakeServer {
  companiesOf(): Promise<readonly { readonly id: string; readonly name: string }[]>;
  can(companyId: string, permission: string): Promise<boolean>;
  load(companyId: CompanyId): Promise<Masters>;
  list(companyId: CompanyId): Promise<readonly Voucher[]>;
  submitInbox(s: InboxSubmission): Promise<Result<{ readonly id: string }>>;
}

export interface IntakeHandlerDeps {
  authenticate(request: Request): Promise<{ userId: string } | undefined>;
  gatewayFor(actorId: string, requestId: string): IntakeServer;
  reader: DocumentReader;
  /** Today in the company's time zone (a document without a date is proposed on it). Default: today in India. */
  today?(): string;
  /** Unexpected errors, for the host's log. Never the document. */
  onError?(error: unknown, requestId: string): void;
  allowOrigin?: string;
}

/** 10 MB of document is ~13.4 MB of base64; a little more for the rest of the body. */
const MAX_BODY_BYTES = 14 * 1024 * 1024;

const body = z.object({
  kind: z.enum(INTAKE_KINDS),
  companyId: z.string().min(1).optional(),
  document: z.union([
    z.object({ mimeType: z.string().min(1).max(100), base64: z.string().min(1) }),
    z.object({ text: z.string().max(200_000) }),
  ]),
  mail: z.object({ subject: z.string().max(1000).optional(), from: z.string().max(1000).optional() }).optional(),
});

const indiaToday = (): string => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function createIntakeHandler(deps: IntakeHandlerDeps): (request: Request) => Promise<Response> {
  const cors = {
    'access-control-allow-origin': deps.allowOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-request-id',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '7200',
  };
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { ...cors, 'content-type': 'application/json' } });
  const refuse = (status: number, code: string, message: string) => json(status, { ok: false, issues: [{ code, message } satisfies Issue] });

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return refuse(405, 'METHOD_NOT_ALLOWED', 'Use POST');
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try {
      const user = await deps.authenticate(request);
      if (!user) return refuse(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) return refuse(413, 'DOCUMENT_TOO_LARGE', 'The document is larger than 10 MB');

      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return refuse(400, 'BAD_REQUEST', 'Request body must be JSON');
      }
      const parsed = body.safeParse(raw);
      if (!parsed.success) return refuse(400, 'BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const cmd = parsed.data;

      const gateway = deps.gatewayFor(user.userId, requestId);
      const companyId = cmd.companyId ?? (await gateway.companiesOf())[0]?.id;
      // the same answer for "no such company" and "not yours": a stranger learns nothing
      if (!companyId || !(await gateway.can(companyId, 'inbox.submit'))) {
        return json(200, { ok: false, issues: [issue(IssueCode.PermissionDenied, 'Not permitted: inbox.submit')] });
      }

      const masters = await gateway.load(companyId as CompanyId);
      const read = await deps.reader.read({
        kind: cmd.kind,
        ownCompany: masters.company.name,
        document: 'text' in cmd.document ? { text: cmd.document.text } : { mimeType: cmd.document.mimeType, base64: cmd.document.base64 },
      });
      if (!read.ok) return json(200, read);
      const extraction = extractionSchema.safeParse(read.value);
      if (!extraction.success) return refuse(200, 'DOCUMENT_UNREADABLE', 'The reading did not come back in the expected shape: try again');

      const vouchers = await gateway.list(companyId as CompanyId);
      const proposal = proposeFromExtraction(cmd.kind, extraction.data, {
        masters,
        vouchers,
        orders: orderBookOf(vouchers, masters),
        today: localDate((deps.today ?? indiaToday)()),
      });
      const id = crypto.randomUUID();
      const queued = await gateway.submitInbox({
        companyId: companyId as CompanyId,
        id,
        proposal,
        mailSubject: cmd.mail?.subject?.slice(0, 200),
        mailFrom: cmd.mail?.from?.slice(0, 200),
      });
      if (!queued.ok) return json(200, queued);
      const party = proposal.party.partyId ? masters.party(proposal.party.partyId as never)?.name : proposal.party.name;
      return json(200, { ok: true, value: { id, kind: cmd.kind, ...(party ? { party } : {}), notes: proposal.notes.map((n) => n.message) } });
    } catch (error) {
      deps.onError?.(error, requestId);
      return refuse(500, 'INTERNAL', `Something went wrong (request ${requestId})`);
    }
  };
}
