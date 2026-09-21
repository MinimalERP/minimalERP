/**
 * @minimalerp/adapter-supabase — the browser's Supabase implementation of the ports.
 *
 *   PostingGateway     → the `post-voucher` Edge Function (validates, plans, commits atomically)
 *   JournalRepository  → PostgREST reads under row-level security
 *
 * It never writes the books directly. Masters/voucher repositories join in Phase 4/5 when screens need them.
 * Only apps/web/src/main.tsx may import an adapter.
 */
export { SupabasePostingGateway, REQUEST_FAILED } from './gateway';
export { SupabaseJournalRepository, PAGE_SIZE } from './journal';
export type { SupabaseLike, FilterBuilder, InvokeResult, QueryResult, SupabaseError } from './client';
