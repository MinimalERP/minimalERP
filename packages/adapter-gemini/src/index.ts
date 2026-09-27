/**
 * @minimalerp/adapter-gemini — Google's Gemini API: reads a document into the extraction shape (ADR-0023), and holds the assistant's
 * conversation with look-ups (function calling). fetch only (it runs in Edge Functions on Deno, and in Node for tests). The key is an
 * AI Studio API key; the free tier works (with its request limits — a refusal for "too many requests" becomes an issue the person can
 * act on: try again in a minute).
 */
export { GeminiReader, type GeminiOptions } from './reader';
export { GeminiChat, type ChatAnswer, type ChatRequest, type ChatTurn, type ToolDeclaration } from './chat';
