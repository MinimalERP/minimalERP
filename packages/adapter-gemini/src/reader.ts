import { type IntakeKind, type Result, extractionPrompt, extractionResponseSchema, fail, ok } from '@minimalerp/domain';
import type { DocumentReader, ReadableDocument } from '@minimalerp/ports';
import { type GeminiOptions, callGemini, problem } from './call';

export type { GeminiOptions } from './call';

/** What goes to Gemini with the document (and nothing else: no ids, no masters — the matching happens on our side). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const READABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'text/plain', 'text/html']);

/**
 * One document → one `generateContent` call with a response schema, at temperature 0: the model can answer only in the extraction shape,
 * and the same document reads the same way twice. The answer is returned raw; `extractionSchema` (domain) is what makes sense of it.
 */
export class GeminiReader implements DocumentReader {
  constructor(private readonly options: GeminiOptions) {}

  async read(input: { readonly kind: IntakeKind; readonly ownCompany: string; readonly document: ReadableDocument }): Promise<Result<unknown>> {
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
    const answer = await callGemini(this.options, body);
    if (!answer.ok) return answer;
    const payload = answer.value;
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
