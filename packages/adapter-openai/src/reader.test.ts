import { extractionSchema } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { OpenAiReader } from './reader';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { model: string; messages: { content: Record<string, unknown>[] }[]; response_format: { type: string; json_schema: { strict: boolean; schema: Record<string, unknown> } } };
}

/** A fetch that records what was sent and answers with `status` and `payload`. */
function fakeFetch(status: number, payload: unknown) {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, sent };
}

const answer = (json: unknown) => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(json) }, finish_reason: 'stop' }] });
const pdf = { mimeType: 'application/pdf', base64: 'JVBERi0xLjQK' };

describe('reading a document with ChatGPT', () => {
  it('sends the PDF with the prompt and a strict response schema, the key in a header; nulls read as "not on the document"', async () => {
    const { f, sent } = fakeFetch(
      200,
      answer({ partyName: 'Acme Ltd', partyGstin: null, poNumber: 'PO-1', date: null, lines: [{ description: 'Bolt', code: null, qty: '10', rate: '4.5', dueDate: null }], bills: [] }),
    );
    const reader = new OpenAiReader({ apiKey: 'secret-key', model: 'some-model', fetch: f });
    const r = await reader.read({ kind: 'salesOrder', ownCompany: 'Padekar Engineering', document: pdf });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const read = extractionSchema.parse(r.value);
    expect(read).toMatchObject({ partyName: 'Acme Ltd', poNumber: 'PO-1', lines: [{ description: 'Bolt', qty: '10', rate: '4.5' }] });
    expect([read.partyGstin, read.date, read.lines[0]?.code, read.lines[0]?.dueDate]).toEqual([undefined, undefined, undefined, undefined]);

    const s = sent[0] as Sent;
    expect(s.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(s.headers['authorization']).toBe('Bearer secret-key');
    expect(s.body.model).toBe('some-model');
    const parts = s.body.messages[0]?.content ?? [];
    expect(String(parts[0]?.['text'])).toContain('Padekar Engineering');
    expect(String(parts[0]?.['text'])).toContain('purchase order');
    expect(parts[1]).toEqual({ type: 'file', file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQK' } });

    // strict: every property required, no others allowed, every value may be null
    const schema = s.body.response_format.json_schema.schema as { type: string; required: string[]; additionalProperties: boolean; properties: Record<string, { type: unknown; items?: { required: string[]; additionalProperties: boolean } }> };
    expect(s.body.response_format.json_schema.strict).toBe(true);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    expect(schema.properties['partyName']?.type).toEqual(['string', 'null']);
    expect(schema.properties['lines']?.type).toBe('array');
    expect(schema.properties['lines']?.items?.additionalProperties).toBe(false);
    expect(schema.properties['lines']?.items?.required).toContain('dueDate');
  });

  it('sends an image as an image, and a mail body or an HTML file as text', async () => {
    const { f, sent } = fakeFetch(200, answer({ partyName: 'Acme Ltd' }));
    const reader = new OpenAiReader({ apiKey: 'k', model: 'm', fetch: f });
    await reader.read({ kind: 'purchase', ownCompany: 'X', document: { mimeType: 'image/png', base64: 'iVBORw0KGgo=' } });
    await reader.read({ kind: 'receipt', ownCompany: 'X', document: { text: 'We have paid INV-1 by NEFT' } });
    await reader.read({ kind: 'receipt', ownCompany: 'X', document: { mimeType: 'text/html', base64: btoa('<p>Paid INV-2</p>') } });
    expect(sent[0]?.body.messages[0]?.content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } });
    expect(String(sent[1]?.body.messages[0]?.content[1]?.['text'])).toContain('We have paid INV-1');
    expect(String(sent[2]?.body.messages[0]?.content[1]?.['text'])).toContain('<p>Paid INV-2</p>');
  });

  it('the limit being reached is an answer the person can act on', async () => {
    const { f } = fakeFetch(429, { error: { code: 'rate_limit_exceeded' } });
    const r = await new OpenAiReader({ apiKey: 'k', model: 'm', fetch: f, retryDelayMs: 1 }).read({ kind: 'purchase', ownCompany: 'X', document: pdf });
    expect(r.ok ? undefined : r.issues[0]?.code).toBe('READER_BUSY');
    expect(r.ok ? '' : r.issues[0]?.message).toContain('try again');
  });

  it('a bad key or a model the key cannot use says the setup needs checking', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { f } = fakeFetch(status, { error: {} });
      const r = await new OpenAiReader({ apiKey: 'k', model: 'm', fetch: f }).read({ kind: 'purchase', ownCompany: 'X', document: pdf });
      expect(r.ok ? undefined : r.issues[0]?.code).toBe('READER_NOT_SET_UP');
    }
  });

  it('refuses what it cannot read before sending anything', async () => {
    const { f, sent } = fakeFetch(200, answer({}));
    const reader = new OpenAiReader({ apiKey: 'k', model: 'm', fetch: f });
    const zip = await reader.read({ kind: 'purchase', ownCompany: 'X', document: { mimeType: 'application/zip', base64: 'UEsDBA==' } });
    const huge = await reader.read({ kind: 'purchase', ownCompany: 'X', document: { mimeType: 'application/pdf', base64: 'A'.repeat(15 * 1024 * 1024) } });
    const empty = await reader.read({ kind: 'purchase', ownCompany: 'X', document: { text: '   ' } });
    expect([zip, huge, empty].map((r) => (r.ok ? undefined : r.issues[0]?.code))).toEqual(['DOCUMENT_UNSUPPORTED', 'DOCUMENT_TOO_LARGE', 'DOCUMENT_EMPTY']);
    expect(sent).toEqual([]);
  });

  it('an empty, refused or cut-off answer is "could not be read", never a crash', async () => {
    const empty = fakeFetch(200, { choices: [{ message: { content: '' } }] });
    const refused = fakeFetch(200, { choices: [{ message: { content: null, refusal: 'I cannot help with that' } }] });
    const cut = fakeFetch(200, { choices: [{ message: { content: '{"partyName": "Acm' }, finish_reason: 'length' }] });
    const garbage = fakeFetch(200, 'not json');
    const codes = [];
    for (const { f } of [empty, refused, cut, garbage]) {
      const r = await new OpenAiReader({ apiKey: 'k', model: 'm', fetch: f }).read({ kind: 'purchase', ownCompany: 'X', document: pdf });
      codes.push(r.ok ? 'ok' : r.issues[0]?.code);
    }
    expect(codes).toEqual(['DOCUMENT_UNREADABLE', 'DOCUMENT_UNREADABLE', 'DOCUMENT_UNREADABLE', 'READER_UNAVAILABLE']);
  });

  it('a busy model hands over to the next one in the list; all busy is tried again, then "try again"', async () => {
    const asked: string[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const model = (JSON.parse(String(init.body)) as { model: string }).model;
      asked.push(model);
      if (model === 'a') return new Response('{}', { status: 503 });
      if (model === 'b') return new Response('{}', { status: 429 });
      return new Response(JSON.stringify(answer({ partyName: 'Acme Ltd' })), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new OpenAiReader({ apiKey: 'k', model: 'a, b ,c', fetch: f, retryDelayMs: 1 }).read({ kind: 'salesOrder', ownCompany: 'X', document: pdf });
    expect(r.ok).toBe(true);
    expect(asked).toEqual(['a', 'b', 'c']);

    const { f: down, sent } = fakeFetch(503, {});
    const none = await new OpenAiReader({ apiKey: 'k', model: 'a,b', fetch: down, rounds: 3, retryDelayMs: 1 }).read({ kind: 'salesOrder', ownCompany: 'X', document: pdf });
    expect(none.ok ? undefined : none.issues[0]?.code).toBe('READER_UNAVAILABLE');
    expect(sent.length).toBe(6);
  });
});
