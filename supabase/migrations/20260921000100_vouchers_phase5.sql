-- Phase 5: bill-wise details, party GST registration and saved addresses.
--
-- Bill-wise details ("this payment settles bill PO-2210", "this journal raises bill BC-77 due 30 June") are CAPTURED on the voucher (in its
-- content, exactly as posted) and mirrored into `bill_allocations` by a trigger in the SAME transaction, so the outstanding and ageing
-- reports can query them without parsing JSON — and so the mirror can never disagree with the voucher. Nothing writes the mirror but the trigger.

alter table public.parties
  add column gst_registration text check (gst_registration is null or gst_registration in ('regular', 'composition', 'unregistered', 'sez', 'overseas')),
  add column addresses        jsonb not null default '[]'::jsonb check (jsonb_typeof(addresses) = 'array');

create table public.bill_allocations (
  id          bigint generated always as identity primary key,
  company_id  uuid not null,
  voucher_id  uuid not null,
  ledger_id   uuid not null,
  -- the side the party line was posted on: a debit line settles or raises a receivable, a credit line a payable
  side        text not null check (side in ('debit', 'credit')),
  kind        text not null check (kind in ('new', 'against', 'advance', 'onAccount')),
  ref         text,
  due_date    date,
  amount      numeric(20, 2) not null check (amount > 0),
  constraint bill_voucher_fk foreign key (company_id, voucher_id) references public.vouchers (company_id, id) on delete cascade,
  constraint bill_ledger_fk  foreign key (company_id, ledger_id)  references public.ledgers (company_id, id),
  constraint bill_ref_needed check (kind not in ('new', 'against') or (ref is not null and length(btrim(ref)) > 0))
);
create index bill_allocations_ledger_ref_idx on public.bill_allocations (company_id, ledger_id, ref);
create index bill_allocations_voucher_idx on public.bill_allocations (company_id, voucher_id);

-- Rebuilds a voucher's mirror rows from its content. Cancelled vouchers have none (they are out of the books).
create function private.sync_bill_allocations() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_kind text;
begin
  delete from public.bill_allocations where voucher_id = new.id;
  if new.status <> 'posted' then
    return null;
  end if;
  select base_kind into v_kind from public.voucher_types where id = new.voucher_type_id and company_id = new.company_id;

  -- Payment / Receipt / Contra: the particulars carry the bills; Payment debits them, Receipt credits them, Contra has none.
  insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, due_date, amount)
  select new.company_id, new.id, (l ->> 'ledgerId')::uuid,
         case v_kind when 'receipt' then 'credit' else 'debit' end,
         a ->> 'kind', nullif(btrim(a ->> 'ref'), ''), nullif(a ->> 'dueDate', '')::date, (a ->> 'amount')::numeric
    from jsonb_array_elements(coalesce(new.content -> 'lines', '[]'::jsonb)) l,
         jsonb_array_elements(coalesce(l -> 'allocations', '[]'::jsonb)) a
   where v_kind in ('payment', 'receipt');

  -- Journal: each entry states its own side.
  insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, due_date, amount)
  select new.company_id, new.id, (e ->> 'ledgerId')::uuid, e ->> 'side',
         a ->> 'kind', nullif(btrim(a ->> 'ref'), ''), nullif(a ->> 'dueDate', '')::date, (a ->> 'amount')::numeric
    from jsonb_array_elements(coalesce(new.content -> 'entries', '[]'::jsonb)) e,
         jsonb_array_elements(coalesce(e -> 'allocations', '[]'::jsonb)) a
   where v_kind = 'journal';

  -- Opening balance: one ledger, one side, its bills at the top level of the content.
  insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, due_date, amount)
  select new.company_id, new.id, (new.content ->> 'ledgerId')::uuid, new.content ->> 'side',
         a ->> 'kind', nullif(btrim(a ->> 'ref'), ''), nullif(a ->> 'dueDate', '')::date, (a ->> 'amount')::numeric
    from jsonb_array_elements(coalesce(new.content -> 'allocations', '[]'::jsonb)) a
   where v_kind = 'opening';
  return null;
end
$$;
create trigger vouchers_sync_bills after insert or update of content, status on public.vouchers
  for each row execute function private.sync_bill_allocations();

-- ---------------------------------------------------------------------------------------------
-- Loading parties now carries the registration type and the address book
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
               'credit_limit', p.credit_limit::text, 'gst_registration', p.gst_registration, 'addresses', p.addresses,
               'is_active', p.is_active)
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

-- ---------------------------------------------------------------------------------------------
-- RLS and privileges (same rules as always: start closed, members read, nobody but the server writes)
-- ---------------------------------------------------------------------------------------------
alter table public.bill_allocations enable row level security;
create policy bill_allocations_select on public.bill_allocations
  for select to authenticated using (private.has_permission(company_id, 'report.view'));
revoke all on public.bill_allocations from anon, authenticated;
grant select on public.bill_allocations to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

revoke execute on function public.load_masters_json(uuid) from public, anon, authenticated;
grant execute on function public.load_masters_json(uuid) to service_role;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
grant execute on function private.has_permission(uuid, text), private.is_member(uuid) to authenticated;
