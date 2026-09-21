-- Phase 4: the rest of the masters, validated master writes, company onboarding and the search index.
--
-- Same shape as the posting path: the application (running the same TypeScript domain code as the browser) decides
-- what a master change means and hands finished rows to ONE atomic function; the database enforces invariants and
-- writes rows. Clients still cannot write anything (see the end of this file for RLS and grants).
--
-- Concurrency: every master change is validated against a snapshot of the company's masters, so two changes made at
-- the same moment could each look fine alone and be wrong together (two ledgers with one name). `companies.masters_version`
-- is the arbiter: master_apply takes the version the caller validated against and refuses (MASTERS_CHANGED) if it moved.
-- The caller reloads, re-validates and tries again, so validation and commit behave as if serialised per company.

create extension if not exists pg_trgm with schema extensions;
-- Functions created after the default-privilege change in 20260918000600 are not executable by everyone. Search (run as
-- the signed-in member, so row-level security applies) needs the two pure similarity functions; nothing else.
grant usage on schema extensions to authenticated, service_role;
grant execute on function extensions.similarity(text, text), extensions.similarity_op(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Existing tables grow
-- ---------------------------------------------------------------------------------------------
alter table public.companies
  add column gstin           text,
  add column state_code      text,
  add column address         text,
  add column masters_version bigint not null default 0;

alter table public.account_groups add column is_active boolean not null default true;

alter table public.voucher_types
  add column is_system boolean not null default false,
  add column is_active boolean not null default true;
-- `opening` is a system voucher kind (a ledger's balance brought forward); users cannot create types of it.
alter table public.voucher_types drop constraint voucher_types_base_kind_check;
alter table public.voucher_types
  add constraint voucher_types_base_kind_check check (base_kind in ('contra', 'payment', 'receipt', 'journal', 'opening'));

-- ---------------------------------------------------------------------------------------------
-- New masters. Same conventions as before: company_id everywhere, composite foreign keys, client-generated ids.
-- Percentages and factors are stored as exact decimals and read back with trim_scale, so '18' comes back as '18'.
-- ---------------------------------------------------------------------------------------------
create table public.parties (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  name          text not null check (length(btrim(name)) > 0),
  gstin         text,
  pan           text,
  phone         text,
  email         text,
  address       text,
  state_code    text,
  credit_days   int check (credit_days is null or credit_days between 0 and 3650),
  credit_limit  numeric(20, 2) check (credit_limit is null or credit_limit >= 0),
  is_active     boolean not null default true,
  unique (company_id, id)
);
create unique index parties_name_uq on public.parties (company_id, lower(name));
create index parties_gstin_idx on public.parties (company_id, gstin) where gstin is not null;

alter table public.ledgers
  add column code         text,
  add column alias        text,
  add column party_id     uuid,
  add column reserved_key text;
alter table public.ledgers
  add constraint ledger_party_fk foreign key (company_id, party_id) references public.parties (company_id, id);
create unique index ledgers_code_uq on public.ledgers (company_id, lower(code)) where code is not null;
create unique index ledgers_reserved_uq on public.ledgers (company_id, reserved_key) where reserved_key is not null;
create index ledgers_party_idx on public.ledgers (company_id, party_id) where party_id is not null;

create table public.units (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  symbol        text not null check (length(btrim(symbol)) > 0),
  name          text not null check (length(btrim(name)) > 0),
  decimals      smallint not null default 0 check (decimals between 0 and 4),
  -- a compound unit: 1 <this> = factor <base unit>
  base_unit_id  uuid,
  factor        numeric(20, 6) check (factor is null or factor > 0),
  is_active     boolean not null default true,
  unique (company_id, id),
  constraint unit_base_fk foreign key (company_id, base_unit_id) references public.units (company_id, id),
  constraint unit_base_and_factor check ((base_unit_id is null) = (factor is null)),
  constraint unit_not_own_base check (base_unit_id is null or base_unit_id <> id)
);
create unique index units_symbol_uq on public.units (company_id, lower(symbol));

create table public.stock_groups (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  parent_id   uuid,
  is_active   boolean not null default true,
  unique (company_id, id),
  constraint stock_group_parent_fk foreign key (company_id, parent_id) references public.stock_groups (company_id, id),
  constraint stock_group_not_own_parent check (parent_id is null or parent_id <> id)
);
create unique index stock_groups_name_uq on public.stock_groups (company_id, lower(name));

create table public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  parent_id   uuid,
  is_active   boolean not null default true,
  unique (company_id, id),
  constraint warehouse_parent_fk foreign key (company_id, parent_id) references public.warehouses (company_id, id),
  constraint warehouse_not_own_parent check (parent_id is null or parent_id <> id)
);
create unique index warehouses_name_uq on public.warehouses (company_id, lower(name));

create table public.gst_rates (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  name            text not null check (length(btrim(name)) > 0),
  rate_percent    numeric(8, 4) not null check (rate_percent between 0 and 100),
  cess_percent    numeric(8, 4) not null default 0 check (cess_percent between 0 and 100),
  effective_from  date not null,
  unique (company_id, id)
);
create unique index gst_rates_name_uq on public.gst_rates (company_id, lower(name));

create table public.stock_items (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  name         text not null check (length(btrim(name)) > 0),
  code         text,
  alias        text,
  group_id     uuid,
  unit_id      uuid not null,
  hsn          text check (hsn is null or hsn ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  gst_rate_id  uuid,
  item_type    text not null check (item_type in ('raw', 'wip', 'finished', 'trading', 'service')),
  is_active    boolean not null default true,
  unique (company_id, id),
  constraint item_group_fk foreign key (company_id, group_id) references public.stock_groups (company_id, id),
  constraint item_unit_fk foreign key (company_id, unit_id) references public.units (company_id, id),
  constraint item_gst_fk foreign key (company_id, gst_rate_id) references public.gst_rates (company_id, id)
);
create unique index stock_items_name_uq on public.stock_items (company_id, lower(name));
create unique index stock_items_code_uq on public.stock_items (company_id, lower(code)) where code is not null;
create index stock_items_group_idx on public.stock_items (company_id, group_id) where group_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Backstops. The application already refuses these; the database refuses them too, so a bug or a hand-run
-- statement cannot break what the rules promise.
-- ---------------------------------------------------------------------------------------------
-- These run AFTER the row is written, so the table's own CHECK and foreign-key errors keep priority over ours.
-- One small function per table: PL/pgSQL resolves OLD/NEW fields when it evaluates an expression, so a shared function
-- that mentions another table's columns would fail even on a branch that is not taken.
create function private.protect_system_ledgers() returns trigger
language plpgsql
as $$
begin
  if old.reserved_key is not null
     and (new.name, new.group_id, new.is_active, new.reserved_key) is distinct from (old.name, old.group_id, old.is_active, old.reserved_key) then
    perform private.raise_issue('SYSTEM_MASTER_LOCKED', format('"%s" is built in and cannot be changed', old.name));
  end if;
  return null;
end
$$;
create trigger ledgers_protect after update on public.ledgers for each row execute function private.protect_system_ledgers();

create function private.protect_system_groups() returns trigger
language plpgsql
as $$
begin
  if old.is_system
     and (new.name, new.parent_id, new.nature, new.is_active) is distinct from (old.name, old.parent_id, old.nature, old.is_active) then
    perform private.raise_issue('SYSTEM_MASTER_LOCKED', format('"%s" is built in and cannot be changed', old.name));
  end if;
  return null;
end
$$;
create trigger account_groups_protect after update on public.account_groups for each row execute function private.protect_system_groups();

create function private.protect_system_types() returns trigger
language plpgsql
as $$
begin
  if old.is_system
     and (new.name, new.base_kind, new.is_active) is distinct from (old.name, old.base_kind, old.is_active) then
    perform private.raise_issue('SYSTEM_MASTER_LOCKED', format('"%s" is built in and cannot be changed', old.name));
  end if;
  return null;
end
$$;
create trigger voucher_types_protect after update on public.voucher_types for each row execute function private.protect_system_types();

-- A ledger with entries keeps its nature: moving it from an asset group to an expense group would silently
-- restate every report it appears in.
create function private.protect_ledger_nature() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_was text;
  v_now text;
begin
  select nature into v_was from public.account_groups where id = old.group_id and company_id = old.company_id;
  select nature into v_now from public.account_groups where id = new.group_id and company_id = new.company_id;
  if v_was is distinct from v_now and exists (select 1 from public.journal_lines where ledger_id = old.id) then
    perform private.raise_issue('NATURE_LOCKED',
      format('"%s" already has entries, so it cannot move from a %s group to a %s group', old.name, v_was, v_now));
  end if;
  return new;
end
$$;
create trigger ledgers_nature_lock before update of group_id on public.ledgers
  for each row when (old.group_id is distinct from new.group_id) execute function private.protect_ledger_nature();

create function private.protect_type_kind() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.vouchers where voucher_type_id = old.id) then
    perform private.raise_issue('IN_USE', 'Vouchers already use this type, so its base kind cannot change');
  end if;
  return new;
end
$$;
create trigger voucher_types_in_use before update of base_kind on public.voucher_types
  for each row when (old.base_kind is distinct from new.base_kind) execute function private.protect_type_kind();

create function private.protect_series_start() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.vouchers where series_id = old.id) then
    perform private.raise_issue('IN_USE', 'Vouchers already use this series, so its start number cannot change');
  end if;
  return new;
