# ADR-0019: GST on Sales and Purchase, GSTR-1 and GSTR-3B reports, and invoice-wise TDS on Receipts

Status: accepted (2026-09-28)

## Context
Sales (ADR-0015) and Purchase (ADR-0018) invoices carried the items alone. This phase adds Goods and Services Tax to both, the two reports a business
needs from it every month (GSTR-1: what we sold; GSTR-3B: the tax position), and the one piece of tax a customer does to us at payment time: TDS deducted
from a receipt. It adds no new machinery — the kind registry, bill-wise allocations, the posting plan and its invariants, the module manifests, the one
grid — and does not redesign anything already built. Decided with the user before coding: GST is a **company switch** (the demo company stays off);
**input GST is never claimed automatically**; the HSN summary reuses the item's HSN; TDS is only ever entered on a Receipt, against a bill; nothing is
submitted to any portal; the Delivery Challan is out of this phase.

## Decisions
1. **A company switch, `Company.chargeGst`** (Company Settings › Charge GST; needs a valid GSTIN). Off, a Sales or Purchase invoice is exactly what it was:
   no column, no tax, no ledger touched — every existing figure, test and the demo company are unchanged. On, each invoice line has a **GST %** (from the
   item's GST Rate master, editable, `0` for nil-rated) and an **HSN** (a snapshot of the item's at the time, so a later change to the item does not
   rewrite a filed month).
2. **Tax is computed once, per rate, half-up to the paisa** (`gst/tax.ts`, pure). An invoice's lines are grouped by rate ("slabs"); each slab's tax is
   `taxable × rate`, and inside the state it is split into **CGST and SGST of half each** (any odd paisa goes to CGST), outside it is **IGST whole**. The
   place of supply decides: for a sale, the customer's state (party details › GSTIN › party state); for a purchase, the company's own state. The
   invoice stores the result as a header `gst { supplyState, placeOfSupply, cgst, sgst, igst }`; the form derives it with the same function
   (`deriveGstHeader`) the engine **re-derives and compares** — a stated figure that is not what the lines come to is refused (`GST_INVALID`), so no client
   can post tax the rules do not produce. Rounding is per rate per invoice, not per line, as returns are filed.
3. **Seven system ledgers, found by reserved key, not by configuration**: Output CGST / SGST / IGST (under Duties & Taxes), Input CGST / SGST / IGST and
   TDS Receivable (under Loans & Advances (Asset)). They are ordinary ledgers to the books (Trial Balance, ledger report, Balance Sheet) with ids derived
   from the company and key, and **locked**: they cannot be renamed, moved or deactivated, which would silently break GST. A new company is seeded with
   them; an **older company gets them by an idempotent ensure step** — in PostgreSQL the migration (adopting an ordinary ledger of the same name that has
   no party, else creating it, once), in the browser's stored companies `ensureSystemLedgers` on open (same rule; it is a no-op when they exist), in the
   memory backend the same function. A hand-made "TDS Receivable" is therefore adopted and becomes locked, never duplicated.
4. **Postings.** A **Sales** invoice: Dr the customer for the total *including* tax, Cr the sales ledger for the taxable value, Cr Output CGST / SGST /
   IGST for the tax. A **Purchase** invoice: Dr the purchase ledger for the taxable value, Dr Input CGST / SGST / IGST for the tax, Cr the supplier for
   the total. The bill (ADR-0017, ADR-0018) is for the **total with tax**, so Outstanding, ageing and the Payment/Receipt "against bill" offer need no change;
   stock still moves at the item value alone (tax is never inventory cost here). The Postgres consistency function checks the same shape.
5. **TDS, only on a Receipt and only against a bill.** A bill allocation on a Receipt may carry a `tds` amount. The bill is settled by the **full
   allocated amount**; the receipt posts **Dr the bank/cash for the amount less the TDS, Dr TDS Receivable for the TDS, Cr the customer for the full
   amount** — for ₹100,000 with ₹2,000 TDS: Dr Bank 98,000, Dr TDS Receivable 2,000, Cr Customer 100,000, and the bill is gone from Outstanding. There is
   no TDS module, no rate table, no return: the TDS Receivable balance is what the customer will have to credit us in the tax return, visible in its
   ledger. TDS on any other voucher, on a new bill or a negative or larger-than-the-allocation figure is refused (`TDS_INVALID`).
6. **GSTR-1 (Reports › GST)** is a report of one month (Financial Year + Month; **F2** changes it; the month is in the address). Rows are per invoice and
   rate with the section (B2B, B2CL, B2CS, Export), the party GSTIN, place of supply, taxable value, CGST/SGST/IGST and invoice value; **Alt+V** switches
   to the **HSN summary** (per HSN, unit and rate, read from the invoice lines' own HSN so it adds up to the invoices; Enter on an HSN lists the invoices
   that carry it). Beneath it the totals are **reconciled to the Output ledgers** for the same period, each with a link to the ledger. Before an export
   it lists what is missing — errors block (company GSTIN or state missing or invalid, a party's invalid or missing GSTIN when registered, an unknown
   place of supply, a line with no GST rate), warnings do not (no HSN on a line, an overseas party) — and **Alt+B** exports the month as structured JSON
   and **Alt+M** the view as CSV; the export only happens when nothing blocks. It is a file the browser saves: nothing is filed anywhere.
