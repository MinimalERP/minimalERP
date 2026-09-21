-- Phase 9: GST on Sales and Purchase invoices, and TDS on a Receipt (ADR-0019).
--
-- What changes in the database is small, because the accounting already flows through the posting engine and its journal:
--   * a company can charge GST (`companies.charge_gst`, off by default: an existing company's invoices are exactly what they were);
--   * every company has the SYSTEM LEDGERS the engine posts to — Output / Input CGST, SGST, IGST and TDS Receivable — found by reserved key, never by name;
--   * an invoice's bill is its total WITH tax (the GST header on the voucher carries the amounts the engine checked).
-- Nothing else: no tax table, no TDS table. The tax lines are ordinary journal lines; TDS is one more journal line and stays on the receipt's allocation.

alter table public.companies add column charge_gst boolean not null default false;

-- ---------------------------------------------------------------------------------------------
-- The system ledgers: every existing company gets each one it does not already have, once
-- ---------------------------------------------------------------------------------------------
-- A company that had already made an ordinary ledger of the same NAME (a "TDS Receivable" set up by hand) keeps it, with its entries: it is ADOPTED as the
-- system ledger rather than duplicated. Then each ledger still missing is added.
update public.ledgers l
   set reserved_key = s.key
  from (values
          ('gst-output-cgst', 'Output CGST'), ('gst-output-sgst', 'Output SGST'), ('gst-output-igst', 'Output IGST'),
          ('gst-input-cgst', 'Input CGST'), ('gst-input-sgst', 'Input SGST'), ('gst-input-igst', 'Input IGST'),
          ('tds-receivable', 'TDS Receivable')) as s(key, name)
 where l.reserved_key is null and l.party_id is null and lower(l.name) = lower(s.name)
   and not exists (select 1 from public.ledgers x where x.company_id = l.company_id and x.reserved_key = s.key);

insert into public.ledgers (id, company_id, name, group_id, is_active, reserved_key)
select gen_random_uuid(), c.id, s.name, g.id, true, s.key
  from public.companies c
 cross join (values
          ('gst-output-cgst', 'Output CGST', 'duties-and-taxes'),
          ('gst-output-sgst', 'Output SGST', 'duties-and-taxes'),
          ('gst-output-igst', 'Output IGST', 'duties-and-taxes'),
          ('gst-input-cgst',  'Input CGST',  'loans-and-advances-asset'),
          ('gst-input-sgst',  'Input SGST',  'loans-and-advances-asset'),
          ('gst-input-igst',  'Input IGST',  'loans-and-advances-asset'),
          ('tds-receivable',  'TDS Receivable', 'loans-and-advances-asset')) as s(key, name, grp)
  join public.account_groups g on g.company_id = c.id and g.reserved_key = s.grp
 where not exists (select 1 from public.ledgers l where l.company_id = c.id and l.reserved_key = s.key)
   and not exists (select 1 from public.ledgers l where l.company_id = c.id and lower(l.name) = lower(s.name));

-- ---------------------------------------------------------------------------------------------
-- The company now carries the switch (loaded, changed and seeded with the rest of the company)
-- ---------------------------------------------------------------------------------------------
create or replace function public.load_masters_json(p_company uuid) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'version', (select c.masters_version from public.companies c where c.id = p_company),
    'company', (select jsonb_build_object('id', c.id, 'name', c.name, 'gstin', c.gstin, 'state_code', c.state_code, 'address', c.address, 'charge_gst', c.charge_gst)
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
               'pincode', p.pincode, 'country', p.country, 'shipping', p.shipping, 'roles', p.roles,
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

create or replace function public.master_apply(
  p_actor uuid, p_company uuid, p_request_id text, p_expected_version bigint, p_change jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_changes jsonb := case when p_change ? 'changes' then p_change -> 'changes' else jsonb_build_array(p_change) end;
  v_one     jsonb;
  v_kind    text;
  v_op      text;
  v_id      uuid;
  v_row     jsonb;
  v_table   text;
  v_version bigint;
  v_before  jsonb;
  v_after   jsonb;
  v_cols    text;
  v_first   jsonb;
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted to change masters');
  end if;
  if jsonb_typeof(v_changes) <> 'array' or jsonb_array_length(v_changes) = 0 then
    perform private.raise_issue('SCHEMA_INVALID', 'A master change names at least one record');
  end if;

  -- Serialise master changes per company and check what the caller validated against is still current.
  select masters_version into v_version from public.companies where id = p_company for update;
  if not found then
    perform private.raise_issue('COMPANY_MISMATCH', format('Company %s not found', p_company));
  end if;
  if v_version <> p_expected_version then
    perform private.raise_issue('MASTERS_CHANGED', 'The masters changed while this was being checked; it will be checked again');
  end if;

  for v_one in select value from jsonb_array_elements(v_changes) loop
    v_kind := v_one ->> 'kind';
    v_op   := v_one ->> 'op';
    v_id   := (v_one ->> 'id')::uuid;
    v_row  := v_one -> 'row';
    v_first := coalesce(v_first, jsonb_build_object('kind', v_kind, 'op', v_op, 'id', v_id));

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
         set name = v_row ->> 'name', gstin = v_row ->> 'gstin', state_code = v_row ->> 'state_code', address = v_row ->> 'address',
             charge_gst = coalesce((v_row ->> 'charge_gst')::boolean, false)
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

    execute format('select to_jsonb(t) from public.%I t where t.id = $1', v_table) into v_after using v_id;
    insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, after, request_id)
    values (p_company, p_actor, 'master.' || v_op, v_kind, v_id, v_before, v_after, p_request_id);
  end loop;

  update public.companies set masters_version = v_version + 1 where id = p_company;
  return v_first || jsonb_build_object('version', v_version + 1);
end
$$;

create or replace function public.company_seed(p_actor uuid, p_request_id text, p_seed jsonb) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_company jsonb := p_seed -> 'company';
  v_id      uuid  := (v_company ->> 'id')::uuid;
begin
  insert into public.companies (id, name, gstin, state_code, address, charge_gst)
  values (v_id, v_company ->> 'name', v_company ->> 'gstin', v_company ->> 'state_code', v_company ->> 'address',
          coalesce((v_company ->> 'charge_gst')::boolean, false));
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
-- The bill mirror: total with tax
-- ---------------------------------------------------------------------------------------------
create or replace function private.sync_bill_allocations() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_kind   text;
  v_gst    numeric;
  v_ledger uuid;
  v_ref    text;
begin
  delete from public.bill_allocations where voucher_id = new.id;
  -- the GST an invoice states (ADR-0019): the header carries the amounts the engine checked, so the mirror adds them and repeats no tax arithmetic
  v_gst := coalesce((new.content #>> '{gst,cgst}')::numeric, 0) + coalesce((new.content #>> '{gst,sgst}')::numeric, 0) + coalesce((new.content #>> '{gst,igst}')::numeric, 0);
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

  -- Sales invoice: Dr the customer's ledger for the total — a new bill, referenced by the invoice number.
  insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, due_date, amount)
  select new.company_id, new.id, l.id, 'debit', 'new', new.number, nullif(new.content ->> 'dueDate', '')::date, t.total + v_gst
    from public.ledgers l
   cross join lateral (
     select coalesce(sum(round((x ->> 'qty')::numeric * (x ->> 'rate')::numeric, 2)), 0) as total
       from jsonb_array_elements(coalesce(new.content -> 'lines', '[]'::jsonb)) x
   ) t
   where v_kind = 'sales'
     and l.company_id = new.company_id
     and l.party_id = (new.content ->> 'partyId')::uuid
     and l.party_role = 'customer'
     and t.total > 0;

-- Purchase invoice: Cr the supplier's ledger for the total — a new bill named by the SUPPLIER'S invoice number (`billNo` on the draft).
  -- A supplier's invoice number is used once: the advisory lock makes two purchases racing for the same number take turns, so the second
  -- sees the first.
  if v_kind = 'purchase' then
    select l.id into v_ledger
      from public.ledgers l
     where l.company_id = new.company_id
       and l.party_id = (new.content ->> 'partyId')::uuid
       and l.party_role = 'vendor';
    v_ref := btrim(new.content ->> 'billNo');
    if v_ledger is not null and v_ref is not null and v_ref <> '' then
      perform pg_advisory_xact_lock(hashtextextended('bill:' || v_ledger::text || '|' || v_ref, 0));
      if exists (select 1 from public.bill_allocations b
                  where b.company_id = new.company_id and b.ledger_id = v_ledger and b.ref = v_ref
                    and b.kind = 'new' and b.voucher_id <> new.id) then
        perform private.raise_issue('BILL_REF_IN_USE',
          format('Invoice %s is already a bill of this supplier: enter the number on this invoice', v_ref));
      end if;
      insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, due_date, amount)
      select new.company_id, new.id, v_ledger, 'credit', 'new', v_ref, nullif(new.content ->> 'dueDate', '')::date, t.total + v_gst
        from (select coalesce(sum(round((x ->> 'qty')::numeric * (x ->> 'rate')::numeric, 2)), 0) as total
                from jsonb_array_elements(coalesce(new.content -> 'lines', '[]'::jsonb)) x) t
       where t.total > 0;
    end if;
  end if;

  return null;
end
$$;

revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function private.has_permission(uuid, text), private.is_member(uuid) to authenticated;
revoke execute on function
  public.master_apply(uuid, uuid, text, bigint, jsonb),
  public.company_seed(uuid, text, jsonb),
  public.load_masters_json(uuid)
from public, anon, authenticated;
grant execute on function
  public.master_apply(uuid, uuid, text, bigint, jsonb),
  public.company_seed(uuid, text, jsonb),
  public.load_masters_json(uuid)
to service_role;
