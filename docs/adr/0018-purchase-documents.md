# ADR-0018: Purchase Orders and Purchase Invoices — the buying side, mirrored from Sales

Status: accepted (2026-09-27)

## Context
Sales (ADR-0015) can order, deliver and bill; buying could not: stock came in only through opening stock and the Stock Journal, suppliers were paid
only through Payment vouchers, and Outstanding Payables knew only bills typed by hand. This phase adds the two purchase documents on the same
foundations — the kind registry, the order book, bill-wise allocations, the one item-line window — and no new machinery. No GST (as with Sales; GST is
its own phase over both sides). Decided with the user: scope is the Purchase Order and the Purchase Invoice only; **the supplier's invoice number names
the bill**; **the invoice itself receives the goods** (no separate goods-receipt note).

## Decisions
1. **Two kinds, registered like the Sales ones** (`purchaseOrder`: a document, posts nothing; `purchase`: an invoice). A Purchase Invoice posts
   **Dr the purchase ledger (under Purchase Accounts) / Cr the supplier's ledger** for the total (each line quantity × rate to the paisa), takes every line's
   goods **IN** to its godown at the line's rate (the stock book's average cost moves; periodic method, ADR-0014) and raises **a new bill named by the
   supplier's invoice number** (`billNo`, required) due on `dueDate` (the date plus the supplier's credit days, unless chosen otherwise). Every line
   that names a purchase-order line fills it; receiving more than is pending is refused on that line's quantity, in the words of the purchase side
   ("… pending, you are receiving …"). Nothing is stored on the order: pending is the ordered quantity minus the links against it, as in ADR-0015.
2. **One order book, two sides.** `OrderDoc.side` (`sales` | `purchase`) says whose order it is; the invoice kind that faces it fills it, never the other
   (an invoice naming an order of the other side is refused with `ORDER_REF_INVALID`, in the domain and again in the database). `committedByItem()` counts
   sales orders only — stock spoken for; the new `onOrderByItem()` counts open purchase orders — stock still to come. A link's stock movement must go the
   invoice's way (out for a sale, in for a purchase); `checkPlanInvariants` and the database both enforce it.
3. **The supplier's invoice number is used once per supplier.** `billRefTaken`/`billRefProblems` (domain) refuse a purchase invoice whose number is already a
   bill of that supplier — on any posted voucher (an opening balance, a journal, another purchase invoice); an alteration may keep its own number and a
   cancelled invoice frees its number. The memory backend and the browser preview run the same function; PostgreSQL enforces it authoritatively in
   `sync_bill_allocations` under a per-(ledger, number) advisory lock, so two invoices racing for one number cannot both win (`BILL_REF_IN_USE`).
4. **Bills need no new code**: `allocatedLinesOf` reads a purchase invoice as a credit bill on the vendor ledger, so `openBills`, Outstanding Payables and
   ageing (ADR-0017), the Payment "against bill" offer and the invoice list's Open / Paid / Overdue all work on it as they stand.
5. **One window, four documents — a profile, not a fork.** `docProfile(kind)` (`vouchers/kinds.ts`) holds what differs: the party role and noun, the
   reserved group its ledger lives under and what it is called, the reference label ("Cust PO / ref", "PO / ref", "Supplier ref"), and the verbs
   (delivered / received). The form model and `SalesVoucherScreen` ask it instead of comparing kinds. F9 / Shift+F9 open the purchase invoice and order;
   an invoice and its order switch into each other in place; the other side's keys open a NEW window (replacing a blank one). Choosing a supplier with
   open purchase orders fills the PO / ref with OUR PO number and brings its pending lines in; **Alt+I** on an order makes the invoice for what is pending.
6. **Lists and reports** take the side: Transactions › Purchase (Purchase Vouchers, Purchase Orders, and the still-planned Debit Note), with the supplier's
   invoice number, pending, due and status columns; the **Purchase Order Register** (Reports › Purchase); **On order** on the Stock Summary and the item's
   stock ledger; the Day Book shows the supplier; Purchases fall into the Trading account with no change to the statements.
7. **Database (migration `20260927000100_purchase_phase8.sql`)** adds no table: the two kinds (voucher-type check, permissions, seeded types and numbering
   for existing companies), `assert_order_sound` (either side, matching invoice), `assert_voucher_consistent` (purchase: balanced journal, stock all IN,
   receipts only on it; purchase order: a document), the purchase bill in `sync_bill_allocations`, and the document test in the write functions.
8. **Demo company**: one open Purchase Order to Steel Supplies (MS Sheet 2mm and MS Rod 12mm). It posts nothing, so every money and stock figure is as it was.

## Consequences
- Existing tests that changed, each because the product changed: the Purchase group of Transactions (Purchase Vouchers, Purchase Orders, and the debit
  note still planned) in `voucherLists.spec`/`keyboard.spec`; the planned-command count (four remain: credit and debit notes, GST reports, GST
  configuration) and the Reports menu groups (a Purchase group) in `services.test`/`books.spec`; the seeded voucher types, numbering series and the
  "unknown kind" example in `commands.test` (`creditNote` is now the unknown one); the shortcut editor's list grew (`moveTo` looks further down).
- The Postgres-loaded `content` carries money as decimal text, so `openBills` over vouchers read back from PostgreSQL (server-side reports, later) needs
  the amounts normalised first; the browser and the memory backend hold them as numbers, which is what every report reads today.
- Deferred: GST (both sides), Credit / Debit Notes (returns), Goods Receipt Note, Quotation and Delivery Note, landed cost in stock value, a supplier bill
  date separate from the voucher date, purchase-price history, server-side reports, export / print.
