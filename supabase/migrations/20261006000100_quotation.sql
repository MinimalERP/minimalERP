-- Quotations (ADR-0015 deferred item): a sales-side document that posts nothing — items, quantities and rates for the customer to read.

alter table public.voucher_types drop constraint voucher_types_base_kind_check;
alter table public.voucher_types
  add constraint voucher_types_base_kind_check
  check (base_kind in ('contra', 'payment', 'receipt', 'journal', 'opening', 'stockJournal', 'stockOpening', 'sales', 'salesOrder', 'quotation', 'purchase', 'purchaseOrder'));

insert into public.role_permissions (role, permission)
  select r.role, 'voucher.quotation.' || a.action
    from (values ('owner'), ('accountant')) as r(role)
   cross join (values ('post'), ('alter'), ('cancel')) as a(action)
  union all
  select 'clerk', 'voucher.quotation.post';

insert into public.voucher_types (id, company_id, name, base_kind, is_system, is_active)
  select gen_random_uuid(), c.id, 'Quotation', 'quotation', true, true
    from public.companies c
   where not exists (select 1 from public.voucher_types x where x.company_id = c.id and x.base_kind = 'quotation')
     and not exists (select 1 from public.voucher_types x where x.company_id = c.id and lower(x.name) = 'quotation');

insert into public.numbering_series (company_id, voucher_type_id, financial_year_id, prefix, suffix, width, start_at, next_value)
  select vt.company_id, vt.id, fy.id,
         'QT/'
           || case when extract(year from fy.start_date) = extract(year from fy.end_date)
                   then to_char(fy.start_date, 'YY')
                   else to_char(fy.start_date, 'YY') || '-' || to_char(fy.end_date, 'YY') end || '/',
         '', 4, 1, 1
    from public.voucher_types vt
    join public.financial_years fy on fy.company_id = vt.company_id
   where vt.base_kind = 'quotation'
     and not exists (
       select 1 from public.numbering_series s
        where s.company_id = vt.company_id and s.voucher_type_id = vt.id and s.financial_year_id = fy.id);

-- Document kinds: no journal, no stock, no delivery links when posted.
create or replace function private.assert_voucher_consistent(p_voucher uuid) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v        public.vouchers;
  v_fy     public.financial_years;
  v_kind   text;
  v_count  int;
  v_stock  int;
  v_links  int;
  v_debit  numeric;
  v_credit numeric;
  v_bad    int;
  v_items  int;
