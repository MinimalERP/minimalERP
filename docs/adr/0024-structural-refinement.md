# ADR-0024: Structural refinement — simplify without changing behaviour

Status: accepted (2026-09-25)

## Context

The product works and layering is enforced (`pnpm boundaries`, ADR-0001). Features arrived in phases (5–8, inbox, online books, GST, import/export). Each phase extended the same shell correctly, but **implementation drift** made the tree feel heavier than the architecture describes:

- **Vouchers:** ADR-0012 and `architecture.md` §5 promise one `VoucherScreen` and ~five layouts; `single-entry` / `double-entry` live in `VoucherScreen.tsx`, while `item-invoice` and `stock` live as separate 800–1400 line files under `screens/`.
- **Reports:** ADR-0017 extended one `ReportScreen` with branches; every new register/GST view added imports and switch cases (~730 lines).
- **Books:** Local IndexedDB, cloud Supabase, saving overlay, demo seed, and master forms share `books/` without a single map of responsibilities.
- **Packages:** `migrate-zoho`, `adapter-gemini`, and web-side report row builders are legitimate but sit beside core paths without a “core vs integrations” story in the tree.

Nothing here changes posting authority, commands, keyboard rules, or the data model. Refinement is **relocate, split, and register** — same behaviour, smaller surfaces.

## Principles

1. **Incremental only.** Each step keeps `pnpm check` green; no big-bang rewrite.
2. **Match the architecture names.** Layout code lives under `vouchers/`; report families under `reports/`; screens stay thin routers.
3. **Extract before abstract.** Shared voucher chrome (header, bottom bar, leave guard, accept flow) is copied into one module only when a second layout already uses the same pattern — no speculative framework.
4. **Registry over switch growth.** New report or layout = register a handler; the host file does not gain another top-level branch every time.

## Phase A — Vouchers (first)

| Step | Action | Done when |
|------|--------|-----------|
| A1 | Move `item-invoice` and `stock` entry UI from `screens/` to `apps/web/src/vouchers/layouts/` | Done |
| A2 | Introduce `voucherLayoutOf(masters, typeId)` in one place (web) mirroring domain `VoucherLayout` | Done |
| A3 | Extract shared **worksheet chrome** into `vouchers/layouts/worksheetChrome.tsx` | Done (section, head, notices, narration, draft hook, date parse, mode handlers) |
| A4 | Rename `SalesVoucherEntry` → `ItemInvoiceEntry` (covers purchase + orders) | Done |

Deferred: merging the three entry implementations into one component — only if A3 proves the shared skeleton is stable.

## Phase B — Reports

| Step | Action | Done when |
|------|--------|-----------|
| B1 | `reports/registry.ts`: host kind + titles | Done |
| B2 | `reports/gridRegistry.ts`: grid rows, columns, default order, headings | Done |
| B3 | Comment in `gridRegistry.ts`: domain figures vs web columns/formatting | Done |

## Phase C — Books layer

| Step | Action | Done when |
|------|--------|-----------|
| C1 | `books/README.md` (short): `BooksHost`, `local` / `cloud` factories, `saving`, `store` / `idb`, `forms` / `entities` | Done |
| C2 | Group tests next to modules they test; avoid new cross-folder imports | Boundaries unchanged |

## Phase D — Packages & integrations

| Step | Action | Done when |
|------|--------|-----------|
| D1 | Root README: core vs integrations (`migrate-zoho`, Gemini, GAS) | Done |
| D2 | No new packages without ADR mention | Ongoing convention |

## Verification

Every step: `pnpm test`, then `pnpm check` before merge. E2e only when voucher/report navigation touched.

## Consequences

- File moves may churn git history; prefer `git mv`.
- No user-visible change until a later step deliberately changes UX.
- Supabase/cloud credentials are not required for Phases A–C.
