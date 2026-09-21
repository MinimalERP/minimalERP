# ADR-0015: Phase 6b — Sales Orders, Sales Invoices, order tracking and the Sales Order Register

Status: accepted (2026-09-24)

## Context
Phase 6a gave stock a ledger. Phase 6b sells it: a Sales Order (what a customer asked for, a due date on every line, the customer's PO number)
and a Sales Invoice (goods delivered and billed, each line optionally against an order line), with the fill status of every order line and a
register that shows it. Quotation, Delivery Note, GST and the purchase side follow; they reuse everything here. As always: extend the
architecture and the UI, do not replace them.

## Decisions

1. **A Sales Order is a document, not a posting.** It writes nothing to the journal and nothing to the stock. `PostingPlan` is now
   `{ journal, stock, links }`; a plan may be journal-only, stock-only, both (an invoice) or empty (a document). The kind declares
   `document: true`, the engine then expects an empty plan, and the database repeats it (`assert_voucher_consistent` is kind-aware).
2. **What has been delivered is DERIVED, never stored.** An invoice line that names an order line is a *delivery* (`voucher_links`, written by
   the posting function in the same transaction as the invoice's journal and stock). The `OrderBook` (domain, like the `StockBook`) reads
   posted orders and their deliveries and answers pending, filled, open, closed and committed-per-item. Cancelling an invoice removes its
   deliveries, so the order simply reopens. Order lines carry stable ids so an alteration cannot orphan a delivery.
3. **Over-delivery is blocked**, on the exact cell ("8 Nos pending, you are delivering 10 Nos"): in the kind's validation, and again in
   the database by a deferred constraint trigger that takes a per-order advisory lock — two invoices racing for one order line cannot both
   win. An order with deliveries cannot be cancelled, lose a delivered line, change its item or party, or shrink below what was delivered
   (`OrderHasDeliveries`), by any route.
4. **An order is Open until every line is delivered or it is closed by hand** (an alteration with `closed`, versioned and audited like any
   other). Only an open order commits stock: *committed* = the pending quantity on the lines of all open orders; *available* = closing − committed.
5. **The invoice's customer line is a NEW BILL named by the invoice's own number** (known only once it is posted, so derived by `openBills` and
   by the `sync_bill_allocations` trigger, never stored in the draft), due on the invoice's due date (date + the party's credit days unless
   chosen otherwise). The Outstanding reports (Phase 7) will find it with no further work. No GST yet: totals are quantity × rate per line.
6. **One window for both documents** (`SalesVoucherScreen`, the third layout beside accounting and stock): the same worksheet, panel, Esc
   order and leave question. F8 / Shift+F8 (or the panel) switch between the two in place, keeping customer, PO, party details and lines.
   Crossing to an accounting voucher opens a new window (a blank one is replaced). A pure model (`salesModel`) builds the draft and previews
   with the SAME engine against the company's stock and orders, placing every problem on its cell.
7. **Cust PO is a working field.** Choosing a customer with open orders fills the PO from the one due first; choosing a PO (from the
   customer's open orders) brings the REMAINING lines of that order onto the invoice, in the godown that holds the goods; *Alt+O* picks the
   order line for one item; *Alt+I* on an order opens a new invoice for everything still pending on it. Every line has a × to take it out.
8. **The Sales Order Register is a definition on the one grid**: one row per order line (order no, PO, party, item, due, ordered,
   delivered, pending, Fill `12/18`, status), sortable and filterable by construction; an open order's still-open line is bold, a delivered
   line plain, a closed order muted; overdue lines say so. Go To on a stock item offers *Sales orders* (the same register for that item).
   The Stock Summary gains Committed and Available; an item's Stock ledger lists its sales orders (with fill status) beside its movements, and
   ends with current, committed and available stock.
9. **Every list opens newest first** (Day Book, ledgers, stock ledger, the register); the running balances are worked out oldest first, so
   they stay true. A column sort replaces it; clearing the sort returns to it.
10. **Database:** `voucher_links` (composite foreign keys; each delivery sits on the stock-out of the same invoice line; read-only to clients),
    kind-aware voucher consistency, the per-order soundness trigger (also fired by a direct update of the order), `post/alter_voucher_atomic`
    carrying links (seven and nine arguments), backfill of the two voucher types and their numbering (`SAL/…`, `SO/…`) for existing
    companies, permissions `voucher.sales.*` and `voucher.salesOrder.*` (a clerk may post both, not alter or cancel).

## Also in this slice (asked for while building it)
- A × in the title bar of every creation window closes it exactly as the panel's Close does (a window with entries still asks "Close and
  leave?"); clicking blank space deactivates the active field; the bottom bar's hints and dialog footers are clickable buttons; the voucher-type
  filter's choices are buttons drawn like the panel's.
- The item picker matches a hyphenated code ("14188-1") — the word matcher could not put such a code back together, so it found nothing.
  Stock lines start in the godown that holds the goods, say where the stock is, and a "not enough" names the godown that has it.

## Consequences
- Existing tests that changed, each because the product legitimately grew: the seed has two more voucher types and series; `PostingPlan` has
  `links`; the migration tests list `voucher_links`, the permissions and the new function arities; the demo company has three orders and two
  invoices, so Day Book counts, stock totals and the stock ledger's rows changed; F8 is real (no "Phase 7" badge); lists open newest first;
  the panel tests count the window's × as its one button; the Stock Summary keeps an ordered item that has no stock.
- Deferred: GST on invoices, discounts, Quotation, Delivery Note (order → delivery → invoice), Purchase Order/Bill, Credit/Debit Notes,
  printing, per-line manual close, reopening a closed order from the window.
