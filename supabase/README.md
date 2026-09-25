# supabase/

The database and the trusted write path. Decisions: `docs/adr/0009-phase2-database-decisions.md`.

```
migrations/                      forward-only, timestamp-named SQL. Never edit an applied migration.
  …0100_tenancy_and_permissions  companies, members, roles, permission strings, RLS helper functions
  …0200_masters                  financial years, groups, ledgers, voucher types, numbering series
  …0300_vouchers_and_journal     vouchers, journal_lines, voucher_revisions, audit_log
  …0400_integrity_triggers       Dr=Cr (deferred), period lock, identity immutability, append-only
  …0500_posting_functions        post/alter/cancel_voucher_atomic, masters loaders
  …0600_rls_and_privileges       RLS policies; REVOKE-then-GRANT (clients are read-only)
  2026092100…_vouchers_phase5    bill_allocations (mirrored from the voucher by a trigger), party GST registration + address book
  2026092000…_masters_phase4     parties, units, stock groups/items, warehouses, GST rates; master_apply, company_seed,
                                 search_index + search_entities; backstop triggers (ADR-0011)
functions/post-voucher/          the Edge Function (Deno): auth + DB glue around handler.bundle.js (also the daily report: action `digest`)
functions/intake/                the AI Inbox's way in (ADR-0023): reads a sent document with Gemini, queues a proposal. Needs the secrets
                                 GEMINI_API_KEY and GEMINI_MODEL; see integrations/google-apps-script/README.md
functions/dash/                  minimalDASH's one way in for changes (jobs, their mails and parts): names the person, calls dash_apply
                                 (github.com/MinimalERP/minimalDASH; tables dash_*, migration 20261009000100)
tests/support/                   supabase_prelude.sql — TEST ONLY, emulates the Supabase platform
```

## How the write path works

```
browser ── intent (draft) ──► post-voucher Edge Function
                               ├─ authenticate (JWT → user)
                               ├─ domain code: validate + build the posting plan   (packages/domain)
                               └─ post_voucher_atomic()   one transaction: number, voucher, journal, audit
```
Clients cannot write any table or call any posting function. Only `service_role` (the Edge Function) can.
Master data (`action: 'master'`) takes the same road: the domain validates, then `master_apply` commits one row change, bumps
`companies.masters_version` (so two changes checked against the same snapshot cannot both commit) and audits it.

## Working with it

```
pnpm build:functions     bundle domain + adapter-postgres → functions/post-voucher/handler.bundle.js (gitignored)
pnpm test:db             every migration on a real PostgreSQL + all database/security/concurrency tests
```
No Docker needed for tests: they use an embedded PostgreSQL.

### Deploying
The project is linked (`supabase/.temp/linked-project.json`, git-ignored). Note: in this repo the CLI must be run from OUTSIDE the repository
(`npx supabase@latest …` from your home directory, with `--workdir` and `--project-ref`) because `package.json`'s `devEngines` asks for Deno.

```
supabase db push --project-ref <ref>                                    # applies migrations/ (forward-only)
pnpm build:functions
supabase functions deploy post-voucher --project-ref <ref>              # the function serves the writes AND the reads/company actions
supabase functions deploy intake --project-ref <ref>                    # the AI Inbox (ADR-0023)
supabase functions deploy dash --project-ref <ref>                      # minimalDASH's changes
supabase secrets set GEMINI_API_KEY=<key> GEMINI_MODEL=<model> --project-ref <ref>
```
`supabase/config.toml` is created by `supabase init` (needs the Supabase CLI). The function needs no secrets set by hand:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` are provided by the platform.

### Making the site sign-in ready (ADR-0020) — dashboard settings, once
1. **Authentication › Sign In / Providers › Email**: leave *Confirm email* on, and turn **Allow new users to sign up OFF** (invitation only).
2. **Authentication › URL Configuration**: *Site URL* = the site (`https://minimalerp.github.io/minimalERP/`); add it (and `http://localhost:5173/**` for development) to *Redirect URLs*.
   Invitation and reset links come back to these addresses; a link to an address not on the list is refused.
3. **Invite a person**: Authentication › Users › *Invite user*. They follow the emailed link, choose a password, and create their company.
4. The built-in email service allows only a few emails an hour; use a custom SMTP provider (Project Settings › Authentication) before inviting many people.
5. GitHub: repository *variables* `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Settings › Secrets and variables › Actions › Variables). The anon key is public by design;
   never store the service-role key or an access token there.

## Rules for every future migration
- every business table has `company_id`, and every foreign key is composite `(company_id, id)`
- add RLS + a `SELECT` policy + explicit grants in the same change — the privilege audit in `packages/db-tests` fails otherwise
- new SQL functions are executable by `service_role` only unless they are RLS helpers in `private`
- a new voucher kind = a migration adding its `role_permissions` rows and widening `voucher_types.base_kind`
- a new master kind = a table (RLS + grants as above), a domain definition, a row mapper in `adapter-postgres/src/masters.ts`, and (if it
  should be searchable) a branch in `private.index_master`
