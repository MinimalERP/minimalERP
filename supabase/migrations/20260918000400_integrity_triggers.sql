-- Database-level invariants. These hold no matter who writes — the posting functions, a future
-- code path, or a person with raw SQL access. The application checks the same rules first and
-- reports friendly errors; these triggers are the last line of defence.
--
-- Errors carry a stable code in MESSAGE (e.g. PLAN_UNBALANCED) and a human explanation in DETAIL,
-- so the server-side adapter can map them back to the domain's IssueCode values.

-- ---------------------------------------------------------------------------------------------
-- 1. Per-voucher consistency, checked at COMMIT (deferred). Covers:
--      Σ debit = Σ credit                       (the accounting invariant)
--      a posted voucher has at least two lines
--      a cancelled voucher has none
--      every line carries its voucher's date and financial year
--      the voucher's date lies inside its financial year
-- ---------------------------------------------------------------------------------------------
create function private.assert_voucher_consistent(p_voucher uuid) returns void
language plpgsql
as $$
declare
  v        public.vouchers;
  v_fy     public.financial_years;
  v_count  int;
  v_debit  numeric;
  v_credit numeric;
  v_bad    int;
begin
  select * into v from public.vouchers where id = p_voucher;
  if not found then
    return; -- lines cannot outlive their voucher (foreign key); nothing to check
  end if;

  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_count, v_debit, v_credit
    from public.journal_lines where voucher_id = p_voucher;

  if v_debit <> v_credit then
    raise exception using errcode = 'check_violation', message = 'PLAN_UNBALANCED',
      detail = format('Voucher %s: total debit %s does not equal total credit %s', p_voucher, v_debit, v_credit);
  end if;
  if v.status = 'posted' and v_count < 2 then
    raise exception using errcode = 'check_violation', message = 'PLAN_TOO_FEW_LINES',
      detail = format('Posted voucher %s has %s journal line(s); at least two are required', p_voucher, v_count);
  end if;
  if v.status = 'cancelled' and v_count > 0 then
    raise exception using errcode = 'check_violation', message = 'CANCELLED_WITH_LINES',
      detail = format('Cancelled voucher %s still has %s journal line(s)', p_voucher, v_count);
  end if;

  select count(*) into v_bad from public.journal_lines l
   where l.voucher_id = p_voucher
     and (l.entry_date <> v.voucher_date or l.financial_year_id <> v.financial_year_id);
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

create function private.trg_journal_line_consistent() returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.assert_voucher_consistent(new.voucher_id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.voucher_id <> new.voucher_id) then
    perform private.assert_voucher_consistent(old.voucher_id);
  end if;
  return null;
end
$$;

create function private.trg_voucher_consistent() returns trigger
language plpgsql
as $$
begin
  perform private.assert_voucher_consistent(new.id);
  return null;
end
$$;

create constraint trigger journal_lines_consistent
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function private.trg_journal_line_consistent();

create constraint trigger vouchers_consistent
  after insert or update on public.vouchers
  deferrable initially deferred
  for each row execute function private.trg_voucher_consistent();

-- ---------------------------------------------------------------------------------------------
-- 2. Period lock: no journal line or voucher dated on/before financial_years.locked_through can be
--    inserted, changed or removed. Immediate (not deferred) so the failing statement is obvious.
-- ---------------------------------------------------------------------------------------------
create function private.assert_period_open(p_fy uuid, p_date date) returns void
language plpgsql stable
as $$
declare
  v_lock date;
begin
  select locked_through into v_lock from public.financial_years where id = p_fy;
  if v_lock is not null and p_date <= v_lock then
    raise exception using errcode = 'check_violation', message = 'PERIOD_LOCKED',
      detail = format('Books are locked through %s; cannot change entries dated %s', v_lock, p_date);
  end if;
end
$$;

create function private.trg_journal_period_lock() returns trigger
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

create function private.trg_voucher_period_lock() returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.assert_period_open(new.financial_year_id, new.voucher_date);
  end if;
  if tg_op = 'UPDATE' then
    perform private.assert_period_open(old.financial_year_id, old.voucher_date);
  end if;
  return new;
end
$$;

create trigger journal_lines_period_lock
  before insert or update or delete on public.journal_lines
  for each row execute function private.trg_journal_period_lock();

create trigger vouchers_period_lock
  before insert or update on public.vouchers
  for each row execute function private.trg_voucher_period_lock();

-- ---------------------------------------------------------------------------------------------
-- 3. Voucher identity is immutable once created, and vouchers are never deleted
--    (a cancelled voucher stays on record and keeps its number).
-- ---------------------------------------------------------------------------------------------
create function private.trg_voucher_immutable() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'check_violation', message = 'VOUCHER_DELETE_FORBIDDEN',
      detail = 'Vouchers are never deleted; cancel them instead';
  end if;
  if new.id is distinct from old.id
     or new.company_id is distinct from old.company_id
     or new.voucher_type_id is distinct from old.voucher_type_id
     or new.financial_year_id is distinct from old.financial_year_id
     or new.series_id is distinct from old.series_id
     or new.number is distinct from old.number then
    raise exception using errcode = 'check_violation', message = 'VOUCHER_IDENTITY_IMMUTABLE',
      detail = 'A voucher''s id, company, type, financial year, series and number cannot change';
  end if;
  return new;
end
$$;

create trigger vouchers_immutable
  before update or delete on public.vouchers
  for each row execute function private.trg_voucher_immutable();

-- ---------------------------------------------------------------------------------------------
-- 4. Append-only tables: audit_log and voucher_revisions can be inserted into, never changed.
-- ---------------------------------------------------------------------------------------------
create function private.trg_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = 'check_violation', message = 'APPEND_ONLY',
    detail = format('%s is append-only; %s is not allowed', tg_table_name, tg_op);
end
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function private.trg_append_only();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function private.trg_append_only();

create trigger voucher_revisions_append_only
  before update or delete on public.voucher_revisions
  for each row execute function private.trg_append_only();
create trigger voucher_revisions_no_truncate
  before truncate on public.voucher_revisions
  for each statement execute function private.trg_append_only();
