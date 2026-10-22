-- Do not let a posted bill be altered or cancelled while any posted voucher settles it.
-- The advisory lock serialises this check with a concurrent receipt/payment allocation.
create or replace function private.assert_bill_unsettled(p_company uuid, p_voucher uuid) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_bill record;
begin
  for v_bill in
    select ledger_id, ref, side
      from public.bill_allocations
     where company_id = p_company and voucher_id = p_voucher and kind = 'new'
     order by ledger_id, ref
  loop
    perform pg_advisory_xact_lock(hashtextextended('bill:' || p_company::text || ':' || v_bill.ledger_id::text || ':' || v_bill.ref, 0));
    if exists (
      select 1
        from public.bill_allocations a
        join public.vouchers v on v.company_id = a.company_id and v.id = a.voucher_id
       where a.company_id = p_company and a.ledger_id = v_bill.ledger_id and a.ref = v_bill.ref
         and a.kind = 'against' and a.side <> v_bill.side
         and a.voucher_id <> p_voucher and v.status = 'posted'
    ) then
      perform private.raise_issue('BILL_SETTLED', format('Bill %s has payments or other settlements. Cancel or correct those entries before changing it.', v_bill.ref));
    end if;
  end loop;
end
$$;

create or replace function private.trg_protect_settled_bill() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'posted' and (new.status <> 'posted' or new.content is distinct from old.content) then
    perform private.assert_bill_unsettled(old.company_id, old.id);
  end if;
  return new;
end
$$;

create trigger vouchers_protect_settled_bill
  before update of content, status on public.vouchers
  for each row execute function private.trg_protect_settled_bill();

-- A payment/receipt/journal/note must settle a real, still-open bill for that same party ledger,
-- in the opposite direction, and cannot settle it past zero. Serialize contenders on its bill key.
create or replace function private.trg_validate_bill_against() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_bill_side text;
  v_side_count int;
  v_raised numeric;
  v_settled numeric;
  v_pending numeric;
begin
  if new.kind <> 'against' then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended('bill:' || new.company_id::text || ':' || new.ledger_id::text || ':' || new.ref, 0));

  select count(distinct b.side), min(b.side), coalesce(sum(b.amount), 0)
    into v_side_count, v_bill_side, v_raised
    from public.bill_allocations b
    join public.vouchers v on v.company_id = b.company_id and v.id = b.voucher_id
   where b.company_id = new.company_id and b.ledger_id = new.ledger_id and b.ref = new.ref
     and b.kind = 'new' and v.status = 'posted';

  if v_side_count <> 1 or v_bill_side = new.side then
    perform private.raise_issue('ALLOCATION_INVALID', format('Bill %s is not an open bill for this party', new.ref));
  end if;

  select coalesce(sum(a.amount), 0)
    into v_settled
    from public.bill_allocations a
    join public.vouchers v on v.company_id = a.company_id and v.id = a.voucher_id
   where a.company_id = new.company_id and a.ledger_id = new.ledger_id and a.ref = new.ref
     and a.kind = 'against' and a.side <> v_bill_side and v.status = 'posted';

  v_pending := v_raised - v_settled;
  if v_pending < new.amount then
    perform private.raise_issue('ALLOCATION_INVALID', format('Bill %s has only %s remaining to settle', new.ref, to_char(greatest(v_pending, 0), 'FM999999999999999990.00')));
  end if;
  return new;
end
$$;

create trigger bill_allocations_validate_against
  before insert on public.bill_allocations
  for each row execute function private.trg_validate_bill_against();
