# ADR-0020: The books live online; sign-in is by invitation only

Status: accepted (2026-09-21)

## Context
Until now the deployed site kept the company in the browser (a backend that enforces every rule, saved to IndexedDB), while the Supabase database, the
`post-voucher` Edge Function and a browser adapter for posting existed but nothing connected them. The site is to become a real, online ERP. Decided with
the user before coding: **fully online** (the company is stored in Supabase, not in the browser), **sign-in with email**, **invitation only** (no public
sign-up), **each account has its own company**, and the companies people already made in their browsers are **discarded** (not migrated).

## Decisions
1. **One writer, one reader: the `post-voucher` Edge Function.** It already validated and committed every change. It now also answers the reads the browser
   needs — `companies`, `company-create`, `load` (the masters as JSON), `vouchers`, `voucher`, `lines`, `stock` — so the browser never touches a table
   directly. What a person may see is decided in one place, next to what they may change. The function's reads run as the service role (they bypass
   row-level security), so **every read first asks `actor_can(actor, company, permission)`** (`master.view`, `voucher.view`, `report.view`) and answers a
   non-member exactly as it answers a company that does not exist. `cloud.test.ts` and `cloud.roundtrip.test.ts` pin this.
2. **The browser rebuilds the same `Masters` the server has.** The JSON→`Masters` code moved from `adapter-postgres` into `packages/domain/src/masters/rows.ts`;
   vouchers, journal lines and stock movements use the existing wire mappers. A voucher's content crosses the wire with money as decimal strings and is read back
   through its kind's own schema, so the screens see the bigint money they always did. `SupabaseBooksBackend` (in `adapter-supabase`) is that backend;
   `createCloudFactory` (in the web app) is the `BooksFactory` that opens the account's company.
3. **Invitation only.** Public sign-up is switched off in the Supabase project (Authentication › Sign In / Providers › *Allow new users to sign up* off);
   the app has no sign-up screen and `AuthGateway` has no `signUp`. A person arrives by the emailed invitation link, is signed in by it, and is asked to choose
   a password (`SetPassword`); the same screen serves a password-reset link. "Forgot password" answers identically whether or not the address has an account.
4. **One company per account**, enforced by the server (`company-create` refuses a second). It seeds the chart of accounts with the domain's `seedCompany`,
   using ids the server makes, and `company_seed` makes the caller its owner. Validation (`newCompanyIssues`) moved into the domain so the browser (to point at
   the field) and the server (which trusts nothing) apply the same rules. Sharing one company between several people is possible later (the database already
   has members and roles) but is not built.
5. **The build decides where the books live.** With `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` the app is online and renders nothing but the sign-in
   until someone is signed in; with neither (development, and the CI browser tests) the books live in the browser as before. One without the other is an error,
   not a quiet fallback, and the Pages workflow refuses to deploy without both. Online, "Close Company" (which deletes a local copy) and "Load Demo Company" (which
   would fill real books with make-believe) are not offered.
6. **Secrets.** The anon key is public by design and is a repository *variable*. The service-role key never leaves the Edge Function's environment and must never
   be given a `VITE_` name, because Vite publishes those.
7. **"Use without signing in" (added the same day, at the user's request).** The sign-in page offers the browser-only books: the same backend and IndexedDB store the
   app used before it went online, so a company someone already made in this browser is still there. The choice is remembered on the device (`auth/mode.ts`);
   the top bar then shows "This browser only" and a **Sign in** button (and Go To finds "Sign In"), and signing in makes the online books the ones in use again.
   The two never mix and nothing is uploaded or migrated. This relaxes decision 3: **invitation-only governs the online books** (an account, a company stored
   in Supabase, other people's access to it), not use of the app itself, which anyone who opens the site may now do with books that live only in their own browser.
   Those books are not backed up or shared, and clearing the site's data deletes them; the button says so.

## Consequences
- The browser holds no copy of the company: closing the tab loses nothing, and there is nothing to sync. Half-entered vouchers still wait in IndexedDB, per person.
- Every screen action is now a network request. `Books` reloads masters, vouchers, journal and stock after a change (three parallel reads); a single
  "snapshot" read is the obvious optimisation if that is slow.
- Reads that fail throw (the ports return plain values); the sign-in flow shows "could not open your books, try again" for the initial open, and other failures
  are logged. Better in-app handling of a dropped connection is not done.
- Invitation emails and their links depend on the project's **Site URL** and **Redirect URLs** including the site's address, and the built-in email service is
  rate-limited; a custom SMTP provider is the usual next step.