begin
  select * into v from public.vouchers where id = p_voucher;
  if not found then
    return;
  end if;
  select base_kind into v_kind from public.voucher_types where id = v.voucher_type_id and company_id = v.company_id;

  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_count, v_debit, v_credit
    from public.journal_lines where voucher_id = p_voucher;
  select count(*) into v_stock from public.stock_movements where voucher_id = p_voucher;
  select count(*) into v_links from public.voucher_links where voucher_id = p_voucher;

  if v_debit <> v_credit then
    raise exception using errcode = 'check_violation', message = 'PLAN_UNBALANCED',
      detail = format('Voucher %s: total debit %s does not equal total credit %s', p_voucher, v_debit, v_credit);
  end if;
  if v.status = 'posted' and v_kind in ('stockJournal', 'stockOpening') then
    if v_stock < 1 then
      raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
        detail = format('Posted stock voucher %s has no stock lines', p_voucher);
    end if;
    if v_count > 0 then
      raise exception using errcode = 'check_violation', message = 'PLAN_UNBALANCED',
        detail = format('Stock voucher %s has %s journal line(s); a stock voucher has no accounting effect', p_voucher, v_count);
    end if;
  elsif v.status = 'posted' and v_kind in ('salesOrder', 'purchaseOrder', 'quotation') then
    if v_count > 0 or v_stock > 0 then
      raise exception using errcode = 'check_violation', message = 'PLAN_INCONSISTENT_LINES',
        detail = format('Order %s has %s journal and %s stock line(s); a document posts none', p_voucher, v_count, v_stock);
    end if;
  elsif v.status = 'posted' and v_kind in ('sales', 'purchase') then
    if v_count < 2 then
      raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
        detail = format('Posted invoice %s has %s journal line(s); at least two are required', p_voucher, v_count);
    end if;
    select count(*) into v_items from jsonb_array_elements(coalesce(v.content -> 'lines', '[]'::jsonb)) x where x ? 'itemId';
    if v_items > 0 and v_stock < 1 then
      raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
        detail = format('Posted invoice %s has item lines but no stock lines', p_voucher);
    end if;
    if v_items = 0 and v_stock > 0 then
      raise exception using errcode = 'check_violation', message = 'PLAN_INCONSISTENT_LINES',
        detail = format('Invoice %s has only written lines but moves stock', p_voucher);
    end if;
    if exists (select 1 from public.stock_movements s
                where s.voucher_id = p_voucher and s.direction <> case v_kind when 'sales' then 'out' else 'in' end) then
      raise exception using errcode = 'check_violation', message = 'STOCK_LINE_INVALID',
        detail = format('Invoice %s moves stock the wrong way: a sales invoice takes goods out, a purchase invoice brings them in', p_voucher);
    end if;
  elsif v.status = 'posted' then
    if v_count < 2 then
      raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
        detail = format('Posted voucher %s has %s journal line(s); at least two are required', p_voucher, v_count);
    end if;
    if v_stock > 0 then
      raise exception using errcode = 'check_violation', message = 'STOCK_LINE_INVALID',
        detail = format('Voucher %s is an accounting voucher and cannot move stock', p_voucher);
    end if;
  end if;
  if v.status = 'cancelled' and (v_count > 0 or v_stock > 0 or v_links > 0) then
    raise exception using errcode = 'check_violation', message = 'CANCELLED_WITH_LINES',
      detail = format('Cancelled voucher %s still has %s journal, %s stock and %s delivery line(s)', p_voucher, v_count, v_stock, v_links);
  end if;
  if v_links > 0 and v_kind not in ('sales', 'purchase') then
    raise exception using errcode = 'check_violation', message = 'PLAN_INCONSISTENT_LINES',
      detail = format('Voucher %s is not an invoice and cannot deliver against an order', p_voucher);
  end if;
  if exists (select 1 from public.voucher_links k
               join public.stock_movements s on s.voucher_id = k.voucher_id and s.line_no = k.line_no
              where k.voucher_id = p_voucher
                and (s.direction <> case v_kind when 'purchase' then 'in' else 'out' end or s.item_id <> k.item_id or s.qty <> k.qty)) then
    raise exception using errcode = 'check_violation', message = 'PLAN_INCONSISTENT_LINES',
      detail = format('A delivery or receipt on voucher %s does not match the stock on its line', p_voucher);
  end if;

  select (select count(*) from public.journal_lines l
           where l.voucher_id = p_voucher and (l.entry_date <> v.voucher_date or l.financial_year_id <> v.financial_year_id))
       + (select count(*) from public.stock_movements s
           where s.voucher_id = p_voucher and (s.entry_date <> v.voucher_date or s.financial_year_id <> v.financial_year_id))
       + (select count(*) from public.voucher_links k
           where k.voucher_id = p_voucher and k.entry_date <> v.voucher_date)
    into v_bad;
  if v_bad > 0 then
    raise exception using errcode = 'check_violation', message = 'LINE_DATE_MISMATCH',
      detail = format('Voucher %s has lines whose date or financial year differ from the voucher', p_voucher);
  end if;

  select * into v_fy from public.financial_years where id = v.financial_year_id;
  if v.voucher_date < v_fy.start_date or v.voucher_date > v_fy.end_date then
    raise exception using errcode = 'check_violation', message = 'DATE_OUTSIDE_FINANCIAL_YEAR',
      detail = format('Voucher %s is dated %s, outside financial year %s', p_voucher, v.voucher_date, v_fy.label);
  end if;
