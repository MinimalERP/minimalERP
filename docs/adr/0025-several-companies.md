# ADR-0025: Several companies per account, one extra user per company, documents between companies

Status: in progress (2026-09-26). Built in steps; each section below is added when its step lands.

## Context
The owner runs five businesses and wants them all in one sign-in: switch between them from the top bar, give each business one extra
person who sees that business and nothing else, send documents from one of their companies to another through the ERP, keep Gmail and
the other integrations separate per company, and give each company its own print layout. The database was multi-company from the start
(every row carries `company_id`; access is `company_members` + `role_permissions`); what held it to one company was the server's refusal
in `company-create` and the browser always opening the first company. This replaces ADR-0020 decision 4 ("one company per account").

## Step 1: several companies, switched from the top bar
1. **Who may create a company.** Anyone with no company yet (onboarding, as before), and anyone who owns at least one. Someone who belongs
   to companies but owns none of them (a person given access to one) is refused: "Only the owner of the books can create a company".
2. **`companies` answers `{ id, name, role }`** and takes an optional `companyId`: with `fresh`, the books sent along are that company's
   (else the first's), so opening the remembered company is still one request.
3. **The browser opens the company opened last on this device** (`localStorage`, `minimalerp-company-<userId>`, read and written in
   try/catch; without it the first company opens). It is a convenience, not a record: the server decides what may be opened.
4. **Switching** is `BooksFactory.open` + `BooksHost.switchTo`, which adopts the other company's books; every screen of the company
   before is closed (back to the Gateway). The top bar's company name is the switcher's button, **Alt+F3** and Go To "Switch Company" open
   it, and Create Company is offered while a company is open. Half-entered vouchers were already kept per company.
5. **The books kept in the browser stay one company** (no `open`/`companies` on the local factory, so no switcher).

## Step 2: one extra person per company
1. **A new role, `member`: everything the owner may do except `company.admin`.** Posting, altering and cancelling every voucher kind,
   masters, reports, the inbox, email, settings. They cannot give anyone access, and (step 1) cannot create companies. The migration
   copies the owner's permissions; every later migration that gives the owner a permission gives it to `member` too, and a test holds the
   two together.
2. **The account is made in Supabase, not by the ERP** (the owner's choice): *Authentication › Users › Add user* with a password the owner
   hands over. The ERP only links it: *Utilities › Company User* (owner only) takes the email, and `company_member_set` looks it up in
   `auth.users` (through `private.user_by_email`, SECURITY DEFINER, server only). No invitation mail is sent.
3. **One person, one company.** Setting another email replaces the company's member; a blank one removes them. An account that already
   belongs to any other company, or already has its own role in this one (the owner), is refused. Every change is an `audit_log` line
   (`company.member`).
4. **Isolation is the existing rule, not a new one**: every read and change asks `actor_can` for the company named, and row-level security
   does the same; a member simply has no row for any other company. `company-member.test.ts` proves it action by action.
5. **What the member sees in the browser**: their one company, without the switcher, Create Company or Company User.

## Step 3a: each company emails from its own Gmail
1. **The Gmail script is the company's, not the project's.** `company_mail_scripts` (one row per company: the script's `/exec` address and
   its secret) replaces the project-wide `MAIL_SCRIPT_URL` / `MAIL_SCRIPT_SECRET`. `send-mail` uses the voucher's company's script and
   nothing else; a company without one is told to set it up. There is no fallback, so one business's mail can never leave from another's
   Gmail. (The old project secrets are no longer read and can be unset.)
2. **Set by the owner** in *Utilities › Company Gmail* (`company.admin`): the address must be a `https://script.google.com/macros/s/…/exec`
   web app (so the server only ever calls Google); the secret is written, never shown or answered back — a blank secret keeps the one set
   before. Row-level security shows the row to `company.admin` only, not to the company's extra person. Changes are audited, without the secret.
3. **The Gmail add-on and the daily report never guess the company.** A sign-in with several companies must name one (`COMPANY_ID`),
   or `intake` and `digest` refuse. The README recommends one add-on sign-in and one script copy per business.
4. Gemini stays one key for the project: it keeps nothing, and each document is read for the company it was sent to.

## Step 3b: Send via ERP between the owner's companies
1. **One button, one rule for where it goes.** *Send via ERP* (Alt+Shift+S, panel "Send via ERP") on a posted Purchase Order, Sales Invoice
   or Payment sends it to the company whose GSTIN is the voucher's party's GSTIN — among the companies that share an owner with this one,
   and only those (`exchange_targets`). No picker and no guessing: no such company, or two with one GSTIN, is a refusal that says so.
2. **The owner keeps each company's parties by hand.** Each company has the others as parties, with their GSTINs, like any customer or
   supplier. The ERP never creates a party, item or ledger in another company's books.
3. **What travels is a reading, matched on arrival** (`outgoingOf` in `packages/domain/src/intake/exchange.ts`). Our voucher becomes an
   `Extraction` — our company's name and GSTIN as the party, items by code, name and HSN, quantities, rates, numbers — and the receiver's
   inbox proposal is made from it by `proposeFromExtraction` against the RECEIVER's masters, on the server: the same cautious matching the
   AI Inbox uses. Our PO → their Sales Order (our PO number is their customer PO); our Sales Invoice → their Purchase (our number is their
   supplier's invoice number); our Payment → their Receipt (against the invoices it settles, by their numbers). The sender never sees the
   receiver's masters.
4. **Status.** `exchange_documents` records each sending, keyed by the inbox item's id. Accepting (posting it, under that id) marks it
   `accepted` with the number it got there, in the same transaction (the existing accept trigger); rejecting marks it `rejected` with the
   reason. A voucher is sent once unless it was rejected. *Transactions › Sent to Companies* lists them. Both companies can read the row
   (row-level security), nothing more of each other.
5. **Who may send**: whoever may post that kind of voucher in the sending company.

## Step 4: a print layout per company
1. **Simple HTML, per company, edited in the app** (*Utilities › Print Layouts*): one layout for invoices and orders and one for Payment /
   Receipt / Contra / Journal, or one for a single voucher kind (which wins over its shape's). Left empty, the built-in layout prints.
   "Start from the built-in layout" loads today's layout as editable HTML; the preview fills it with the newest voucher it would print.
   A drag-and-drop editor can come later on the same stored layouts.
2. **Placeholders, not a program** (`renderTemplate` in `packages/domain/src/print/template.ts`): `{{name}}` (always HTML-escaped),
   `{{#list}}…{{/list}}` (repeat), `{{#x}}…{{/x}}` / `{{^x}}…{{/x}}` (shown when present / absent). The data is the `PrintDoc` the screen
   already built, formatted as the built-in layout prints it (`layoutData` in `apps/web/src/ui/printTemplate.ts`): a layout arranges
   figures, it never computes one.
3. **Safe to show.** The filled HTML is cleaned (`cleanLayoutHtml`: no scripts, frames, forms, `on…` handlers, outside links or pictures,
   `@import` / `url()`), and rendered in a shadow root inside the same framed print copy, so its styles cannot reach the app. A layout that
   cannot be read prints the built-in one.
4. **Kept per company** in `company_print_layouts` (templates and the logo / signature as small data-URL pictures, checked in SQL), read
   by anyone who sees the company's vouchers and changed by whoever may change its masters. Loaded with the books when the company opens.
   The books kept in the browser only print the built-in layout. Stock journals, dispatch dockets and reports keep the built-in one.
