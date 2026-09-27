# MinimalERP — product roadmap

Living status of **what ships today** vs **what the original phase plan still owes**. Structural cleanup (layouts, report registry) is tracked in [adr/0024-structural-refinement.md](adr/0024-structural-refinement.md). New product scope needs an ADR before schema or posting rules change.

## Shipped (you can use this now)

| Area | What works |
|------|------------|
| Core posting | Payment, Receipt, Contra, Journal; alter/cancel; bill-wise allocations; period lock |
| Masters + Go To | Parties (with ledgers), ledgers, stock items, godowns, GST rates, Alt+C create-and-return |
| Books & reports | Day Book, Ledger, Cash/Bank Book, Trial Balance, P&L, Balance Sheet, Outstanding (aged), Stock Summary / Stock Ledger |
| Sales | Sales Order, Sales Invoice (F8 / Shift+F8), order register, invoice against order lines, Alt+I invoice pending |
| Purchase | Purchase Order, Purchase Invoice (F9 / Shift+F9), supplier bill number, PO register, on-order on stock |
| Inventory | Stock Journal (F10), weighted-average stock, opening stock vouchers |
| GST | Charge GST company flag, invoice tax lines, GSTR-1 / GSTR-3B reports, TDS on receipts |
| Online | Invite-only Supabase books, Edge Function posting (ADR-0020) |
| Automation | AI Inbox (Gemini + Gmail panel, ADR-0023), CSV import/export screen |

**Important today:** a **sales invoice is the delivery** (stock out + billing in one voucher). A **purchase invoice is the receipt** (stock in + supplier bill). A **Delivery Challan** (`deliveryChallan`, Alt+F8, `DC/` series) sends goods out without a bill — purpose *Sale – invoice later* or *Free of cost*; stock out, no journal. A sales invoice bills challan lines without moving stock again. A **Returnable Challan** (`returnableChallan`, Transactions › Purchase, `RC/` series) sends goods to a supplier; *Mark returned* posts its return (same lines back in). There is **no GRN voucher yet** (ADR-0018, deferred).

## Remaining — original architecture phases

From [architecture.md](architecture.md) §10 (dependency order). Phases 0–3 and most of 4–9 are **partially or fully done**; the table below is the **honest remainder**.

| Phase | Theme | Still to build | Exit gate (unchanged) |
|-------|--------|----------------|------------------------|
| **7** (tail) | Inventory & GST | **Credit Note**, **Debit Note** (sales/purchase returns; reverse stock + tax) | Returns post correctly; GST registers include them |
| **8** (tail) | Orders & documents | **Delivery Note / Delivery Challan** (stock out, often before invoice), **Goods Receipt Note** (stock in before purchase bill), optional **Quotation** | Order → challan/GRN → invoice tracking; `voucher_links` already exist for invoice↔order |
| **9** | Production readiness | Year-end close UI, roles admin, audit viewer, print/PDF polish, server-side reports, load tests, backup restore drill | Carry-forward reconciles; restore drill |
| **10+** | Manufacturing | BOM, production orders, job work (separate plan) | Per manufacturing ADR when scoped |

## Delivery challan & GRN (what “Phase 8 tail” means)

**Delivery Note / Delivery Challan (sales)**

- **Purpose:** dispatch goods against a Sales Order (or ad hoc) **without** raising the customer bill yet — typical manufacturing / dispatch workflow.
- **Posting:** stock **out** only (like architecture’s “Delivery note” row: journal **no**, stock **yes**). Links to order lines (reuse order book + `voucher_links` patterns from invoices).
- **Shipped (stage 1):** base kind `deliveryChallan` on the `ItemInvoiceEntry` worksheet, command `voucher.new.deliveryChallan` (Alt+F8), Transactions › Inventory › Delivery Challans, print ("Delivery Challan", "– Free of Cost"), email template. Purpose `sale` or `foc` on the voucher, one number series.
- **Shipped (stage 2):** a Sales Invoice line may bill a challan line (`challanRef`): it moves no stock; pending = sent − invoiced, derived (`orders/challanBook.ts`, carried on the `OrderBook`). Cust PO / ref and Against order / DC pickers offer pending challans; Alt+I on a challan invoices what is pending; the list reads To invoice / Part invoiced / Invoiced / FOC; the invoice prints DC No. An FOC challan is never invoiced; an invoiced challan cannot be cancelled or cut below what was billed (domain + deferred trigger `vouchers_challan_sound`).
- **Returnable Challan:** goods to a supplier that come back as they went; *Mark returned* posts a return (`returnOf`) of the same type bringing the same lines back — once (unique index `vouchers_one_return_per_challan`). Job work (other items back, scrap, labour bills) was deliberately left out.
- **Not in scope of first cut:** e-invoice, e-way bill generation (architecture §13).

**Goods Receipt Note (purchase)**

- **Purpose:** record physical receipt **before** the supplier’s tax invoice — GRN → later Purchase Invoice.
- **Posting:** stock **in** only; link to PO lines (mirror of delivery note).
- **Today:** ADR-0018 explicitly deferred GRN; purchase invoice receives goods in one step.

**Quotations**

- Shipped: document-only quotation (`quotation` base kind), customer + item lines + optional valid-until and GST on the quote; Transactions › Quotations.

## Other deferred items (from ADRs / architecture §13)

- Landed cost in stock valuation; purchase price history; supplier bill date ≠ voucher date  
- Server-side report SQL (browser reads books today)  
- GSTR JSON **filing** to portal (export exists; submission does not)  
- Bank reconciliation, cost centres, batch/serial, multi-currency  
- Payroll, CRM, plugin marketplace, report designer  
- Manufacturing (Phase 10+) until scoped  

## How planned features appear in the app before they exist

`apps/web/src/modules/roadmap.ts` registers **planned commands** (same ids forever): Gateway, Transactions menu, Go To, and shortcut editor show them with a **Phase** badge; they open a short “planned” screen until a module **replaces** the entry with the real command (same id). When delivery challan ships, it follows the same pattern as Sales Invoice replacing its planned stub.

## Suggested build order (after structural ADR-0024)

1. **Credit / Debit Note** — extends existing invoice kinds and GST; commands already stubbed.  
2. **Delivery Note (challan)** — new kind, stock-out, order links; then optional split “invoice without stock” if you want invoice-only billing after challan.  
3. **Goods Receipt Note** — new kind, stock-in, PO links; then optional “purchase invoice without stock” for bill-only.  
4. **Quotation** — document kind, no posting.  
5. Phase **9** hardening (roles, year-end, server reports).  

Each step: domain kind + migration + `ItemInvoiceEntry`/new layout + `modules/vouchers.ts` + lists/registers + testkit contract + e2e keyboard path.
