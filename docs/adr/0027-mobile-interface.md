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

## Stage 2: touch entry of the selling side's documents
Sales Invoice, Sales Order, Quotation and Delivery Challan are entered on the phone (`mobile/EntryScreen.tsx`, `mobile/entry.ts`); every
other voucher is still entered on the desktop.
1. **The form is the desktop's.** The page fills a `SalesForm`, `previewSales` builds the draft and judges it with the engine the server
   runs, and `books.post` / `books.alter` send it. Totals, GST, due dates, the godown a line leaves and every refusal come from
   `vouchers/salesModel.ts`; `entry.ts` only says what a new document and a tapped item START as. Nothing can be posted from the phone that
   the desktop could not post, and the server decides both.
2. **One page, the document itself** — not a wizard: the customer, the lines, the details, with the total and Save fixed at the bottom
   under the thumb. The customer and "Add item" open a full-screen list that filters as you type (an item shows its stock); a tapped item
   becomes a line of ONE, at the rate this customer last paid (else anyone), with its GST and from the godown that holds it, and its sheet
   opens for the quantity (− / + and a number pad). The usual invoice is: customer, item, Done, Save.
3. **Back is the phone's.** It closes the list or the sheet first, then the page (`MobileNav.openLayer` / `swapLayer`). A new document is
   kept as a draft on the device as it is typed (`books.saveDraft`), so leaving — a call, the app closed — loses nothing: it is there on
   return, with "Start again". Only what has no draft (altering a posted document, one started from an order or a party) asks "Discard?".
4. **Engine refusals are said at once** on the line they belong to (not enough stock, more than the order has pending); what is merely not
   filled in yet is said when Save is tapped, where it is missing.
5. **From what is already there**: "+ New" at the foot of the four lists and on the Gateway; "+ New invoice / order" on a customer's page;
   "Invoice pending" on an open Sales Order and "Invoice this" on a challan still to be billed (the desktop's `invoiceFormFromOrder` /
   `invoiceFormFromChallan`); "Edit" on a posted document of the four kinds (a quotation already made into an order stays as it was).
6. Not on the phone yet: one-time (written) lines, choosing another party address, order-line picking on an invoice typed from scratch,
   cancelling, emailing — all still in the desktop version.

## Stage 3: Scan, purchase bills, reports
1. **Scan** (`mobile/ScanScreen.tsx`, `mobile/scan.ts`) is the AI Inbox for a thumb, under a plainer name: Take photo / Choose file → "What
   is it?" → `books.sendDocument`; what was read waits in a list (`books.inbox`), re-checked while a document is being read. A tap opens
   it in the touch entry page filled by the desktop's own `salesFormFromProposal`, posted under the item's id (so only once); a long
   press throws it away (`books.rejectInbox`). What the reader could not match stays in the document's words: an unmatched party or line
   opens its list searched for those words, and "+ Create" starts from what the document printed (`partySeedOf`, `itemSeedOf`). Receipt
   and Payment advices are listed and completed on the desktop. A document shared to the app arrives at Scan (`mobile/mount.tsx` reads the
   `#/inbox` address); the rule that sent a phone to the desktop inbox for it is gone. The Gateway's "waiting" figure is what was last
   known, refreshed in the background at most once a minute — never a request in the way of drawing the Gateway.
2. **Purchase bills by touch**: the entry page is side-driven by `docProfile` — supplier, purchase ledger, a required supplier invoice
   number (a repeat is refused by the engine's `billRefProblems`), goods received into the main godown, the rate this supplier last
   charged. An open Purchase Order has "Bill received". "Paid from" stays on the desktop.
3. **Ship to** on a customer's document: the party's billing address, its own shipping address and its saved addresses; the place of
   supply follows where the goods go, exactly as the desktop's Party Details does, and the engine works the GST out from that.
4. **Reports** (`mobile/ReportsScreen.tsx`): the Sales and Purchase Order Registers (the desktop's `orderRegisterRows`; Pending / All,
   earliest due first), Receivable, Payable, the Day Book. Order lists carry the customer's PO beside the number. The Stock list has tabs:
   All / Committed / On order.
5. **Stock Journal** (`mobile/StockJournalScreen.tsx`): "+ Out" / "+ In" lines on the desktop's `StockForm`, judged by `previewStock`;
   listed under Transactions › Inventory and shown as what moved. Creating only.
6. Still to come: Receipt / Payment entry on the phone; the rule-based on-device bill reader (standard GST bills read without the AI,
   AI as the fallback).

## Stage 4: copies, and the Android app
1. **Print asks which copies** (`mobile/PrintSheet.tsx`, `mobile/print.ts`): "Print / PDF" on a document opens a sheet with the desktop's
   own list (`COPY_COUNT_OPTIONS`: 1–4 copies, or Duplicate / Triplicate / Extra Copy alone), ticked at what this phone printed last.
   **Print** is the desktop's `PrintCoordinator`; **Share PDF** and **Save PDF** are the desktop's `pdfOf` with the same labels — so a
   phone's Duplicate is the desk's Duplicate. Nothing about a page is decided in mobile code.
2. **Share PDF** leaves through the Android app's share sheet (`shareFile` on the bridge, `ui/nativeApp.ts`), or a browser's own file
   sharing where it has one. The bridge is feature-tested, not versioned: an app built before sharing shows "update the app" and still
   prints and saves. A browser that will not send a file drawn seconds after the tap keeps it, and the next tap sends it.
3. **The Android app** (`apps/android`) stays one Activity and one provider, no libraries. Added: `shareFile` (the PDF is written to the
   app's cache and read through `CaptureProvider` with a one-off grant); a plain "No connection" page with Try again, retried by itself
   when the network returns, in place of the browser's error page; icon shortcuts **Scan** and **New** (`#/inbox`, `#/new`, read by
   `mobile/mount.tsx`); "Open with MinimalERP" on a PDF, which arrives at Scan like a shared one.
4. **A test build before release**: `.github/workflows/android.yml` run by hand on a branch publishes a pre-release APK (never "latest"),
   so the app is checked on a real phone before the merge that publishes it to everyone.

## Consequences
- The existing phone tests of the DESKTOP app (`e2e/mobile.spec`, the assistant's phone test) now ask for `?ui=desktop`: a touch phone no
  longer gets the desktop shell by itself. Nothing else in the desktop suite changed.
- A phone user who needs something only the desktop has (purchases, receipts, masters, GST reports) uses "Desktop version"; the choice sticks
  until they switch back.
- The Android app shows this interface (it is a WebView on the site), and is the way a PDF reaches WhatsApp from a phone.
