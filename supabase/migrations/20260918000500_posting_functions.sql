-- The only write path into the books.
--
-- The application (Edge Function, running the same TypeScript domain code as the browser) derives
-- the voucher's posting plan. These functions receive the finished voucher + journal lines and
-- commit them ATOMICALLY: numbering, voucher, journal, revision snapshot and audit row all land in
-- one transaction, or none do. They do no business derivation — they enforce invariants, allocate
-- numbers and write rows. EXECUTE is granted to service_role only (see 20260918000600).
--
-- Errors: RAISE EXCEPTION with MESSAGE = a stable code (matching the domain's IssueCode values)
-- and DETAIL = the human explanation.

create function private.raise_issue(p_code text, p_detail text) returns void
language plpgsql
as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = p_detail;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- JSON views of a voucher (used for return values and revision snapshots)
-- ---------------------------------------------------------------------------------------------
create function private.voucher_result(p_voucher uuid, p_replayed boolean) returns jsonb
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
    ), '[]'::jsonb)
  )
  from public.vouchers v
  where v.id = p_voucher
$$;

-- The journal payload must already balance; the deferred trigger re-checks at COMMIT regardless.
create function private.assert_plan_shape(p_journal jsonb) returns void
language plpgsql
as $$
declare
  v_count  int;
  v_debit  numeric;
  v_credit numeric;
begin
  select count(*),
         coalesce(sum(case when e ->> 'side' = 'debit'  then (e ->> 'amount')::numeric end), 0),
         coalesce(sum(case when e ->> 'side' = 'credit' then (e ->> 'amount')::numeric end), 0)
    into v_count, v_debit, v_credit
    from jsonb_array_elements(p_journal) as e;

  if v_count < 2 then
    perform private.raise_issue('PLAN_TOO_FEW_LINES', format('A posting needs at least two journal lines, got %s', v_count));
  end if;
  if v_debit <> v_credit then
    perform private.raise_issue('PLAN_UNBALANCED', format('Total debit %s does not equal total credit %s', v_debit, v_credit));
  end if;
end
$$;

create function private.insert_journal(p_company uuid, p_voucher uuid, p_date date, p_fy uuid, p_journal jsonb) returns void
language sql
set search_path = public, pg_temp
as $$
  insert into public.journal_lines
         (company_id, voucher_id, line_no, entry_date, financial_year_id, ledger_id, debit, credit, narration)
  select p_company, p_voucher, e.ord::int, p_date, p_fy,
         (e.j ->> 'ledger_id')::uuid,
         case when e.j ->> 'side' = 'debit'  then (e.j ->> 'amount')::numeric else 0 end,
         case when e.j ->> 'side' = 'credit' then (e.j ->> 'amount')::numeric else 0 end,
         e.j ->> 'narration'
    from jsonb_array_elements(p_journal) with ordinality as e(j, ord)
$$;

-- ---------------------------------------------------------------------------------------------
-- Read helpers for the server-side adapter
-- ---------------------------------------------------------------------------------------------
create function public.actor_can(p_actor uuid, p_company uuid, p_permission text) returns boolean
language sql stable
as $$ select private.actor_has_permission(p_actor, p_company, p_permission) $$;

create function public.load_masters_json(p_company uuid) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'company', (select jsonb_build_object('id', c.id, 'name', c.name) from public.companies c where c.id = p_company),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name, 'parent_id', g.parent_id, 'nature', g.nature,
               'affects_gross_profit', g.affects_gross_profit, 'is_system', g.is_system, 'reserved_key', g.reserved_key)
             order by g.name)
        from public.account_groups g where g.company_id = p_company), '[]'::jsonb),
    'voucher_types', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'base_kind', t.base_kind) order by t.name)
        from public.voucher_types t where t.company_id = p_company), '[]'::jsonb),
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'voucher_type_id', s.voucher_type_id, 'financial_year_id', s.financial_year_id,
               'prefix', s.prefix, 'suffix', s.suffix, 'width', s.width, 'start_at', s.start_at)
             order by s.id)
        from public.numbering_series s where s.company_id = p_company), '[]'::jsonb),
    'financial_years', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'label', f.label, 'start_date', f.start_date, 'end_date', f.end_date,
               'locked_through', f.locked_through)
             order by f.start_date)
        from public.financial_years f where f.company_id = p_company), '[]'::jsonb)
  )
$$;

-- Ledgers are loaded separately so posting fetches only the ones a voucher references
-- (a company can have tens of thousands). p_ids is a JSON array of uuid strings; null loads them all.
-- jsonb (not uuid[]) so any database driver can call it without array-parameter support.
create function public.load_ledgers_json(p_company uuid, p_ids jsonb) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'name', l.name, 'group_id', l.group_id, 'is_active', l.is_active) order by l.name), '[]'::jsonb)
    from public.ledgers l
   where l.company_id = p_company
     and (p_ids is null or l.id in (select value::uuid from jsonb_array_elements_text(p_ids)))
$$;

-- ---------------------------------------------------------------------------------------------
-- post_voucher_atomic
--   p_voucher: { id, voucher_type_id, financial_year_id, date, content }
--   p_journal: [ { ledger_id, side: 'debit'|'credit', amount: '1234.56', narration } ... ]
-- Idempotent on the voucher id: re-posting identical content returns the existing voucher.
-- ---------------------------------------------------------------------------------------------
create function public.post_voucher_atomic(
  p_actor uuid, p_company uuid, p_request_id text, p_voucher jsonb, p_journal jsonb
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
  perform private.assert_plan_shape(p_journal);

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

  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, after, request_id)
  values (p_company, p_actor, 'voucher.post', 'voucher', v_id,
          jsonb_build_object('number', v_number, 'date', v_date, 'version', 1, 'voucher_type_id', v_type_id),
          p_request_id);

  return private.voucher_result(v_id, false);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- alter_voucher_atomic: replace a posted voucher's content and journal. Keeps id, type, number and
-- financial year. The previous state is snapshotted into voucher_revisions in the same transaction.
-- ---------------------------------------------------------------------------------------------
create function public.alter_voucher_atomic(
  p_actor uuid, p_company uuid, p_request_id text, p_voucher_id uuid, p_expected_version int,
  p_voucher jsonb, p_journal jsonb
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
  perform private.assert_plan_shape(p_journal);

  v_snapshot := private.voucher_result(v_old.id, false) - 'replayed';
  insert into public.voucher_revisions (company_id, voucher_id, version, reason, snapshot)
  values (p_company, v_old.id, v_old.version, 'alter', v_snapshot);

  delete from public.journal_lines where voucher_id = v_old.id;
  update public.vouchers
     set voucher_date = v_date, content = v_content,
         version = version + 1, revision = revision + 1, updated_at = now()
   where id = v_old.id;
  perform private.insert_journal(p_company, v_old.id, v_date, v_old.financial_year_id, p_journal);

  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, after, request_id)
  values (p_company, p_actor, 'voucher.alter', 'voucher', v_old.id,
          jsonb_build_object('number', v_old.number, 'date', v_old.voucher_date, 'version', v_old.version),
          jsonb_build_object('number', v_old.number, 'date', v_date, 'version', v_old.version + 1),
          p_request_id);

  return private.voucher_result(v_old.id, false);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- cancel_voucher_atomic: the voucher stays on record with its number but leaves the books.
-- ---------------------------------------------------------------------------------------------
create function public.cancel_voucher_atomic(
  p_actor uuid, p_company uuid, p_request_id text, p_voucher_id uuid, p_expected_version int
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old  public.vouchers;
  v_type public.voucher_types;
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

  delete from public.journal_lines where voucher_id = v_old.id;
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
