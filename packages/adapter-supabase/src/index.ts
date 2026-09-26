/**
 * @minimalerp/adapter-supabase — the browser's Supabase implementation of the ports.
 *
 *   PostingGateway     → the `post-voucher` Edge Function (validates, plans, commits atomically)
 *   JournalRepository  → PostgREST reads under row-level security
 *   AuthGateway        → Supabase Auth (email + password)
 *
 * It never writes the books directly. Masters/voucher repositories join in Phase 4/5 when screens need them.
 * Only apps/web/src/main.tsx may import an adapter.
 */
export { SupabasePostingGateway, REQUEST_FAILED } from './gateway';
export { SupabaseAuth, AUTH_FAILED } from './auth';
export { SupabaseBooksBackend } from './books';
export type { CompanyMail, CompanySummary, CompanyUser } from './books';
export type { SupabaseAuthOptions } from './auth';
export { SupabaseJournalRepository, PAGE_SIZE } from './journal';
export type { SupabaseAuthLike, SupabaseAuthSession, SupabaseLike, FilterBuilder, InvokeResult, QueryResult, SupabaseError } from './client';
