-- A Sales Invoice billed against Delivery Challans. An invoice line may name a challan line (content lines[].challanRef): the goods left on
-- the challan, so that line moves NO stock. What is still to invoice on a challan is never stored: it is the challan's quantity minus what
-- the posted sales invoices bill against it, read from their content — so cancelling an invoice makes the challan pending again.
--
-- The domain refuses over-billing, a free-of-cost challan and cancelling an invoiced challan; HERE is the backstop that holds under
-- concurrency: a deferred constraint trigger takes a per-challan advisory lock and re-derives, for every challan an invoice (or a challan
-- itself) touches, that it is a posted sale challan, that every line billed still exists for the same item, and that no line is billed
-- beyond what went out.

create function private.assert_challan_sound(p_company uuid, p_challan uuid) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ch   public.vouchers;
  v_kind text;
  v_bad  record;
begin
  perform pg_advisory_xact_lock(hashtextextended('challan:' || p_challan::text, 0));
  if not exists (
    select 1 from public.vouchers v
      join public.voucher_types t on t.id = v.voucher_type_id
     where v.company_id = p_company and v.status = 'posted' and t.base_kind = 'sales'
       and exists (select 1 from jsonb_array_elements(coalesce(v.content -> 'lines', '[]'::jsonb)) e where e -> 'challanRef' ->> 'challanId' = p_challan::text)) then
    return;
  end if;

  select * into v_ch from public.vouchers where id = p_challan and company_id = p_company;
  select base_kind into v_kind from public.voucher_types where id = v_ch.voucher_type_id;
  if v_ch.id is null or v_ch.status <> 'posted' or v_kind is distinct from 'deliveryChallan' then
    raise exception using errcode = 'check_violation', message = 'ORDER_HAS_DELIVERIES',
      detail = format('Invoices bill challan %s, which is not a posted delivery challan', p_challan);
  end if;
  if v_ch.content ->> 'purpose' is distinct from 'sale' then
    raise exception using errcode = 'check_violation', message = 'ORDER_REF_INVALID',
      detail = format('Challan %s went out free of cost and cannot be invoiced', v_ch.number);
  end if;

  select b.line_id, b.item_id, b.billed, c.item_id as sent_item, c.qty as sent into v_bad
    from (
      select e -> 'challanRef' ->> 'lineId' as line_id, e ->> 'itemId' as item_id, sum((e ->> 'qty')::numeric) as billed
        from public.vouchers v
        join public.voucher_types t on t.id = v.voucher_type_id
        cross join lateral jsonb_array_elements(coalesce(v.content -> 'lines', '[]'::jsonb)) e
       where v.company_id = p_company and v.status = 'posted' and t.base_kind = 'sales'
         and e -> 'challanRef' ->> 'challanId' = p_challan::text
       group by 1, 2
    ) b
    left join lateral (
      select l ->> 'itemId' as item_id, (l ->> 'qty')::numeric as qty
        from jsonb_array_elements(coalesce(v_ch.content -> 'lines', '[]'::jsonb)) l
       where l ->> 'id' = b.line_id
    ) c on true
   where c.item_id is null or c.item_id <> b.item_id or b.billed > c.qty
   limit 1;
  if found then
    raise exception using errcode = 'check_violation', message = 'OVER_DELIVERY',
      detail = format('Line %s of challan %s: %s invoiced against %s sent', v_bad.line_id, v_ch.number, v_bad.billed, coalesce(v_bad.sent, 0));
  end if;
end
$$;

-- Every challan an invoice names (before and after the change), or the challan itself when it is the one changing.
create function private.trg_challan_sound() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_id   uuid;
begin
  select base_kind into v_kind from public.voucher_types where id = new.voucher_type_id;
  if v_kind = 'deliveryChallan' then
    perform private.assert_challan_sound(new.company_id, new.id);
  elsif v_kind = 'sales' then
    for v_id in
      select distinct (e -> 'challanRef' ->> 'challanId')::uuid
        from jsonb_array_elements(coalesce(new.content -> 'lines', '[]'::jsonb) || coalesce(case when tg_op = 'UPDATE' then old.content -> 'lines' end, '[]'::jsonb)) e
       where e -> 'challanRef' ->> 'challanId' is not null
       order by 1
    loop
      perform private.assert_challan_sound(new.company_id, v_id);
    end loop;
  end if;
  return null;
end
$$;

create constraint trigger vouchers_challan_sound
  after insert or update on public.vouchers
  deferrable initially deferred
  for each row execute function private.trg_challan_sound();

-- An invoice's item lines move stock unless they are billed against a challan.
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
    select count(*) into v_items from jsonb_array_elements(coalesce(v.content -> 'lines', '[]'::jsonb)) x where x ? 'itemId' and not x ? 'challanRef';
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

