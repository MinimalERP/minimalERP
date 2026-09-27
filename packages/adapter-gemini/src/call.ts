import { type Issue, type Result, fail, ok } from '@minimalerp/domain';

export interface GeminiOptions {
  /** An API key from Google AI Studio (aistudio.google.com). Free-tier keys work. Kept in a server secret, never in the browser or the add-on. */
  readonly apiKey: string;
  /**
   * The model(s) to ask, in order of preference: one name, or several separated by commas ("gemini-3.5-flash,gemini-3.8-flash").
   * When one is overloaded (500 / 503) or its free quota is used up (429), the next is tried at once — on the free tier each model has
   * its own quota, and which one is busy changes by the minute. Configurable because Google renames them.
   */
  readonly model: string;
  /** For tests. */
  readonly fetch?: typeof fetch;
  /** Default https://generativelanguage.googleapis.com/v1beta */
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
 * One `generateContent` request, asked of each model in turn (and, when every one was busy, again after a pause — within the rounds and
 * the deadline). Returns Gemini's JSON answer, or an issue a person can act on: the free limit reached, the key or model to be checked,
 * Gemini busy. Shared by the document reader and the assistant.
 */
export async function callGemini(options: GeminiOptions, body: unknown): Promise<Result<unknown>> {
  const base = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const models = options.model.split(',').map((m) => m.trim()).filter((m) => m !== '');
  const doFetch = options.fetch ?? fetch;
  const once = async (model: string): Promise<Response | Result<unknown>> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 45_000);
    try {
      return await doFetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        // the key travels in a header, never in the URL (URLs end up in logs)
        headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (e) {
      const timedOut = (e as { name?: string })?.name === 'AbortError';
      return fail(problem('READER_UNAVAILABLE', timedOut ? 'Gemini took too long to answer: try again' : 'Could not reach Gemini: try again in a minute'));
    } finally {
      clearTimeout(timer);
    }
  };
  /** Overloaded, its quota used up, too slow or unreachable: another model (or a moment later) may well answer. */
  const busy = (r: Response | Result<unknown>) => (r instanceof Response ? r.status === 429 || r.status === 500 || r.status === 503 : !r.ok && r.issues[0]?.code === 'READER_UNAVAILABLE');

  const started = Date.now();
  const deadline = options.deadlineMs;
  const inTime = () => deadline === undefined || Date.now() - started < deadline;
  let last: Response | Result<unknown> = fail(problem('READER_NOT_SET_UP', 'No Gemini model is set up'));
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

  if (response.status === 429) {
    return fail(problem('READER_BUSY', 'Gemini’s free limit was reached for now: try again in a few minutes'));
  }
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
    // a bad or restricted key, or a model this key cannot use: the owner has to fix the setup, the person can only report it
    return fail(problem('READER_NOT_SET_UP', `Gemini refused the request (${response.status}): the API key or model needs checking`));
  }
  if (!response.ok) return fail(problem('READER_UNAVAILABLE', `Gemini is busy (${response.status}): try again in a minute`));

  try {
    return ok((await response.json()) as unknown);
  } catch {
    return fail(problem('READER_UNAVAILABLE', 'Gemini sent an answer that could not be read'));
  }
}
