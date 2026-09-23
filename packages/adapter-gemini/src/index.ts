/**
 * @minimalerp/adapter-gemini — reads a document with Google's Gemini API into the extraction shape (ADR-0023).
 * fetch only (it runs in the `intake` Edge Function on Deno, and in Node for tests). The key is an AI Studio API key; the free tier works
 * (with its request limits — a refusal for "too many requests" becomes an issue the person can act on: try again in a minute).
 */
export { GeminiReader, type GeminiOptions } from './reader';
