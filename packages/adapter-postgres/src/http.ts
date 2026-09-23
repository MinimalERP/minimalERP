import {
  type CompanyId,
  type Issue,
  type Masters,
  type Result,
  IssueCode,
  fail,
  issue,
  canonicalId,
  dailyDigest,
  digestHtml,
  digestSheetRows,
  dueItemRows,
  journalLineToWire,
  orderBookOf,
  localDate,
  newCompanyIssues,
  normalizeName,
  orderLinkToWire,
  seedCompany,
  stockMovementToWire,
  voucherToWire,
} from '@minimalerp/domain';
import type { InboxGateway, JournalRepository, MasterGateway, MastersRepository, PostOutcome, PostingGateway, StockRepository, VoucherRepository } from '@minimalerp/ports';
import { z } from 'zod';

/**
 * The transport-independent core of the `post-voucher` Edge Function: a Web-standard
 * Request → Response handler. The Edge Function file is a few lines of glue around this;
 * tests drive it directly against a real database.
 *
 * Contract
 *   POST  { action: 'post',   companyId, draft }
 *         { action: 'alter',  companyId, voucherId, expectedVersion, draft }
 *         { action: 'cancel', companyId, voucherId, expectedVersion }
 *         { action: 'master', companyId, command }      a master-data command: create / alter / setActive
 *         { action: 'companies' }                        the caller's companies: [{ id, name }]
 *         { action: 'company-create', company }          seed a company for the caller (one per account), who becomes its owner
 *         { action: 'load', companyId }                  the masters as JSON ({ core, ledgers }; the browser rebuilds them with buildMasters)
 *         { action: 'vouchers' | 'voucher' | 'lines' | 'stock', companyId, … }   reads, each checked against the caller's permission
 *         { action: 'inbox', companyId }                 the AI Inbox: the proposals waiting (ADR-0023)
 *         { action: 'inbox-reject', companyId, id, reason? }   throw a proposal away (accepting one is an ordinary 'post' under its id)
 *         { action: 'digest', companyId?, asOn? }        the daily report: { asOn, subject, html, sheetRows, dueItemRows }
 *   200   { ok: true,  value: { voucher, journal?, replayed? } }   money as decimal strings
 *   200   { ok: false, issues: [{ code, message, path? }] }        a business-rule refusal
 *   400 malformed request · 401 not signed in · 405 wrong method · 500 unexpected failure
 * Business refusals are HTTP 200 on purpose: they are answers, not transport errors.
 *
 * Every request from a browser costs a network round trip, and after a change the browser reloads what the change touched. So a change
 * (post / alter / cancel / master), `companies` and `company-create` accept `fresh: true`, and answer with what the browser would otherwise ask
 * for next, in the same response:  { ok: true, value, fresh: { companyId, masters?: { core, ledgers }, books?: { vouchers, lines, movements } } }
 * (masters after a master change, the books after a voucher change, both when a company is opened). Left out when the caller may not read it.
 * Every answer carries a Server-Timing header (the time spent in here), so slowness can be split into "the network" and "the server".
 */

const companyId = z.string().min(1);
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('post'), companyId, draft: z.unknown(), fresh: z.boolean().optional() }),
  z.object({
    action: z.literal('alter'),
    companyId,
    voucherId: z.string().min(1),
    expectedVersion: z.number().int(),
    draft: z.unknown(),
    fresh: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('cancel'),
    companyId,
    voucherId: z.string().min(1),
    expectedVersion: z.number().int(),
    fresh: z.boolean().optional(),
  }),
  z.object({ action: z.literal('master'), companyId, command: z.unknown(), fresh: z.boolean().optional() }),
  z.object({ action: z.literal('companies'), fresh: z.boolean().optional() }),
  z.object({
    action: z.literal('company-create'),
    company: z.object({
      name: z.string(),
      fyStart: z.string(),
      gstin: z.string().optional(),
      stateCode: z.string().optional(),
      address: z.string().optional(),
    }),
    fresh: z.boolean().optional(),
  }),
  z.object({ action: z.literal('load'), companyId }),
  z.object({ action: z.literal('vouchers'), companyId }),
  z.object({ action: z.literal('voucher'), companyId, voucherId: z.string().min(1) }),
  z.object({
    action: z.literal('lines'),
    companyId,
    from: z.string().optional(),
    to: z.string().optional(),
    ledgerId: z.string().optional(),
    voucherId: z.string().optional(),
  }),
  z.object({ action: z.literal('stock'), companyId, itemIds: z.array(z.string()).optional() }),
  z.object({ action: z.literal('series-status'), companyId, seriesId: z.string().min(1) }),
  z.object({ action: z.literal('inbox'), companyId }),
  // the daily report: for the company given, or the caller's only one (the add-on's sign-in); `asOn` defaults to today in India
  z.object({ action: z.literal('digest'), companyId: companyId.optional(), asOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  z.object({ action: z.literal('inbox-reject'), companyId, id: z.string().min(1), reason: z.string().max(200).optional() }),
]);

