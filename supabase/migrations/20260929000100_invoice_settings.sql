-- Invoice / PDF Settings: fixed, company-level content a Sales/Purchase invoice print carries — phone, email, bank
-- details, a thank-you note and terms text (ADR-0022). All nullable: a company that never sets these prints without
-- that block, never with blanks. Everything transaction-specific (party, items, amounts, dates, GST figures) still
-- comes from the voucher and the masters exactly as before; only this fixed content is new.

alter table public.companies
  add column phone           text,
  add column email           text,
  add column bank_name       text,
  add column bank_account_no text,
  add column bank_ifsc       text,
  add column bank_branch     text,
  add column invoice_note    text,
  add column invoice_terms   text;

-- ---------------------------------------------------------------------------------------------
-- load_masters_json: the company object carries the new fields alongside the ones it always had.
-- ---------------------------------------------------------------------------------------------
create or replace function public.load_masters_json(p_company uuid) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'version', (select c.masters_version from public.companies c where c.id = p_company),
    'company', (select jsonb_build_object(
                  'id', c.id, 'name', c.name, 'gstin', c.gstin, 'state_code', c.state_code, 'address', c.address, 'charge_gst', c.charge_gst,
                  'phone', c.phone, 'email', c.email, 'bank_name', c.bank_name, 'bank_account_no', c.bank_account_no,
                  'bank_ifsc', c.bank_ifsc, 'bank_branch', c.bank_branch, 'invoice_note', c.invoice_note, 'invoice_terms', c.invoice_terms)
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

-- ---------------------------------------------------------------------------------------------
-- master_apply: the hand-written company update carries the new fields too (company is not part of
-- the generic per-table upsert other master kinds use).
-- ---------------------------------------------------------------------------------------------
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
             charge_gst = coalesce((v_row ->> 'charge_gst')::boolean, false),
             phone = v_row ->> 'phone', email = v_row ->> 'email',
             bank_name = v_row ->> 'bank_name', bank_account_no = v_row ->> 'bank_account_no',
             bank_ifsc = v_row ->> 'bank_ifsc', bank_branch = v_row ->> 'bank_branch',
             invoice_note = v_row ->> 'invoice_note', invoice_terms = v_row ->> 'invoice_terms'
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
