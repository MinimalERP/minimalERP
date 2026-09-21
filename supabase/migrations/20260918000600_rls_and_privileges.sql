-- Row-level security and privileges. This is what makes "the client cannot write the books" true.
--
-- Supabase grants anon / authenticated / service_role full access to new public objects by default
-- (ALTER DEFAULT PRIVILEGES), so we REVOKE everything first and then grant back only what each
-- role needs. Any migration that adds a table must add its RLS policy and grants here-style, and
-- the privilege audit in packages/db-tests fails the build if it forgets.

-- 1. Start closed.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- 2. RLS on every table. service_role bypasses it (BYPASSRLS); nobody else does.
alter table public.companies          enable row level security;
alter table public.app_roles          enable row level security;
alter table public.role_permissions   enable row level security;
alter table public.company_members    enable row level security;
alter table public.financial_years    enable row level security;
alter table public.account_groups     enable row level security;
alter table public.ledgers            enable row level security;
alter table public.voucher_types      enable row level security;
alter table public.numbering_series   enable row level security;
alter table public.vouchers           enable row level security;
alter table public.journal_lines      enable row level security;
alter table public.voucher_revisions  enable row level security;
alter table public.audit_log          enable row level security;

-- 3. Read-only access for signed-in members, gated by permission strings.
--    (No INSERT/UPDATE/DELETE policies exist, and no write privileges are granted below.)
create policy companies_select on public.companies
  for select to authenticated using (private.is_member(id));

create policy members_select on public.company_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.has_permission(company_id, 'company.admin'));

create policy roles_select on public.app_roles
  for select to authenticated using (true);
create policy role_permissions_select on public.role_permissions
  for select to authenticated using (true);

create policy financial_years_select on public.financial_years
  for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy account_groups_select on public.account_groups
  for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy ledgers_select on public.ledgers
  for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy voucher_types_select on public.voucher_types
  for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy numbering_series_select on public.numbering_series
  for select to authenticated using (private.has_permission(company_id, 'master.view'));

create policy vouchers_select on public.vouchers
  for select to authenticated using (private.has_permission(company_id, 'voucher.view'));
create policy voucher_revisions_select on public.voucher_revisions
  for select to authenticated using (private.has_permission(company_id, 'voucher.view'));
create policy journal_lines_select on public.journal_lines
  for select to authenticated using (private.has_permission(company_id, 'report.view'));
create policy audit_log_select on public.audit_log
  for select to authenticated using (private.has_permission(company_id, 'audit.view'));

-- 4. Grants. authenticated: SELECT only. anon: nothing. service_role: full (it is the trusted server).
grant select on
  public.companies, public.app_roles, public.role_permissions, public.company_members,
  public.financial_years, public.account_groups, public.ledgers, public.voucher_types,
  public.numbering_series, public.vouchers, public.journal_lines, public.voucher_revisions,
  public.audit_log
to authenticated;

grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- 5. The write path: functions callable by the trusted server only.
grant execute on function
  public.post_voucher_atomic(uuid, uuid, text, jsonb, jsonb),
  public.alter_voucher_atomic(uuid, uuid, text, uuid, int, jsonb, jsonb),
  public.cancel_voucher_atomic(uuid, uuid, text, uuid, int),
  public.load_masters_json(uuid),
  public.load_ledgers_json(uuid, jsonb),
  public.actor_can(uuid, uuid, text)
to service_role;

-- 6. Helper functions in `private` are for the server and for RLS policies only.
--    (Trigger functions need no EXECUTE grant to fire; the ones the triggers PERFORM do.)
revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function private.has_permission(uuid, text), private.is_member(uuid) to authenticated;

-- 7. Functions created by future migrations must not be executable by everyone by default.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
