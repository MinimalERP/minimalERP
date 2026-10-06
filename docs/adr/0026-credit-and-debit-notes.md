# ADR-0026: Credit Notes and Debit Notes — an invoice taken back

Status: accepted (2026-10-06)

## Context
Sales (ADR-0015), Purchase (ADR-0018) and GST (ADR-0019) left one hole in the day-to-day books: an invoice could be raised, altered or cancelled,
but not *taken back in part* — goods a customer returns, goods sent back to a supplier, a price reduced after the bill. Until now that was a
Journal by hand (no stock, no GST in the returns). The two kinds were planned from the start (`voucher.new.creditNote` / `voucher.new.debitNote`,
architecture §5: "reversal of Sales / Purchase; stock in / out") and were the last thing keeping the books from replacing Zoho Books. This phase
adds them on the foundations already there — the kind registry, the one item-line window, bill-wise allocations, the GST header — and no new table.

## Decisions
1. **Two kinds, each an invoice turned round** (`creditNote`: sales side, `CN/` series, Transactions › Sales; `debitNote`: purchase side, `DN/`
   series, Transactions › Purchase). A **Credit Note** posts the exact reverse of a Sales Invoice — Dr the sales ledger for the items, Dr Output
   CGST / SGST / IGST for the tax, Cr the customer for the total (rounded like an invoice; Round Off reversed too). A **Debit Note** posts the exact
   reverse of a Purchase Invoice — Dr the supplier, Cr the purchase ledger, Cr Input CGST / SGST / IGST. The posting rules are the invoices' own,
   flipped (`vouchers/kinds/notes.ts`), so the two can never drift apart. GST is derived and re-checked exactly as on the invoice of that side.
2. **A note is of the lines it names**, like an invoice: a stock item moves stock, a service item or a written (one-time) line does not. So a
   return is item lines, and a rate difference, a discount or a shortage claim is a written line — one voucher covers both, with no "type of
   note" switch. A note line is never against an order or a challan (a return does not re-open an order line: the order was delivered).
3. **Stock.** A credit note brings each stock line back **IN** to its godown; a debit note takes it **OUT** (refused when the godown does not
   hold it). Goods coming back from a customer are valued **at the book's own cost on that day** (`StockBook.costOf`: the running weighted
   average; when none are left, the cost the last of them went out at) — never at the selling rate — so a return does not move the average
   cost. Goods going back to a supplier leave at the book's average, as every Out does (periodic method, ADR-0014).
4. **Which invoice, and the bill.** A note may name the invoice it is for (`invoiceRef`: our invoice number on a credit note, the supplier's
   on a debit note) and state how much of it is **set against that invoice's bill** (`against`, never more than the note). That part settles the
   invoice's bill (an `against` allocation, on the other side of the party's ledger); **the rest is a bill of the note's own**, named by the
   note's number — a credit the customer holds (or a debit the supplier owes) until it is refunded or used. Nothing is stored that can be
   derived: the split is read from the note (`noteSettlementOf`), by the browser, the memory backend and the SQL bill mirror alike. The window
   fills `against` with what the named invoice still has open (its own earlier share counted as open on an alteration), so a note for an
   unpaid invoice reduces it and a note for a paid one stands as a credit.
5. **Refunds and later use need no new code.** The note's own bill sits on the opposite side of the party's ledger, so the existing bill-wise
   panel offers it where it belongs: a Payment to the customer (F5 on the credit note fills it in) or a Receipt from the supplier (F6 on the debit
   note) *against* the note's number is the refund; Outstanding already counts such bills as money in the party's favour. Using an open
   credit on a later invoice is an alteration of the note: name that invoice in *Against inv.*
6. **One window.** `docProfile` gains `note` and `goodsOut`; the note is the invoice worksheet without what only an invoice has (due date,
   E-way bill, order column, Paid from) and with **Against inv.** — a picker of that party's invoices with what is open on each, or any text.
   **Alt+Shift+R** on a posted Sales invoice makes its credit note (on a Purchase invoice its debit note) with the invoice's lines, to be cut down
   to what came back. Lists: Credit Notes / Debit Notes with *Against inv.*, the open credit and Open / Applied. They print ("Credit Note",
   "Against Inv.") and are emailed with their own templates.
7. **GST reports.** `gstInvoices` reads a note as an invoice whose every figure is **negative** (`note: true`), so GSTR-1's totals, the HSN
   summary, the B2CS summary, GSTR-3B's outward and input figures and the reconciliation with the tax ledgers net them without special cases.
   GSTR-1 places a credit note where the portal wants it: **CDNR** (Table 9B) for a registered customer; **CDNUR** for an unregistered one whose
   invoice was reported on its own (inter-state above ₹2,50,000 — the original invoice's value decides, when the books hold it); otherwise it
   nets the **B2CS** summary of its own month. Table 13 lists the credit-note series as nature 5. GSTR-2B matching and the ITC follow-up are of
   invoices only and leave notes out. GSTR-3B still claims no input tax by itself (ADR-0019): debit notes reduce the figure *to review*.
8. **Database (migration `20261027000100_credit_debit_notes.sql`)** adds no table: the two kinds (voucher-type check, permissions for owner,
   accountant, member and clerk-post, seeded types and `CN/` / `DN/` numbering for existing companies), the stock direction of each in
   `assert_voucher_consistent`, and a note's two rows in `sync_bill_allocations`.

## Consequences
- Existing tests that changed, each because the product changed: the seeded voucher types and series and the "unknown kind" example in
  `commands.test` (`receiptNote` is now the unknown one); the permission counts in `migrations.test` (owner 56, accountant 55, member 55, clerk 17);
  the planned commands (one remains: the Receipt Note) and the Purchase group in `services.test`; the planned-command example in `keyboard.spec` and
  the Transactions groups in `voucherLists.spec`.
- A credit note's stock value is fixed when it is posted (it is a stored movement, like every In). Back-dating a purchase before it afterwards does
  not re-price the return — the same as any posted receipt.
- The quantity returned is not checked against the invoice line by line: a note may credit more than the invoice it names sold (the surplus
  simply stands as an open credit). The link is by number, as in a ledger, not by line.
- Deferred: line-level return tracking against the invoice, a supplier's own credit note number and date on a debit note (GSTR-2B's CDNR),
  credit notes for exports (shipping-bill details, as for export invoices), TCS/cess, e-invoice IRNs for notes, amendments of filed notes
  (CDNRA), and importing Zoho credit notes (`migrate-zoho` brings invoices and receipts).
