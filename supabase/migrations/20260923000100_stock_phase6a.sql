-- Phase 6a: the stock ledger, the Stock Journal and opening stock.
--
-- Stock is written only by posting a voucher, exactly like the journal: the application (the same TypeScript domain code as the
-- browser) derives the voucher's stock movements and these functions commit them in the SAME transaction as the voucher. A stock voucher
-- (Stock Journal, opening stock) has NO journal lines — it has no accounting effect — so the "at least two balanced journal lines" rule now
-- depends on the voucher's kind. Nothing about stock VALUE is stored except what an In brought in: an Out is valued by reading the ordered
-- movements (moving weighted average, ADR-0014), so back-dating and alteration never leave a stale figure.

-- ---------------------------------------------------------------------------------------------
-- Two new voucher kinds
-- ---------------------------------------------------------------------------------------------
alter table public.voucher_types drop constraint voucher_types_base_kind_check;
alter table public.voucher_types
  add constraint voucher_types_base_kind_check
  check (base_kind in ('contra', 'payment', 'receipt', 'journal', 'opening', 'stockJournal', 'stockOpening'));

-- Permissions are named voucher.<base kind>.<action> and a base kind is camelCase (stockJournal), so the name pattern allows capitals.
alter table public.role_permissions drop constraint role_permissions_permission_check;
alter table public.role_permissions
  add constraint role_permissions_permission_check check (permission ~ '^[A-Za-z_]+(\.[A-Za-z_]+)+$');

insert into public.role_permissions (role, permission)
  select r.role, 'voucher.' || k.kind || '.' || a.action
    from (values ('owner'), ('accountant')) as r(role)
   cross join (values ('stockJournal'), ('stockOpening')) as k(kind)
   cross join (values ('post'), ('alter'), ('cancel')) as a(action)
  union all
  select 'clerk', 'voucher.stockJournal.post';

-- Companies that already exist get the two voucher types and their numbering for every financial year they have.
insert into public.voucher_types (id, company_id, name, base_kind, is_system, is_active)
  select gen_random_uuid(), c.id, t.name, t.kind, true, true
    from public.companies c
   cross join (values ('Stock Journal', 'stockJournal'), ('Opening Stock', 'stockOpening')) as t(name, kind)
   where not exists (select 1 from public.voucher_types x where x.company_id = c.id and x.base_kind = t.kind)
     and not exists (select 1 from public.voucher_types x where x.company_id = c.id and lower(x.name) = lower(t.name));

insert into public.numbering_series (company_id, voucher_type_id, financial_year_id, prefix, suffix, width, start_at, next_value)
  select vt.company_id, vt.id, fy.id,
         case vt.base_kind
           when 'stockOpening' then 'OS/'
           else 'STJ/' || case when extract(year from fy.start_date) = extract(year from fy.end_date)
                               then to_char(fy.start_date, 'YY')
                               else to_char(fy.start_date, 'YY') || '-' || to_char(fy.end_date, 'YY') end || '/'
         end,
         '', 4, 1, 1
    from public.voucher_types vt
    join public.financial_years fy on fy.company_id = vt.company_id
   where vt.base_kind in ('stockJournal', 'stockOpening')
     and not exists (
       select 1 from public.numbering_series s
        where s.company_id = vt.company_id and s.voucher_type_id = vt.id and s.financial_year_id = fy.id);

-- ---------------------------------------------------------------------------------------------
-- The stock ledger
-- ---------------------------------------------------------------------------------------------
create table public.stock_movements (
  id                 bigint generated always as identity primary key,
  company_id         uuid not null,
  voucher_id         uuid not null,
  line_no            int  not null check (line_no >= 1),
  entry_date         date not null,
  financial_year_id  uuid not null,
  item_id            uuid not null,
  warehouse_id       uuid not null,
  direction          text not null check (direction in ('in', 'out')),
  qty                numeric(18, 4) not null check (qty > 0),
  -- an In carries its value (quantity × rate, to the paisa); an Out carries none: the reader values it from the running average
  value              numeric(18, 2),
  constraint stock_in_has_value check ((direction = 'in' and value is not null and value >= 0) or (direction = 'out' and value is null)),
  unique (voucher_id, line_no),
  constraint stock_voucher_fk   foreign key (company_id, voucher_id)        references public.vouchers (company_id, id),
  constraint stock_item_fk      foreign key (company_id, item_id)           references public.stock_items (company_id, id),
  constraint stock_warehouse_fk foreign key (company_id, warehouse_id)      references public.warehouses (company_id, id),
  constraint stock_fy_fk        foreign key (company_id, financial_year_id) references public.financial_years (company_id, id)
);
-- an item's ledger (and the running position) and the stock summary read by item and date
create index stock_item_idx on public.stock_movements (company_id, item_id, entry_date, voucher_id, line_no);
create index stock_voucher_idx on public.stock_movements (company_id, voucher_id);

