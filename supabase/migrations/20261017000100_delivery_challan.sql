-- The Delivery Challan: goods sent out without a bill — to a customer, to be invoiced later, or free of cost. One voucher type and one number
-- series whatever the purpose (the purpose is in the voucher's content). It takes the goods OUT of stock and posts nothing to the accounts:
-- a stock voucher, like the Stock Journal, whose movements only ever go out.

alter table public.voucher_types drop constraint voucher_types_base_kind_check;
alter table public.voucher_types
  add constraint voucher_types_base_kind_check
  check (base_kind in ('contra', 'payment', 'receipt', 'journal', 'opening', 'stockJournal', 'stockOpening', 'sales', 'salesOrder', 'quotation', 'purchase', 'purchaseOrder', 'deliveryChallan'));

-- owner, accountant and the company's member may post, alter and cancel challans; a clerk may post them
insert into public.role_permissions (role, permission)
  select r.role, 'voucher.deliveryChallan.' || a.action
    from (values ('owner'), ('accountant'), ('member')) as r(role)
   cross join (values ('post'), ('alter'), ('cancel')) as a(action)
  union all
  select 'clerk', 'voucher.deliveryChallan.post';

insert into public.voucher_types (id, company_id, name, base_kind, is_system, is_active)
  select gen_random_uuid(), c.id, 'Delivery Challan', 'deliveryChallan', true, true
    from public.companies c
   where not exists (select 1 from public.voucher_types x where x.company_id = c.id and x.base_kind = 'deliveryChallan')
     and not exists (select 1 from public.voucher_types x where x.company_id = c.id and lower(x.name) = 'delivery challan');

insert into public.numbering_series (company_id, voucher_type_id, financial_year_id, prefix, suffix, width, start_at, next_value)
  select vt.company_id, vt.id, fy.id,
         'DC/'
           || case when extract(year from fy.start_date) = extract(year from fy.end_date)
                   then to_char(fy.start_date, 'YY')
                   else to_char(fy.start_date, 'YY') || '-' || to_char(fy.end_date, 'YY') end || '/',
         '', 4, 1, 1
    from public.voucher_types vt
    join public.financial_years fy on fy.company_id = vt.company_id
   where vt.base_kind = 'deliveryChallan'
     and not exists (
       select 1 from public.numbering_series s
        where s.company_id = vt.company_id and s.voucher_type_id = vt.id and s.financial_year_id = fy.id);

-- A challan is a stock voucher: stock lines, no journal — and every line goes out.
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
  if v.status = 'posted' and v_kind in ('stockJournal', 'stockOpening', 'deliveryChallan') then
    if v_stock < 1 then
      raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
        detail = format('Posted stock voucher %s has no stock lines', p_voucher);
    end if;
    if v_count > 0 then
      raise exception using errcode = 'check_violation', message = 'PLAN_UNBALANCED',
        detail = format('Stock voucher %s has %s journal line(s); a stock voucher has no accounting effect', p_voucher, v_count);
    end if;
    if v_kind = 'deliveryChallan' and exists (select 1 from public.stock_movements s where s.voucher_id = p_voucher and s.direction <> 'out') then
      raise exception using errcode = 'check_violation', message = 'STOCK_LINE_INVALID',
        detail = format('Delivery challan %s brings stock in: a challan sends goods out', p_voucher);
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

