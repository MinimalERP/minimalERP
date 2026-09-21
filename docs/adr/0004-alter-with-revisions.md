# ADR-0004: Alter posted vouchers in place, with revisions, cancellation and period locks

Status: accepted (2026-09-18)

## Context
Tally users alter vouchers routinely; immutable-plus-reversal is stricter but foreign to the workflow.

## Decision
Alteration snapshots the prior version into `voucher_revisions` and replaces current journal/stock rows in one transaction. Cancel keeps the voucher and number and removes its lines from the books. Only drafts are hard-deleted. `financial_years.locked_through` blocks post/alter/cancel. `audit_log` is append-only.

## Consequences
Report queries need no version filter (books hold only current lines). History is complete via revisions + audit log.
