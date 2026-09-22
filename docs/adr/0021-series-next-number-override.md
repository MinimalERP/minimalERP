# ADR-0021: Manual override of a numbering series' next number

Status: accepted (2026-09-22)

## Context
ADR-0009 §5 made numbering a column, not a counter table: `numbering_series.next_value` advances only under `SELECT … FOR UPDATE`
inside the posting transaction, so numbers stay gapless and a refused posting never burns one. That rule stands. But the owner
needs a way to move that column by hand at any time — continuing from a legacy system's last number, or matching a paper
register — not merely to jump to a specific value once, before the series has ever been used (`numbering_series.start_at`
already does that, but it locks the moment the series has a voucher: see the "a series in use... start number" behaviour).
This is one narrow, audited, forward-only exception to §5, not a reopening of it.

## Decisions
1. **Forward only, ever.** `series_advance(actor, company, requestId, seriesId, nextValue)` (`supabase/migrations/20260930000100_series_advance.sql`)
   refuses `nextValue < current` with a new `SERIES_NEXT_BEHIND` issue — the current value already accounts for everything issued
   before it, so nothing before it may ever be reassigned. Requesting the *same* value is a true no-op: no write, no audit row,
   matching how a replayed create/setActive never reaches the database.
2. **The same row lock as posting, so the two can never race.** The function does `SELECT … FOR UPDATE` on the exact
   `numbering_series` row `post_voucher_atomic` locks, so a concurrent post and a concurrent override serialise naturally through
   Postgres's own lock queue — there is no window for a lost update either way. Proven directly: `packages/db-tests/src/concurrency.test.ts`
   races posts against overrides and checks the final `next_value` is exactly the larger of what posting would have reached and
   what the last successful override set it to.
3. **A new `MasterOp`, not a new port method.** `'advanceSeries'` was added to `packages/domain/src/masters/commands.ts`'s `MasterOp`
   and its command envelope, with a `seriesAdvanceIssues(current, requested)` pure rule shared by every backend. Because
   `Books.execute` → `MasterGateway.execute` → the Edge Function's `'master'` action already forward `{ op, kind, id, data }`
   verbatim, no new wire action was needed for the *write*; only `PostgresBackend.execute()` needed one branch, routing
   `advanceSeries` to `series_advance` instead of the generic `master_apply` upsert (`next_value` is not even a column
   `master_apply` is allowed to touch).
4. **`next_value` still never enters the domain snapshot.** `Masters`/`NumberingSeries` gained no field. It is adapter-side data,
   read on demand the same way "is this in use" already was: `MasterUsage` gained `seriesNextValue: ReadonlyMap<string, number>`,
   populated by widening `master_usage_json` (one more key in the same JSON object) rather than a new round trip. A dedicated
   read, `seriesStatus(companyId, seriesId)`, exists on `MasterGateway`/`Books` so the browser can show "Next number: N" and
   default the override dialog to it without depending on `master_usage_json`'s id-scoped shape.
5. **Same permission as every other master change** — owner and accountant hold `master.write`; a clerk, viewer or outsider is
   refused `PERMISSION_DENIED`, exactly like `master_apply`.
6. **The series record itself is untouched by the change.** `prepareOne`'s `advanceSeries` branch returns a `MasterChange` whose
   `before`/`after` are the same, unchanged record — the actual before/after `next_value` and the gap it created live only in
   `series_advance`'s own `audit_log` row (`action = 'series.advanceNext'`), not in the generic masters audit path. This also
   means the change does **not** bump `masters_version`: nothing else's validated snapshot goes stale because of it.
7. **UI**: `MasterFormScreen` shows "Next number: N" for a numbering series' display/alter screen (fetched once via `seriesStatus`,
   not part of the form's own fields), and a new `master.advanceSeries` panel command ("Next number…", `Alt+N`, hidden unless a
   handler is registered — i.e. only ever offered on a numbering series) opens `SeriesAdvanceDialog`: one field, pre-filled with
   the current value, so accepting untouched is "continue from the last made number." Typing something more than one ahead shows
   an informational skip-count hint — never blocking, since a real reason to jump more than one (matching a legacy system, a
   paper register) is the entire point of the feature. The server's refusal, if any (a concurrent post moved the value between
   opening the dialog and accepting), is shown inline the same way a local one is.

## Consequences
- `start_at` and this override now do genuinely different things: `start_at` sets where a series *begins*, and is locked the
  moment it has a voucher; this override moves where it *continues from*, and works at any time, used or not.
- Pinned by `packages/domain/src/masters/commands.test.ts` (`seriesAdvanceIssues` and the `prepareOne` branch: forward accepted,
  same value replays, backward refused, non-integer/below-1 refused), `packages/db-tests/src/masters.db.test.ts` (permission,
  a forward jump changes `next_value` and the next posted voucher picks it up, works even when the series already has vouchers,
  same-value is a no-op with no audit row, backward is refused with `next_value` unchanged, the audit row records the gap),
  `packages/db-tests/src/concurrency.test.ts` (races against posting), and `e2e/masters.spec.ts` (the display line, the dialog's
  pre-fill and gap hint, a forward jump taking effect, a backward one refused inline).
