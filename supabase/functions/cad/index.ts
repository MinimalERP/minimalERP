// Supabase Edge Function: cad  (Deno runtime)
//
// MinimalCAD's (and the ERP item form's) only way to WRITE a drawing: browsers read item_cad_files and cad_drawings through row-level
// security, and send every change here. This function finds out who is asking (the gateway has already verified the JWT), then calls the
// matching SQL function of 20261026000100_cad.sql as that person — the permission check and every rule live there, in the database.
//
// Required environment (provided by Supabase): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from '@supabase/supabase-js';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '7200',
};
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
// always 200 with ok:false for a refusal the person can read: supabase-js hides the body of a non-2xx answer behind a generic error
const refuse = (message: string) => answer({ ok: false, message });

/** What each action sends to its SQL function (the actor is always the signed-in person, never something the browser says). */
const ACTIONS: Record<string, (actor: string, b: Record<string, unknown>) => { fn: string; args: Record<string, unknown> }> = {
  'item-file-save': (actor, b) => ({ fn: 'cad_item_file_save', args: { p_actor: actor, p_company: b.companyId, p_item: b.itemId ?? null, p_id: b.id ?? null, p_name: b.name, p_document: b.document } }),
  'item-file-delete': (actor, b) => ({ fn: 'cad_item_file_delete', args: { p_actor: actor, p_company: b.companyId, p_id: b.id } }),
  'drawing-save': (actor, b) => ({ fn: 'cad_drawing_save', args: { p_actor: actor, p_id: b.id ?? null, p_name: b.name ?? '', p_document: b.document, p_autosave: b.autosave === true } }),
  'drawing-rename': (actor, b) => ({ fn: 'cad_drawing_rename', args: { p_actor: actor, p_id: b.id, p_name: b.name } }),
  'drawing-delete': (actor, b) => ({ fn: 'cad_drawing_delete', args: { p_actor: actor, p_id: b.id ?? null, p_autosave: b.autosave === true } }),
};

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return answer({ ok: false, message: 'POST only' }, 405);

  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const { data, error: authError } = token ? await admin.auth.getUser(token) : { data: { user: null }, error: null };
  if (authError || !data.user) return answer({ ok: false, message: 'Sign in first' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return refuse('The request was not JSON');
  }
  const action = ACTIONS[String(body.action ?? '')];
  if (!action) return refuse('Unknown action');

  const call = action(data.user.id, body);
  const { data: value, error } = await admin.rpc(call.fn, call.args);
  // the SQL functions refuse with a code as the message and the sentence for a person as the detail
  if (error) return refuse(error.details || error.message || 'The drawing could not be saved');
  return answer({ ok: true, value });
});
