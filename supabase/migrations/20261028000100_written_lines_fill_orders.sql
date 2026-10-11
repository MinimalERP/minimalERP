-- A ONE-TIME (written) line on an invoice may fill the WRITTEN line of the order it was ordered on, line by line like an item. Until now
-- nothing was counted against an order's written line: it never showed as pending, and an order of written lines alone stayed open for ever.
--
-- A written line names no item and moves no stock, so its delivery (or receipt) is a voucher_links row with NO item and no stock movement
-- behind it — the same shape as a service's delivery (20261025000100), told apart by the missing item. For goods and services nothing changes.

alter table public.voucher_links alter column item_id drop not null;

-- assert_order_sound is the one of 20260927000100_purchase_phase8 with a written line's delivery matched to a written line of the order
-- (a line of the order with no itemId), and to nothing else.
create or replace function private.assert_order_sound(p_company uuid, p_order uuid) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_bad   record;
begin
  perform pg_advisory_xact_lock(hashtextextended('order:' || p_order::text, 0));
  if not exists (select 1 from public.voucher_links where company_id = p_company and order_id = p_order) then
    return;
  end if;

  select v.status, v.content, t.base_kind
    into v_order
    from public.vouchers v
    join public.voucher_types t on t.id = v.voucher_type_id and t.company_id = v.company_id
   where v.company_id = p_company and v.id = p_order;
  if not found or v_order.base_kind not in ('salesOrder', 'purchaseOrder') or v_order.status <> 'posted' then
    perform private.raise_issue('ORDER_REF_INVALID',
      format('Deliveries point at %s, which is not a posted sales or purchase order', p_order));
  end if;
  -- a sales invoice delivers against a sales order, a purchase invoice receives against a purchase order — never across
  if exists (select 1
               from public.voucher_links k
               join public.vouchers iv on iv.id = k.voucher_id and iv.company_id = k.company_id
               join public.voucher_types it on it.id = iv.voucher_type_id and it.company_id = iv.company_id
              where k.company_id = p_company and k.order_id = p_order
                and it.base_kind <> case v_order.base_kind when 'salesOrder' then 'sales' else 'purchase' end) then
    perform private.raise_issue('ORDER_REF_INVALID',
      format('Order %s (%s) is filled by an invoice of the other side', p_order, v_order.base_kind));
  end if;

  select d.line_id, d.delivered, o.ordered, d.item_min, d.item_max, o.item_id
    into v_bad
    from (select order_line_id as line_id, sum(qty) as delivered,
                 min(coalesce(item_id::text, '')) as item_min, max(coalesce(item_id::text, '')) as item_max
            from public.voucher_links
           where company_id = p_company and order_id = p_order
           group by order_line_id) d
    -- a written line of the order names no item: '' on both sides, so only a written line's delivery matches it
    left join (select l ->> 'id' as line_id, (l ->> 'qty')::numeric as ordered, coalesce(l ->> 'itemId', '') as item_id
                 from jsonb_array_elements(coalesce(v_order.content -> 'lines', '[]'::jsonb)) l) o
           on o.line_id = d.line_id
   where o.line_id is null or d.delivered > o.ordered or d.item_min <> o.item_id or d.item_max <> o.item_id
   limit 1;
  if found then
    if v_bad.ordered is null then
      perform private.raise_issue('ORDER_REF_INVALID', format('Order %s has no line %s any more', p_order, v_bad.line_id));
    elsif v_bad.delivered > v_bad.ordered then
      perform private.raise_issue('OVER_DELIVERY',
        format('Line %s of order %s: %s delivered against %s ordered', v_bad.line_id, p_order, v_bad.delivered, v_bad.ordered));
    else
      perform private.raise_issue('ORDER_REF_INVALID', format('Line %s of order %s is for another item, or is a written line', v_bad.line_id, p_order));
    end if;
  end if;
end
$$;

-- assert_voucher_consistent is the one of 20261027000100_credit_debit_notes with a delivery that names no item treated like a service's:
-- it sits on no stock line.
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
  elsif v.status = 'posted' and v_kind in ('sales', 'purchase', 'creditNote', 'debitNote') then
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
                where s.voucher_id = p_voucher and s.direction <> case when v_kind in ('sales', 'debitNote') then 'out' else 'in' end) then
      raise exception using errcode = 'check_violation', message = 'STOCK_LINE_INVALID',
        detail = format('Voucher %s moves stock the wrong way: a sales invoice and a debit note take goods out, a purchase invoice and a credit note bring them in', p_voucher);
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
  -- a service, or a written line (no item): nothing moves, so its delivery sits on no stock line at all.
  if exists (select 1 from public.voucher_links k
               left join public.stock_movements s on s.voucher_id = k.voucher_id and s.line_no = k.line_no
              where k.voucher_id = p_voucher
                and case when k.item_id is null or private.is_service_item(k.company_id, k.item_id::text)
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
