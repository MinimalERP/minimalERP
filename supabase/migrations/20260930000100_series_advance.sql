-- Manual override of a numbering series' next number (ADR-0021). Forward only — it can never collide with a number
-- already issued — audited, and usable at ANY time (unlike start_at, which locks once the series has vouchers): the
-- owner may need to jump to a specific number, e.g. continuing from a legacy system or a paper register, not merely
-- to the next integer. Same permission as every other master change (owner and accountant hold master.write).

create or replace function public.series_advance(
  p_actor uuid, p_company uuid, p_request_id text, p_series_id uuid, p_next_value bigint
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_next bigint;
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted to change masters');
  end if;

  select next_value into v_next from public.numbering_series
   where id = p_series_id and company_id = p_company
     for update;
  if not found then
    perform private.raise_issue('MASTER_NOT_FOUND', 'No numbering series with that id');
  end if;

  if p_next_value < v_next then
    perform private.raise_issue('SERIES_NEXT_BEHIND',
      format('The next number cannot go before %s — number %s may already be issued', v_next, v_next - 1));
  end if;

  -- Equal is a true no-op: no write, no audit row — the same replay behaviour every other master change has.
  if p_next_value > v_next then
    update public.numbering_series set next_value = p_next_value where id = p_series_id;
    insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, after, request_id)
    values (p_company, p_actor, 'series.advanceNext', 'numberingSeries', p_series_id,
            jsonb_build_object('next_value', v_next),
            jsonb_build_object('next_value', p_next_value, 'gap', p_next_value - v_next),
            p_request_id);
  end if;

  return jsonb_build_object('series_id', p_series_id, 'from', v_next, 'to', p_next_value);
end
$$;

revoke all on function public.series_advance(uuid, uuid, text, uuid, bigint) from public, anon, authenticated;
grant execute on function public.series_advance(uuid, uuid, text, uuid, bigint) to service_role;

-- master_usage_json widened: also reports a numbering series' current next_value, so the browser can show it and
-- default the override to "continue from the last made number" without a separate round trip.
create or replace function public.master_usage_json(p_company uuid, p_id uuid) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ledger_has_entries', exists (select 1 from public.journal_lines where company_id = p_company and ledger_id = p_id),
    'voucher_type_in_use', exists (select 1 from public.vouchers where company_id = p_company and voucher_type_id = p_id),
    'series_in_use', exists (select 1 from public.vouchers where company_id = p_company and series_id = p_id),
    'series_next_value', (select s.next_value from public.numbering_series s where s.company_id = p_company and s.id = p_id)
  )
$$;
