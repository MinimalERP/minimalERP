-- Credit Note and Debit Note (ADR-0026): an invoice taken back, in whole or in part.
--   Credit Note (Transactions › Sales, CN/ series): we credit a customer — the reverse of a Sales Invoice. Dr sales and Output GST / Cr the
--     customer; the goods it names come back IN to stock.
--   Debit Note (Transactions › Purchase, DN/ series): we debit a supplier — the reverse of a Purchase Invoice. Dr the supplier / Cr purchases
--     and Input GST; the goods it names go OUT of stock.
-- A note may name the invoice it is for and say how much of it is set against that invoice's bill; the rest is a bill of its own on the
-- other side of the party's ledger. No table is added: two voucher kinds, their permissions, types and number series, the stock direction
-- in the voucher invariant, and the two bill rows in the bill mirror.

alter table public.voucher_types drop constraint voucher_types_base_kind_check;
alter table public.voucher_types
  add constraint voucher_types_base_kind_check
  check (base_kind in ('contra', 'payment', 'receipt', 'journal', 'opening', 'stockJournal', 'stockOpening', 'sales', 'salesOrder', 'quotation', 'purchase', 'purchaseOrder', 'deliveryChallan', 'returnableChallan', 'creditNote', 'debitNote'));

-- owner, accountant and the company's member may post, alter and cancel them; a clerk may post them
insert into public.role_permissions (role, permission)
  select r.role, 'voucher.' || k.kind || '.' || a.action
    from (values ('owner'), ('accountant'), ('member')) as r(role)
   cross join (values ('creditNote'), ('debitNote')) as k(kind)
   cross join (values ('post'), ('alter'), ('cancel')) as a(action)
  union all
  select 'clerk', 'voucher.' || k.kind || '.post'
    from (values ('creditNote'), ('debitNote')) as k(kind);

-- every existing company gets the two types (a company that already made one by hand, or uses the name, keeps its own)
insert into public.voucher_types (id, company_id, name, base_kind, is_system, is_active)
  select gen_random_uuid(), c.id, t.name, t.kind, true, true
    from public.companies c
   cross join (values ('creditNote', 'Credit Note'), ('debitNote', 'Debit Note')) as t(kind, name)
   where not exists (select 1 from public.voucher_types x where x.company_id = c.id and x.base_kind = t.kind)
     and not exists (select 1 from public.voucher_types x where x.company_id = c.id and lower(x.name) = lower(t.name));

insert into public.numbering_series (company_id, voucher_type_id, financial_year_id, prefix, suffix, width, start_at, next_value)
  select vt.company_id, vt.id, fy.id,
         case vt.base_kind when 'creditNote' then 'CN/' else 'DN/' end
           || case when extract(year from fy.start_date) = extract(year from fy.end_date)
                   then to_char(fy.start_date, 'YY')
                   else to_char(fy.start_date, 'YY') || '-' || to_char(fy.end_date, 'YY') end || '/',
         '', 4, 1, 1
    from public.voucher_types vt
    join public.financial_years fy on fy.company_id = vt.company_id
   where vt.base_kind in ('creditNote', 'debitNote')
     and not exists (
       select 1 from public.numbering_series s
        where s.company_id = vt.company_id and s.voucher_type_id = vt.id and s.financial_year_id = fy.id);

-- ---------------------------------------------------------------------------------------------
-- The voucher invariant: a note is an invoice turned round — a balanced journal of at least two lines, stock only for the stock items it
-- names, IN on a credit note and OUT on a debit note, and never a delivery against an order. This is the function of
-- 20261025000100_service_lines_fill_orders with the two kinds added to the invoice branch.
-- ---------------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------------
-- The bill mirror: the function of 20261005000100_round_off with a note's two rows added.
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
  v_total   numeric;
  v_against numeric;
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

  -- Sales invoice: Dr the customer's ledger for the total, ROUNDED to the nearest rupee — a new bill, referenced by the invoice number.
  insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, due_date, amount)
  select new.company_id, new.id, l.id, 'debit', 'new', new.number, nullif(new.content ->> 'dueDate', '')::date, round(t.total + v_gst)
    from public.ledgers l
   cross join lateral (
     select coalesce(sum(round((x ->> 'qty')::numeric * (x ->> 'rate')::numeric, 2)), 0) as total
       from jsonb_array_elements(coalesce(new.content -> 'lines', '[]'::jsonb)) x
   ) t
   where v_kind = 'sales'
     and l.company_id = new.company_id
     and l.party_id = (new.content ->> 'partyId')::uuid
     and l.party_role = 'customer'
     and round(t.total + v_gst) > 0;

-- Purchase invoice: Cr the supplier's ledger for the total, ROUNDED to the nearest rupee — a new bill named by the SUPPLIER'S invoice number (`billNo` on the draft).
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
      select new.company_id, new.id, v_ledger, 'credit', 'new', v_ref, nullif(new.content ->> 'dueDate', '')::date, round(t.total + v_gst)
        from (select coalesce(sum(round((x ->> 'qty')::numeric * (x ->> 'rate')::numeric, 2)), 0) as total
                from jsonb_array_elements(coalesce(new.content -> 'lines', '[]'::jsonb)) x) t
       where round(t.total + v_gst) > 0;
    end if;
  end if;

  -- Credit Note / Debit Note: the other side of the party's ledger from its invoices (Cr the customer, Dr the supplier), for the total ROUNDED
  -- like an invoice's. The part set against the invoice it names (`against`, never more than the note) settles that invoice's bill; the rest
  -- is a bill of the note's own, named by its number. The split is the one `noteSettlementOf` (packages/domain/src/vouchers/kinds/notes.ts)
  -- reads — keep the two in sync.
  if v_kind in ('creditNote', 'debitNote') then
    select l.id into v_ledger
      from public.ledgers l
     where l.company_id = new.company_id
       and l.party_id = (new.content ->> 'partyId')::uuid
       and l.party_role = case v_kind when 'creditNote' then 'customer' else 'vendor' end;
    select round(coalesce(sum(round((x ->> 'qty')::numeric * (x ->> 'rate')::numeric, 2)), 0) + v_gst) into v_total
      from jsonb_array_elements(coalesce(new.content -> 'lines', '[]'::jsonb)) x;
    v_ref := nullif(btrim(new.content ->> 'invoiceRef'), '');
    v_against := case when v_ref is null then 0
                      else least(greatest(coalesce((new.content ->> 'against')::numeric, 0), 0), v_total) end;
    if v_ledger is not null then
      insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, due_date, amount)
      select new.company_id, new.id, v_ledger, case v_kind when 'creditNote' then 'credit' else 'debit' end, 'against', v_ref, null, v_against
       where v_against > 0;
      insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, due_date, amount)
      select new.company_id, new.id, v_ledger, case v_kind when 'creditNote' then 'credit' else 'debit' end, 'new', new.number, null, v_total - v_against
       where v_total - v_against > 0;
    end if;
  end if;

  return null;
end
$$;