-- ---------------------------------------------------------------------------------------------
-- Integrity
-- ---------------------------------------------------------------------------------------------
-- Stock in a locked period cannot change, like the journal.
create function private.trg_stock_period_lock() returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.assert_period_open(new.financial_year_id, new.entry_date);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.assert_period_open(old.financial_year_id, old.entry_date);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
create trigger stock_movements_period_lock
  before insert or update or delete on public.stock_movements
  for each row execute function private.trg_stock_period_lock();

-- No godown may ever hold less than nothing: for one item, every godown's running quantity, in the book's order (date; Ins before Outs;
-- voucher; line), must stay at or above zero. The per-item advisory lock makes two concurrent transactions take turns, so both cannot
-- pass this check against a picture that lacks the other's movements.
create function private.assert_stock_sound(p_company uuid, p_item uuid) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_bad record;
begin
  perform pg_advisory_xact_lock(hashtextextended('stock:' || p_item::text, 0));
  select m.entry_date, m.warehouse_id, m.running
    into v_bad
    from (
      select entry_date, warehouse_id, direction,
             sum(case when direction = 'in' then qty else -qty end)
               over (partition by warehouse_id
                     order by entry_date, case when direction = 'in' then 0 else 1 end, voucher_id, line_no
                     rows between unbounded preceding and current row) as running
        from public.stock_movements
       where company_id = p_company and item_id = p_item
    ) m
   where m.running < 0
   limit 1;
  if found then
    perform private.raise_issue('STOCK_NEGATIVE',
      format('Stock of item %s would go below zero in godown %s on %s', p_item, v_bad.warehouse_id, v_bad.entry_date));
  end if;
end
$$;

-- The voucher-level rules, now kind-aware:
--   accounting kinds: at least two journal lines, Dr = Cr, and no stock lines
--   stock kinds (stockJournal, stockOpening): at least one stock line and NO journal lines
--   a cancelled voucher has neither
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
  if v.status = 'cancelled' and (v_count > 0 or v_stock > 0) then
    raise exception using errcode = 'check_violation', message = 'CANCELLED_WITH_LINES',
      detail = format('Cancelled voucher %s still has %s journal and %s stock line(s)', p_voucher, v_count, v_stock);
  end if;

  select (select count(*) from public.journal_lines l
           where l.voucher_id = p_voucher and (l.entry_date <> v.voucher_date or l.financial_year_id <> v.financial_year_id))
       + (select count(*) from public.stock_movements s
           where s.voucher_id = p_voucher and (s.entry_date <> v.voucher_date or s.financial_year_id <> v.financial_year_id))
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

-- Checked at COMMIT, once the whole voucher is in place (deferred, like the journal's).
create function private.trg_stock_line_consistent() returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.assert_voucher_consistent(new.voucher_id);
    perform private.assert_stock_sound(new.company_id, new.item_id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and (old.voucher_id <> new.voucher_id or old.item_id <> new.item_id)) then
    perform private.assert_voucher_consistent(old.voucher_id);
    perform private.assert_stock_sound(old.company_id, old.item_id);
  end if;
  return null;
end
$$;
create constraint trigger stock_movements_consistent
  after insert or update or delete on public.stock_movements
  deferrable initially deferred
  for each row execute function private.trg_stock_line_consistent();

-- ---------------------------------------------------------------------------------------------
-- The write path (replaces the Phase 2 functions: they now carry the stock movements too)
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
    ), '[]'::jsonb)
  )
  from public.vouchers v
  where v.id = p_voucher
$$;

