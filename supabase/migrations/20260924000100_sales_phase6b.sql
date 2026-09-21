-- Phase 6b: Sales Orders and Sales Invoices (ADR-0015).
--
-- A Sales Order is a DOCUMENT: it posts nothing to the journal and nothing to the stock; it records what a customer ordered (items,
-- quantities, rates, a due date on each line, the customer's own PO reference). A Sales Invoice posts Dr customer / Cr sales, takes the goods
-- out of stock (the Phase 6a movements) and — for every line that names an order line — records a DELIVERY against it in `voucher_links`, all
-- in the SAME transaction. What is pending on an order is never stored: it is the order's quantity minus the deliveries against it, read at
-- query time, so cancelling an invoice reopens exactly what it had filled.
--
-- Over-delivery is refused in the domain with a message on the line, and again HERE as the backstop that holds under concurrency: a deferred
-- constraint trigger takes a per-order advisory lock and re-derives, for every line of the order, that the deliveries do not exceed the
-- ordered quantity — so two invoices racing for the same order line cannot both win.

-- ---------------------------------------------------------------------------------------------
-- Two new voucher kinds
-- ---------------------------------------------------------------------------------------------
alter table public.voucher_types drop constraint voucher_types_base_kind_check;
alter table public.voucher_types
  add constraint voucher_types_base_kind_check
  check (base_kind in ('contra', 'payment', 'receipt', 'journal', 'opening', 'stockJournal', 'stockOpening', 'sales', 'salesOrder'));

insert into public.role_permissions (role, permission)
  select r.role, 'voucher.' || k.kind || '.' || a.action
    from (values ('owner'), ('accountant')) as r(role)
   cross join (values ('sales'), ('salesOrder')) as k(kind)
   cross join (values ('post'), ('alter'), ('cancel')) as a(action)
  union all
  select 'clerk', 'voucher.sales.post'
  union all
  select 'clerk', 'voucher.salesOrder.post';

-- Companies that already exist get the two voucher types and their numbering for every financial year they have.
insert into public.voucher_types (id, company_id, name, base_kind, is_system, is_active)
  select gen_random_uuid(), c.id, t.name, t.kind, true, true
    from public.companies c
   cross join (values ('Sales', 'sales'), ('Sales Order', 'salesOrder')) as t(name, kind)
   where not exists (select 1 from public.voucher_types x where x.company_id = c.id and x.base_kind = t.kind)
     and not exists (select 1 from public.voucher_types x where x.company_id = c.id and lower(x.name) = lower(t.name));

insert into public.numbering_series (company_id, voucher_type_id, financial_year_id, prefix, suffix, width, start_at, next_value)
  select vt.company_id, vt.id, fy.id,
         case vt.base_kind when 'sales' then 'SAL/' else 'SO/' end
           || case when extract(year from fy.start_date) = extract(year from fy.end_date)
                   then to_char(fy.start_date, 'YY')
                   else to_char(fy.start_date, 'YY') || '-' || to_char(fy.end_date, 'YY') end || '/',
         '', 4, 1, 1
    from public.voucher_types vt
    join public.financial_years fy on fy.company_id = vt.company_id
   where vt.base_kind in ('sales', 'salesOrder')
     and not exists (
       select 1 from public.numbering_series s
        where s.company_id = vt.company_id and s.voucher_type_id = vt.id and s.financial_year_id = fy.id);

-- ---------------------------------------------------------------------------------------------
-- Deliveries: which invoice line fills which order line
-- ---------------------------------------------------------------------------------------------
create table public.voucher_links (
  id             bigint generated always as identity primary key,
  company_id     uuid not null,
  -- the sales invoice, and the line of it that delivers (the same number as its stock movement)
  voucher_id     uuid not null,
  line_no        int  not null check (line_no >= 1),
  entry_date     date not null,
  -- the sales order, and the line of it (an id chosen when the line was created, kept across alterations)
  order_id       uuid not null,
  order_line_id  text not null check (length(btrim(order_line_id)) > 0),
  item_id        uuid not null,
  qty            numeric(18, 4) not null check (qty > 0),
  unique (voucher_id, line_no),
  constraint link_voucher_fk foreign key (company_id, voucher_id) references public.vouchers (company_id, id),
  constraint link_order_fk   foreign key (company_id, order_id)   references public.vouchers (company_id, id),
  constraint link_item_fk    foreign key (company_id, item_id)    references public.stock_items (company_id, id),
  -- a delivery IS a stock-out: it sits on the movement of the same invoice line
  constraint link_stock_fk   foreign key (voucher_id, line_no)    references public.stock_movements (voucher_id, line_no)
);
create index voucher_links_order_idx on public.voucher_links (company_id, order_id, order_line_id);
create index voucher_links_voucher_idx on public.voucher_links (company_id, voucher_id);

-- ---------------------------------------------------------------------------------------------
-- Integrity
-- ---------------------------------------------------------------------------------------------
-- For one order: every delivery names a real line of it, for the same item, and no line has been delivered more than was ordered.
-- The per-order advisory lock makes concurrent transactions take turns, so both cannot pass against a picture that lacks the other.
create function private.assert_order_sound(p_company uuid, p_order uuid) returns void
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
  if not found or v_order.base_kind <> 'salesOrder' or v_order.status <> 'posted' then
    perform private.raise_issue('ORDER_REF_INVALID',
      format('Deliveries point at %s, which is not a posted sales order', p_order));
  end if;

  select d.line_id, d.delivered, o.ordered, d.item_min, d.item_max, o.item_id
    into v_bad
    from (select order_line_id as line_id, sum(qty) as delivered, min(item_id::text) as item_min, max(item_id::text) as item_max
            from public.voucher_links
           where company_id = p_company and order_id = p_order
           group by order_line_id) d
    left join (select l ->> 'id' as line_id, (l ->> 'qty')::numeric as ordered, l ->> 'itemId' as item_id
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
      perform private.raise_issue('ORDER_REF_INVALID', format('Line %s of order %s is for another item', v_bad.line_id, p_order));
    end if;
  end if;
end
$$;

-- The voucher-level rules, kind-aware:
--   accounting kinds:  at least two journal lines, Dr = Cr, no stock lines, no deliveries
--   stock kinds (stockJournal, stockOpening): at least one stock line and NO journal lines
--   sales invoice:     at least two balanced journal lines AND at least one stock line; deliveries only on it, each on its own stock-out
--   sales order:       a document — no journal lines, no stock lines, no deliveries of its own
--   a cancelled voucher has none of them
--   every line carries its voucher's date and financial year; the voucher's date lies inside its financial year
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
begin
  select * into v from public.vouchers where id = p_voucher;
  if not found then
    return; -- lines cannot outlive their voucher (foreign key); nothing to check
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
  elsif v.status = 'posted' and v_kind = 'salesOrder' then
    if v_count > 0 or v_stock > 0 then
      raise exception using errcode = 'check_violation', message = 'PLAN_INCONSISTENT_LINES',
        detail = format('Sales order %s has %s journal and %s stock line(s); a document posts none', p_voucher, v_count, v_stock);
    end if;
  elsif v.status = 'posted' and v_kind = 'sales' then
    if v_count < 2 then
      raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
        detail = format('Posted invoice %s has %s journal line(s); at least two are required', p_voucher, v_count);
    end if;
    if v_stock < 1 then
      raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
        detail = format('Posted invoice %s has no stock lines', p_voucher);
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
  if v_links > 0 and v_kind <> 'sales' then
    raise exception using errcode = 'check_violation', message = 'PLAN_INCONSISTENT_LINES',
      detail = format('Voucher %s is not a sales invoice and cannot deliver against an order', p_voucher);
  end if;
  if exists (select 1 from public.voucher_links k
               join public.stock_movements s on s.voucher_id = k.voucher_id and s.line_no = k.line_no
              where k.voucher_id = p_voucher and (s.direction <> 'out' or s.item_id <> k.item_id or s.qty <> k.qty)) then
    raise exception using errcode = 'check_violation', message = 'PLAN_INCONSISTENT_LINES',
      detail = format('A delivery on voucher %s does not match the stock going out on its line', p_voucher);
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

-- Checked at COMMIT, once the whole voucher is in place (deferred, like the journal's and the stock's).
create function private.trg_link_consistent() returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.assert_voucher_consistent(new.voucher_id);
    perform private.assert_order_sound(new.company_id, new.order_id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and (old.voucher_id <> new.voucher_id or old.order_id <> new.order_id)) then
    perform private.assert_voucher_consistent(old.voucher_id);
    perform private.assert_order_sound(old.company_id, old.order_id);
  end if;
  return null;
end
$$;
create constraint trigger voucher_links_consistent
  after insert or update or delete on public.voucher_links
  deferrable initially deferred
  for each row execute function private.trg_link_consistent();

-- An order that has deliveries against it cannot be cancelled, lose a delivered line or shrink below it — by any route.
create function private.trg_order_voucher_sound() returns trigger
language plpgsql
as $$
begin
  perform private.assert_order_sound(new.company_id, new.id);
  return null;
end
$$;
create constraint trigger vouchers_order_sound
  after update of content, status on public.vouchers
  deferrable initially deferred
  for each row
  when (old.content is distinct from new.content or old.status is distinct from new.status)
  execute function private.trg_order_voucher_sound();

-- A sales invoice raises a NEW bill on its customer's line, named by the invoice's own number (which only exists once it is posted, so it
-- is derived here, not stored in the draft) and due on the invoice's due date. Its amount is the sum of the lines, each to the paisa.
create or replace function private.sync_bill_allocations() returns trigger
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

  -- Sales invoice: Dr the customer's ledger for the total — a new bill, referenced by the invoice number.
  insert into public.bill_allocations (company_id, voucher_id, ledger_id, side, kind, ref, due_date, amount)
  select new.company_id, new.id, l.id, 'debit', 'new', new.number, nullif(new.content ->> 'dueDate', '')::date, t.total
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
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The write path (replaces the Phase 6a functions: they now carry the deliveries too)
-- ---------------------------------------------------------------------------------------------
create or replace function private.voucher_result(p_voucher uuid, p_replayed boolean) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'replayed', p_replayed,
    'voucher', jsonb_build_object(
      'id', v.id,
      'company_id', v.company_id,
      'voucher_type_id', v.voucher_type_id,
      'financial_year_id', v.financial_year_id,
      'number', v.number,
      'date', v.voucher_date,
      'status', v.status,
      'version', v.version,
      'revision', v.revision,
      'content', v.content
    ),
    'journal', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_no', l.line_no,
               'ledger_id', l.ledger_id,
               'side', case when l.debit > 0 then 'debit' else 'credit' end,
               'amount', (l.debit + l.credit)::text,   -- text: JSON numbers would lose precision
               'narration', l.narration
             ) order by l.line_no)
        from public.journal_lines l
       where l.voucher_id = v.id
    ), '[]'::jsonb),
    'stock', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_no', s.line_no,
               'item_id', s.item_id,
               'warehouse_id', s.warehouse_id,
               'direction', s.direction,
               'qty', s.qty::text,
               'value', s.value::text
             ) order by s.line_no)
        from public.stock_movements s
       where s.voucher_id = v.id
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_no', k.line_no,
               'order_id', k.order_id,
               'order_line_id', k.order_line_id,
               'item_id', k.item_id,
               'qty', k.qty::text
             ) order by k.line_no)
        from public.voucher_links k
       where k.voucher_id = v.id
    ), '[]'::jsonb)
  )
  from public.vouchers v
  where v.id = p_voucher
