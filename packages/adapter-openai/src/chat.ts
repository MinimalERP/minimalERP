import { type Result, fail, ok } from '@minimalerp/domain';
import { type OpenAiOptions, callOpenAi, jsonSchema, problem } from './call';

/** One turn of the conversation as the person saw it. */
export interface ChatTurn {
  readonly role: 'user' | 'model';
  readonly text: string;
}

/** A look-up the model may call: its name, what it is for, and its arguments (as the domain writes them: OBJECT / STRING / BOOLEAN…). */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
}

export interface ChatRequest {
  /** Who it works for and its rules (the system message). */
  readonly system: string;
  /** The conversation so far, oldest first, ending with the person's question. */
  readonly history: readonly ChatTurn[];
  readonly tools: readonly ToolDeclaration[];
  /** Runs one look-up the model asked for; what it returns is sent back to the model as the look-up's answer. */
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface ChatAnswer {
  readonly text: string;
  /** The look-ups used, in order (the "from ERP · stock, orders" tag). */
  readonly toolsUsed: readonly string[];
}

/** How many times the model may ask for look-ups before it must answer. */
const MAX_ROUNDS = 5;

type ToolCall = { id?: string; function?: { name?: string; arguments?: string } };
type Message = { role: string; content?: unknown; refusal?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string } & Record<string, unknown>;

/**
 * The assistant's conversation with ChatGPT (function calling): the question goes with the look-ups it may use; while the model answers
 * with look-up calls, each is run on OUR side (`callTool`, as the signed-in person) and its result sent back; its final text is the answer.
 */
export class OpenAiChat {
  constructor(private readonly options: OpenAiOptions) {}

  async ask(request: ChatRequest): Promise<Result<ChatAnswer>> {
    const messages: Message[] = [
      { role: 'system', content: request.system },
      ...request.history.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text })),
    ];
    const tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: jsonSchema(t.parameters ?? { type: 'OBJECT', properties: {} }) },
    }));
    const used: string[] = [];

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      // no temperature: the newer models take only their own
      const answer = await callOpenAi(this.options, { messages, ...(tools.length > 0 ? { tools } : {}) });
      if (!answer.ok) return answer;
      const message = (answer.value as { choices?: { message?: Message }[] })?.choices?.[0]?.message;
      const calls = (message?.tool_calls ?? []).filter((c) => c.function?.name);

      if (!message || calls.length === 0) {
        const text = typeof message?.content === 'string' ? message.content.trim() : '';
        if (text === '') return fail(problem('ASSISTANT_NO_ANSWER', message?.refusal ? 'ChatGPT would not answer this' : 'ChatGPT gave no answer: ask again'));
        return ok({ text, toolsUsed: used });
      }
      if (round === MAX_ROUNDS) break;

      messages.push(message); // as it came: the call ids on it are what the results answer
      for (const c of calls) {
        const name = c.function?.name as string;
        used.push(name);
        let result: unknown;
        try {
          let args: unknown = {};
          try {
            args = JSON.parse(c.function?.arguments || '{}');
          } catch {
            // arguments that are not JSON: the look-up runs without them and says what it needs
          }
          result = await request.callTool(name, typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {});
        } catch (error) {
          result = { error: `The look-up failed: ${String((error as Error)?.message ?? error)}` };
        }
        messages.push({ role: 'tool', tool_call_id: c.id ?? '', content: JSON.stringify({ result }) });
      }
    }
    return fail(problem('ASSISTANT_NO_ANSWER', 'The question needed too many look-ups: ask it more simply'));
  }
}
