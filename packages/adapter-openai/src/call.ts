import { type Issue, type Result, fail, ok } from '@minimalerp/domain';

export interface OpenAiOptions {
  /** An API key from platform.openai.com (a paid account). Kept in a server secret, never in the browser or the add-on. */
  readonly apiKey: string;
  /**
   * The model(s) to ask, in order of preference: one name, or several separated by commas. When one is overloaded (500 / 503), rate
   * limited (429) or too slow, the next is tried at once. Configurable because OpenAI renames them.
   */
  readonly model: string;
  /** For tests. */
  readonly fetch?: typeof fetch;
  /** Default https://api.openai.com/v1 */
  readonly baseUrl?: string;
  /** How long to wait for one model's answer, in ms (default 45 s). A model that takes longer counts as busy: the next one is asked. */
  readonly timeoutMs?: number;
  /** How many times the whole list is tried when every model is busy (default 2). */
  readonly rounds?: number;
  /** The pause between rounds, in ms (default 2 s). */
  readonly retryDelayMs?: number;
  /** Stop trying after this long in all, in ms (default: no limit beyond the rounds). Keeps a background reading inside the function's time. */
  readonly deadlineMs?: number;
}

export const problem = (code: string, message: string): Issue => ({ code, message }) as Issue;

/**
 * The look-ups and the extraction shape are written once, in the domain, in Gemini's schema subset (types in capitals: OBJECT / STRING…).
 * OpenAI takes plain JSON Schema: the same shape with the types in small letters. With `strict`, every object also lists all its
 * properties as required and allows no others, and every value may be null — the model then answers in exactly that shape, with null for
 * what is not on the document.
 */
export function jsonSchema(schema: unknown, strict = false): unknown {
  if (Array.isArray(schema)) return schema.map((s) => jsonSchema(s, strict));
  if (typeof schema !== 'object' || schema === null) return schema;
  const s = schema as Record<string, unknown>;
  const type = typeof s['type'] === 'string' ? s['type'].toLowerCase() : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type') out[k] = strict && type !== 'object' && type !== 'array' ? [type, 'null'] : type;
    else if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, p]) => [name, jsonSchema(p, strict)]));
    else if (k === 'items') out[k] = jsonSchema(v, strict);
    else out[k] = v;
  }
  if (strict && type === 'object') {
    out['required'] = Object.keys((s['properties'] as Record<string, unknown> | undefined) ?? {});
    out['additionalProperties'] = false;
  }
  return out;
}

/**
 * One chat-completions request, asked of each model in turn (and, when every one was busy, again after a pause — within the rounds and
 * the deadline). `body` is the request without its model. Returns OpenAI's JSON answer, or an issue a person can act on: the limit
 * reached, the credit used up, the key or model to be checked, OpenAI busy. Shared by the document reader and the assistant.
 */
export async function callOpenAi(options: OpenAiOptions, body: Record<string, unknown>): Promise<Result<unknown>> {
  const base = options.baseUrl ?? 'https://api.openai.com/v1';
  const models = options.model.split(',').map((m) => m.trim()).filter((m) => m !== '');
  const doFetch = options.fetch ?? fetch;
  const once = async (model: string): Promise<Response | Result<unknown>> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 45_000);
    try {
      return await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model, ...body }),
        signal: abort.signal,
      });
    } catch (e) {
      const timedOut = (e as { name?: string })?.name === 'AbortError';
      return fail(problem('READER_UNAVAILABLE', timedOut ? 'ChatGPT took too long to answer: try again' : 'Could not reach ChatGPT: try again in a minute'));
    } finally {
      clearTimeout(timer);
    }
  };
  /** Overloaded, rate limited, too slow or unreachable: another model (or a moment later) may well answer. */
  const busy = (r: Response | Result<unknown>) => (r instanceof Response ? r.status === 429 || r.status === 500 || r.status === 503 : !r.ok && r.issues[0]?.code === 'READER_UNAVAILABLE');

  const started = Date.now();
  const deadline = options.deadlineMs;
  const inTime = () => deadline === undefined || Date.now() - started < deadline;
  let last: Response | Result<unknown> = fail(problem('READER_NOT_SET_UP', 'No ChatGPT model is set up'));
  rounds: for (let round = 0; round < (options.rounds ?? 2); round++) {
    if (round > 0) {
      if (!inTime()) break;
      await new Promise((r) => setTimeout(r, options.retryDelayMs ?? 2_000));
    }
    for (const model of models) {
      if (!inTime()) break rounds;
      last = await once(model);
      if (!busy(last)) break rounds;
    }
  }
  if (!(last instanceof Response)) return last;
  const response = last;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (response.ok) return payload === undefined ? fail(problem('READER_UNAVAILABLE', 'ChatGPT sent an answer that could not be read')) : ok(payload);

  // OpenAI's own short code for the refusal (invalid_api_key, model_not_found, insufficient_quota…) — never its message, which may quote the request
  const code = (payload as { error?: { code?: unknown } } | undefined)?.error?.code;
  const why = typeof code === 'string' && code !== '' ? `, ${code}` : '';
  if (response.status === 429) {
    return code === 'insufficient_quota'
      ? fail(problem('READER_NOT_SET_UP', 'The OpenAI credit is used up: add credit in the OpenAI billing page'))
      : fail(problem('READER_BUSY', 'ChatGPT’s limit was reached for now: try again in a few minutes'));
  }
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
    // a bad or restricted key, or a model this key cannot use: the owner has to fix the setup, the person can only report it
    return fail(problem('READER_NOT_SET_UP', `ChatGPT refused the request (${response.status}${why}): the API key or model needs checking`));
  }
  return fail(problem('READER_UNAVAILABLE', `ChatGPT is busy (${response.status}): try again in a minute`));
}