$$;

-- What must hold of a plan before anything is written: two balanced journal lines — or, for a stock voucher, stock and no journal — or,
-- for a document, nothing at all.
create function private.assert_plan_shape(p_journal jsonb, p_stock jsonb, p_document boolean) returns void
language plpgsql
as $$
declare
  v_count  int;
  v_debit  numeric;
  v_credit numeric;
  v_stock  int := jsonb_array_length(coalesce(p_stock, '[]'::jsonb));
begin
  select count(*),
         coalesce(sum(case when e ->> 'side' = 'debit'  then (e ->> 'amount')::numeric end), 0),
         coalesce(sum(case when e ->> 'side' = 'credit' then (e ->> 'amount')::numeric end), 0)
    into v_count, v_debit, v_credit
    from jsonb_array_elements(p_journal) as e;

  if p_document then
    if v_count > 0 or v_stock > 0 then
      perform private.raise_issue('PLAN_INCONSISTENT_LINES', 'A document posts no journal or stock lines');
    end if;
    return;
  end if;
  if v_count < 2 and not (v_count = 0 and v_stock > 0) then
    perform private.raise_issue('PLAN_TOO_FEW_LINES', format('A posting needs at least two journal lines, got %s', v_count));
  end if;
  if v_debit <> v_credit then
    perform private.raise_issue('PLAN_UNBALANCED', format('Total debit %s does not equal total credit %s', v_debit, v_credit));
  end if;