end
$$;
create trigger numbering_series_in_use before update of start_at on public.numbering_series
  for each row when (old.start_at is distinct from new.start_at) execute function private.protect_series_start();

-- ---------------------------------------------------------------------------------------------
-- The search index. Maintained by triggers in the SAME transaction as the change, so it is never behind the data.
-- (A ledger's subtitle — its group's name — is captured when the ledger is written; renaming a group does not rewrite
-- its ledgers' subtitles. Titles and identifiers, which is what search matches on, are always current.)
-- ---------------------------------------------------------------------------------------------
create table public.search_index (
  company_id   uuid not null references public.companies (id) on delete cascade,
  entity_type  text not null,
  entity_id    uuid not null,
  title        text not null,
  subtitle     text,
  -- codes, alias, GSTIN, phone, HSN: what should find the record outright
  identifiers  text not null default '',
  -- the same, lower-case with punctuation removed, so "fg-bl-m8" and "FGBLM8" find each other
  identifiers_norm text generated always as (regexp_replace(lower(identifiers), '[^a-z0-9 ]', '', 'g')) stored,
  is_active    boolean not null default true,
  -- what the client needs to open it: { kind, id }
  target       jsonb not null,
  primary key (company_id, entity_type, entity_id)
);
create index search_index_title_trgm on public.search_index using gin (lower(title) extensions.gin_trgm_ops);
create index search_index_ident_trgm on public.search_index using gin (identifiers_norm extensions.gin_trgm_ops);

create function private.index_master() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  j       jsonb := to_jsonb(new);
  v_type  text;
  v_title text;
  v_sub   text;
  v_ident text;
  v_kind  text;
  v_active boolean := coalesce((j ->> 'is_active')::boolean, true);
begin
  case tg_table_name
    when 'ledgers' then
      v_type := 'ledger'; v_kind := 'ledger'; v_title := j ->> 'name';
      v_sub := concat_ws(' · ',
        (select g.name from public.account_groups g where g.id = new.group_id and g.company_id = new.company_id),
        (select p.name from public.parties p where p.id = new.party_id and p.company_id = new.company_id));
      v_ident := concat_ws(' ', j ->> 'code', j ->> 'alias');
    when 'account_groups' then
      v_type := 'group'; v_kind := 'group'; v_title := j ->> 'name';
      v_sub := (select g.name from public.account_groups g where g.id = new.parent_id and g.company_id = new.company_id);
      v_ident := '';
    when 'parties' then
      v_type := 'party'; v_kind := 'party'; v_title := j ->> 'name';
      v_sub := concat_ws(' · ', j ->> 'gstin', j ->> 'phone', j ->> 'address');
      v_ident := concat_ws(' ', j ->> 'gstin', j ->> 'pan', j ->> 'phone', j ->> 'email');
    when 'stock_items' then
      v_type := 'item'; v_kind := 'stockItem'; v_title := j ->> 'name';
      v_sub := concat_ws(' · ',
        (select u.symbol from public.units u where u.id = new.unit_id and u.company_id = new.company_id),
        (select s.name from public.stock_groups s where s.id = new.group_id and s.company_id = new.company_id),
        case when new.hsn is not null then 'HSN ' || new.hsn end);
      v_ident := concat_ws(' ', j ->> 'code', j ->> 'alias', j ->> 'hsn');
    when 'stock_groups' then
      v_type := 'stockgroup'; v_kind := 'stockGroup'; v_title := j ->> 'name'; v_ident := '';
    when 'units' then
      v_type := 'unit'; v_kind := 'unit'; v_title := (j ->> 'name') || ' (' || (j ->> 'symbol') || ')'; v_ident := j ->> 'symbol';
    when 'warehouses' then
      v_type := 'warehouse'; v_kind := 'warehouse'; v_title := j ->> 'name'; v_ident := '';
    else
      return null;
  end case;

  insert into public.search_index (company_id, entity_type, entity_id, title, subtitle, identifiers, is_active, target)
  values (new.company_id, v_type, new.id, v_title, nullif(v_sub, ''), coalesce(v_ident, ''), v_active,
          jsonb_build_object('kind', v_kind, 'id', new.id))
  on conflict (company_id, entity_type, entity_id) do update
    set title = excluded.title, subtitle = excluded.subtitle, identifiers = excluded.identifiers,
        is_active = excluded.is_active, target = excluded.target;
  return null;
end
$$;
create trigger ledgers_index after insert or update on public.ledgers for each row execute function private.index_master();
create trigger account_groups_index after insert or update on public.account_groups for each row execute function private.index_master();
create trigger parties_index after insert or update on public.parties for each row execute function private.index_master();
create trigger stock_items_index after insert or update on public.stock_items for each row execute function private.index_master();
create trigger stock_groups_index after insert or update on public.stock_groups for each row execute function private.index_master();
create trigger units_index after insert or update on public.units for each row execute function private.index_master();
create trigger warehouses_index after insert or update on public.warehouses for each row execute function private.index_master();

-- Callable by signed-in members; row level security on search_index decides what they may see.
-- Ranking: an exact identifier beats a prefix of the title beats a word prefix beats similarity.
create function public.search_entities(p_company uuid, p_query text, p_types text[] default null, p_limit int default 30)
returns table (entity_type text, entity_id uuid, title text, subtitle text, is_active boolean, target jsonb, score real)
language sql stable
set search_path = public, extensions, pg_temp
as $$
  with q as (select lower(btrim(p_query)) as t, regexp_replace(lower(p_query), '[^a-z0-9]', '', 'g') as compact)
  select s.entity_type, s.entity_id, s.title, s.subtitle, s.is_active, s.target,
         (case
            when q.compact <> '' and s.identifiers_norm ~ ('(^| )' || q.compact || '( |$)') then 1.0
            when lower(s.title) = q.t then 0.98
            when lower(s.title) like q.t || '%' then 0.9
            when lower(s.title) like '% ' || q.t || '%' then 0.8
            when q.compact <> '' and s.identifiers_norm like '%' || q.compact || '%' then 0.7
            else similarity(lower(s.title), q.t)
          end * case when s.is_active then 1 else 0.7 end)::real as score
    from public.search_index s, q
   where s.company_id = p_company
     and length(q.t) > 0
     and (p_types is null or s.entity_type = any (p_types))
     and (lower(s.title) like '%' || q.t || '%'
          or lower(s.title) % q.t
          or (q.compact <> '' and s.identifiers_norm like '%' || q.compact || '%'))
   order by score desc, s.title
   limit least(greatest(p_limit, 1), 100)
$$;

-- ---------------------------------------------------------------------------------------------
-- Permissions: who may change masters, and post opening balances
-- ---------------------------------------------------------------------------------------------
insert into public.role_permissions (role, permission)
  select r.role, p.permission
    from (values ('owner'), ('accountant')) as r(role)
   cross join (values ('master.write'), ('voucher.opening.post'), ('voucher.opening.alter'), ('voucher.opening.cancel')) as p(permission);

-- ---------------------------------------------------------------------------------------------
-- Loading masters for the server-side adapter (replaces the Phase 2 versions)
-- ---------------------------------------------------------------------------------------------
create or replace function public.load_masters_json(p_company uuid) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'version', (select c.masters_version from public.companies c where c.id = p_company),
    'company', (select jsonb_build_object('id', c.id, 'name', c.name, 'gstin', c.gstin, 'state_code', c.state_code, 'address', c.address)
                  from public.companies c where c.id = p_company),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name, 'parent_id', g.parent_id, 'nature', g.nature,
               'affects_gross_profit', g.affects_gross_profit, 'is_system', g.is_system, 'reserved_key', g.reserved_key,
               'is_active', g.is_active)
             order by g.name)
        from public.account_groups g where g.company_id = p_company), '[]'::jsonb),
    'voucher_types', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'base_kind', t.base_kind, 'is_system', t.is_system, 'is_active', t.is_active)
             order by t.name)
        from public.voucher_types t where t.company_id = p_company), '[]'::jsonb),
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'voucher_type_id', s.voucher_type_id, 'financial_year_id', s.financial_year_id,
               'prefix', s.prefix, 'suffix', s.suffix, 'width', s.width, 'start_at', s.start_at)
             order by s.id)
        from public.numbering_series s where s.company_id = p_company), '[]'::jsonb),
    'financial_years', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'label', f.label, 'start_date', f.start_date, 'end_date', f.end_date,
               'locked_through', f.locked_through)
             order by f.start_date)
        from public.financial_years f where f.company_id = p_company), '[]'::jsonb),
    'parties', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'gstin', p.gstin, 'pan', p.pan, 'phone', p.phone, 'email', p.email,
               'address', p.address, 'state_code', p.state_code, 'credit_days', p.credit_days,
               'credit_limit', p.credit_limit::text, 'is_active', p.is_active)
             order by p.name)
        from public.parties p where p.company_id = p_company), '[]'::jsonb),
    'units', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', u.id, 'symbol', u.symbol, 'name', u.name, 'decimals', u.decimals, 'base_unit_id', u.base_unit_id,
               'factor', trim_scale(u.factor)::text, 'is_active', u.is_active)
             order by u.symbol)
        from public.units u where u.company_id = p_company), '[]'::jsonb),
    'stock_groups', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'parent_id', s.parent_id, 'is_active', s.is_active) order by s.name)
        from public.stock_groups s where s.company_id = p_company), '[]'::jsonb),
    'stock_items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'name', i.name, 'code', i.code, 'alias', i.alias, 'group_id', i.group_id, 'unit_id', i.unit_id,
               'hsn', i.hsn, 'gst_rate_id', i.gst_rate_id, 'item_type', i.item_type, 'is_active', i.is_active)
             order by i.name)
        from public.stock_items i where i.company_id = p_company), '[]'::jsonb),
    'warehouses', coalesce((
      select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'parent_id', w.parent_id, 'is_active', w.is_active) order by w.name)
        from public.warehouses w where w.company_id = p_company), '[]'::jsonb),
    'gst_rates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'name', r.name, 'rate_percent', trim_scale(r.rate_percent)::text,
               'cess_percent', trim_scale(r.cess_percent)::text, 'effective_from', r.effective_from)
             order by r.effective_from, r.name)
        from public.gst_rates r where r.company_id = p_company), '[]'::jsonb)
  )
