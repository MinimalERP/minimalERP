# ADR-0012: Phase 5 — the voucher window, bill-wise details, party details and the report grid

Status: accepted (2026-09-21)

## Context
Phase 5 turns the engine into something a person enters data with and reads the books through: one voucher window for every
voucher type, switched on the existing bottom bar; bill-wise details captured for the later outstanding/ageing report; a
Party Details window that keeps addresses out of the entry form; and one report grid (Day Book, Ledger) that is sortable and
filterable by construction. As always: **extend the current UI and architecture, do not change them.**

## Decisions

1. **One voucher screen, driven by the kind's layout.** `single-entry` (Payment/Receipt/Contra: an account plus particulars,
   total derived) and `double-entry` (Journal: *By/To* with Debit and Credit columns, live balance check) are two layouts of the
   same window. The form is plain strings (so it survives being covered by another screen and can be saved as a draft); a pure
   model (`apps/web/src/vouchers/model.ts`) turns it into the draft the engine takes, previews it with the **same
   `prepareVoucher` the server runs**, and puts every problem on the exact field (`lines.2.amount` → line 3's amount, counting
   only the lines actually sent). Pickers offer only what the engine would accept (cash/bank for an account and for a contra, never
   cash/bank in a journal, never the built-in difference ledger).

2. **Type switching is on the bottom bar, by scoped bindings.** F4–F7 open a new voucher from anywhere (as before); inside a
   voucher the same keys are bound in the `screen:voucher` scope to `voucher.switch.*`, whose status-bar hints appear only there.
   Switching keeps date, narration, lines and party details; across layouts the cash/bank account cannot come along and the user is
   told. `ScreenStack.replaceTop` changes the screen's identity (address, breadcrumb) while keeping its frame and draft. Keys that
   only make sense in one mode (switch: creating; Alt+A: displaying; Alt+X: an existing posted voucher) are registered only then,
   so the bar never offers a key that would do nothing.

3. **Entry is a keyboard flow, not a form.** Enter/Tab next, Shift+Tab back, Enter on an empty last ledger ends the lines (→ narration),
   Enter on the narration accepts, Ctrl+A accepts from anywhere, F2 edits the date (`10`, `10-5`, `10-5-24`; a bare day-and-month
   means the year of the financial year it falls in), Alt+C creates the missing ledger and returns with the draft intact. Errors are
   shown only after an attempt to accept. After a save the window clears for the next voucher, keeping type, date and account. A
   half-entered voucher is kept per type in the browser and restored after a reload. The layout follows the Tally sheet the user showed
   (a compact header with the type tag, number and date; particulars with each ledger's current balance beneath it; narration and
   the actions at the foot), in our own tokens.

4. **Bill-wise details are captured on the voucher and mirrored by the database.** A party line can be split into *new* (reference,
   due date defaulting from the party's credit days), *against* an open bill, *advance* or *on account*; the parts must add up to the
   line, and only customer/supplier ledgers may carry them. They are part of the voucher's content (so posting, replay, alter and
   cancel treat them like any other field) and a trigger mirrors them into `bill_allocations` in the same transaction — the mirror
   cannot disagree with the voucher, and nothing else writes it. `openBills` derives what is still pending from posted vouchers, and the
   bill panel prefills a sensible breakdown (oldest-due bills first, the rest on account or as a new bill). **Deliberately not yet
   enforced server-side:** that an *against* reference names a bill that exists and is not overpaid — that needs the whole history and
   arrives with the outstanding report (Phase 7); today the picker offers only real bills.

5. **Party details are a snapshot, in their own window.** Alt+P (or automatically, for sales/purchase documents in Phase 6b) opens a
   modal window prefilled from the party: mailing name, billing address, state, GST registration, GSTIN, ship-to (same as billing, a
   saved address, or entered by hand), place of supply. Everything can be changed for this voucher only. The voucher stores a copy, so
   editing the party later never rewrites a posted voucher. GSTIN (checksum, state match), state codes and the party link are validated
   by the engine. A manual address can be saved into the party's **address book** (`parties.addresses`), and the party gains a GST
   registration type. The party form itself does not edit the address book (the window is where addresses are added), and altering the
   profile keeps the saved addresses.

6. **A report is a definition; the grid is generic.** `ColumnSpec` (id, label, type, sortable, filterable, value, text) plus rows; `applyGridQuery`
   filters (contains / range / in / notIn / quick) then sorts (stable, nulls last, multi-key) and treats the column list as a
   **whitelist** — a query naming an unknown or forbidden column is ignored. Property tests: never adds or loses a row, filters commute,
   idempotent, sorted per the column. Keys: Tab/Shift+Tab or ←/→ pick a column (← → only when the quick filter is empty, so they still move
   its caret), Alt+S sorts (asc → desc → off), Alt+L filters the column (choice, text or range dialog), Alt+K clears, Alt+T filters by
   voucher type, F2 changes the period, Enter opens the voucher and Esc returns to the same row **in the same view** (sort, filters and period
   live in the screen-stack frame). Chrome keys are avoided (Alt+F, Alt+D). Sorting and filtering run in the browser over the loaded books;
   compiling the same whitelisted query to SQL with keyset paging is deferred until a server-backed company exists — the definitions
   do not change when it does. The view is not written into the address (only the report and ledger are).

7. **Day Book and Ledger are pure functions of vouchers and journal lines.** `dayBookRows` and `ledgerStatement` (opening = everything before the
   period, one row per voucher touching the ledger, running balance, debit positive). Tests reconcile every ledger's statement with the
   trial-balance oracle over the whole year and over a sub-period, for a hand-built history and for random ones.

8. **The Ledger's voucher-type filter is a display filter.** `statementView` chooses which rows to show; the running balance on a shown row is
   still the ledger's **true** balance after that voucher, opening and closing are the ledger's own, and the footer adds a *Filtered total*.
   The types come from the company's voucher types, not a hard-coded list, so Sales, Purchase… appear when they exist. The same filter is on
   the Day Book. Tested: any selection shows exactly its rows; the types partition the totals; balances equal the unfiltered statement.

9. **Go To reaches vouchers.** `v:` finds by number, narration, particulars or amount (unscoped queries include vouchers only when the text
   looks like a number or a voucher number); each hit offers Display and Alter; a ledger hit gains *Ledger report*.

## Consequences
- All Phase 0–4 tests still pass. Changes to existing assertions: the planned-command count (fewer commands are placeholders); the
  function-key test helper recognises the real voucher screen; the shortcut-list e2e helper looks further down a longer list; the
  palette e2e expects the extra *Ledger report* action; Playwright allows one retry and a 10 s expectation timeout because many tests
  now load the demo company at once (a real bug fails every time, a slow moment does not). Loading the demo company reloads the screens once at the end
  (`Books.bulk`) instead of after every one of its ~50 changes.
- Deferred: server-side sort/filter/keyset paging; against-bill existence/overpayment enforcement; the address book in the Party form; the
  view (sort/filters) in the address; per-company custom voucher types as switch keys (they reach the screen by id, not yet by key).
- Phase 6a builds the Stock Journal on the two-column window, and 6b the sales documents (party details required, due date per line) on the
  same screen and the same bar.