/**
 * What the handler needs from the server-side backend beyond posting: the reads the browser cannot do itself, and company creation.
 * The reads run as the service role (they bypass row-level security), so the handler asks `can` before every one of them.
 */
export interface BooksServer extends PostingGateway, MasterGateway, MastersRepository, VoucherRepository, JournalRepository, StockRepository, InboxGateway {
  companiesOf(): Promise<readonly { readonly id: string; readonly name: string }[]>;
  can(companyId: string, permission: string): Promise<boolean>;
  loadJson(companyId: string): Promise<{ readonly core: unknown; readonly ledgers: unknown } | undefined>;
  createCompany(masters: Masters): Promise<Result<{ companyId: CompanyId }>>;
}

export interface PostingHandlerDeps {
  /** Resolves the signed-in user from the request (JWT), or undefined if there is none. */
  authenticate(request: Request): Promise<{ userId: string } | undefined>;
  /** A gateway that acts as `actorId` and tags audit rows with `requestId`. */
  gatewayFor(actorId: string, requestId: string): BooksServer;
  /** Called with unexpected errors so the host can log them. Never sent to the client. */
  onError?(error: unknown, requestId: string): void;
  /** CORS: allowed origin for browser callers. Defaults to '*'. */
  allowOrigin?: string;
}

const outcomeToWire = (o: PostOutcome) => ({
  voucher: voucherToWire(o.voucher),
  journal: o.plan.journal.map(journalLineToWire),
  stock: o.plan.stock.map(stockMovementToWire),
  links: o.plan.links.map(orderLinkToWire),
  replayed: o.replayed,
});

