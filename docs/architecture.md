# MinimalERP — Architecture

Status: approved 2026-09-18. Changes to anything here go through an ADR in `docs/adr/`.

```
Gateway → Universal Search/Go To → Masters → Vouchers → Posting Engine → Books → Reports → Drill-down
```

## 1. Principles

1. **The journal is the only source of financial truth.** Balances are derived from `journal_lines` and `stock_movements`. No writable balance exists anywhere.
2. **Domain logic is pure TypeScript** — no DOM, no Supabase, no Preact.
3. **The posting plan is computed in pure code and committed in one atomic database transaction.**
4. **Everything navigable or actionable is a Command** in one registry: menus, reports, hotkeys, Alt+G results, Alt+C.
5. **Keyboard handling is one layer.** Components declare scopes and commands; they never attach shortcut listeners.
6. **Extension by registration.** New voucher kind, report, or module = a manifest; the shell is not edited.
7. **Don't build ahead.** No reserved columns or stubs for future modules (ADR-0007).

## 2. Layers and dependency rules

```
apps/web ─► command, keyboard, ports, domain           (adapters only in src/main.tsx)
adapters ─► ports, domain
ports    ─► domain
command, keyboard ─► (nothing in the workspace)        generic over entity types
domain   ─► stdlib, zod, big.js only
```

Enforced by `tooling/dependency-cruiser.cjs` (`pnpm boundaries`) and `eslint.config.js`; proven by `tooling/guards.test.ts`.
Packages are source-only (`exports` → `src/index.ts`); cross-package imports go through the package index.

## 3. Posting authority

| Step | Where |
|---|---|
| Live preview (totals, GST, posting effect) | Browser, `domain` package — advisory |
| **Authoritative** validate + build `PostingPlan` | Edge Function `post-voucher`, same `domain` bundle |
| **Atomic commit** | Postgres RPC `post_voucher_atomic()`: number → voucher → lines → journal → stock → links → search index → audit → outbox |
| Last line of defence | Deferred constraint trigger: `SUM(debit) = SUM(credit)` per voucher at COMMIT |

