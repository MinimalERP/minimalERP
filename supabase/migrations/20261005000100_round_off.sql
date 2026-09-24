-- Round Off (ADR-0025): a Sales or Purchase Invoice's grand total is rounded to the nearest whole rupee (half up); the
-- difference between the raw total (items + GST) and the rounded one goes to a new reserved "Round Off" ledger. This
-- never changes the taxable value or the GST itself — it is strictly a balancing adjustment on the customer/vendor's
-- own line. `round(numeric)` in Postgres rounds half AWAY FROM ZERO, the same rule `roundOffAmount()`
-- (packages/domain/src/vouchers/kinds/gstDoc.ts) uses in TypeScript — confirmed empirically (round(2549.50) = 2550,
-- round(2.5) = 3, not banker's rounding), so the two stay in agreement. Keep the two in sync if this rule ever changes.

-- ---------------------------------------------------------------------------------------------
-- The system ledger: every existing company gets it, once, the same "adopt a hand-made one, else insert" dance
-- as Phase 9's GST/TDS ledgers (20260928000100_gst_tds_phase9.sql).
-- ---------------------------------------------------------------------------------------------
update public.ledgers l
   set reserved_key = s.key
  from (values ('round-off', 'Round Off')) as s(key, name)
 where l.reserved_key is null and l.party_id is null and lower(l.name) = lower(s.name)
   and not exists (select 1 from public.ledgers x where x.company_id = l.company_id and x.reserved_key = s.key);

insert into public.ledgers (id, company_id, name, group_id, is_active, reserved_key)
select gen_random_uuid(), c.id, s.name, g.id, true, s.key
  from public.companies c
 cross join (values ('round-off', 'Round Off', 'indirect-expenses')) as s(key, name, grp)
  join public.account_groups g on g.company_id = c.id and g.reserved_key = s.grp
 where not exists (select 1 from public.ledgers l where l.company_id = c.id and l.reserved_key = s.key)
   and not exists (select 1 from public.ledgers l where l.company_id = c.id and lower(l.name) = lower(s.name));

-- ---------------------------------------------------------------------------------------------
-- The bill mirror: a Sales/Purchase invoice's "new bill" amount is now the ROUNDED total, matching what the
-- engine actually posts to the customer/vendor's ledger (gstDoc.ts's `grandTotalParts(...).rounded`).
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

  return null;
end
$$;