export function createPostingHandler(deps: PostingHandlerDeps): (request: Request) => Promise<Response> {
  const cors = {
    'access-control-allow-origin': deps.allowOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-request-id, x-region',
    'access-control-allow-methods': 'POST, OPTIONS',
    // Every call is preceded by a preflight round trip unless the browser remembers it (5 s by default). Chrome caps this at 2 hours.
    'access-control-max-age': '7200',
  };
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { ...cors, 'content-type': 'application/json' } });
  const problem = (status: number, code: string, message: string) =>
    json(status, { ok: false, issues: [{ code, message } satisfies Issue] });

  const handle = async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return problem(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try {
      const user = await deps.authenticate(request);
      if (!user) return problem(401, 'UNAUTHENTICATED', 'Sign in to continue');

      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return problem(400, 'BAD_REQUEST', 'Request body must be JSON');
      }
      const parsed = body.safeParse(raw);
      if (!parsed.success) {
        return problem(400, 'BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      }

      const gateway = deps.gatewayFor(user.userId, requestId);
      const cmd = parsed.data;
      const asResponse = async <T>(r: Result<T>, map: (v: T) => unknown, fresh?: () => Promise<unknown>) =>
        json(200, r.ok ? { ok: true, value: map(r.value), ...(fresh ? { fresh: await fresh() } : {}) } : { ok: false, issues: r.issues });
      const wantsMasters = (c: { companyId: string; fresh?: boolean | undefined }) => (c.fresh ? () => freshMasters(gateway, c.companyId) : undefined);
      const wantsBooks = (c: { companyId: string; fresh?: boolean | undefined }) => (c.fresh ? () => freshBooks(gateway, c.companyId) : undefined);

      switch (cmd.action) {
        case 'post':
          return asResponse(await gateway.post({ companyId: cmd.companyId as never, draft: cmd.draft }), outcomeToWire, wantsBooks(cmd));
        case 'alter':
          return asResponse(
            await gateway.alter({
              companyId: cmd.companyId as never,
              voucherId: cmd.voucherId as never,
              expectedVersion: cmd.expectedVersion,
              draft: cmd.draft,
            }),
            outcomeToWire,
            wantsBooks(cmd),
          );
        case 'cancel':
          return asResponse(
            await gateway.cancel({
              companyId: cmd.companyId as never,
              voucherId: cmd.voucherId as never,
              expectedVersion: cmd.expectedVersion,
            }),
            (voucher) => ({ voucher: voucherToWire(voucher) }),
            wantsBooks(cmd),
          );
        case 'master':
          return asResponse(await gateway.execute({ companyId: cmd.companyId as never, command: cmd.command }), (outcome) => outcome, wantsMasters(cmd));

        case 'companies': {
          const companies = await gateway.companiesOf();
          const first = companies[0];
          return json(200, { ok: true, value: { companies }, ...(cmd.fresh && first ? { fresh: await freshAll(gateway, first.id) } : {}) });
        }

        case 'company-create': {
          const input = cmd.company;
          // One company per account (someone who wants another asks to be invited to it).
          if ((await gateway.companiesOf()).length > 0) {
            return json(200, { ok: false, issues: [issue(IssueCode.UnsupportedOperation, 'This account already has a company')] });
          }
          const problems = newCompanyIssues(input);
          if (problems.length > 0) return json(200, { ok: false, issues: problems });
          const ids = new Map<string, string>(); // one id per seeded thing, however many times the seed asks for it
          const newId = (name: string) => ids.get(name) ?? (ids.set(name, crypto.randomUUID()), ids.get(name)!);
          const gstin = canonicalId(input.gstin ?? '');
          const masters = seedCompany({
            name: normalizeName(input.name),
            fyStart: localDate(input.fyStart),
            gstin: gstin === '' ? undefined : gstin,
            stateCode: input.stateCode?.trim() || undefined,
            address: input.address?.trim() || undefined,
            newId,
          });
          return asResponse(
            await gateway.createCompany(masters),
            (created) => ({ companyId: created.companyId }),
            cmd.fresh ? () => freshAll(gateway, masters.company.id) : undefined,
          );
        }

        // ---- reads: each answers only to someone who may see that part of the books ----
        case 'load': {
          const denied = await refuse(gateway, cmd.companyId, 'master.view');
          if (denied) return json(200, denied);
          const loaded = await gateway.loadJson(cmd.companyId);
          return loaded ? json(200, { ok: true, value: loaded }) : json(200, notFound(cmd.companyId));
        }
        case 'vouchers': {
          const denied = await refuse(gateway, cmd.companyId, 'voucher.view');
          if (denied) return json(200, denied);
          return json(200, { ok: true, value: { vouchers: (await gateway.list(cmd.companyId as never)).map(voucherToWire) } });
        }
        case 'voucher': {
          const denied = await refuse(gateway, cmd.companyId, 'voucher.view');
          if (denied) return json(200, denied);
          const found = await gateway.get(cmd.companyId as never, cmd.voucherId as never);
          return json(200, { ok: true, value: { voucher: found ? voucherToWire(found) : null } });
        }
        case 'lines': {
          const denied = await refuse(gateway, cmd.companyId, 'report.view');
          if (denied) return json(200, denied);
          const lines = await gateway.lines({
            companyId: cmd.companyId as never,
            ...(cmd.from !== undefined ? { from: cmd.from as never } : {}),
            ...(cmd.to !== undefined ? { to: cmd.to as never } : {}),
            ...(cmd.ledgerId !== undefined ? { ledgerId: cmd.ledgerId as never } : {}),
            ...(cmd.voucherId !== undefined ? { voucherId: cmd.voucherId as never } : {}),
          });
          return json(200, { ok: true, value: { lines: lines.map(journalLineToWire) } });
        }
        case 'stock': {
          const denied = await refuse(gateway, cmd.companyId, 'report.view');
          if (denied) return json(200, denied);
          const movements = await gateway.stockMovements({
            companyId: cmd.companyId as never,
            ...(cmd.itemIds !== undefined ? { itemIds: cmd.itemIds as never } : {}),
          });
          return json(200, { ok: true, value: { movements: movements.map(stockMovementToWire) } });
        }
        // seriesStatus checks master.view itself (the same answer to "not permitted" and "no such series" either refuses).
        case 'series-status':
          return asResponse(await gateway.seriesStatus(cmd.companyId as never, cmd.seriesId), (status) => status);
        // Both check their own permission (voucher.view; posting the item's kind to reject it).
        case 'inbox':
          return asResponse(await gateway.inbox(cmd.companyId as never), (items) => ({ items }));
        case 'inbox-reject':
          return asResponse(await gateway.rejectInbox(cmd.companyId as never, cmd.id, cmd.reason), () => ({}));
        case 'digest': {
          const company = cmd.companyId ?? (await gateway.companiesOf())[0]?.id;
          const denied = company ? await refuse(gateway, company, 'report.view') : { ok: false as const, issues: [issue(IssueCode.PermissionDenied, 'Not permitted: report.view')] };
          if (denied || !company) return json(200, denied);
          const id = company as CompanyId;
          const [masters, vouchers, lines, inbox] = await Promise.all([gateway.load(id), gateway.list(id), gateway.lines({ companyId: id }), gateway.inbox(id)]);
          const d = dailyDigest({
            vouchers,
            lines,
            masters,
            orders: orderBookOf(vouchers, masters),
            asOn: localDate(cmd.asOn ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)),
            inboxWaiting: inbox.ok ? inbox.value.length : 0,
          });
          const late = d.orders.overdueLines > 0 ? ` · ${d.orders.overdueLines} item${d.orders.overdueLines === 1 ? '' : 's'} late` : '';
          return json(200, {
            ok: true,
            value: { asOn: d.asOn, subject: `${d.company} — daily report ${d.asOn.slice(8, 10)}-${d.asOn.slice(5, 7)}-${d.asOn.slice(0, 4)}${late}`, html: digestHtml(d), sheetRows: digestSheetRows(d), dueItemRows: dueItemRows(d) },
          });
        }
      }
    } catch (error) {
      deps.onError?.(error, requestId);
      return problem(500, 'INTERNAL', `Something went wrong (request ${requestId})`);
    }
  };

  return async (request) => {
    const started = performance.now();
    const response = await handle(request);
    response.headers.set('server-timing', `total;dur=${(performance.now() - started).toFixed(0)}`);
    return response;
  };
}