-- What must hold of a plan before anything is written: two balanced journal lines — or, for a stock voucher, stock and no journal.
create function private.assert_plan_shape(p_journal jsonb, p_stock jsonb) returns void
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

  if v_count < 2 and not (v_count = 0 and v_stock > 0) then
    perform private.raise_issue('PLAN_TOO_FEW_LINES', format('A posting needs at least two journal lines, got %s', v_count));
  end if;
  if v_debit <> v_credit then
    perform private.raise_issue('PLAN_UNBALANCED', format('Total debit %s does not equal total credit %s', v_debit, v_credit));
  end if;
end
$$;
drop function private.assert_plan_shape(jsonb);

-- Locks the items first, in a fixed order, so concurrent stock vouchers cannot deadlock each other; then writes the movements.
create function private.insert_stock(p_company uuid, p_voucher uuid, p_date date, p_fy uuid, p_stock jsonb) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_item uuid;
begin
  if p_stock is null or jsonb_array_length(p_stock) = 0 then
    return;
  end if;
  for v_item in select distinct (e ->> 'item_id')::uuid as id from jsonb_array_elements(p_stock) e order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('stock:' || v_item::text, 0));
  end loop;
  insert into public.stock_movements
         (company_id, voucher_id, line_no, entry_date, financial_year_id, item_id, warehouse_id, direction, qty, value)
  select p_company, p_voucher, e.ord::int, p_date, p_fy,
         (e.j ->> 'item_id')::uuid, (e.j ->> 'warehouse_id')::uuid, e.j ->> 'direction',
         (e.j ->> 'qty')::numeric, (e.j ->> 'value')::numeric
    from jsonb_array_elements(p_stock) with ordinality as e(j, ord);
end
$$;

drop function public.post_voucher_atomic(uuid, uuid, text, jsonb, jsonb);
create function public.post_voucher_atomic(
  p_actor uuid, p_company uuid, p_request_id text, p_voucher jsonb, p_journal jsonb, p_stock jsonb default '[]'::jsonb
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
  perform private.assert_plan_shape(p_journal, p_stock);

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

  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, after, request_id)
  values (p_company, p_actor, 'voucher.post', 'voucher', v_id,
          jsonb_build_object('number', v_number, 'date', v_date, 'version', 1, 'voucher_type_id', v_type_id),
          p_request_id);

  return private.voucher_result(v_id, false);
end
$$;

drop function public.alter_voucher_atomic(uuid, uuid, text, uuid, int, jsonb, jsonb);
create function public.alter_voucher_atomic(
  p_actor uuid, p_company uuid, p_request_id text, p_voucher_id uuid, p_expected_version int,
  p_voucher jsonb, p_journal jsonb, p_stock jsonb default '[]'::jsonb
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
  perform private.assert_plan_shape(p_journal, p_stock);

  v_snapshot := private.voucher_result(v_old.id, false) - 'replayed';
  insert into public.voucher_revisions (company_id, voucher_id, version, reason, snapshot)
  values (p_company, v_old.id, v_old.version, 'alter', v_snapshot);

  delete from public.journal_lines where voucher_id = v_old.id;
  delete from public.stock_movements where voucher_id = v_old.id;
  update public.vouchers
     set voucher_date = v_date, content = v_content,
         version = version + 1, revision = revision + 1, updated_at = now()
   where id = v_old.id;
  perform private.insert_journal(p_company, v_old.id, v_date, v_old.financial_year_id, p_journal);
  perform private.insert_stock(p_company, v_old.id, v_date, v_old.financial_year_id, p_stock);

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

-- ---------------------------------------------------------------------------------------------
-- RLS and privileges (start closed; members read; nobody but the server writes)
-- ---------------------------------------------------------------------------------------------
alter table public.stock_movements enable row level security;
create policy stock_movements_select on public.stock_movements
  for select to authenticated using (private.has_permission(company_id, 'report.view'));
revoke all on public.stock_movements from anon, authenticated;
grant select on public.stock_movements to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant execute on function
  public.post_voucher_atomic(uuid, uuid, text, jsonb, jsonb, jsonb),
  public.alter_voucher_atomic(uuid, uuid, text, uuid, int, jsonb, jsonb, jsonb)
to service_role;
revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on all functions in schema private to service_role;
grant  execute on function private.has_permission(uuid, text), private.is_member(uuid) to authenticated;
