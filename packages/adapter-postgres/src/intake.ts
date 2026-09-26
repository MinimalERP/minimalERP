import {
  type CompanyId,
  type Issue,
  type Masters,
  type Proposal,
  type Result,
  type Voucher,
  INTAKE_KINDS,
  IssueCode,
  extractionSchema,
  fail,
  issue,
  localDate,
  ok,
  orderBookOf,
  proposeFromExtraction,
  readRemittanceAdvice,
} from '@minimalerp/domain';
import type { DocumentReader, InboxSubmission } from '@minimalerp/ports';
import { z } from 'zod';

/**
 * The core of the `intake` Edge Function (ADR-0023): a person chose a document in Gmail and pressed "Send to ERP → Sales Order" (or the
 * Upload button in the AI Inbox). This reads it, matches what it says against the company's masters, and puts the PROPOSAL in the inbox —
 * nothing is posted. The document is held only for this request: it goes to the reader, and is gone; it is never logged or stored.
 *
 *   POST { kind, document: { mimeType, base64 } | { text }, mail?: { subject?, from? }, companyId?, background?, rule? }
 *   200  { ok: true, value: { id, kind, party?, notes } }        what was queued, for the add-on to say
 *   200  { ok: true, value: { id, kind, background: true } }     the default: answered at once, read afterwards (Gmail gives an
 *                                                                add-on ~30 s; a busy reader may need longer). A reading that still
 *                                                                fails leaves an inbox item saying so ("send it again").
 *                                                                `background: false` waits for the reading and answers with it.
 *   200  { ok: false, issues }                                   refused (permission, unreadable document, the reader busy…)
 *   400 malformed · 401 not signed in · 405 wrong method · 413 too large · 500 unexpected
 * `companyId` may be left out by a sign-in that belongs to one company (the add-on's).
 *
 * A receipt PDF is first tried against the fixed payment-advice rules (`readRemittanceAdvice`), read from the PDF's own text: a layout
 * a rule knows never goes to the reader. `rule: 'remittance'` (Gmail's "Eclipse Receipt") means ONLY the rule: a document it does
 * not recognise is queued as not read, never handed to Gemini to guess.
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
  /** Keeps work running after the answer is sent (Supabase: EdgeRuntime.waitUntil). Without it `background` is ignored. */
  defer?(work: Promise<unknown>): void;
  /** A PDF's own text (base64 in), for the fixed payment-advice rules. Without it every document goes to the reader. */
  pdfText?(base64: string): Promise<string>;
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
    z.object({ extraction: z.unknown() }),
  ]),
  mail: z.object({ subject: z.string().max(1000).optional(), from: z.string().max(1000).optional() }).optional(),
  background: z.boolean().optional(),
  rule: z.enum(['remittance']).optional(),
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
      // Without a company named, only a sign-in with exactly one company may send: with several, guessing could put one business's
      // documents in another's inbox (ADR-0025). The add-on then needs its COMPANY_ID.
      const mine = cmd.companyId ? [] : await gateway.companiesOf();
      if (!cmd.companyId && mine.length > 1) {
        return json(200, { ok: false, issues: [issue(IssueCode.UnsupportedOperation, 'This sign-in has several companies: set COMPANY_ID in the add-on to the one it sends to')] });
      }
      const companyId = cmd.companyId ?? mine[0]?.id;
      // the same answer for "no such company" and "not yours": a stranger learns nothing
      if (!companyId || !(await gateway.can(companyId, 'inbox.submit'))) {
        return json(200, { ok: false, issues: [issue(IssueCode.PermissionDenied, 'Not permitted: inbox.submit')] });
      }

      const masters = await gateway.load(companyId as CompanyId);
      const id = crypto.randomUUID();
      const mailSubject = cmd.mail?.subject?.slice(0, 200);
      const mailFrom = cmd.mail?.from?.slice(0, 200);
      const today = localDate((deps.today ?? indiaToday)());
      // A CSV row (or another bulk import) already IS an Extraction — mechanical, structured data, needing no reading at all.
      const cmdDocument = cmd.document;

      /** Read, match, queue. In the background a failed reading is queued too, as an item that says so — the person sent something and must learn it did not arrive. */
      const work = async (background: boolean): Promise<Result<{ id: string; party?: string; notes: string[] }>> => {
        const ruled =
          cmd.kind === 'receipt' && 'base64' in cmdDocument && cmdDocument.mimeType === 'application/pdf' && deps.pdfText
            ? await deps.pdfText(cmdDocument.base64).then(readRemittanceAdvice, () => undefined)
            : undefined;
        const read =
          'extraction' in cmdDocument
            ? ok(cmdDocument.extraction)
            : ruled
              ? ok(ruled)
              : cmd.rule
                ? fail(issue('NOT_RECOGNISED' as never, 'it is not an Eclipse Combustion remittance advice, or its rows do not add up to its total'))
                : await deps.reader.read({
                kind: cmd.kind,
                ownCompany: masters.company.name,
                document: 'text' in cmdDocument ? { text: cmdDocument.text } : { mimeType: cmdDocument.mimeType, base64: cmdDocument.base64 },
              });
        const extraction = read.ok ? extractionSchema.safeParse(read.value) : undefined;
        if (!read.ok || !extraction?.success) {
          const why = read.ok ? 'the reading did not come back in the expected shape' : (read.issues[0]?.message ?? 'the reader did not answer');
          if (background) {
            const failed: Proposal = {
              kind: cmd.kind,
              date: today,
              party: {},
              lines: [],
              bills: [],
              notes: [{ code: 'READ_FAILED', message: `This document could not be read (${why}). Send the mail again from Gmail, and reject this line (Alt+X).`.slice(0, 300) }],
            };
            await gateway.submitInbox({ companyId: companyId as CompanyId, id, proposal: failed, mailSubject, mailFrom });
          }
          return read.ok ? fail(issue('DOCUMENT_UNREADABLE' as never, 'The reading did not come back in the expected shape: try again')) : read;
        }
        const vouchers = await gateway.list(companyId as CompanyId);
        const proposal = proposeFromExtraction(cmd.kind, extraction.data, { masters, vouchers, orders: orderBookOf(vouchers, masters), today });
        const queued = await gateway.submitInbox({ companyId: companyId as CompanyId, id, proposal, mailSubject, mailFrom });
        if (!queued.ok) {
          // in the background nobody is waiting for the answer: say it where someone will see it
          if (background) deps.onError?.(new Error(`The proposal was not queued: ${queued.issues.map((i) => i.message).join('; ')}`), requestId);
          return queued;
        }
        const party = proposal.party.partyId ? masters.party(proposal.party.partyId as never)?.name : proposal.party.name;
        return ok({ id, ...(party ? { party } : {}), notes: proposal.notes.map((n) => n.message) });
      };

      // Background unless the caller asks to wait (`background: false`): an add-on button may take ~30 s at most, and a busy Gemini longer.
      if ((cmd.background ?? true) && deps.defer) {
        deps.defer(work(true).catch((error: unknown) => deps.onError?.(error, requestId)));
        return json(200, { ok: true, value: { id, kind: cmd.kind, background: true } });
      }
      const done = await work(false);
      return json(200, done.ok ? { ok: true, value: { kind: cmd.kind, ...done.value } } : done);
    } catch (error) {
      deps.onError?.(error, requestId);
      return refuse(500, 'INTERNAL', `Something went wrong (request ${requestId})`);
    }
  };
}
