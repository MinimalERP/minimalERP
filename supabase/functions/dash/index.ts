// Supabase Edge Function: dash (Deno runtime): the one way minimalDASH (github.com/MinimalERP/minimalDASH) and its Gmail add-on
// change anything. It only names the signed-in person and passes the change on: public.dash_apply checks their dash.edit permission
// in the company and does the work in one statement (migration 20261009000100_dash.sql). Reading needs no function: RLS (dash.view).
//
// Request:  POST { companyId, op, payload }   with the person's sign-in as Authorization: Bearer <token>
// Answer:   { ok: true, value: <the row as it now is> }  or  { ok: false, issues: [{ code, message }] }
//
// Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided by Supabase).

import { createClient } from '@supabase/supabase-js';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '7200',
};
const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { ...cors, 'content-type': 'application/json' } });
const problem = (status: number, code: string, message: string) => json(status, { ok: false, issues: [{ code, message }] });

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return problem(405, 'METHOD_NOT_ALLOWED', 'POST only');

  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const { data: who } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!who.user) return problem(401, 'UNAUTHENTICATED', 'Sign in again');

  let body: { companyId?: string; op?: string; payload?: unknown };
  try {
    body = await request.json();
  } catch {
    return problem(400, 'BAD_REQUEST', 'The request is not JSON');
  }
  if (!body.companyId || !body.op) return problem(400, 'BAD_REQUEST', 'companyId and op are needed');

  const { data, error } = await admin.rpc('dash_apply', {
    p_actor: who.user.id,
    p_company: body.companyId,
    p_op: body.op,
    p_payload: body.payload ?? {},
  });
  if (error) {
    // private.raise_issue: the code is the message, the sentence is the detail
    if (error.code === 'P0001') return json(200, { ok: false, issues: [{ code: error.message, message: error.details ?? error.message }] });
    console.error(JSON.stringify({ level: 'error', op: body.op, error: error.message, code: error.code }));
    return json(200, { ok: false, issues: [{ code: 'DATABASE', message: error.message }] });
  }
  return json(200, { ok: true, value: data });
});
