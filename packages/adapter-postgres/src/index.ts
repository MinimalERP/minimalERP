/**
 * @minimalerp/adapter-postgres — the server-side posting service over PostgreSQL.
 * Implements the ports on top of the atomic SQL functions in supabase/migrations. Runs in the
 * Supabase Edge Function (Deno) and in Node (tests, scripts); the only driver requirement is `Queryable`.
 * The browser never uses this — it calls the Edge Function through adapter-supabase.
 */
export { PostgresBackend, type PostgresBackendOptions, type VoucherRevision } from './backend';
export { createPostingHandler, type CompanyMailScript, type MailResult, type MailScript, type OutgoingMail, type PostingHandlerDeps, type SentDocument } from './http';
export { createIntakeHandler, type IntakeHandlerDeps, type IntakeServer } from './intake';
export { MASTER_TABLES, buildMasters, ledgersFromJson, masterRecordToRow, mastersToSeed, mastersVersion } from './masters';
export { issueFromDbError } from './errors';
export type { Queryable, QueryResult } from './queryable';
