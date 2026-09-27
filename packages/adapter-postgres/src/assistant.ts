import {
  type AssistantBooks,
  type AssistantTool,
  type CompanyId,
  type Issue,
  type JournalLine,
  type Masters,
  type Result,
  type StockMovement,
  type Voucher,
  ASSISTANT_TOOLS,
  IssueCode,
  assistantPrompt,
  describeScreen,
  fail,
  issue,
  localDate,
  ok,
  runLookup,
} from '@minimalerp/domain';
import { z } from 'zod';
import type { AssistantFactRow } from './backend';

/**
 * The core of the `assistant` Edge Function: the floating assistant's question → an answer from the live books (v1, read only).
 *
 *   POST { companyId, messages: [{ role: 'user' | 'model', text }], screen?: { type, id?, kind?, title? } }
 *   200  { ok: true, value: { answer, sources } }   sources: the look-ups used ("from ERP · stock, orders")
 *   200  { ok: false, issues }                      Gemini busy / not set up, not a member, …
 *
 * Everything is read AS THE SIGNED-IN PERSON: a look-up needs the same permission its report needs in the ERP (report.view, or
 * voucher.view for invoices), and without it the model is told "not permitted", never given the data. The conversation is not stored;
 * only facts the person asks it to remember are (in the books, not in the model).
 */

/** What the handler needs from the server-side backend (PostgresBackend is one). */
export interface AssistantServer {
  companiesOf(): Promise<readonly { readonly id: string; readonly name: string }[]>;
  can(companyId: string, permission: string): Promise<boolean>;
  load(companyId: CompanyId): Promise<Masters>;
  list(companyId: CompanyId): Promise<readonly Voucher[]>;
  lines(query: { readonly companyId: CompanyId }): Promise<readonly JournalLine[]>;
  stockMovements(query: { readonly companyId: CompanyId }): Promise<readonly StockMovement[]>;
  assistantFacts(companyId: string): Promise<Result<readonly AssistantFactRow[]>>;
  addAssistantFact(companyId: string, id: string, text: string): Promise<Result<readonly AssistantFactRow[]>>;
  removeAssistantFact(companyId: string, id: string): Promise<Result<readonly AssistantFactRow[]>>;
}

/** The model's side of the conversation (adapter-gemini's GeminiChat is one — the packages do not know each other). */
export interface AssistantChat {
  ask(request: {
    readonly system: string;
    readonly history: readonly { readonly role: 'user' | 'model'; readonly text: string }[];
    readonly tools: readonly AssistantTool[];
    readonly callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  }): Promise<Result<{ readonly text: string; readonly toolsUsed: readonly string[] }>>;
}

export interface AssistantHandlerDeps {
  authenticate(request: Request): Promise<{ userId: string } | undefined>;
  gatewayFor(actorId: string, requestId: string): AssistantServer;
  chat: AssistantChat;
  /** Today in India (default: the clock). */
  today?(): string;
  /** A new id for a taught fact. */
  newId?(): string;
  onError?(error: unknown, requestId: string): void;
  allowOrigin?: string;
}

const body = z.object({
  companyId: z.string().uuid(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'model']), text: z.string().min(1).max(8000) }))
    .min(1)
    .max(40)
    .refine((m) => m.at(-1)?.role === 'user', 'The last message must be the question'),
  screen: z.object({ type: z.string().max(40), id: z.string().max(80).optional(), kind: z.string().max(40).optional(), title: z.string().max(200).optional() }).optional(),
});

/** Which permission each look-up needs — the same its report needs in the ERP. */
const NEEDS: Record<string, string> = { find_items: 'master.view', stock: 'report.view', orders: 'report.view', outstanding: 'report.view', invoices: 'voucher.view' };
/** The look-ups that read the books (the "from ERP" tag); remember / forget are not. */
const READS = new Set(Object.keys(NEEDS));

const indiaToday = (): string => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function createAssistantHandler(deps: AssistantHandlerDeps): (request: Request) => Promise<Response> {
  const cors = {
    'access-control-allow-origin': deps.allowOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-request-id, x-region',
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
      // the same answer for "no such company" and "not yours": a stranger learns nothing
      if (!(await gateway.companiesOf()).some((c) => c.id === cmd.companyId)) {
        return json(200, fail(issue(IssueCode.PermissionDenied, 'Not permitted: this company is not yours')));
      }
      const company = cmd.companyId as CompanyId;
      const permitted = new Map<string, boolean>();
      for (const p of new Set(Object.values(NEEDS))) permitted.set(p, await gateway.can(company, p));

      // the books, as far as this person may see them
      const masters = await gateway.load(company);
      const [vouchers, lines, movements, facts] = await Promise.all([
        permitted.get('report.view') || permitted.get('voucher.view') ? gateway.list(company) : Promise.resolve([] as readonly Voucher[]),
        permitted.get('report.view') || permitted.get('voucher.view') ? gateway.lines({ companyId: company }) : Promise.resolve([] as readonly JournalLine[]),
        permitted.get('report.view') ? gateway.stockMovements({ companyId: company }) : Promise.resolve([] as readonly StockMovement[]),
        gateway.assistantFacts(company),
      ]);
      const books: AssistantBooks = { masters, vouchers, lines, movements, today: localDate(deps.today?.() ?? indiaToday()) };
      let known = facts.ok ? facts.value : [];

      const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
        if (name === 'remember') {
          const text = typeof args['fact'] === 'string' ? args['fact'].trim() : '';
          const r = await gateway.addAssistantFact(company, deps.newId?.() ?? crypto.randomUUID(), text);
          if (!r.ok) return { saved: false, why: r.issues[0]?.message };
          known = r.value;
          return { saved: true, number: r.value.at(-1)?.number };
        }
        if (name === 'forget') {
          const n = Number(args['number']);
          const fact = known.find((f) => f.number === n);
          if (!fact) return { forgotten: false, why: `There is no fact number ${String(args['number'])}` };
          const r = await gateway.removeAssistantFact(company, fact.id);
          if (!r.ok) return { forgotten: false, why: r.issues[0]?.message };
          known = r.value;
          return { forgotten: true, text: fact.text };
        }
        const need = NEEDS[name];
        if (need && !permitted.get(need)) return { error: `Not permitted: this sign-in may not see that (${need})` };
        return runLookup(books, name, args);
      };

      const answer = await deps.chat.ask({
        system: assistantPrompt({ company: masters.company.name, today: books.today, facts: known.map((f) => ({ number: f.number, text: f.text })), screen: describeScreen(books, cmd.screen) }),
        history: cmd.messages,
        tools: ASSISTANT_TOOLS,
        callTool,
      });
      if (!answer.ok) return json(200, answer);
      const sources = [...new Set(answer.value.toolsUsed.filter((t) => READS.has(t)))];
      return json(200, ok({ answer: answer.value.text, sources, facts: known.length }));
    } catch (error) {
      deps.onError?.(error, requestId);
      return refuse(500, 'INTERNAL', `Something went wrong (request ${requestId})`);
    }
  };
}