end
$$;

create or replace function public.post_voucher_atomic(
  p_actor uuid, p_company uuid, p_request_id text, p_voucher jsonb, p_journal jsonb,
  p_stock jsonb default '[]'::jsonb, p_links jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id      uuid  := (p_voucher ->> 'id')::uuid;
  v_type_id uuid  := (p_voucher ->> 'voucher_type_id')::uuid;
  v_fy_id   uuid  := (p_voucher ->> 'financial_year_id')::uuid;
  v_date    date  := (p_voucher ->> 'date')::date;
  v_content jsonb := p_voucher -> 'content';
  v_type     public.voucher_types;
  v_fy       public.financial_years;
  v_series   public.numbering_series;
  v_existing public.vouchers;
  v_seq      bigint;
  v_number   text;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));

  select * into v_type from public.voucher_types where id = v_type_id and company_id = p_company;
  if not found then
    perform private.raise_issue('VOUCHER_TYPE_UNKNOWN', format('Unknown voucher type %s', v_type_id));
  end if;
  if not private.actor_has_permission(p_actor, p_company, 'voucher.' || v_type.base_kind || '.post') then
    perform private.raise_issue('PERMISSION_DENIED', format('Not permitted to post %s vouchers', v_type.base_kind));
  end if;

  select * into v_existing from public.vouchers where id = v_id;
  if found then
    if v_existing.company_id = p_company and v_existing.voucher_type_id = v_type_id and v_existing.content = v_content then
      return private.voucher_result(v_id, true);
    end if;
    perform private.raise_issue('IDEMPOTENCY_CONFLICT', format('Voucher id %s was already used for a different voucher', v_id));
  end if;

  select * into v_fy from public.financial_years where id = v_fy_id and company_id = p_company;
  if not found or v_date < v_fy.start_date or v_date > v_fy.end_date then
    perform private.raise_issue('DATE_OUTSIDE_FINANCIAL_YEAR', format('%s is outside the voucher''s financial year', v_date));
  end if;
  perform private.assert_period_open(v_fy_id, v_date);
  perform private.assert_plan_shape(p_journal, p_stock, v_type.base_kind in ('salesOrder', 'purchaseOrder', 'quotation'));

  select * into v_series from public.numbering_series
   where company_id = p_company and voucher_type_id = v_type_id and financial_year_id = v_fy_id
   for update;
  if not found then
    perform private.raise_issue('NUMBERING_SERIES_MISSING',
      format('No numbering series for "%s" in %s', v_type.name, v_fy.label));
  end if;
  v_seq := v_series.next_value;
  update public.numbering_series set next_value = v_seq + 1 where id = v_series.id;
  v_number := v_series.prefix
              || repeat('0', greatest(v_series.width - length(v_seq::text), 0)) || v_seq::text
              || v_series.suffix;

  insert into public.vouchers
         (id, company_id, voucher_type_id, financial_year_id, series_id, number, voucher_date,
          status, version, revision, content, created_by)
  values (v_id, p_company, v_type_id, v_fy_id, v_series.id, v_number, v_date,
          'posted', 1, 0, v_content, p_actor);

  perform private.insert_journal(p_company, v_id, v_date, v_fy_id, p_journal);
  perform private.insert_stock(p_company, v_id, v_date, v_fy_id, p_stock);
  perform private.insert_links(p_company, v_id, v_date, p_links);

  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, after, request_id)
  values (p_company, p_actor, 'voucher.post', 'voucher', v_id,
          jsonb_build_object('number', v_number, 'date', v_date, 'version', 1, 'voucher_type_id', v_type_id),
          p_request_id);

  return private.voucher_result(v_id, false);
end
$$;

