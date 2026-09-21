# ADR-0009: Phase 2 database and posting-service decisions

Status: accepted (2026-09-18)

## Context
Phase 2 put the accounting engine on PostgreSQL behind Supabase-style security. The dev machine has no Docker or
Supabase CLI, so the phase also had to decide how to verify SQL without them.

## Decisions

1. **Tests run on real PostgreSQL 18 via `embedded-postgres`, not Docker and not pgTAP.** One throwaway server per test
   run (`packages/db-tests/src/harness/globalSetup.ts`), one database per test file, every migration applied for real.
   Real triggers, RLS, row locks and genuinely parallel connections. Tests are TypeScript, so they share the
   testkit's scenarios. A `supabase_prelude.sql` emulates the platform pieces migrations lean on (roles, `auth.uid()`,
   Supabase's default privileges) and is **never applied to a real Supabase project**.
   *Not covered:* GoTrue, PostgREST, Storage, Realtime, and the Supabase-hosted Edge runtime. The migrations target
   Postgres 15+ (Supabase's range); the test cluster is 18.

2. **Every invariant is enforced in two layers.** The application (domain + posting functions) refuses bad input with
   friendly errors; the database refuses it again regardless of who writes. Layers: a deferred constraint trigger for
   Σdebit = Σcredit / ≥2 lines / cancelled ⇒ no lines / date and FY consistency; an immediate period-lock trigger; identity
   immutability and no-delete on vouchers; append-only `audit_log` and `voucher_revisions`. Mutation-checked: removing one
   layer is caught by the layer's own tests, and (for the period lock) the other layer still holds.

3. **The write path is `SECURITY INVOKER` SQL functions in `public`, executable by `service_role` only.** Supabase
   grants `anon`/`authenticated`/`service_role` everything on new public objects by default, so migration 6 REVOKEs first
   and grants back: signed-in users get `SELECT` on tables, nothing else; there are no write policies. A privilege audit
   test fails the build if a future table lacks RLS or a function is executable by clients. Helper functions used by RLS
   policies live in an unexposed `private` schema.

4. **Permissions are data.** `role_permissions(role, permission)` with strings like `voucher.payment.post`; roles owner /
   accountant / clerk / viewer are seeded. A clerk posts money vouchers but not journals and never alters or cancels.
   Checked twice: by the adapter before validation (so a denied user learns nothing about the draft) and inside each SQL
   function.

5. **Numbering is a column, not a counter table.** `numbering_series.next_value` is advanced under `SELECT … FOR UPDATE`
   inside the posting transaction, so numbers are gapless and never burned by a refused posting. (Supersedes the
   `numbering_counters` table sketched in architecture.md.) Number formatting avoids `lpad`, which truncates.

6. **Idempotency is serialised by an advisory lock on the voucher id** and compared by JSONB content, so N identical
   concurrent posts yield one voucher and N−1 replays; the same id with different content is `IDEMPOTENCY_CONFLICT`.

7. **The posting service loads masters in two steps** — everything except ledgers, then only the ledgers the draft
   references — so a company with tens of thousands of ledgers does not pay for them on every post.

8. **JSON and dates cross the driver as TEXT and are cast in SQL (`$n::text::jsonb`, `$n::text::date`).** Found by running
   the real Edge Function on Deno: `postgres.js` re-encodes a string sent to a `jsonb` parameter, `node-postgres` does not.
   Money is a decimal string end to end and `numeric(18,2)` in storage; a domain `MAX_MONEY` refuses amounts the column
   cannot hold, as a validation error rather than a database exception.

9. **The Edge Function is thin glue over a tested handler.** `createPostingHandler` (Web `Request` → `Response`) is where
   behaviour lives; `supabase/functions/post-voucher/index.ts` only supplies auth and a database connection. It ships as one
   self-contained bundle (`pnpm build:functions`, ~0.8 MB, no imports). It is exercised end to end on real Deno with
   the real `postgres` and `supabase-js` packages (only GoTrue is mocked).

10. **Scope deliberately left out** (ADR-0007): outbox events, the search index, master-data write paths, drafts, and the
    browser's masters/voucher repositories. Masters are writable only by the service until Phase 4 adds validated CRUD.

## Consequences
- Adding a table means adding RLS + grants in the same migration set, or the privilege audit fails.
- Adding a voucher kind means one migration inserting its `role_permissions` rows and widening the `base_kind` check.
- CI must be able to run `embedded-postgres` (allowed install scripts are listed in `pnpm-workspace.yaml`) and Deno
  (pinned in `devEngines`). Linux CI is configured but was not run from this machine.
