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
functions/post-voucher/          the Edge Function (Deno): auth + DB glue around handler.bundle.js
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

### Deploying (not yet done — needs a Supabase project)
```
supabase link --project-ref <ref>
supabase db push                      # applies migrations/
pnpm build:functions
supabase functions deploy post-voucher
```
`supabase/config.toml` is created by `supabase init` (needs the Supabase CLI). The function needs no secrets set by hand:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` are provided by the platform.

## Rules for every future migration
- every business table has `company_id`, and every foreign key is composite `(company_id, id)`
- add RLS + a `SELECT` policy + explicit grants in the same change — the privilege audit in `packages/db-tests` fails otherwise
- new SQL functions are executable by `service_role` only unless they are RLS helpers in `private`
- a new voucher kind = a migration adding its `role_permissions` rows and widening `voucher_types.base_kind`
- a new master kind = a table (RLS + grants as above), a domain definition, a row mapper in `adapter-postgres/src/masters.ts`, and (if it
  should be searchable) a branch in `private.index_master`
