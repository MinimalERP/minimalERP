# ADR-0011: Phase 4 — masters, opening balances and universal Alt+G search

Status: accepted (2026-09-20)

## Context
Phase 4 makes every kind of master record creatable, findable and alterable from the keyboard, makes Alt+G a universal
search from ledgers to items, and lets a company start with opening balances. The rule from the start of the project
still holds: **extend the current UI and architecture, do not change them.** Everything below is added through module
manifests, the existing command/keyboard layer, the existing screen stack and the existing posting path.

## Decisions

1. **Master writes have one path, exactly like postings.** `MasterGateway.execute({ companyId, command })` with
   `command = { op: 'create' | 'alter' | 'setActive', kind, id, data? }`. The pure domain function `prepareMasterCommand`
   validates it against a `Masters` snapshot and returns the next snapshot plus a description of the change. The
   in-memory backend applies it; the PostgreSQL backend validates with the *same function* and commits through the
   single SQL function `master_apply`. The browser can therefore preview the same errors the server enforces.

2. **The command id is the idempotency key.** A retried create of an identical record is a replay (nothing changes, the
   caller is told); the same id with different content is refused. Deactivating something already inactive is a no-op.

3. **Rules that matter, and where they live.** Domain (`masters/commands.ts`): a group and a ledger share one name
   pool (Tally's rule); names compare case- and spacing-insensitively; group nature is inherited and locked; a ledger
   with entries keeps its nature; built-in records (the *Opening Balance Difference* ledger, the standard groups, the
   system voucher types) cannot be changed; deactivate instead of delete, and only when nothing active depends on it;
   parent/base-unit cycles are refused; GSTIN (structure, state and check digit), PAN, HSN/SAC, phone and email are
   validated; a numbering series in use cannot restart from another number; a voucher type in use keeps its base kind.
   The database re-enforces the load-bearing ones with triggers (system rows, ledger nature, in-use type/series) and
   CHECK/foreign-key/unique constraints, so a bug or a hand-run statement cannot break them.

4. **Concurrency without a transaction across the network.** `companies.masters_version` is bumped by every master
   change. The server adapter validates against a snapshot, then calls `master_apply(…, expected_version, …)`; if another
   change landed first the database answers `MASTERS_CHANGED` and the adapter reloads and validates again (up to 12
   times, with jitter). Validation and commit therefore behave as if serialised per company: twelve simultaneous
   creates of one name produce exactly one winner and eleven `NAME_TAKEN`; ten unrelated creates all succeed. The trade-off
   is that unrelated changes to one company briefly queue — fine for humans, and a bulk import should be sequential.

5. **One generic write function.** The adapter turns the resulting record into a table row (snake_case columns) and
   `master_apply` upserts it with `jsonb_populate_record`, listing the columns from the catalog. Adding a master kind is
   a table, a row mapper and a domain definition — no new SQL write function. Each change is audited with before and after.

6. **Opening balances are ordinary vouchers.** A new system voucher kind `opening` (one ledger, one side, an amount, dated
   the first day of the financial year) posts its own side and the opposite side to the built-in *Opening Balance
   Difference* ledger, so Dr = Cr holds from day one and the gap between what was entered and a balanced opening is visible
   as that ledger's balance. The voucher id is derived from the ledger id, so asking twice is a replay. Creating a ledger
   with an opening balance is two steps (create, then post); if the second is refused the ledger exists and the form says
   so and lets the user fix it and accept again. (A single "create with opening" transaction was not worth a second
   write path; the two steps are each atomic and idempotent.)

7. **Unit conversions are folded into `units`.** The plan had a separate `unit_conversions` table. A unit may instead be
   defined as a multiple of a base unit (`base_unit_id` + `factor`, e.g. 1 Qtl = 100 Kg), which covers the cases that
   matter (Kg/Qtl/Ton, Nos/Dozen/Gross) with no second table and no cycle problem beyond parent/child.

8. **Master changes reuse the single gateway function** (`post-voucher`, `action: 'master'`) rather than adding a second
   Edge Function. One authentication path, one CORS/error contract, one thing to deploy. (The plan named `master-command`;
   nothing else about the design depends on the name.)

9. **Company onboarding is a seed.** `seedCompany` (pure, deterministic for given ids) produces the chart of accounts,
   *Cash*, the built-in difference ledger, the voucher types with numbering for the first year, GST slabs, common units
   and a main location. `company_seed` writes it in one transaction with the caller as owner. Financial years may run
   April–March or January–December (labelled `2024-25` or `2024`).

10. **Search: one matcher, two tiers.** `searchEntities` (packages/command) is the only entity matcher; Go To reaches it through
    `entityProvider`/a module provider and field pickers call it directly, so a name matches identically everywhere. It
    weighs an exact identifier (code, alias, GSTIN, phone, HSN) above a name prefix above a word inside the name above a
    typo, ranks inactive records lower, and prepares each document once (a 20,000-record company answers in ~50–130 ms).
    Tier 1 is the client-held snapshot (immutable per change, so a new record is searchable the instant it exists). Tier 2
    is the server: `search_index` (trigram indexes) maintained by triggers in the same transaction as the change, and
    `search_entities`, callable by signed-in members under RLS. The browser build uses Tier 1 only until a Supabase project
    exists; the Tier 2 client is a provider away.
    **Prefixes** narrow a query: `@` parties, `l:` ledgers, `i:` items, `u:` units, `w:` warehouses, `g:` groups, `>` commands.
    **Entity actions:** each hit has a primary action (Enter: display) and a list (→: display, alter; later transactions,
    stock ledger). → acts only when the caret is at the end of the text so it never steals caret movement.

11. **Alt+C creates and returns.** In a picker field, Alt+C opens the create form for the kind the field points at
    (`navigateForResult`), pre-filled with what was typed. The form underneath keeps every value in its screen-stack frame,
    so returning restores the draft, focus and the new record chosen. Found by the browser tests: the stack must hand the
    result over *before* it tells the UI to re-render, otherwise the screen rebuilt underneath reads state that does not
    have the result yet (`ScreenStack.pop` now resolves first; covered by a test that fails if the order is swapped).

12. **Demo mode is a real backend.** With no Supabase project, the company lives in the browser: the in-memory backend,
    which enforces every rule, is saved as *the seed plus every change* and replayed on the next visit (numbers and
    balances reproduce exactly). Swapping in a server-backed company is a change to `main.tsx` only. A **Load Demo Company**
    command creates a realistic manufacturer (customers/suppliers with valid GSTINs, steel and fastener items with HSN
    codes, balanced opening balances); *Close Company* deletes the local copy after a confirmation.

## Consequences
- The 862 tests that gated Phase 3 all still pass. The few *assertions* that changed did so because the product legitimately
  grew, and each is small: the master and company-settings commands are no longer "planned" placeholders (the planned-command
  count in `services.test.ts` drops, and that test's module list now includes the masters module); the "exact title finds its
  command" test skips commands that are unavailable right now (no company to close); the one browser test that types "create"
  opens the demo company first (with no company, "create" also offers *Create Company* — the first-run path); the migration
  test lists the new tables and permissions; the function-privilege audit allows `search_entities` (members search under RLS);
  the guard tests get a realistic timeout (each runs the dependency checker over the whole tree).
- Deferred, deliberately: a Supabase-backed `Books` client (sign-in, `search_entities` provider) until a project exists;
  `CommandRegistry.unregisterModule` (needed when voucher types become per-company commands, Phase 5); a group rename does
  not rewrite its ledgers' search subtitles (titles and identifiers, which search matches on, are always current).
- Phase 5 (vouchers screen + report grid) builds on `navigateForResult`, the master pickers and `MasterGateway`.
