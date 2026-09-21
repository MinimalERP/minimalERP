-- Tenancy, roles and permissions.
--
-- Security model in one paragraph: every business row carries company_id; access is decided by
-- company membership + a role's permission strings (data, not code). The `private` schema holds
-- helper functions that are NOT exposed through the API. Clients never write the books directly —
-- see 20260918000600 for privileges and 20260918000500 for the posting functions.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  created_at  timestamptz not null default now()
);

create table public.app_roles (
  role text primary key
);

create table public.role_permissions (
  role        text not null references public.app_roles (role) on delete cascade,
  permission  text not null check (permission ~ '^[a-z_]+(\.[a-z_]+)+$'),
  primary key (role, permission)
);

create table public.company_members (
  company_id  uuid not null references public.companies (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null references public.app_roles (role),
  created_at  timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index company_members_user_idx on public.company_members (user_id);

-- ---------------------------------------------------------------------------------------------
-- Roles and their permissions. Voucher permissions are per kind: voucher.<kind>.<post|alter|cancel>.
-- Adding a voucher kind later = one migration inserting its rows here.
-- ---------------------------------------------------------------------------------------------
insert into public.app_roles (role) values ('owner'), ('accountant'), ('clerk'), ('viewer');

with kinds(kind) as (values ('contra'), ('payment'), ('receipt'), ('journal')),
     actions(action) as (values ('post'), ('alter'), ('cancel')),
     everyone(role) as (values ('owner'), ('accountant'), ('clerk'), ('viewer'))
insert into public.role_permissions (role, permission)
  -- everybody can read masters, reports and vouchers
  select e.role, p.permission
    from everyone e cross join (values ('master.view'), ('report.view'), ('voucher.view')) as p(permission)
  union all
  -- owner and accountant can post, alter and cancel every kind
  select r.role, 'voucher.' || k.kind || '.' || a.action
    from (values ('owner'), ('accountant')) as r(role) cross join kinds k cross join actions a
  union all
  -- a clerk can post money vouchers, but not journals, and cannot alter or cancel anything
  select 'clerk', 'voucher.' || k.kind || '.post' from kinds k where k.kind in ('contra', 'payment', 'receipt')
  union all
  select r, p from (values ('owner', 'company.admin'), ('owner', 'audit.view'), ('accountant', 'audit.view')) as x(r, p);

-- ---------------------------------------------------------------------------------------------
-- Permission helpers. SECURITY DEFINER so they can read membership without tripping RLS on
-- company_members (which would recurse); search_path is pinned so they cannot be hijacked.
-- ---------------------------------------------------------------------------------------------
create function private.actor_has_permission(p_actor uuid, p_company uuid, p_permission text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.company_members m
      join public.role_permissions rp on rp.role = m.role
     where m.company_id = p_company
       and m.user_id = p_actor
       and rp.permission = p_permission
  )
$$;

create function private.has_permission(p_company uuid, p_permission text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.actor_has_permission((select auth.uid()), p_company, p_permission)
$$;

create function private.is_member(p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company_members m
     where m.company_id = p_company and m.user_id = (select auth.uid())
  )
$$;

revoke execute on function private.actor_has_permission(uuid, uuid, text) from public;
revoke execute on function private.has_permission(uuid, text) from public;
revoke execute on function private.is_member(uuid) from public;
grant execute on function private.has_permission(uuid, text) to authenticated;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.actor_has_permission(uuid, uuid, text) to service_role;
