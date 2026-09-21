# ADR-0016: Transactions grouped by area, a list per voucher type, and a create window that closes back

Status: accepted (2026-09-25)

## Context
The Transactions menu was a flat list of "New … Voucher" rows. People work with a *kind* of voucher — look at the recent ones, open one, make another —
so the entry point should be the list, with New on it, and creating should return to it. No domain or database change: this is shell and reports.

## Decisions
1. **One grouped screen.** Gateway › Transactions shows headed groups — Sales, Purchase, Inventory, General — each with its voucher types as rows
   (the F-key of the voucher it creates on the row). Generic: `MenuEntry.group`, `registry.menuItems()`, and `MenuScreen` drawing one list per group
   under a single keyboard cursor. Planned vouchers (Purchase, Credit/Debit Note) sit in their groups with their phase badges.
2. **A list per voucher type is a report definition on the one grid** (`reports/voucherLists.ts`, address `#/report/vouchers/<kind>`): one row per voucher,
   newest first, sortable and filterable, Enter opens it, Esc returns to the same row. Each kind lists what it is about: an invoice its customer, Cust PO,
   amount, what is still pending, the due date; a payment its ledgers and amount; a stock journal its items.
3. **One overall status word per voucher**, not the line-by-line story (that stays in the Sales Order Register and the stock reports): a sales order is
   **Open** (nothing delivered), **Partially filled** or **Closed** (delivered in full, or closed by hand); an invoice is **Open** (not yet paid),
   **Paid** (its bill — named by its number — is settled by receipts) or **Overdue** (unpaid past its due date); cancelled vouchers are struck out.
4. **Creating closes back.** New on a list (panel button, or the same F-key while the list is in front) opens the create window ON TOP with
   `navigateForResult`; **Ctrl+A saves and closes** the window back to wherever it was opened from — a list, the Gateway — handing over
   `{ id, number, typeName }`; a list shows "Sales SAL/26-27/0004 saved." and puts the cursor on the new row. **Alt+N is Save and new** (the previous
   behaviour: saved banner, blank form) for rapid entry. Enter on the narration accepts like Ctrl+A. Altering already closed on accept.
5. **Panel buttons that belong to one screen** among many of the same type (`New Sales Voucher` on the Sales list only) are declared with
   `hideWhenUnavailable`: shown only while that list supplies them, never greyed on every other report.

## Consequences
- Existing tests that changed, each because the product changed: the Transactions menu rows are lists (`Sales Vouchers` …) not "New …"; every browser test
  that saved with Ctrl+A / Enter and then read the "saved." banner in the same window now uses Alt+N (Save and new), and the Accept click test asserts the
  window closes back; the shortcut list has the new list/`Save & new` commands.
- Deferred: lists for Purchase, Quotation, Delivery Note as they are built; per-type saved layouts; totals beyond count and amount.
