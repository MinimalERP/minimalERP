# ADR-0022: Invoice / PDF Settings, and Print for vouchers and reports

Status: accepted (2026-09-22)

## Context
Vouchers and reports had no way to produce a paper or PDF copy. The ask, from the user, was deliberately narrow: use the browser's own
Print (Save-as-PDF is then just what that dialog offers) — no new dependency, no logo or letterhead, a plain monospace/tabular "dot-matrix
invoice" look — with a copy-count picker (1–4: Original / Duplicate / Triplicate / Extra Copy) so one Print action produces every copy,
labelled, in one pass. A hand-built sample (a mock Sales Invoice) was reviewed and iterated on directly with the user before any of this
was wired into the real app — the printed structure below is that approved design, not a fresh one.

## Decisions
1. **No new dependency, no server change.** Printing is `window.print()` plus CSS. A hidden `#print-root` (`apps/web/src/ui/PrintView.tsx`,
   `apps/web/src/ui/print.css`) is shown only under `@media print`, which also hides the rest of the app (`.shell`). No PDF library, no
   Supabase migration, no Edge Function change for this half of the work.
2. **Every printed figure is one the screen already computed.** `PrintView` never recomputes a GST split, a total or a stock value — each
   voucher screen builds its own `PrintDoc` from the exact numbers already on screen (`previewSales`'s `amounts`/`total`/`gst`/`grand` for
   Sales/Purchase, `previewStock`'s `values` for the Stock Journal, the posted voucher's own journal lines for Payment/Receipt/Contra/
   Journal, and a report's own `columns`/`rows` — never `DataGrid`'s windowed 160-row DOM, which does not hold every row of a long report).
3. **Four document shapes, one component.** `PrintView` renders `LedgerDoc` (Dr/Cr particulars — Payment/Receipt/Contra/Journal/Opening),
   `InvoiceDoc` (Bill To/Ship To, an item table, GST, totals, amount in words, bank details, a signature line — Sales/Purchase, order or
   invoice), `StockDoc` (item/godown/qty, no GST or signature — an internal movement, not a customer document), and `ReportDoc` (a plain
   table of whatever the screen is showing). A voucher kind that isn't one of these does not yet print; nothing else changed for it.
4. **Copies are for a document sent to someone; a report only ever prints one, unlabelled page**, since "Original/Duplicate" makes no sense
   for a Day Book. `voucher.print` (Ctrl+P, panel "Print") opens a copy-count dialog (`ChooseOneDialog`, already used elsewhere — no new
   dialog component was needed); `report.print` (Ctrl+P) prints straight away. Both share `apps/web/src/ui/printing.ts`'s two small hooks.
5. **The mounted print copies are never torn down right after `window.print()` returns.** `#print-root` stays invisible on screen either
   way (the `display: none` rule outside `@media print`), and `window.print()` is not guaranteed to block until the dialog closes on every
   platform — unmounting on its return risked racing the browser's own capture of the page. They are simply left in place until the next
   Print overwrites them, or the screen itself unmounts.
6. **Invoice / PDF Settings — new, company-level, fixed content**: phone, email, four bank fields, a thank-you note, and terms text
   (`apps/web/src/screens/InvoiceSettingsScreen.tsx`), reached from its own place under Utilities & Settings — separate from Company
   Settings (name/GSTIN/state/address), since it is edited far less often and is about how documents look, not who the company is. Stored
   as eight new nullable columns on `companies` (`supabase/migrations/20260929000100_invoice_settings.sql`), new optional fields on the
   domain `Company` type, threaded through `load_masters_json`, `master_apply`'s hand-written company update, and `masterRecordToRow`'s
   company case (company alone bypasses the generic per-table upsert every other master kind uses — widening it meant touching the row
   mapper too, not just the domain type). Every field is optional and blank by default: a field left empty is left off the printed
   document entirely, never shown empty or with a stray label.
7. **Everything transaction-specific keeps coming from the database** — party, items, quantities, amounts, dates, GST figures — only this
   fixed, company-level content is edited from the new screen.

## Consequences
- A report's print is deliberately simple: title, period, active filters as plain text, the full data table, a row count. It does not
  reproduce every report kind's own special footer totals (trial balance's debit/credit sum, etc.) — a plain table was judged enough for
  "very simple," and can be extended per report kind later if wanted.
- `Ctrl+P` is bound in both the voucher and report keyboard scopes; it is not among the handful of browser shortcuts that truly cannot be
  captured (unlike Ctrl+N/T/W), but the panel's "Print" button is the reliable primary path regardless — the shortcut is a convenience.
- Pinned by `e2e/print.spec.ts` (the dialog, the copy count and labels, one `window.print()` call per action, a report prints every row
  the screen shows, Invoice/PDF Settings fields persist and show on the next print, and a blank one is left off) and
  `packages/db-tests/src/masters.db.test.ts` (the new company fields: who may set them, that they round-trip, that blank stays blank).