$$;

create or replace function public.load_ledgers_json(p_company uuid, p_ids jsonb) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'name', l.name, 'group_id', l.group_id, 'is_active', l.is_active,
           'code', l.code, 'alias', l.alias, 'party_id', l.party_id, 'reserved_key', l.reserved_key) order by l.name), '[]'::jsonb)
    from public.ledgers l
   where l.company_id = p_company
     and (p_ids is null or l.id in (select value::uuid from jsonb_array_elements_text(p_ids)))
$$;

-- Does the books already use this record? (One small query instead of shipping every ledger with entries.)
create function public.master_usage_json(p_company uuid, p_id uuid) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ledger_has_entries', exists (select 1 from public.journal_lines where company_id = p_company and ledger_id = p_id),
    'voucher_type_in_use', exists (select 1 from public.vouchers where company_id = p_company and voucher_type_id = p_id),
    'series_in_use', exists (select 1 from public.vouchers where company_id = p_company and series_id = p_id)
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- master_apply: commit ONE validated master change.
--   p_change = { kind, op, id, row: { ...columns of the table... } }
-- The caller (server-side TypeScript) has already applied every business rule; this function checks the version it
-- validated against, writes the row, bumps the version and audits — all in one transaction.
-- ---------------------------------------------------------------------------------------------
create function public.master_apply(
  p_actor uuid, p_company uuid, p_request_id text, p_expected_version bigint, p_change jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_kind    text  := p_change ->> 'kind';
  v_op      text  := p_change ->> 'op';
  v_id      uuid  := (p_change ->> 'id')::uuid;
  v_row     jsonb := p_change -> 'row';
  v_table   text;
  v_version bigint;
  v_before  jsonb;
  v_after   jsonb;
  v_cols    text;
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted to change masters');
  end if;

  -- Serialise master changes per company and check what the caller validated against is still current.
  select masters_version into v_version from public.companies where id = p_company for update;
  if not found then
    perform private.raise_issue('COMPANY_MISMATCH', format('Company %s not found', p_company));
  end if;
  if v_version <> p_expected_version then
    perform private.raise_issue('MASTERS_CHANGED', 'The masters changed while this was being checked; it will be checked again');
  end if;

  v_table := case v_kind
    when 'group'           then 'account_groups'
    when 'ledger'          then 'ledgers'
    when 'party'           then 'parties'
    when 'unit'            then 'units'
    when 'stockGroup'      then 'stock_groups'
    when 'stockItem'       then 'stock_items'
    when 'warehouse'       then 'warehouses'
    when 'gstRate'         then 'gst_rates'
    when 'voucherType'     then 'voucher_types'
    when 'numberingSeries' then 'numbering_series'
    when 'company'         then 'companies'
  end;
  if v_table is null or v_op not in ('create', 'alter', 'setActive') then
    perform private.raise_issue('SCHEMA_INVALID', format('Unknown master command %s %s', v_op, v_kind));
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1', v_table) into v_before using v_id;

  if v_kind = 'company' then
    if v_id <> p_company then
      perform private.raise_issue('COMPANY_MISMATCH', 'A company can only be changed from inside itself');
    end if;
    update public.companies
       set name = v_row ->> 'name', gstin = v_row ->> 'gstin', state_code = v_row ->> 'state_code', address = v_row ->> 'address'
     where id = p_company;
  else
    if (v_row ->> 'company_id')::uuid is distinct from p_company then
      perform private.raise_issue('COMPANY_MISMATCH', 'The record belongs to another company');
    end if;
    -- Every column except identity is replaced; a series keeps its running counter.
    select string_agg(format('%1$I = excluded.%1$I', a.attname), ', ')
      into v_cols
      from pg_attribute a
     where a.attrelid = ('public.' || quote_ident(v_table))::regclass
       and a.attnum > 0 and not a.attisdropped
       and a.attname not in ('id', 'company_id')
       and not (v_table = 'numbering_series' and a.attname = 'next_value');
    execute format(
      'insert into public.%1$I select * from jsonb_populate_record(null::public.%1$I, $1) on conflict (id) do update set %2$s',
      v_table, v_cols) using v_row;
  end if;

  update public.companies set masters_version = v_version + 1 where id = p_company;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1', v_table) into v_after using v_id;
  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, after, request_id)
  values (p_company, p_actor, 'master.' || v_op, v_kind, v_id, v_before, v_after, p_request_id);

  return jsonb_build_object('kind', v_kind, 'op', v_op, 'id', v_id, 'version', v_version + 1);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- company_seed: create a company with its standard chart, voucher types, numbering, units and so on in one
