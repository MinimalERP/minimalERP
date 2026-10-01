/**
 * @minimalerp/adapter-openai — OpenAI's API (ChatGPT): reads a document into the extraction shape (ADR-0023), and holds the assistant's
 * conversation with look-ups (function calling). The same two jobs as adapter-gemini, so either can be the model behind the ERP. fetch
 * only (it runs in Edge Functions on Deno, and in Node for tests). The key is a platform.openai.com API key on a paid account.
 */
export { OpenAiReader, type OpenAiOptions } from './reader';
export { OpenAiChat, type ChatAnswer, type ChatRequest, type ChatTurn, type ToolDeclaration } from './chat';
