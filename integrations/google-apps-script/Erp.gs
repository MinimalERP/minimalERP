/**
 * MinimalERP for Google Workspace — talking to the ERP (ADR-0023).
 *
 * The add-on signs in as its own ERP user (role `automation`: it may send documents to the AI Inbox and read reports; it can post
 * nothing). The credentials live in this script's properties (Project Settings › Script properties), never in the code:
 *
 *   SUPABASE_URL        https://<project>.supabase.co
 *   SUPABASE_ANON_KEY   the project's public anon key
 *   ERP_EMAIL           the automation user's sign-in email
 *   ERP_PASSWORD        its password
 *   COMPANY_ID          optional: only if that user belongs to more than one company
 *   REPORT_TO           where the daily report goes (your address)
 *   REPORT_SHEET_ID     optional: a Google Sheet the daily report adds a row to
 */

function prop_(name, required) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (required && !v) throw new Error('MinimalERP is not set up: script property ' + name + ' is missing');
  return v || '';
}

/** An ERP access token, kept for 50 minutes (they last an hour). */
function erpToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('erp-token');
  if (cached) return cached;
  var res = UrlFetchApp.fetch(prop_('SUPABASE_URL', true) + '/auth/v1/token?grant_type=password', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: prop_('SUPABASE_ANON_KEY', true) },
    payload: JSON.stringify({ email: prop_('ERP_EMAIL', true), password: prop_('ERP_PASSWORD', true) }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Could not sign in to MinimalERP (' + res.getResponseCode() + '): check ERP_EMAIL and ERP_PASSWORD');
  var token = JSON.parse(res.getContentText()).access_token;
  cache.put('erp-token', token, 50 * 60);
  return token;
}

/**
 * Calls one of the ERP's functions and returns its { ok, value | issues } answer. Transport failures become an answer too, so every
 * caller shows the person a sentence, never a stack trace.
 */
function erpCall_(fn, body) {
  var res = UrlFetchApp.fetch(prop_('SUPABASE_URL', true) + '/functions/v1/' + fn, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + erpToken_(), apikey: prop_('SUPABASE_ANON_KEY', true) },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code === 401) CacheService.getScriptCache().remove('erp-token');
  try {
    var parsed = JSON.parse(res.getContentText());
    if (parsed && typeof parsed.ok === 'boolean') return parsed;
  } catch (e) {
    /* fall through */
  }
  return { ok: false, issues: [{ code: 'HTTP_' + code, message: 'MinimalERP did not answer properly (' + code + '): try again' }] };
}

function companyId_() {
  return prop_('COMPANY_ID', false) || undefined;
}
