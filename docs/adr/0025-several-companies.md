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
