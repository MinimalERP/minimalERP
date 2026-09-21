# ADR-0014: Phase 6a — the stock ledger, the Stock Journal, opening stock and the stock reports

Status: accepted (2026-09-23)

## Context
Masters already hold stock items, units and godowns; nothing yet moved stock. Phase 6a adds the movements and the first voucher that makes them
(the Stock Journal — Debit = stock in, Credit = stock out, **no accounting effect**), opening stock, and the two reports that let a person check
what they entered (Stock Summary, Item ledger). Sales, Purchase and their documents (6b) build on it. As always: extend the architecture and the
UI, do not replace them.

## Decisions

1. **Stock is written only by posting a voucher, in the same step as the voucher** — exactly like the journal. `PostingPlan` is now
   `{ journal, stock }`; a stock voucher has stock and **no journal lines**, an accounting voucher has a journal and no stock. The "at least two
   balanced journal lines" rule therefore depends on the voucher's kind, in the domain (`checkPlanInvariants`) and in the database
   (`assert_voucher_consistent`). Two new base kinds: `stockJournal` (a user kind, F10) and `stockOpening` (system, like `opening`).
2. **Valuation is a moving weighted average per item, derived at read time, never stored** (refines ADR-0003). Only what an In brought in is stored
   (`value` = quantity × rate, to the paisa); an Out is valued by reading the ordered movements — the running value times its share of the running
   quantity, as an exact fraction, so there is no rate rounding to drift. For every item and period **closing value = opening value + value in −
   value out**, exactly. Order: date; Ins before Outs within a day; then voucher id; then line — total and deterministic, so the answer never depends
   on the order things were entered. A back-dated entry, an alteration or a cancellation just changes what the next read returns.
3. **Stock never goes below zero, in any godown, on any day.** The check covers the whole timeline: a new Out is checked against the day it is
   dated, a back-dated Out against the Outs after it, and altering or cancelling an In is refused if later Outs depend on it. It runs in the domain
   (`StockBook.shortfalls`, with a message naming the item, the godown and the shortfall, placed on the quantity cell) and again in the database:
   a deferred constraint trigger takes a per-item advisory lock and re-derives every godown's running quantity, so two concurrent stock-outs cannot
   both win. (A per-company "allow negative stock" switch is deferred.)
4. **Quantities are `numeric(18,4)`**, held as a bigint of ten-thousandths (`Qty`) and shown with the unit's decimals and Indian grouping; a rate is a
   money-per-unit with four places (`Rate`). Both travel in drafts and on the wire as canonical text ("10.0000") — JSON has no bigint, and a draft is
   stored exactly as posted — so "10" and "10.0" are one voucher (idempotency). Quantity is entered in the item's own unit; alternate units are later.
5. **The Stock Journal is the same worksheet** (compact header, grid under it, narration at the foot, actions in the panel) with Particulars | Godown |
   Qty | Rate | Value and a side per line: In (Debit) or Out (Credit). An In takes a rate (prefilled with what the stock costs now; 0 allowed for a free
   issue); an Out takes none — its rate and value are shown live from the stock. The window is its own screen (`StockVoucherScreen`) sharing the
   worksheet classes, the panel, the Esc order and the leave question with the accounting voucher, so the accounting screen was not touched by it.
6. **Opening stock is posted by the item form** (create only: quantity, rate, godown — the main one when left blank) as the item's own opening-stock
   voucher, id derived from the item and godown so asking twice is a replay, dated the first day of the year. Like an accounting opening balance it
   reaches the books through the stock reports, not a ledger (periodic method): the trial balance is unchanged.
7. **The reports are definitions on the one grid.** Stock Summary (Opening | Inward | Outward | Closing quantity, rate and value per item, for a period)
   and the Item ledger (every movement with the item's true running quantity and value) are pure functions of the stock book, on `ColumnSpec` /
   `applyGridQuery` / `DataGrid` — sortable and filterable by construction, the period on F2, Enter drills (summary → item ledger → voucher) and Esc
   returns to the same row. The Day Book lists Stock Journals (by item, no amounts) but not opening-stock vouchers, which the stock reports show.
8. **Database:** `stock_movements` (composite foreign keys; an In has a value, an Out none; read-only to clients, readable with `report.view`), period
   lock like the journal, the kind-aware voucher consistency, the negative-stock trigger, and `post/alter/cancel_voucher_atomic` carrying the stock in
   the same transaction. Existing companies are backfilled with the two voucher types and their numbering. Permission names use the base kind
   (`voucher.stockJournal.post`), so the name pattern now allows capitals; a clerk may post stock journals, not alter or cancel them.

## Consequences
- Existing tests that changed, each because the product legitimately grew: the seed has two more voucher types and series; `PostingPlan` has `stock`;
  the migration tests list `stock_movements` and the new permissions; the Day Book counts include the demo's two stock journals; the accounting
  arbitraries in the testkit are scoped to the accounting kinds.
- Values are derived, so the Stock Summary is O(movements of the item); it is fast at these sizes and is where an index or a materialised view would go
  if it ever is not.
- Deferred: Sales/Purchase and their stock effect (6b); GST on items; godown-detail valuation; batches and serials; an "allow negative" switch; alternate
  units; FIFO/LIFO; a stock-item unit change guard once it has movements.
