import { extractionSchema } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { GeminiReader } from './reader';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> };
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

const answer = (json: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP' }] });
const pdf = { mimeType: 'application/pdf', base64: 'JVBERi0xLjQK' };

describe('reading a document with Gemini', () => {
  it('sends the document with the prompt and a response schema, the key in a header (never the URL), at temperature 0', async () => {
    const { f, sent } = fakeFetch(200, answer({ partyName: 'Acme Ltd', poNumber: 'PO-1', lines: [{ description: 'Bolt', qty: '10', rate: '4.5' }] }));
    const reader = new GeminiReader({ apiKey: 'secret-key', model: 'some-flash-model', fetch: f });
    const r = await reader.read({ kind: 'salesOrder', ownCompany: 'Padekar Engineering', document: pdf });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(extractionSchema.parse(r.value)).toMatchObject({ partyName: 'Acme Ltd', poNumber: 'PO-1', lines: [{ description: 'Bolt', qty: '10', rate: '4.5' }] });

    const s = sent[0] as Sent;
    expect(s.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/some-flash-model:generateContent');
    expect(s.url).not.toContain('secret-key');
    expect(s.headers['x-goog-api-key']).toBe('secret-key');
    expect(s.body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json' });
    expect(s.body.generationConfig['responseSchema']).toBeDefined();
    const parts = s.body.contents[0]?.parts ?? [];
    expect(String(parts[0]?.['text'])).toContain('Padekar Engineering');
    expect(String(parts[0]?.['text'])).toContain('purchase order');
    expect(parts[1]).toEqual({ inline_data: { mime_type: 'application/pdf', data: 'JVBERi0xLjQK' } });
  });

  it('reads a mail body as text', async () => {
    const { f, sent } = fakeFetch(200, answer({ partyName: 'Acme Ltd' }));
    const r = await new GeminiReader({ apiKey: 'k', model: 'm', fetch: f }).read({ kind: 'receipt', ownCompany: 'X', document: { text: 'We have paid INV-1 by NEFT' } });
    expect(r.ok).toBe(true);
    expect(String(sent[0]?.body.contents[0]?.parts[1]?.['text'])).toContain('We have paid INV-1');
  });

  it('the free tier being used up is an answer the person can act on', async () => {
    const { f } = fakeFetch(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    const r = await new GeminiReader({ apiKey: 'k', model: 'm', fetch: f, retryDelayMs: 1 }).read({ kind: 'purchase', ownCompany: 'X', document: pdf });
    expect(r.ok ? undefined : r.issues[0]?.code).toBe('READER_BUSY');
    expect(r.ok ? '' : r.issues[0]?.message).toContain('try again');
  });

  it('a bad key or a model the key cannot use says the setup needs checking', async () => {
    for (const status of [400, 401, 403]) {
      const { f } = fakeFetch(status, { error: {} });
      const r = await new GeminiReader({ apiKey: 'k', model: 'm', fetch: f }).read({ kind: 'purchase', ownCompany: 'X', document: pdf });
      expect(r.ok ? undefined : r.issues[0]?.code).toBe('READER_NOT_SET_UP');
    }
  });

  it('refuses what it cannot read before sending anything', async () => {
    const { f, sent } = fakeFetch(200, answer({}));
    const reader = new GeminiReader({ apiKey: 'k', model: 'm', fetch: f });
    const zip = await reader.read({ kind: 'purchase', ownCompany: 'X', document: { mimeType: 'application/zip', base64: 'UEsDBA==' } });
    const huge = await reader.read({ kind: 'purchase', ownCompany: 'X', document: { mimeType: 'application/pdf', base64: 'A'.repeat(15 * 1024 * 1024) } });
    const empty = await reader.read({ kind: 'purchase', ownCompany: 'X', document: { text: '   ' } });
    expect([zip, huge, empty].map((r) => (r.ok ? undefined : r.issues[0]?.code))).toEqual(['DOCUMENT_UNSUPPORTED', 'DOCUMENT_TOO_LARGE', 'DOCUMENT_EMPTY']);
    expect(sent).toEqual([]);
  });

  it('an empty, blocked or cut-off answer is "could not be read", never a crash', async () => {
    const empty = fakeFetch(200, { candidates: [{ content: { parts: [] } }] });
    const blocked = fakeFetch(200, { promptFeedback: { blockReason: 'OTHER' } });
    const cut = fakeFetch(200, { candidates: [{ content: { parts: [{ text: '{"partyName": "Acm' }] } }] });
    const garbage = fakeFetch(200, 'not json');
    const codes = [];
    for (const { f } of [empty, blocked, cut, garbage]) {
      const r = await new GeminiReader({ apiKey: 'k', model: 'm', fetch: f }).read({ kind: 'purchase', ownCompany: 'X', document: pdf });
      codes.push(r.ok ? 'ok' : r.issues[0]?.code);
    }
    expect(codes).toEqual(['DOCUMENT_UNREADABLE', 'DOCUMENT_UNREADABLE', 'DOCUMENT_UNREADABLE', 'READER_UNAVAILABLE']);
  });

  it('an overloaded answer (503) is retried once, quietly; twice overloaded is "try again"', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(answer({ partyName: 'Acme Ltd' })), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new GeminiReader({ apiKey: 'k', model: 'm', fetch: flaky, retryDelayMs: 1 }).read({ kind: 'purchase', ownCompany: 'X', document: pdf });
    expect([r.ok, calls]).toEqual([true, 2]);

    const { f, sent } = fakeFetch(503, {});
    const down = await new GeminiReader({ apiKey: 'k', model: 'm', fetch: f, retryDelayMs: 1 }).read({ kind: 'purchase', ownCompany: 'X', document: pdf });
    expect(down.ok ? undefined : down.issues[0]?.code).toBe('READER_UNAVAILABLE');
    expect(sent.length).toBe(2);
  });

  it('a busy model hands over to the next one in the list at once; the first that answers reads the document', async () => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      const model = /models\/([^:]+):/.exec(url)?.[1] ?? '';
      asked.push(model);
      if (model === 'flash-a') return new Response('{}', { status: 503 });
      if (model === 'flash-b') return new Response('{}', { status: 429 });
      return new Response(JSON.stringify(answer({ partyName: 'Acme Ltd' })), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new GeminiReader({ apiKey: 'k', model: 'flash-a, flash-b ,flash-c', fetch: f, retryDelayMs: 1 }).read({ kind: 'salesOrder', ownCompany: 'X', document: pdf });
    expect(r.ok).toBe(true);
    expect(asked).toEqual(['flash-a', 'flash-b', 'flash-c']);
  });

  it('a model that is too slow is left for the next one', async () => {
    const asked: string[] = [];
    const f = ((url: string, init: RequestInit) => {
      const model = /models\/([^:]+):/.exec(url)?.[1] ?? '';
      asked.push(model);
      if (model === 'slow')
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      return Promise.resolve(new Response(JSON.stringify(answer({ partyName: 'Acme Ltd' })), { status: 200 }));
    }) as unknown as typeof fetch;
    const r = await new GeminiReader({ apiKey: 'k', model: 'slow,quick', fetch: f, timeoutMs: 20, retryDelayMs: 1 }).read({ kind: 'salesOrder', ownCompany: 'X', document: pdf });
    expect(r.ok).toBe(true);
    expect(asked).toEqual(['slow', 'quick']);
  });

  it('keeps trying round after round while every model is busy, and stops at the deadline', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response('{}', { status: 503 });
    }) as unknown as typeof fetch;
    const r = await new GeminiReader({ apiKey: 'k', model: 'a,b', fetch: f, rounds: 3, retryDelayMs: 1 }).read({ kind: 'salesOrder', ownCompany: 'X', document: pdf });
    expect(r.ok).toBe(false);
    expect(calls).toBe(6);
    calls = 0;
    await new GeminiReader({ apiKey: 'k', model: 'a,b', fetch: f, rounds: 50, retryDelayMs: 5, deadlineMs: 30 }).read({ kind: 'salesOrder', ownCompany: 'X', document: pdf });
    expect(calls).toBeLessThan(30);
  });

  it('a model that is not there (404) is a setup problem, not a reason to try another', async () => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      asked.push(url);
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const r = await new GeminiReader({ apiKey: 'k', model: 'gone,other', fetch: f, retryDelayMs: 1 }).read({ kind: 'salesOrder', ownCompany: 'X', document: pdf });
    expect(r.ok ? undefined : r.issues[0]?.code).toBe('READER_NOT_SET_UP');
    expect(asked.length).toBe(1);
  });

  it('a network failure is "try again", not an exception', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await new GeminiReader({ apiKey: 'k', model: 'm', fetch: f }).read({ kind: 'purchase', ownCompany: 'X', document: pdf });
    expect(r.ok ? undefined : r.issues[0]?.code).toBe('READER_UNAVAILABLE');
  });
});
