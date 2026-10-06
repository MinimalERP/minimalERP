-- A SERVICE item on an invoice may fill the order line it was ordered on. An order takes service items (job work, modification charges),
-- and until now the invoice that bills them could not be against the order: the order stayed open for ever. A service holds no stock, so
-- its delivery (or receipt) is recorded in voucher_links with NO stock movement behind it.
--
-- For GOODS nothing changes: a delivery still is the stock movement on its own invoice line (same item, same quantity, out for a sale, in
-- for a purchase). The foreign key that said so for every link is replaced by the same rule in assert_voucher_consistent, which now tells
-- the two apart by the item's type. The same function also stops counting an invoice's service lines as lines that must move stock: an
-- invoice of service lines alone moves none (the domain already accepted it; the database refused it).

create function private.is_service_item(p_company uuid, p_item text) returns boolean
language sql stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.stock_items i where i.company_id = p_company and i.id::text = p_item and i.item_type = 'service')
$$;
revoke all on function private.is_service_item(uuid, text) from public, anon, authenticated;
grant execute on function private.is_service_item(uuid, text) to service_role;

alter table public.voucher_links drop constraint link_stock_fk;

-- assert_voucher_consistent is the one of 20261024000100_written_delivery_challan with the service rules above.
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
  if v.status = 'posted' and v_kind in ('stockJournal', 'stockOpening', 'deliveryChallan', 'returnableChallan') then
    if v_kind = 'deliveryChallan' then
      select count(*) into v_items
        from jsonb_array_elements(coalesce(v.content -> 'lines', '[]'::jsonb)) x
        join public.stock_items i on i.id = (x ->> 'itemId')::uuid and i.company_id = v.company_id
       where x ? 'itemId' and i.item_type <> 'service';
    else
      v_items := 1;
    end if;
    if v_stock < 1 and v_items > 0 then
      raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
        detail = format('Posted stock voucher %s has no stock lines', p_voucher);
    end if;
    if v_count > 0 then
      raise exception using errcode = 'check_violation', message = 'PLAN_UNBALANCED',
        detail = format('Stock voucher %s has %s journal line(s); a stock voucher has no accounting effect', p_voucher, v_count);
    end if;
    if v_kind = 'deliveryChallan' and v_items = 0 and v_stock > 0 then
      raise exception using errcode = 'check_violation', message = 'PLAN_INCONSISTENT_LINES',
        detail = format('Written or service-only challan %s cannot move stock', p_voucher);
    end if;
    if v_kind = 'deliveryChallan' and exists (select 1 from public.stock_movements s where s.voucher_id = p_voucher and s.direction <> 'out') then
      raise exception using errcode = 'check_violation', message = 'STOCK_LINE_INVALID',
        detail = format('Delivery challan %s brings stock in: a challan sends goods out', p_voucher);
    end if;
    -- a returnable challan sends goods out; its return (it names the challan) brings them back in
    if v_kind = 'returnableChallan' and exists (
         select 1 from public.stock_movements s
          where s.voucher_id = p_voucher and s.direction <> case when v.content ? 'returnOf' then 'in' else 'out' end) then
      raise exception using errcode = 'check_violation', message = 'STOCK_LINE_INVALID',
        detail = format('Returnable challan %s moves stock the wrong way: out when sent, in when it comes back', p_voucher);
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
    select count(*) into v_items from jsonb_array_elements(coalesce(v.content -> 'lines', '[]'::jsonb)) x
     where x ? 'itemId' and not x ? 'challanRef' and not private.is_service_item(v.company_id, x ->> 'itemId');
    if v_items > 0 and v_stock < 1 then
      raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
        detail = format('Posted invoice %s has item lines but no stock lines', p_voucher);
    end if;
    if v_items = 0 and v_stock > 0 then
      raise exception using errcode = 'check_violation', message = 'PLAN_INCONSISTENT_LINES',
        detail = format('Invoice %s has only written or service lines but moves stock', p_voucher);
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
  -- goods: a delivery (or receipt) IS the stock movement on its own invoice line — same item, same quantity, the right way.
  -- a service: nothing moves, so its delivery sits on no stock line at all.
  if exists (select 1 from public.voucher_links k
               left join public.stock_movements s on s.voucher_id = k.voucher_id and s.line_no = k.line_no
              where k.voucher_id = p_voucher
                and case when private.is_service_item(k.company_id, k.item_id::text)
                         then s.voucher_id is not null
                         else s.voucher_id is null or s.direction <> case v_kind when 'purchase' then 'in' else 'out' end or s.item_id <> k.item_id or s.qty <> k.qty
                    end) then
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