-- transaction. p_seed holds table-shaped rows; the caller becomes the owner.
-- ---------------------------------------------------------------------------------------------
create function public.company_seed(p_actor uuid, p_request_id text, p_seed jsonb) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_company jsonb := p_seed -> 'company';
  v_id      uuid  := (v_company ->> 'id')::uuid;
begin
  insert into public.companies (id, name, gstin, state_code, address)
  values (v_id, v_company ->> 'name', v_company ->> 'gstin', v_company ->> 'state_code', v_company ->> 'address');
  insert into public.company_members (company_id, user_id, role) values (v_id, p_actor, 'owner');

  insert into public.financial_years select * from jsonb_populate_recordset(null::public.financial_years, p_seed -> 'financial_years');
  insert into public.account_groups  select * from jsonb_populate_recordset(null::public.account_groups,  p_seed -> 'account_groups');
  insert into public.parties         select * from jsonb_populate_recordset(null::public.parties,         coalesce(p_seed -> 'parties', '[]'));
  insert into public.ledgers         select * from jsonb_populate_recordset(null::public.ledgers,         p_seed -> 'ledgers');
  insert into public.voucher_types   select * from jsonb_populate_recordset(null::public.voucher_types,   p_seed -> 'voucher_types');
  insert into public.numbering_series select * from jsonb_populate_recordset(null::public.numbering_series, p_seed -> 'numbering_series');
  insert into public.units           select * from jsonb_populate_recordset(null::public.units,           coalesce(p_seed -> 'units', '[]'));
  insert into public.stock_groups    select * from jsonb_populate_recordset(null::public.stock_groups,    coalesce(p_seed -> 'stock_groups', '[]'));
  insert into public.warehouses      select * from jsonb_populate_recordset(null::public.warehouses,      coalesce(p_seed -> 'warehouses', '[]'));
  insert into public.gst_rates       select * from jsonb_populate_recordset(null::public.gst_rates,       coalesce(p_seed -> 'gst_rates', '[]'));
  insert into public.stock_items     select * from jsonb_populate_recordset(null::public.stock_items,     coalesce(p_seed -> 'stock_items', '[]'));

  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, after, request_id)
  values (v_id, p_actor, 'company.create', 'company', v_id, jsonb_build_object('name', v_company ->> 'name'), p_request_id);
  return jsonb_build_object('company_id', v_id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS and privileges for everything added above (same rules as 20260918000600: start closed, read-only for members)
-- ---------------------------------------------------------------------------------------------
alter table public.parties       enable row level security;
alter table public.units         enable row level security;
alter table public.stock_groups  enable row level security;
alter table public.stock_items   enable row level security;
alter table public.warehouses    enable row level security;
alter table public.gst_rates     enable row level security;
alter table public.search_index  enable row level security;

create policy parties_select      on public.parties      for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy units_select        on public.units        for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy stock_groups_select on public.stock_groups for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy stock_items_select  on public.stock_items  for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy warehouses_select   on public.warehouses   for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy gst_rates_select    on public.gst_rates    for select to authenticated using (private.has_permission(company_id, 'master.view'));
create policy search_index_select on public.search_index for select to authenticated using (private.has_permission(company_id, 'master.view'));

revoke all on public.parties, public.units, public.stock_groups, public.stock_items, public.warehouses, public.gst_rates, public.search_index
  from anon, authenticated;
grant select on public.parties, public.units, public.stock_groups, public.stock_items, public.warehouses, public.gst_rates, public.search_index
  to authenticated;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- The write path and the server's read helpers: trusted server only.
revoke execute on function
  public.master_apply(uuid, uuid, text, bigint, jsonb),
  public.company_seed(uuid, text, jsonb),
  public.master_usage_json(uuid, uuid),
  public.load_masters_json(uuid),
  public.load_ledgers_json(uuid, jsonb)
from public, anon, authenticated;
grant execute on function
  public.master_apply(uuid, uuid, text, bigint, jsonb),
  public.company_seed(uuid, text, jsonb),
  public.master_usage_json(uuid, uuid),
  public.load_masters_json(uuid),
  public.load_ledgers_json(uuid, jsonb)
to service_role;

-- Search is for signed-in members (row level security decides what they see).
revoke execute on function public.search_entities(uuid, text, text[], int) from public, anon;
grant  execute on function public.search_entities(uuid, text, text[], int) to authenticated, service_role;

revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function private.has_permission(uuid, text), private.is_member(uuid) to authenticated;
