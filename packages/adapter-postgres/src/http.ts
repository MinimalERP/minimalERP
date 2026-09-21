import {
  type Issue,
  type Result,
  journalLineToWire,
  orderLinkToWire,
  stockMovementToWire,
  voucherToWire,
} from '@minimalerp/domain';
import type { MasterGateway, PostOutcome, PostingGateway } from '@minimalerp/ports';
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
 *   200   { ok: true,  value: { voucher, journal?, replayed? } }   money as decimal strings
 *   200   { ok: false, issues: [{ code, message, path? }] }        a business-rule refusal
 *   400 malformed request · 401 not signed in · 405 wrong method · 500 unexpected failure
 * Business refusals are HTTP 200 on purpose: they are answers, not transport errors.
 */

const companyId = z.string().min(1);
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('post'), companyId, draft: z.unknown() }),
  z.object({
    action: z.literal('alter'),
    companyId,
    voucherId: z.string().min(1),
    expectedVersion: z.number().int(),
    draft: z.unknown(),
  }),
  z.object({
    action: z.literal('cancel'),
    companyId,
    voucherId: z.string().min(1),
    expectedVersion: z.number().int(),
  }),
  z.object({ action: z.literal('master'), companyId, command: z.unknown() }),
]);

export interface PostingHandlerDeps {
  /** Resolves the signed-in user from the request (JWT), or undefined if there is none. */
  authenticate(request: Request): Promise<{ userId: string } | undefined>;
  /** A gateway that acts as `actorId` and tags audit rows with `requestId`. */
  gatewayFor(actorId: string, requestId: string): PostingGateway & MasterGateway;
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
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-request-id',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { ...cors, 'content-type': 'application/json' } });
  const problem = (status: number, code: string, message: string) =>
    json(status, { ok: false, issues: [{ code, message } satisfies Issue] });

  return async (request) => {
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
      const asResponse = <T>(r: Result<T>, map: (v: T) => unknown) =>
        json(200, r.ok ? { ok: true, value: map(r.value) } : { ok: false, issues: r.issues });

      switch (cmd.action) {
        case 'post':
          return asResponse(await gateway.post({ companyId: cmd.companyId as never, draft: cmd.draft }), outcomeToWire);
        case 'alter':
          return asResponse(
            await gateway.alter({
              companyId: cmd.companyId as never,
              voucherId: cmd.voucherId as never,
              expectedVersion: cmd.expectedVersion,
              draft: cmd.draft,
            }),
            outcomeToWire,
          );
        case 'cancel':
          return asResponse(
            await gateway.cancel({
              companyId: cmd.companyId as never,
              voucherId: cmd.voucherId as never,
              expectedVersion: cmd.expectedVersion,
            }),
            (voucher) => ({ voucher: voucherToWire(voucher) }),
          );
        case 'master':
          return asResponse(await gateway.execute({ companyId: cmd.companyId as never, command: cmd.command }), (outcome) => outcome);
      }
    } catch (error) {
      deps.onError?.(error, requestId);
      return problem(500, 'INTERNAL', `Something went wrong (request ${requestId})`);
    }
  };
}