/**
 * The same answer whether the company does not exist or the caller is not in it: a stranger learns nothing about which ids are real.
 */
async function refuse(gateway: BooksServer, companyId: string, permission: string) {
  return (await gateway.can(companyId, permission))
    ? undefined
    : { ok: false as const, issues: [issue(IssueCode.PermissionDenied, `Not permitted: ${permission}`)] };
}

const notFound = (companyId: string) => fail(issue(IssueCode.CompanyMismatch, `Company ${companyId} not found`));

/**
 * The parts of the books a browser reloads after a change, gathered here so they travel with the change's own answer.
 * Each is left out (not refused) when the caller may not read it: they then ask, and get the ordinary refusal.
 */
async function freshMasters(gateway: BooksServer, companyId: string) {
  if (!(await gateway.can(companyId, 'master.view'))) return undefined;
  const masters = await gateway.loadJson(companyId);
  return masters ? { companyId, masters } : undefined;
}

async function freshBooks(gateway: BooksServer, companyId: string) {
  if (!(await gateway.can(companyId, 'voucher.view')) || !(await gateway.can(companyId, 'report.view'))) return undefined;
  const id = companyId as CompanyId;
  const [vouchers, lines, movements] = await Promise.all([gateway.list(id), gateway.lines({ companyId: id }), gateway.stockMovements({ companyId: id })]);
  return { companyId, books: { vouchers: vouchers.map(voucherToWire), lines: lines.map(journalLineToWire), movements: movements.map(stockMovementToWire) } };
}

async function freshAll(gateway: BooksServer, companyId: string) {
  const masters = await freshMasters(gateway, companyId);
  const books = await freshBooks(gateway, companyId);
  return { companyId, ...(masters ? { masters: masters.masters } : {}), ...(books ? { books: books.books } : {}) };
}
