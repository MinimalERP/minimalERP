import { describe, expect, it, vi } from 'vitest';
import { GeminiChat } from './chat';

interface Sent {
  url: string;
  body: { systemInstruction: { parts: { text: string }[] }; contents: { role: string; parts: Record<string, unknown>[] }[]; tools?: unknown[] };
}

/** A fetch answering with each of `replies` in turn ([status, payload]); records what was sent. */
function scripted(replies: [number, unknown][]) {
  const sent: Sent[] = [];
  let i = 0;
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const [status, payload] = replies[Math.min(i++, replies.length - 1)] as [number, unknown];
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, sent };
}

const text = (t: string) => ({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] });
const call = (name: string, args: Record<string, unknown>, signature = 'sig-1') => ({
  candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: signature }] } }],
});
const TOOLS = [{ name: 'stock_of', description: 'Stock of an item', parameters: { type: 'OBJECT', properties: { item: { type: 'STRING' } } } }];

describe('the assistant asking Gemini, with look-ups', () => {
  it('runs the look-up Gemini asks for on our side, sends its result back with the model turn unchanged, and returns the answer', async () => {
    const { f, sent } = scripted([
      [200, call('stock_of', { item: '14188' })],
      [200, text('14188 blank: 38 Nos.')],
    ]);
    const callTool = vi.fn(async () => ({ item: '14188 - Orifice Blank,90', total: '38' }));
    const r = await new GeminiChat({ apiKey: 'k', model: 'm', fetch: f }).ask({
      system: 'You work for Micro Components.',
      history: [{ role: 'user', text: 'stock of 14188?' }],
      tools: TOOLS,
      callTool,
    });
    expect(r).toEqual({ ok: true, value: { text: '14188 blank: 38 Nos.', toolsUsed: ['stock_of'] } });
    expect(callTool).toHaveBeenCalledWith('stock_of', { item: '14188' });
    expect(sent[0]?.body.systemInstruction.parts[0]?.text).toBe('You work for Micro Components.');
    expect(sent[0]?.body.tools).toEqual([{ functionDeclarations: TOOLS }]);
    const second = sent[1]?.body.contents ?? [];
    expect(second[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'stock_of', args: { item: '14188' } }, thoughtSignature: 'sig-1' }] });
    expect(second[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'stock_of', response: { result: { item: '14188 - Orifice Blank,90', total: '38' } } } }] });
  });

  it('a question needing no look-up is answered at once', async () => {
    const { f } = scripted([[200, text('SS304 is about 8.0 g/cm³.')]]);
    const r = await new GeminiChat({ apiKey: 'k', model: 'm', fetch: f }).ask({ system: 's', history: [{ role: 'user', text: 'density of SS304?' }], tools: TOOLS, callTool: async () => ({}) });
    expect(r).toEqual({ ok: true, value: { text: 'SS304 is about 8.0 g/cm³.', toolsUsed: [] } });
  });

  it('a busy model hands over to the next one in the list', async () => {
    const { f, sent } = scripted([
      [503, {}],
      [200, text('ok')],
    ]);
    const r = await new GeminiChat({ apiKey: 'k', model: 'first,second', fetch: f }).ask({ system: 's', history: [{ role: 'user', text: 'hi' }], tools: [], callTool: async () => ({}) });
    expect(r.ok).toBe(true);
    expect(sent.map((s) => s.url.split('/').pop())).toEqual(['first:generateContent', 'second:generateContent']);
  });

  it('a look-up that throws is told to the model as an error, not a crash', async () => {
    const { f, sent } = scripted([
      [200, call('stock_of', { item: 'x' })],
      [200, text('I could not look that up.')],
    ]);
    const r = await new GeminiChat({ apiKey: 'k', model: 'm', fetch: f }).ask({
      system: 's',
      history: [{ role: 'user', text: 'stock of x' }],
      tools: TOOLS,
      callTool: async () => {
        throw new Error('database down');
      },
    });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(sent[1]?.body.contents[2])).toContain('database down');
  });

  it('a model that keeps asking for look-ups is stopped after five rounds', async () => {
    const { f, sent } = scripted([[200, call('stock_of', { item: 'x' })]]);
    const r = await new GeminiChat({ apiKey: 'k', model: 'm', fetch: f }).ask({ system: 's', history: [{ role: 'user', text: 'q' }], tools: TOOLS, callTool: async () => ({}) });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(6);
  });

  it('the free limit reached everywhere is an issue the person can act on', async () => {
    const { f } = scripted([[429, {}]]);
    const r = await new GeminiChat({ apiKey: 'k', model: 'm', fetch: f, rounds: 1 }).ask({ system: 's', history: [{ role: 'user', text: 'q' }], tools: [], callTool: async () => ({}) });
    expect(r).toMatchObject({ ok: false, issues: [{ code: 'READER_BUSY' }] });
  });
});
