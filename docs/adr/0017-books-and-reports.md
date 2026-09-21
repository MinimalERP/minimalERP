# ADR-0017: Books and reports — Trial Balance, Profit & Loss, Balance Sheet, Cash/Bank Book, Outstanding with ageing

Status: accepted (2026-09-26)

## Context
Every voucher already posts to the journal and the stock book, and invoices raise bills, but the accountant could not SEE the books as statements. The
Reports menu had placeholders ("Phase 6") for Trial Balance, Profit & Loss, Balance Sheet, Cash Book, Bank Book and Outstanding. This phase turns the data
into books. Nothing new is entered and there is **no database change**: the browser already reads every journal line, the stock book and the vouchers.

## Decisions
1. **All figures are pure domain functions** (`packages/domain/src/reports/`), read from the journal, the stock book and the vouchers; nothing is stored, so a
   cancellation, a back-dated entry or a receipt is simply what the next read shows.
   - `groupSummary.ts` — `groupRows`: the children of a group (sub-groups rolled up, then ledgers) or the primary groups, each with Opening / Debit /
     Credit / Closing (signed, debit positive). The Trial Balance is the root; a Cash or Bank Book is the same rows restricted to Cash-in-Hand or Bank
     Accounts + Bank OD, ledgers with no entries included.
   - `financials.ts` — `profitAndLoss` (Trading account and Profit & Loss account) and `balanceSheet`. A group's nature and `affectsGrossProfit` decide the
     side and the trading / P&L split. Stock uses the **periodic method** (ADR-0014): opening and closing stock come from the stock book.
   - `outstanding.ts` — `outstandingBills` and `outstandingByParty`.
2. **Two-sided statements, Tally-style.** Profit & Loss: Opening Stock, Purchases, Direct expenses, Gross profit c/d on the left; Sales, Direct income,
   Closing stock on the right; then the Profit & Loss account (Indirect expenses / Net profit against Gross profit b/d and Indirect income). Zero
   "carried" lines are omitted; each side of each section totals the same.
3. **The Balance Sheet balances by construction.** Opening-stock vouchers do not reach a ledger (ADR-0014), so the sheet shows them under Capital as
   **Opening Stock (brought forward)**, and the cumulative profit is `income − expenses + closing stock − opening stock`. Liabilities = assets is a tested
   invariant (including random books with back-dating and cancellations, and two financial years). A profit is a liability (left); a **loss is shown among
   the assets** as Profit & Loss A/c, as Tally does.
4. **Outstanding is aged from the bill's DUE date**, as on a date (today unless F2 changes it): Not yet due · 1–30 · 31–60 · 61–90 · Over 90 days past the
   due date. A party's row also shows **Advance / on account** and **Not in bills** (ledger balance − Σ open bills), so the report always reconciles to the
   ledger. The invoice list's **Overdue** uses the same `daysOverdue` rule (due today is not overdue), so the two never disagree.
5. **Shell, not redesign.** The grid reports (Trial Balance, books, outstanding, bills) are new branches of `ReportScreen` with definitions in
   `reports/booksReports.ts` and `reports/outstandingReports.ts`, on the one `DataGrid` — sortable, filterable, F2, Enter drills, Esc returns to the same
   row. The two statements are one component (`StatementScreen`) drawing left / right tables under the same report chrome; ↑↓ move, ←→ / Tab switch side,
   Enter opens the group behind a line (the Trial Balance one level down; stock lines open the Stock Summary).
6. **Drill-down.** Group → sub-group → ledger → the Ledger report → voucher; party → its bills → the voucher that raised the bill (a bill brought forward
   as an opening balance has no voucher screen, so it opens the party's ledger). Addresses: `#/report/trial-balance[/<group>]`, `#/report/book/cash|bank`,
   `#/report/profit-loss`, `#/report/balance-sheet`, `#/report/outstanding/receivable|payable[/<ledger>]`. Go To offers **Group summary** on an account group.
7. **Commands.** The planned commands keep their ids and become real (`report.trialBalance`, `report.profitAndLoss`, `report.balanceSheet`,
   `report.cashBook`, `report.bankBook`, `report.outstanding` = receivables), plus `report.payables` and the hidden `report.groupSummary`. The Reports menu
   uses `MenuEntry.group`: Statements · Books · Outstanding · Inventory & Sales (GST Reports stays planned, under Tax).

## Consequences
- Existing tests that changed, each because the product changed: the "planned screen" examples that used Trial Balance / Balance Sheet (`keyboard.spec`,
  `services.test`) now use GST Reports, still planned; the Go To title for `debtors` is "Outstanding Receivables"; the planned-command count is lower.
- Report queries run in the browser over the loaded books; server-side (SQL) versions are a later step, as ADR-0005 planned.
- Deferred: GST reports (with the GST slice), purchase registers, bank reconciliation, cost centres, schedules and notes, PDF / Excel export, comparative periods.
