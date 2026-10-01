import { type IntakeKind, type Result, extractionPrompt, extractionResponseSchema, fail, ok } from '@minimalerp/domain';
import type { DocumentReader, ReadableDocument } from '@minimalerp/ports';
import { type OpenAiOptions, callOpenAi, jsonSchema, problem } from './call';

export type { OpenAiOptions } from './call';

/** What goes to OpenAI with the document (and nothing else: no ids, no masters — the matching happens on our side). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const TEXTS = new Set(['text/plain', 'text/html']);

/**
 * One document → one chat-completions call with a strict response schema: the model can answer only in the extraction shape (null for
 * what is not on the document). The answer is returned raw; `extractionSchema` (domain) is what makes sense of it.
 */
export class OpenAiReader implements DocumentReader {
  constructor(private readonly options: OpenAiOptions) {}

  async read(input: { readonly kind: IntakeKind; readonly ownCompany: string; readonly document: ReadableDocument }): Promise<Result<unknown>> {
    const doc = input.document;
    const asText = (text: string) => ({ type: 'text', text: `The document:\n\n${text.slice(0, 200_000)}` });
    let part: Record<string, unknown>;
    if ('text' in doc) {
      if (doc.text.trim() === '') return fail(problem('DOCUMENT_EMPTY', 'The mail has no text to read'));
      part = asText(doc.text);
    } else {
      const known = doc.mimeType === 'application/pdf' || IMAGES.has(doc.mimeType) || TEXTS.has(doc.mimeType);
      if (!known) return fail(problem('DOCUMENT_UNSUPPORTED', `A ${doc.mimeType} file cannot be read: send a PDF or an image (PNG, JPEG)`));
      if ((doc.base64.length * 3) / 4 > MAX_DOCUMENT_BYTES) return fail(problem('DOCUMENT_TOO_LARGE', 'The document is larger than 10 MB'));
      const dataUrl = `data:${doc.mimeType};base64,${doc.base64}`;
      if (doc.mimeType === 'application/pdf') part = { type: 'file', file: { filename: 'document.pdf', file_data: dataUrl } };
      else if (IMAGES.has(doc.mimeType)) part = { type: 'image_url', image_url: { url: dataUrl } };
      else part = asText(new TextDecoder().decode(Uint8Array.from(atob(doc.base64), (c) => c.charCodeAt(0))));
    }

    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: extractionPrompt(input.kind, input.ownCompany) }, part] }],
      response_format: { type: 'json_schema', json_schema: { name: 'extraction', strict: true, schema: jsonSchema(extractionResponseSchema, true) } },
    };
    const answer = await callOpenAi(this.options, body);
    if (!answer.ok) return answer;
    const message = (answer.value as { choices?: { message?: { content?: unknown; refusal?: string | null } }[] })?.choices?.[0]?.message;
    const text = typeof message?.content === 'string' ? message.content : '';
    if (text.trim() === '') {
      return fail(problem('DOCUMENT_UNREADABLE', message?.refusal ? 'ChatGPT would not read this document' : 'Nothing could be read from this document'));
    }
    try {
      return ok(JSON.parse(text) as unknown);
    } catch {
      return fail(problem('DOCUMENT_UNREADABLE', 'The reading was cut short: try a smaller document'));
    }
  }
}