end
$$;

-- Locks the orders first, in a fixed order, so concurrent invoices cannot deadlock each other; then writes the deliveries (the stock
-- movements they sit on are already in place, and the item locks were taken before).
create function private.insert_links(p_company uuid, p_voucher uuid, p_date date, p_links jsonb) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
begin
  if p_links is null or jsonb_array_length(p_links) = 0 then
    return;
  end if;
  for v_order in select distinct (e ->> 'order_id')::uuid as id from jsonb_array_elements(p_links) e order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('order:' || v_order::text, 0));
  end loop;
  insert into public.voucher_links (company_id, voucher_id, line_no, entry_date, order_id, order_line_id, item_id, qty)
  select p_company, p_voucher, (e ->> 'line_no')::int, p_date, (e ->> 'order_id')::uuid, e ->> 'order_line_id',
         (e ->> 'item_id')::uuid, (e ->> 'qty')::numeric
    from jsonb_array_elements(p_links) as e;
end
$$;

drop function public.post_voucher_atomic(uuid, uuid, text, jsonb, jsonb, jsonb);
create function public.post_voucher_atomic(
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
  -- Serialise concurrent posts of the SAME voucher id so exactly one wins and the rest replay.
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
  perform private.assert_plan_shape(p_journal, p_stock, v_type.base_kind = 'salesOrder');

  -- Row lock on the series: concurrent posts queue here, so numbers are gapless and unique.
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

drop function public.alter_voucher_atomic(uuid, uuid, text, uuid, int, jsonb, jsonb, jsonb);
create function public.alter_voucher_atomic(
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
  perform private.assert_plan_shape(p_journal, p_stock, v_type.base_kind = 'salesOrder');

  v_snapshot := private.voucher_result(v_old.id, false) - 'replayed';
  insert into public.voucher_revisions (company_id, voucher_id, version, reason, snapshot)
  values (p_company, v_old.id, v_old.version, 'alter', v_snapshot);

  -- deliveries sit on stock movements, so they go first and come back last
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

create or replace function public.cancel_voucher_atomic(
  p_actor uuid, p_company uuid, p_request_id text, p_voucher_id uuid, p_expected_version int
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old  public.vouchers;
  v_type public.voucher_types;
  v_item uuid;
begin
  select * into v_old from public.vouchers where id = p_voucher_id and company_id = p_company for update;
  if not found then
    perform private.raise_issue('VOUCHER_NOT_FOUND', format('Voucher %s not found', p_voucher_id));
  end if;

  select * into v_type from public.voucher_types where id = v_old.voucher_type_id;
  if not private.actor_has_permission(p_actor, p_company, 'voucher.' || v_type.base_kind || '.cancel') then
    perform private.raise_issue('PERMISSION_DENIED', format('Not permitted to cancel %s vouchers', v_type.base_kind));
  end if;
  if v_old.status <> 'posted' then
    perform private.raise_issue('VOUCHER_NOT_POSTED', format('Voucher %s is %s', v_old.number, v_old.status));
  end if;
  if v_old.version <> p_expected_version then
    perform private.raise_issue('VERSION_CONFLICT',
      format('Voucher %s was changed by someone else (version %s, you had %s)', v_old.number, v_old.version, p_expected_version));
  end if;
  perform private.assert_period_open(v_old.financial_year_id, v_old.voucher_date);

  insert into public.voucher_revisions (company_id, voucher_id, version, reason, snapshot)
  values (p_company, v_old.id, v_old.version, 'cancel', private.voucher_result(v_old.id, false) - 'replayed');

  for v_item in select distinct item_id from public.stock_movements where voucher_id = v_old.id order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('stock:' || v_item::text, 0));
  end loop;
  delete from public.voucher_links where voucher_id = v_old.id;
  delete from public.journal_lines where voucher_id = v_old.id;
  delete from public.stock_movements where voucher_id = v_old.id;
  update public.vouchers
     set status = 'cancelled', version = version + 1, updated_at = now()
   where id = v_old.id;

  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, after, request_id)
  values (p_company, p_actor, 'voucher.cancel', 'voucher', v_old.id,
          jsonb_build_object('number', v_old.number, 'status', 'posted', 'version', v_old.version),
          jsonb_build_object('number', v_old.number, 'status', 'cancelled', 'version', v_old.version + 1),
          p_request_id);

  return private.voucher_result(v_old.id, false);
end
$$;

drop function private.assert_plan_shape(jsonb, jsonb);

-- ---------------------------------------------------------------------------------------------
-- RLS and privileges (start closed; members read; nobody but the server writes)
-- ---------------------------------------------------------------------------------------------
alter table public.voucher_links enable row level security;
create policy voucher_links_select on public.voucher_links
  for select to authenticated using (private.has_permission(company_id, 'report.view'));
revoke all on public.voucher_links from anon, authenticated;
grant select on public.voucher_links to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant execute on function
  public.post_voucher_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.alter_voucher_atomic(uuid, uuid, text, uuid, int, jsonb, jsonb, jsonb, jsonb)
to service_role;
revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function private.has_permission(uuid, text), private.is_member(uuid) to authenticated;
