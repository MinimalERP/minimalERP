# ADR-0023: The AI Inbox, a Gmail "Send to ERP" panel, and a daily report

Status: accepted (2026-09-24)

## Context
The user wanted to connect MinimalERP to Gemini through their Google Workspace:
- enter their most-used vouchers from documents that arrive by mail: a customer's PO becomes a Sales Order, a supplier's bill a Purchase
  Invoice, plus Sales Invoices, Receipts and Payments;
- get a daily report by mail (to them only), including **every due item with its due date and customer PO**.

They set four constraints:
- **They choose each mail.** Nothing watches the mailbox.
- **Nothing is stored that does not have to be.** No PDFs, no raw readings.
- **An item the ERP does not know is never guessed.** The line keeps a short text from the mail, and the person selects an item or creates one.
- **The free Gemini plan.**

## Decisions
1. **AI only proposes; a person posts.** A document becomes a *proposal*, never a voucher.
   - The proposal waits in the **AI Inbox** (Transactions › AI Inbox). Enter opens it in the ordinary voucher window, pre-filled.
   - Ctrl+A posts it through the unchanged `post-voucher` path, with the same validation, permissions and audit. Alt+X (pressed twice) on the inbox rejects it.
   - The Posting Engine invariant ("the UI never manipulates balances") is untouched.
2. **A proposal is not a draft.** `Proposal` (`packages/domain/src/intake/proposal.ts`) lets a line be only the document's words, with no item.
   - The voucher window puts those words in the item cell (`itemLabel` with no `itemId`). The picker searches them, and Alt+C creates the item seeded with the name, HSN, GST rate and unit.
   - An unknown party works the same way, seeded with its name, GSTIN and address.
   - The engine refuses a line without an item, so words can never be posted.
3. **Matching is cautious and pure** (`packages/domain/src/intake/match.ts`, `propose.ts`).
   - A party is matched by GSTIN, then exact name, then a fuzzy name only if clearly best. The role (customer or vendor) must fit.
   - An item is matched by code, then name or alias, then a fuzzy name within the same HSN.
   - Anything less is left for the person, with a note. The notes also flag:
     - a customer PO already entered;
     - a supplier bill number already used;
     - a UTR already in a voucher;
     - totals that disagree with the lines;
     - bills that are not open;
     - money left unallocated.
4. **What is kept, and for how long** (migration `20261001000100_ai_inbox.sql`).
   - `inbox_items` holds the proposal, the mail's subject and sender, and who sent it. Nothing else.
   - Accepting posts the voucher under the item's own id, and a trigger deletes the row in the same transaction. Posting twice only replays.
   - Rejecting deletes it, leaving one audit line (who, kind, subject).
   - The document goes to Gemini inside the request and is never written anywhere. The `intake` function never logs the body.
5. **Who may do what.**
   - A new role, `automation`, is for the add-on's own sign-in. It has `inbox.submit`, `master.view`, `voucher.view` and `report.view`, and no `voucher.*.post`.
   - Rejecting needs the permission to post that kind.
   - The inbox is readable by `voucher.view` under RLS.
6. **Gemini runs on the server, on the free tier** (`packages/adapter-gemini`, the `intake` Edge Function).
   - The key (`GEMINI_API_KEY`) and model (`GEMINI_MODEL`) are Supabase secrets. They never reach the browser or the add-on.
   - The model is a secret because models get renamed.
   - One call with a response schema, at temperature 0.
   - Free-tier limits (HTTP 429) become "try again in a minute".
   - Free-tier data may be used by Google. This is documented where the key is set up, and a paid key changes nothing in the code.
7. **The Gmail side is an Apps Script add-on** (`integrations/google-apps-script`).
   - It asks for the open message only (`gmail.addons.current.message.readonly`), not the mailbox.
   - It cannot label mails without full modify access. So "already sent" is remembered in the person's own Google user properties, not in the ERP, and sending again asks first.
8. **The daily report is a pure domain function** (`dailyDigest` in `packages/domain/src/reports/digest.ts`).
   - It is built from the same reports the screens show.
   - It is served by the `digest` action of `post-voucher`, and mailed at 8 by an Apps Script trigger to `REPORT_TO` only.
   - Due customer order lines are listed each with due date, customer PO, customer, item, pending quantity and order number, late ones marked.
   - The same lines go to a "Due items" sheet tab; the other figures go to a "Daily" tab.

## Not done (yet)
- An **Upload** button in the AI Inbox (for documents that do not come by mail). `intake` already accepts the owner's and accountant's own sign-in; only the screen's button is missing.
- An end-to-end browser test of the AI Inbox. The model, the database and the handlers are tested; the screen was typechecked and linted.
