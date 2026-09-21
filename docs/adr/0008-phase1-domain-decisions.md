# ADR-0008: Phase 1 domain decisions

Status: accepted (2026-09-18)

## Context
Phase 1 built the pure domain core (money, groups, ledgers, voucher kinds, posting engine, trial-balance oracle) and an
in-memory backend that stands in for the Edge Function + `post_voucher_atomic` RPC. These choices shape everything after it.

## Decisions

1. **Money is a bigint of paise, and floats are rejected at the boundary.** A JS `number` for an amount fails schema
   parsing. Drafts accept a bigint (in-process) or a decimal string (wire); the wire format is `"1234.56"`.
2. **A posting rule emits identity-free `PlannedLine`s.** The engine stamps voucher id, line numbers and date, so a rule
   cannot get identity wrong. The engine then asserts the plan (≥2 lines, positive amounts, Dr = Cr, consistent lines)
   and refuses it otherwise. The backend repeats the balance check independently at commit (`assertCommitInvariants`),
   which the Postgres trigger will mirror.
3. **Payment / Receipt / Contra share one "single-entry" kind factory.** The account (cash/bank) amount is *derived* as the
   sum of the particulars, so these vouchers cannot be unbalanced by construction. Journal is the only kind where the
   user enters both sides, so it is the only one that can fail with `UNBALANCED`.
4. **Journal refuses cash and bank ledgers** (Payment/Receipt/Contra exist for those), so cash/bank books stay complete.
   This is a per-kind rule in `journalKind.validate` and is easy to relax or make configurable.
5. **Drafts carry no company id.** The company comes from the `Masters` snapshot the engine is given, so a draft cannot
   name one company while referencing another's ledgers.
6. **`VoucherKind` is registered per `BaseKind`; `VoucherType` rows are configuration.** The registry is an instance, not
   a global. `BaseKind` is a closed union; adding a kind means extending it and registering a kind (one place each).
7. **Alteration keeps id, voucher type, number and financial year.** Moving a voucher into another financial year would
   change its numbering series, so it is refused (`FINANCIAL_YEAR_CHANGED`); cancel and re-post instead.
8. **Idempotency is checked before validation.** A retry of an already-posted voucher succeeds (`replayed: true`) even if
   the period has since been locked. The same id with different content is `IDEMPOTENCY_CONFLICT`. Equality is by parsed
   content, so `"10.00"` and `1000n` are the same voucher.
9. **Numbers are allocated only at commit.** A refused posting never consumes a number; a cancelled voucher keeps its
   number and it is never reused (gapless per voucher type per financial year).
10. **Cross-package behaviour tests live in `packages/testkit`.** Domain tests may import only the domain, so tests that
    exercise domain + ports + adapter together (properties, lifecycle) sit in testkit. Expected effects in those tests are
    computed by plain arithmetic in the scenario builders, not by the posting rules, so they are a real cross-check.

## Consequences
- The contract suite for the Supabase adapter (Phase 2) can reuse `testkit` scenarios and properties against a second `PostingGateway`.
- Sales/Purchase (Phase 7) extend `BaseKind`, `PostingPlan` (stock, links, bill allocations) and `assertCommitInvariants`.
- Opening-balance vouchers, drafts, and bill allocations are deliberately not in Phase 1.
