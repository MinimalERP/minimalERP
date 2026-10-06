# ADR-0027: A mobile interface — a second root over the same books

Status: in progress (2026-10-06). Built in stages; each section is added when its stage lands.

## Context
The app is keyboard-first: one keyboard layer, scopes, a command registry, a worksheet. On a phone none of that can be reached, and the
phone support so far was the desktop worksheet squeezed down (cards for rows, floating keys). The owner wants to look things up and enter
the everyday sales documents from a phone — simply, by touch — **without the desktop app changing at all**, and wants the Android app to
show the same thing.

## Decisions
1. **Two roots, one of everything else.** `main.tsx` opens the books exactly as before and then mounts either the desktop `Shell` or
   `mobile/MobileApp` — the single branch in existing desktop code (plus one "Mobile version" command in `modules/core.ts`). The mobile
   root is loaded with a dynamic `import()`: a desktop never downloads it, and a phone never starts the keyboard manager, the router or the
   command registry. Everything mobile lives in `apps/web/src/mobile/`, and every style rule under `.m-app`.
2. **Which interface** (`mobile/device.ts`, pure and tested), in this order: `?ui=mobile|desktop` in the address → the choice saved on the
   device (`localStorage minimalerp.ui`) → a phone (`(pointer: coarse) and (max-width: 820px)`) → desktop. An address that names one is
   remembered. "Desktop version" (mobile › Utilities) and "Mobile version" (desktop › Utilities, on touch devices) switch. Tablets and
   touch laptops stay on the desktop app unless asked.
3. **No accounting in the mobile code.** Its screens are views over the functions the desktop reports already use (`mobile/data.ts`):
   Outstanding (`partyRows`, `billRows`, `partyTotals`), the Stock Summary and item ledger, the voucher lists (`voucherListRows`), the daily
   digest, the GST invoice reading for sales figures, and — for a document — the form model's own `salesFormFromVoucher` + `previewSales`,
   so an invoice's total and tax on the phone are computed by the same engine that posted it. A test holds mobile figures equal to the
   desktop's.
4. **The interface is never the security boundary.** It draws what `Books` returns and asks `Books` to act; permissions, period locks and
   every posting rule are enforced where they always were — the Edge Function and the database (ADR-0002, ADR-0020). Hiding a button on a
   phone protects nothing and is not relied on.
5. **It moves like the desktop**: a Gateway of plain rows (Transactions, Parties, Stock, Utilities) with the day's figures above them and
   one Go-to box; a row opens a menu or a list, a row of that the record; Back — the phone's own, or the bar's — returns step by step
   (each page opened is a history entry). Lists filter as you type. Rows are at least 56px tall; nothing needs a hover or a key.

## Stage 1 (this change): the shell and look-up
Gateway (sales today / this month, receivable with overdue, payable, orders to deliver), Transactions (every voucher list, grouped as on the
desktop), a document (an item document with its lines, GST and bill status; any other voucher with what it posted), Parties and a party
(balance, open bills with ageing, documents, Call / WhatsApp / Email), Stock and an item (quantity, free after orders, godowns, movements),
Receivable / Payable by party, Utilities (switch company, Desktop version, sign out), Print / PDF of an item document (one Original, through
the existing `PrintView`).

## Consequences
- The existing phone tests of the DESKTOP app (`e2e/mobile.spec`, the assistant's phone test) now ask for `?ui=desktop`: a touch phone no
  longer gets the desktop shell by itself. Nothing else in the desktop suite changed.
- A phone user who needs something only the desktop has (purchases, receipts, masters, GST reports) uses "Desktop version"; the choice sticks
  until they switch back.
- Still to come: stage 2 — touch entry of Sales Invoice, Sales Order, Quotation and Delivery Challan on the same form model
  (`vouchers/salesModel.ts`); stage 3 — the Android app (it already shows this interface, being a WebView on the site): share a PDF through
  the share sheet, status-bar colour, a new APK.
