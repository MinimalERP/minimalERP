-- Masters: financial years, account groups, ledgers, voucher types, numbering series.
--
-- Conventions
--   * every table carries company_id; every foreign key is COMPOSITE (company_id, id), so a row can
--     never reference another company's data, even through a bug (each parent has UNIQUE (company_id, id)).
--   * ids are client-generated uuids.
-- Write access to masters is deliberately service-only in this migration set; validated master
-- CRUD (group-nature rules, "cannot delete a ledger with entries") arrives with Phase 4.

create extension if not exists btree_gist with schema extensions;

create table public.financial_years (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  label           text not null,
  start_date      date not null,
  end_date        date not null,
  -- inclusive: nothing dated on or before this day may be posted, altered or cancelled
  locked_through  date,
  constraint fy_dates_ordered check (end_date >= start_date),
  constraint fy_lock_within_year check (locked_through is null or locked_through between start_date and end_date),
  unique (company_id, id),
  unique (company_id, label),
  -- a company's financial years never overlap
  constraint fy_no_overlap exclude using gist (
    company_id with =,
    daterange(start_date, end_date, '[]') with &&
  )
);

create table public.account_groups (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete cascade,
  name                  text not null check (length(btrim(name)) > 0),
  parent_id             uuid,
  nature                text not null check (nature in ('asset', 'liability', 'income', 'expense')),
  affects_gross_profit  boolean not null default false,
  is_system             boolean not null default false,
  reserved_key          text,
  unique (company_id, id),
  constraint group_parent_fk foreign key (company_id, parent_id) references public.account_groups (company_id, id),
  constraint group_not_own_parent check (parent_id is null or parent_id <> id)
);
create unique index account_groups_name_uq on public.account_groups (company_id, lower(name));
create unique index account_groups_reserved_uq on public.account_groups (company_id, reserved_key) where reserved_key is not null;

create table public.ledgers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  group_id    uuid not null,
  is_active   boolean not null default true,
  unique (company_id, id),
  constraint ledger_group_fk foreign key (company_id, group_id) references public.account_groups (company_id, id)
);
create unique index ledgers_name_uq on public.ledgers (company_id, lower(name));
create index ledgers_group_idx on public.ledgers (company_id, group_id);

create table public.voucher_types (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  base_kind   text not null check (base_kind in ('contra', 'payment', 'receipt', 'journal')),
  unique (company_id, id)
);
create unique index voucher_types_name_uq on public.voucher_types (company_id, lower(name));

-- One numbering sequence per (voucher type, financial year). `next_value` is advanced under a row
-- lock inside the posting transaction, so numbers are gapless and never reused.
create table public.numbering_series (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete cascade,
  voucher_type_id    uuid not null,
  financial_year_id  uuid not null,
  prefix             text not null default '',
  suffix             text not null default '',
  width              int  not null check (width between 1 and 12),
  start_at           int  not null check (start_at >= 1),
  next_value         bigint not null,
  unique (company_id, id),
  unique (company_id, voucher_type_id, financial_year_id),
  constraint series_type_fk foreign key (company_id, voucher_type_id) references public.voucher_types (company_id, id),
  constraint series_fy_fk   foreign key (company_id, financial_year_id) references public.financial_years (company_id, id),
  constraint series_next_ok check (next_value >= start_at)
);

-- next_value defaults to start_at so seeders only supply start_at.
create function private.series_init() returns trigger
language plpgsql
as $$
begin
  new.next_value := coalesce(new.next_value, new.start_at::bigint);
  return new;
end
$$;
create trigger numbering_series_init before insert on public.numbering_series
  for each row execute function private.series_init();