`EXECUTE` on the posting functions is granted to `service_role` only (Supabase's default grants are REVOKEd first); the Edge Function authenticates the JWT, checks permission, and the SQL function checks it again.
Journal and stock tables are not writable by clients. The SQL does no business derivation — it enforces invariants,
allocates numbers and writes rows. Replacing Supabase later = run the `domain` bundle in a Node service and make the RPC
a plain SQL transaction; `ports` isolate the UI from both.

## 4. Data model (summary)

- Every business table has `company_id`; **all foreign keys are composite `(company_id, id)`**.
- IDs: UUIDv7, client-generated for vouchers (the voucher id is the idempotency key).
- Money `numeric(18,2)`; quantity/rate `numeric(18,4)`. TS: `Money` = bigint minor units; `big.js` for qty/rate/percent.
- **Masters:** companies, financial_years, account_groups (Tally primary groups seeded, protected), ledgers, **parties** (entity profile with 0..n ledgers; only ledgers post), stock_groups, units, stock_items, warehouses, tax_rates (effective-dated), voucher_types, numbering_series/counters.
- **Transactions:** vouchers (header) · voucher_lines · voucher_items · bill_allocations · voucher_links · voucher_revisions · `journal_lines` · `stock_movements`.
- **Cross-cutting:** audit_log (append-only), outbox_events, search_index, user_navigation, roles/permissions/company_members.
- **Opening balances are an *Opening Balance* system voucher**, not a ledger column.
- Alter-in-place with snapshots into `voucher_revisions`; cancel keeps the voucher number; only drafts are hard-deleted; period lock via `financial_years.locked_through`.
- Numbering: FY-aware series; `numbering_series.next_value` advanced under a row lock **inside** the posting transaction (gapless; no separate counters table — ADR-0009).
- Inventory valuation: weighted average first, Tally-style periodic (closing stock computed from movements) — ADR-0003.

## 5. Voucher and posting engine

```
Voucher UI (draft store) → VoucherService.post → normalise → structural validation → business validation
  → PostingRule → PostingPlan{journal[], stock[], links[], billAllocations[]} → invariant assertions
  → PostingGateway → Edge Function (re-runs all) → post_voucher_atomic
```

`VoucherKind` (code, registered) supplies schema, layout, validators, posting rule, ledger filters, defaults.
`voucher_types` (rows) point at a kind and carry numbering, hotkey, field config — so "Sales–Export" is data, not code.
One generic `VoucherScreen` renders one of ~5 layouts (single-entry, double-entry, item-invoice, ledger-invoice, order/stock).

| Voucher | Journal | Stock |
|---|---|---|
| Contra / Payment / Receipt / Journal | yes | — |
| Sales / Purchase | yes (party, sales/purchase, tax, round-off) | out / in |
| Credit Note / Debit Note | reversal of Sales / Purchase | in / out |
| Sales Order / Purchase Order | — (order book) | — |
| Delivery / Receipt note | — | out / in |
| Inventory transactions | — | in and out |

**Alt+C** in a picker pushes a create-master frame onto the ScreenStack with a `resolve` callback; on accept the new id
returns to the originating field with draft state and focus restored.

## 6. Universal Search / Go To

`Alt+G → GoToOverlay → SearchService.query(text, SearchContext)` over providers:
**CommandProvider** (registry, in-memory) · **MasterProvider** (Tier 1 client cache, <5 ms) · **ServerProvider** (Tier 2,
RPC over `search_index`, debounced + abortable) · **RecentProvider** (frecency).

- `Command {id, title, keywords, category, when, requires, args, shortcut, run}`; modules contribute via `ModuleManifest`.
  Voucher-type commands are generated from `voucher_types`; report commands from the report registry.
- `search_index` rows for masters are trigger-maintained; voucher rows are written **inside the posting transaction**. `pg_trgm` for fuzzy/partial, prefix via tsvector; ranking: exact identifier > prefix > trigram > frecency.
- A hit = **entity + entity-actions** (`actionsFor('party')` → Ledger Report, Outstanding, Sales Vouchers, …). Enter = primary action; → expands the rest.
- Query language: auto-detect GSTIN / phone / HSN / voucher number; prefixes `>` `l:` `i:` `v:` `@` `=amount`.
- Context-aware via `SearchContext`. **Field pickers are the same service in constrained mode** — no independent search boxes.
- Results are filtered by RLS and permissions.

## 7. Keyboard and focus

- One `KeyboardManager` (capture-phase listener) normalises to chords (`event.code` for letters, `event.key` for F-keys).
- Scope stack `global < screen < region < overlay`; keymap is data (`chord → commandId` per scope); user overrides from `user_settings`, conflict-checked.
- Components use `useScope()` / `useCommandHandler()`. Lint bans `onKeyDown`, `addEventListener('keydown')`, `keyCode` outside `packages/keyboard` and `apps/web/src/ui`.
- `FormNavigator` (declarative fields, conditional/skipped fields) and `GridNavigator` (Enter on last column adds a row; empty ledger + Enter exits) are pure models; DOM focus follows the model.
- `ScreenStack` handles Esc-back, Alt+C return and focus restore; drafts live in a store outside components and persist to IndexedDB.
- Browser limits are real (Ctrl+N/T/W can't be captured; F5/F6/F7 usually can). Mitigation: installable PWA in standalone mode, startup key self-test, everything remappable.

Defaults: F2 date · F4 Contra · F5 Payment · F6 Receipt · F7 Journal · F8 Sales · F9 Purchase · Alt+G Go To · Alt+C create master ·
Ctrl+A accept · Esc back/cancel · Enter/Tab next · Shift+Tab previous. F4–F9 open a voucher globally and switch type inside a voucher.

## 8. UI hierarchy

```
App → Providers (Session · Company/FY · Services · Keyboard · Command · ScreenStack)
  └ Shell: TopBar · ScreenHost {Gateway, MenuScreen, MasterList/Form, VoucherScreen, ReportScreen, SettingsScreen}
           · ButtonBar · OverlayHost {GoTo, create-master, pickers, confirms} · StatusBar
```
Primitives in `apps/web/src/ui`: KeyField, DateField, AmountField, EntityPicker, Grid (virtualised), Overlay, ListView.
Design tokens in `ui/tokens.css`. URL reflects the base route; overlays live in the in-memory stack.

## 9. Reports and drill-down

`ReportDefinition {id, title, params, fetch, build (pure), drill(row) → Target}`. SQL functions return ledger/item-level rows;
group rollup and presentation are pure domain code. Every row carries a `Target` with the filters, so drill-down is navigation:
**Report → Group → Ledger/Party/Item → Ledger vouchers → Voucher → line details / revisions.** Esc returns to the same row.
Keyset pagination for Day Book / Ledger; rollup table `ledger_monthly_totals` only if benchmarks demand it (a cache, never truth).

Reconciliation invariants tested on every report change: TB Dr = Cr · Assets = Liabilities + P&L · Ledger closing = TB line · Day Book total = ledger movements.

## 10. Phases (dependency order; each has an exit gate)

| # | Phase | Exit gate | Status |
|---|---|---|---|
| 0 | Foundations: monorepo, lint boundaries, CI, tokens | Shell builds; a planted boundary violation fails | **done** |
| 1 | Domain core (no UI/DB): Money, groups, ledgers, VoucherKind, PostingPlan, Journal/Contra/Payment/Receipt rules, in-memory repos + TB oracle | Property tests: valid vouchers balance; post+cancel nets to zero | **done** (ADR-0008) |
| 2 | Database, security, atomic posting: migrations, RLS, roles, deferred Dr=Cr trigger, numbering, audit, RPC, Edge Function, Supabase adapter | Raw SQL can't insert unbalanced voucher; RLS suite; parallel numbering | **done** (ADR-0009) |
| 3 | Command, keyboard, shell: registry, keymap/scopes, ScreenStack, navigators, Gateway, **Alt+G (commands/reports/settings)** | Keyboard-only E2E; keymap override | **done** (ADR-0010) |
| 4 | Masters + search index: schema-driven forms, triggers, Tier-1 cache, Alt+C create-and-return | "ABC" returns multi-entity hits; Alt+C returns id with focus restored | next |
| 5 | Accounting vouchers + first books: VoucherScreen, Contra/Payment/Receipt/Journal, bill allocations, alter/cancel, Day Book, Ledger | Payment → Day Book → Ledger → Voucher, keyboard only | |
| 6 | Books & reports: Cash/Bank Book, TB, P&L, BS, Outstanding, drill everywhere | Reconciliation suite; TB p95 on 1M-row seed | |
| 7 | Inventory, Sales/Purchase, GST: items, stock ledger, valuation, invoices, Credit/Debit notes, Stock Summary, GST registers | Books/stock reconcile; GST fixtures | |
| 8 | Orders & documents: SO/PO, Delivery/Receipt notes, voucher_links, stock journal | Order → delivery → invoice tracking | |
| 9 | Production readiness: year-end close, roles UI, audit viewer, CSV import, print/PDF, restore drill, load tests | Carry-forward reconciles; restore drill | |
| 10+ | Manufacturing (BOM, production, job work) — separate plan | | |

Current shipped vs remaining detail (credit notes, delivery challan, GRN, …): **[product-roadmap.md](product-roadmap.md)**.

## 11. Testing

Vitest + fast-check (domain properties, golden posting fixtures) · shared repository contract suite run against memory and Supabase adapters ·
pgTAP (RLS, unbalanced insert, direct write denied, period lock, concurrent numbering, idempotency) · pure keyboard/focus model tests ·
testing-library for primitives · search relevance fixtures · Playwright keyboard-only flows · scale seed (1M journal lines / 200k vouchers / 50k masters) ·
reconciliation invariants (§9). CI: typecheck, lint, boundaries, unit, DB + contract on ephemeral Supabase, E2E on PR previews.

## 12. Deployment

Local (Supabase CLI) → staging → production, separate Supabase projects; forward-only migrations applied by CI; Vite static build on a CDN host with PWA
service worker; Edge Function bundles `packages/domain`; prefer Mumbai region; PITR backups; app checks `schema_version` at boot;
expand/contract for breaking migrations; Sentry + request-id structured logs.

## 13. Not building now

Payroll, CRM, e-invoicing / e-way bill, banking feeds & reconciliation, cost centres, batch/serial, multi-currency, manufacturing (until Phase 10), job work,
SaaS billing, FIFO/LIFO and perpetual COGS, offline-first sync, mobile apps, plugin marketplace, report designer/scripting, GSTR filing/JSON, AI features, multi-language UI.
