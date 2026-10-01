import { describe, expect, it, vi } from 'vitest';
import { OpenAiChat } from './chat';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { model: string; messages: Record<string, unknown>[]; tools?: unknown[]; temperature?: number };
}

/** A fetch answering with each of `replies` in turn ([status, payload]); records what was sent. */
function scripted(replies: [number, unknown][]) {
  const sent: Sent[] = [];
  let i = 0;
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const [status, payload] = replies[Math.min(i++, replies.length - 1)] as [number, unknown];
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, sent };
}

const text = (t: string) => ({ choices: [{ message: { role: 'assistant', content: t } }] });
const call = (name: string, args: Record<string, unknown>, id = 'call-1') => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const TOOLS = [{ name: 'stock_of', description: 'Stock of an item', parameters: { type: 'OBJECT', properties: { item: { type: 'STRING' }, all: { type: 'BOOLEAN' } }, required: ['item'] } }];

describe('the assistant asking ChatGPT, with look-ups', () => {
  it('runs the look-up ChatGPT asks for on our side, sends its result back under the call id, and returns the answer', async () => {
    const { f, sent } = scripted([
      [200, call('stock_of', { item: '14188' })],
      [200, text('14188 blank: 38 Nos.')],
    ]);
    const callTool = vi.fn(async () => ({ item: '14188 - Orifice Blank,90', total: '38' }));
    const r = await new OpenAiChat({ apiKey: 'secret-key', model: 'm', fetch: f }).ask({
      system: 'You work for Micro Components.',
      history: [
        { role: 'user', text: 'hello' },
        { role: 'model', text: 'Hello.' },
        { role: 'user', text: 'stock of 14188?' },
      ],
      tools: TOOLS,
      callTool,
    });
    expect(r).toEqual({ ok: true, value: { text: '14188 blank: 38 Nos.', toolsUsed: ['stock_of'] } });
    expect(callTool).toHaveBeenCalledWith('stock_of', { item: '14188' });

    const first = sent[0] as Sent;
    expect(first.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(first.headers['authorization']).toBe('Bearer secret-key');
    expect(first.body.model).toBe('m');
    expect(first.body.temperature).toBeUndefined();
    expect(first.body.messages.map((m) => m['role'])).toEqual(['system', 'user', 'assistant', 'user']);
    expect(first.body.messages[0]?.['content']).toBe('You work for Micro Components.');
    // the look-ups in plain JSON Schema: the types in small letters
    expect(first.body.tools).toEqual([
      { type: 'function', function: { name: 'stock_of', description: 'Stock of an item', parameters: { type: 'object', properties: { item: { type: 'string' }, all: { type: 'boolean' } }, required: ['item'] } } },
    ]);
    const second = (sent[1] as Sent).body.messages;
    expect(second[4]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call-1' }] });
    expect(second[5]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ result: { item: '14188 - Orifice Blank,90', total: '38' } }) });
  });

  it('a question needing no look-up is answered at once', async () => {
    const { f } = scripted([[200, text('SS304 is about 8.0 g/cm³.')]]);
    const r = await new OpenAiChat({ apiKey: 'k', model: 'm', fetch: f }).ask({ system: 's', history: [{ role: 'user', text: 'density of SS304?' }], tools: TOOLS, callTool: async () => ({}) });
    expect(r).toEqual({ ok: true, value: { text: 'SS304 is about 8.0 g/cm³.', toolsUsed: [] } });
  });

  it('a busy model hands over to the next one in the list', async () => {
    const { f, sent } = scripted([
      [503, {}],
      [200, text('ok')],
    ]);
    const r = await new OpenAiChat({ apiKey: 'k', model: 'first,second', fetch: f }).ask({ system: 's', history: [{ role: 'user', text: 'hi' }], tools: [], callTool: async () => ({}) });
    expect(r.ok).toBe(true);
    expect(sent.map((s) => s.body.model)).toEqual(['first', 'second']);
    expect(sent[0]?.body.tools).toBeUndefined();
  });

  it('a look-up that throws is told to the model as an error, not a crash', async () => {
    const { f, sent } = scripted([
      [200, call('stock_of', { item: 'x' })],
      [200, text('I could not look that up.')],
    ]);
    const r = await new OpenAiChat({ apiKey: 'k', model: 'm', fetch: f }).ask({
      system: 's',
      history: [{ role: 'user', text: 'stock of x' }],
      tools: TOOLS,
      callTool: async () => {
        throw new Error('database down');
      },
    });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(sent[1]?.body.messages[3])).toContain('database down');
  });

  it('a model that keeps asking for look-ups is stopped after five rounds', async () => {
    const { f, sent } = scripted([[200, call('stock_of', { item: 'x' })]]);
    const r = await new OpenAiChat({ apiKey: 'k', model: 'm', fetch: f }).ask({ system: 's', history: [{ role: 'user', text: 'q' }], tools: TOOLS, callTool: async () => ({}) });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(6);
  });

  it('the limit reached is "try again"; the credit used up or a bad key is the setup to check', async () => {
    const ask = (status: number, payload: unknown) =>
      new OpenAiChat({ apiKey: 'k', model: 'm', fetch: scripted([[status, payload]]).f, rounds: 1 }).ask({ system: 's', history: [{ role: 'user', text: 'q' }], tools: [], callTool: async () => ({}) });
    expect(await ask(429, { error: { code: 'rate_limit_exceeded' } })).toMatchObject({ ok: false, issues: [{ code: 'READER_BUSY' }] });
    expect(await ask(429, { error: { code: 'insufficient_quota' } })).toMatchObject({ ok: false, issues: [{ code: 'READER_NOT_SET_UP' }] });
    const badKey = await ask(401, { error: { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-…' } });
    expect(badKey).toMatchObject({ ok: false, issues: [{ code: 'READER_NOT_SET_UP' }] });
    expect(badKey.ok ? '' : badKey.issues[0]?.message).toContain('invalid_api_key');
    expect(badKey.ok ? '' : badKey.issues[0]?.message).not.toContain('sk-');
  });
});
