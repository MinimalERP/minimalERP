import { type IntakeKind, type Issue, type Result, extractionPrompt, extractionResponseSchema, fail, ok } from '@minimalerp/domain';
import type { DocumentReader, IntakeDocument } from '@minimalerp/ports';

export interface GeminiOptions {
  /** An API key from Google AI Studio (aistudio.google.com). Free-tier keys work. Kept in a server secret, never in the browser or the add-on. */
  readonly apiKey: string;
  /**
   * The model(s) to read with, in order of preference: one name, or several separated by commas ("gemini-3.5-flash,gemini-3.8-flash").
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

/** What goes to Gemini with the document (and nothing else: no ids, no masters — the matching happens on our side). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const READABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'text/plain', 'text/html']);

const problem = (code: string, message: string): Issue => ({ code, message }) as Issue;

/**
 * One document → one `generateContent` call with a response schema, at temperature 0: the model can answer only in the extraction shape,
 * and the same document reads the same way twice. The answer is returned raw; `extractionSchema` (domain) is what makes sense of it.
 */
export class GeminiReader implements DocumentReader {
  constructor(private readonly options: GeminiOptions) {}

  async read(input: { readonly kind: IntakeKind; readonly ownCompany: string; readonly document: IntakeDocument }): Promise<Result<unknown>> {
    const doc = input.document;
    let part: Record<string, unknown>;
    if ('text' in doc) {
      if (doc.text.trim() === '') return fail(problem('DOCUMENT_EMPTY', 'The mail has no text to read'));
      part = { text: `The document:\n\n${doc.text.slice(0, 200_000)}` };
    } else {
      if (!READABLE.has(doc.mimeType)) return fail(problem('DOCUMENT_UNSUPPORTED', `A ${doc.mimeType} file cannot be read: send a PDF or an image`));
      if ((doc.base64.length * 3) / 4 > MAX_DOCUMENT_BYTES) return fail(problem('DOCUMENT_TOO_LARGE', 'The document is larger than 10 MB'));
      part = { inline_data: { mime_type: doc.mimeType, data: doc.base64 } };
    }

    const body = {
      contents: [{ role: 'user', parts: [{ text: extractionPrompt(input.kind, input.ownCompany) }, part] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: extractionResponseSchema },
    };
    const base = this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const models = this.options.model.split(',').map((m) => m.trim()).filter((m) => m !== '');
    const doFetch = this.options.fetch ?? fetch;
    const once = async (model: string): Promise<Response | Result<unknown>> => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 45_000);
      try {
        return await doFetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          // the key travels in a header, never in the URL (URLs end up in logs)
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.options.apiKey },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
      } catch (e) {
        const timedOut = (e as { name?: string })?.name === 'AbortError';
        return fail(problem('READER_UNAVAILABLE', timedOut ? 'Reading the document took too long: try again' : 'Could not reach Gemini: try again in a minute'));
      } finally {
        clearTimeout(timer);
      }
    };
    /** Overloaded, its quota used up, too slow or unreachable: another model (or a moment later) may well answer. */
    const busy = (r: Response | Result<unknown>) => (r instanceof Response ? r.status === 429 || r.status === 500 || r.status === 503 : !r.ok && r.issues[0]?.code === 'READER_UNAVAILABLE');

    // Each model in turn; if every one was busy, another round after a pause — within the rounds and the deadline.
    const started = Date.now();
    const deadline = this.options.deadlineMs;
    const inTime = () => deadline === undefined || Date.now() - started < deadline;
    let last: Response | Result<unknown> = fail(problem('READER_NOT_SET_UP', 'No Gemini model is set up'));
    rounds: for (let round = 0; round < (this.options.rounds ?? 2); round++) {
      if (round > 0) {
        if (!inTime()) break;
        await new Promise((r) => setTimeout(r, this.options.retryDelayMs ?? 2_000));
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

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return fail(problem('READER_UNAVAILABLE', 'Gemini sent an answer that could not be read'));
    }
    const candidate = (payload as { candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[] })?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (text.trim() === '') {
      const blocked = (payload as { promptFeedback?: { blockReason?: string } })?.promptFeedback?.blockReason;
      return fail(problem('DOCUMENT_UNREADABLE', blocked ? `Gemini would not read this document (${blocked})` : 'Nothing could be read from this document'));
    }
    try {
      return ok(JSON.parse(text) as unknown);
    } catch {
      return fail(problem('DOCUMENT_UNREADABLE', 'The reading was cut short: try a smaller document'));
    }
  }
}