7. **GSTR-3B is an internal position report**, not a return to be submitted: outward supplies with their tax, then input tax, then the net. **Input GST is
   never assumed claimable** — the invoices do not say whether a credit is eligible (blocked credits, reverse charge, credit/debit notes and supplier
   filing status are not modelled), so purchase GST appears on its own line **TO REVIEW**, the "eligible" line stays zero, and the net payable claims
   nothing under review; a second line shows what the net would be if every credit under review were eligible. Each line opens the invoices behind it
   (sales in GSTR-1, purchases in a **GST purchase register** on the same screen), and both sides are reconciled to their tax ledgers.
8. **Every figure traces back**: a GSTR-3B line → its invoices → the voucher → its journal lines and the tax ledger; a GSTR-1 row → the voucher; an HSN →
   its invoices; the reconciliation buttons → the ledger report. The reports read the posted vouchers and journal only (`reports/gst.ts`, pure
   functions); they post nothing and write no table.
9. **Web.** The invoice window (same worksheet, same keys) gains a GST % cell after Rate and a tax line under the grid only when the company charges GST;
   the Receipt's bill panel gains a TDS cell on its "against" lines and a "TDS deducted … reaches the bank …" line; the three GST screens are one
   `GstScreen` reached from the Reports menu (new **GST** group; Purchase Order Register moves to Inventory & Sales) with contextual commands
   (`gst.exportJson`, `gst.exportCsv`, `gst.view`) that only exist while it is in front. The planned "GST Reports" and "GST Configuration" rows are gone.
10. **Database (migration `20260928000100_gst_tds_phase9.sql`)** adds one column (`companies.charge_gst`) and no table: the system-ledger backfill,
    `load_masters_json` / `master_apply` / `company_seed` carrying the switch and the ledgers, and `sync_bill_allocations` / the voucher consistency
    check reading GST and TDS. The Postgres adapter re-parses stored content through its kind schema when reading (money is stored as decimal text), so
    reports over Postgres-read vouchers see the same figures as the browser's.

11. **The bill-wise panel serves several invoices, each in part** (Payment and Receipt alike; no domain change — an allocation may be less than the bill's
    pending, and any number of rows may be against different bills). It opens **blank**: one row for the whole amount, no bill chosen, starting on its
    **type list** (Against ref, Advance, On account, New ref — always visible on that field, ↑↓ Enter). For Against ref the reference is a **search box**: it
    opens on typing (or ↓, or Enter on an empty ref), lists only the party's open bills not already named by another row, and Enter takes the highlighted one
    with what it can be settled for. The panel is offered **every time the amount is left** (what was chosen returns as it was while it still adds up; a
    changed amount starts afresh). **Enter walks every field of every row in order**; after the last row it adds another blank row while the line is not
    used up, and otherwise moves on to the next line. **Esc steps back one field** at a time inside the panel (amount → ref → type) and only from its first field leaves it. A row (or a whole line, on every worksheet) is cleared with the **×** at its end, or Ctrl+Delete.
12. **A Receipt is entered as the payment advice reads**: the line and each row hold what was **received**, and the TDS is a separate figure beside the row
    (850 received + 5 TDS settles the bill by 855). The web form translates when it builds the draft (the engine still receives the settled amount plus the
    `tds`, decision 5, so Dr Bank 850, Dr TDS Receivable 5, Cr Customer 855) and back when a stored receipt is shown. Two invoices of 1,500, 1,490 received
    with 5 TDS on each: one line of 1,490, two rows of 745 + TDS 5; each bill has paid 750 and keeps 750 open.

## Consequences
- Existing tests that changed, each because the product changed: the seeded ledger list and counts (seven system ledgers) in the masters/seed tests;
  the permission counts in `migrations.test` (accountant 38, clerk 11, owner 39, viewer 3); the planned-command count (two remain: credit and debit notes),
  the Reports menu groups (a GST group) and the Go To expectations for "gst" (GSTR-1, GSTR-3B, GST Rates instead of the two planned rows) in `services.test`;
  the reported Go To rows and the Purchase Order Register's menu group in `books.spec`.
- A voucher posted while GST was off has no GST header: it is listed in the GST reports as a taxable value with no tax, and GSTR-1 flags a line with no
  rate on a company that charges GST. Turning the switch on does not rewrite history.
- The "locked" system ledgers mean an accountant cannot deactivate `Input IGST` even when never used. That is the intent.
- Deferred: Credit / Debit Notes (and their GST adjustment), reverse charge, blocked-credit and eligibility rules (so GSTR-3B input stays "to review"),
  cess and TCS, e-invoice / e-way bill, GSTR-2B reconciliation, composition dealers, GSTR-1 tables for amendments and advances, TDS payable / TDS
  returns, portal submission, the Delivery Challan.
