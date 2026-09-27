import { type Result, fail, ok } from '@minimalerp/domain';
import { type GeminiOptions, callGemini, problem } from './call';

/** One turn of the conversation as the person saw it. */
export interface ChatTurn {
  readonly role: 'user' | 'model';
  readonly text: string;
}

/** A look-up the model may call: its name, what it is for, and its arguments (Gemini's OpenAPI subset: OBJECT / STRING / BOOLEAN…). */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
}

export interface ChatRequest {
  /** Who it works for and its rules (the system instruction). */
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

type Part = { text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } } & Record<string, unknown>;
type Content = { role: string; parts: Part[] };

/**
 * The assistant's conversation with Gemini (function calling): the question goes with the look-ups it may use; while Gemini answers with
 * look-up calls, each is run on OUR side (`callTool`, as the signed-in person) and its result sent back; its final text is the answer.
 * The model's own turns are sent back exactly as they came (newer models sign them), so it can continue its reasoning.
 */
export class GeminiChat {
  constructor(private readonly options: GeminiOptions) {}

  async ask(request: ChatRequest): Promise<Result<ChatAnswer>> {
    const contents: Content[] = request.history.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
    const tools = request.tools.length > 0 ? [{ functionDeclarations: request.tools }] : undefined;
    const used: string[] = [];

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents,
        ...(tools ? { tools } : {}),
        generationConfig: { temperature: 0.2 },
      };
      const answer = await callGemini(this.options, body);
      if (!answer.ok) return answer;
      const payload = answer.value as { candidates?: { content?: Content }[]; promptFeedback?: { blockReason?: string } };
      const content = payload?.candidates?.[0]?.content;
      const parts = content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall?.name);

      if (calls.length === 0) {
        const text = parts.map((p) => p.text ?? '').join('').trim();
        if (text === '') {
          const blocked = payload?.promptFeedback?.blockReason;
          return fail(problem('ASSISTANT_NO_ANSWER', blocked ? `Gemini would not answer this (${blocked})` : 'Gemini gave no answer: ask again'));
        }
        return ok({ text, toolsUsed: used });
      }
      if (round === MAX_ROUNDS) break;

      contents.push({ role: 'model', parts }); // as it came: the signatures on it must go back unchanged
      const responses: Part[] = [];
      for (const c of calls) {
        const name = c.functionCall?.name as string;
        used.push(name);
        let result: unknown;
        try {
          result = await request.callTool(name, c.functionCall?.args ?? {});
        } catch (error) {
          result = { error: `The look-up failed: ${String((error as Error)?.message ?? error)}` };
        }
        responses.push({ functionResponse: { name, response: { result } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return fail(problem('ASSISTANT_NO_ANSWER', 'The question needed too many look-ups: ask it more simply'));
  }
}