create or replace function public.alter_voucher_atomic(
  p_actor uuid, p_company uuid, p_request_id text, p_voucher_id uuid, p_expected_version int,
  p_voucher jsonb, p_journal jsonb, p_stock jsonb default '[]'::jsonb, p_links jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old     public.vouchers;
  v_type    public.voucher_types;
  v_fy      public.financial_years;
  v_date    date  := (p_voucher ->> 'date')::date;
  v_content jsonb := p_voucher -> 'content';
  v_snapshot jsonb;
begin
  select * into v_old from public.vouchers where id = p_voucher_id and company_id = p_company for update;
  if not found then
    perform private.raise_issue('VOUCHER_NOT_FOUND', format('Voucher %s not found', p_voucher_id));
  end if;

  select * into v_type from public.voucher_types where id = v_old.voucher_type_id;
  if not private.actor_has_permission(p_actor, p_company, 'voucher.' || v_type.base_kind || '.alter') then
    perform private.raise_issue('PERMISSION_DENIED', format('Not permitted to alter %s vouchers', v_type.base_kind));
  end if;
  if v_old.status <> 'posted' then
    perform private.raise_issue('VOUCHER_NOT_POSTED', format('Voucher %s is %s', v_old.number, v_old.status));
  end if;
  if v_old.version <> p_expected_version then
    perform private.raise_issue('VERSION_CONFLICT',
      format('Voucher %s was changed by someone else (version %s, you had %s)', v_old.number, v_old.version, p_expected_version));
  end if;
  if (p_voucher ->> 'voucher_type_id')::uuid <> v_old.voucher_type_id then
    perform private.raise_issue('VOUCHER_TYPE_CHANGED', 'A posted voucher cannot change its voucher type');
  end if;
  if (p_voucher ->> 'financial_year_id')::uuid <> v_old.financial_year_id then
    perform private.raise_issue('FINANCIAL_YEAR_CHANGED', 'An alteration cannot move a voucher into another financial year');
  end if;

  select * into v_fy from public.financial_years where id = v_old.financial_year_id;
  if v_date < v_fy.start_date or v_date > v_fy.end_date then
    perform private.raise_issue('DATE_OUTSIDE_FINANCIAL_YEAR', format('%s is outside the voucher''s financial year', v_date));
  end if;
  perform private.assert_period_open(v_old.financial_year_id, v_old.voucher_date);
  perform private.assert_period_open(v_old.financial_year_id, v_date);
  perform private.assert_plan_shape(p_journal, p_stock, v_type.base_kind in ('salesOrder', 'purchaseOrder', 'quotation'));

  v_snapshot := private.voucher_result(v_old.id, false) - 'replayed';
  insert into public.voucher_revisions (company_id, voucher_id, version, reason, snapshot)
  values (p_company, v_old.id, v_old.version, 'alter', v_snapshot);

  delete from public.voucher_links where voucher_id = v_old.id;
  delete from public.journal_lines where voucher_id = v_old.id;
  delete from public.stock_movements where voucher_id = v_old.id;
  update public.vouchers
     set voucher_date = v_date, content = v_content,
         version = version + 1, revision = revision + 1, updated_at = now()
   where id = v_old.id;
  perform private.insert_journal(p_company, v_old.id, v_date, v_old.financial_year_id, p_journal);
  perform private.insert_stock(p_company, v_old.id, v_date, v_old.financial_year_id, p_stock);
  perform private.insert_links(p_company, v_old.id, v_date, p_links);

  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, after, request_id)
  values (p_company, p_actor, 'voucher.alter', 'voucher', v_old.id,
          jsonb_build_object('number', v_old.number, 'date', v_old.voucher_date, 'version', v_old.version),
          jsonb_build_object('number', v_old.number, 'date', v_date, 'version', v_old.version + 1),
          p_request_id);

  return private.voucher_result(v_old.id, false);
end
$$;

grant execute on function
  public.post_voucher_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.alter_voucher_atomic(uuid, uuid, text, uuid, int, jsonb, jsonb, jsonb, jsonb)
to service_role;
