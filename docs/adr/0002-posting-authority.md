# ADR-0002: Posting engine runs server-side in TypeScript; commit is one atomic RPC

Status: accepted (2026-09-18)

## Context
The browser cannot be trusted to send journal lines, multiple client calls are not atomic, and rules must not be duplicated between SQL and TS.

## Decision
The same `packages/domain` bundle runs in the browser (advisory preview) and in an Edge Function (authoritative). The function calls `post_voucher_atomic()`, which numbers, writes voucher/journal/stock/links/search-index/audit/outbox in one transaction. A deferred constraint trigger enforces Dr=Cr at COMMIT. EXECUTE on the RPC is revoked from `authenticated`; journal/stock tables are not client-writable. Voucher id is the idempotency key.

## Consequences
Rules are written once and unit-testable without a DB. Backend replacement = run the bundle in Node + plain SQL transaction. Cost: a function hop per post and a bundling step. Rejected: all logic in PL/pgSQL (duplicates rules needed for browser preview, harder to test).
