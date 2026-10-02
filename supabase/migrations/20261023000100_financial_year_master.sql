-- A financial year becomes a master a person can add (Settings → Financial Years): the year after the last one, or an
-- EARLIER year, to bring in a previous year's books (say, its invoices from another system). The domain decides whether a
-- year may be added (adjacent to the years already there, never overlapping, dates fixed once made) and brings a numbering
-- series for every voucher type in the same change; master_apply only stores it. Same permission as every other master
-- change (master.write). master_apply is the one of 20261008000100_email_templates with 'financialYear' added.

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
      when 'financialYear'   then 'financial_years'
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
             invoice_note = v_row ->> 'invoice_note', invoice_terms = v_row ->> 'invoice_terms',
             email_templates = case when jsonb_typeof(v_row -> 'email_templates') = 'object' then v_row -> 'email_templates' end
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
