-- Sending a voucher to another of the owner's companies through the ERP (ADR-0025, step 3).
--
-- "Send via ERP" on a Purchase Order, a Sales Invoice or a Payment puts a proposal in the inbox of the company whose GSTIN is the voucher's
-- party's GSTIN — our PO as their sales order, our invoice as their purchase, our payment as their receipt. There a person accepts it (it is
-- posted like any inbox proposal) or rejects it; the sender sees Sent / Accepted / Rejected.
--
--   * Only between companies that share an owner: one business of the group may send to another, never outside it.
--   * The proposal is built on the server from the receiver's OWN masters (the party with the sender's GSTIN, items matched only when
--     certain). Nothing is created in the receiver's books, and the sender is never shown them.
--   * `exchange_documents` is the record both sides see: one row per sending, keyed by the inbox item's id (= the voucher's id in the
--     receiving company once accepted). Its status follows the inbox: the accept trigger and `inbox_discard` update it in the same
--     transaction.

create table public.exchange_documents (
  id              uuid primary key,
  from_company    uuid not null references public.companies (id) on delete cascade,
  from_voucher    uuid not null,
  from_kind       text not null check (from_kind in ('purchaseOrder', 'sales', 'payment')),
  from_number     text not null check (char_length(from_number) <= 60),
  to_company      uuid not null references public.companies (id) on delete cascade,
  to_kind         text not null check (to_kind in ('salesOrder', 'purchase', 'receipt')),
  status          text not null default 'sent' check (status in ('sent', 'accepted', 'rejected')),
  reason          text check (char_length(reason) <= 200),
  to_number       text check (char_length(to_number) <= 60),
  sent_by         uuid,
  sent_at         timestamptz not null default now(),
  decided_by      uuid,
  decided_at      timestamptz,
  check (from_company <> to_company)
);
-- A voucher is sent once: again only after the other company rejected it.
create unique index exchange_documents_live_idx on public.exchange_documents (from_company, from_voucher) where status in ('sent', 'accepted');
create index exchange_documents_from_idx on public.exchange_documents (from_company, sent_at);
create index exchange_documents_to_idx on public.exchange_documents (to_company, sent_at);
-- The company to send to is found by its GSTIN.
create index companies_gstin_idx on public.companies (upper(gstin)) where gstin is not null;

alter table public.exchange_documents enable row level security;
revoke all on public.exchange_documents from public, anon, authenticated;
grant select on public.exchange_documents to authenticated;
create policy exchange_documents_select on public.exchange_documents
  for select to authenticated using (private.has_permission(from_company, 'voucher.view') or private.has_permission(to_company, 'voucher.view'));

-- The companies the sender's company may send to: those with this GSTIN that share an owner with it (never itself).
create function public.exchange_targets(p_from uuid, p_gstin text) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.created_at), '[]'::jsonb)
    from public.companies c
   where upper(c.gstin) = upper(btrim(p_gstin)) and c.id <> p_from
     and exists (
       select 1 from public.company_members a join public.company_members b on b.user_id = a.user_id
        where a.company_id = p_from and a.role = 'owner' and b.company_id = c.id and b.role = 'owner'
     )
$$;

-- Sends: the proposal lands in the receiver's inbox and the sending is recorded, both or neither.
create function public.exchange_send(
  p_actor uuid, p_request_id text, p_id uuid, p_from uuid, p_voucher uuid, p_from_kind text, p_from_number text,
  p_to uuid, p_to_kind text, p_proposal jsonb, p_subject text, p_from_name text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- whoever may make this kind of voucher in the sending company may send it
  if not private.actor_has_permission(p_actor, p_from, 'voucher.' || p_from_kind || '.post') then
    perform private.raise_issue('PERMISSION_DENIED', format('Not permitted: voucher.%s.post', p_from_kind));
  end if;
  if not exists (
    select 1 from public.company_members a join public.company_members b on b.user_id = a.user_id
     where a.company_id = p_from and a.role = 'owner' and b.company_id = p_to and b.role = 'owner'
  ) or p_from = p_to then
    perform private.raise_issue('EXCHANGE_NOT_POSSIBLE', 'That company is not one of this company''s group: documents go only between companies with the same owner');
  end if;
  if exists (select 1 from public.exchange_documents where from_company = p_from and from_voucher = p_voucher and status in ('sent', 'accepted')) then
    perform private.raise_issue('EXCHANGE_NOT_POSSIBLE', 'This voucher has already been sent (it can be sent again only if they reject it)');
  end if;
  if (select count(*) from public.inbox_items where company_id = p_to) >= 500 then
    perform private.raise_issue('UNSUPPORTED_OPERATION', 'Their inbox is full (500 waiting): they must accept or reject some first');
  end if;
  insert into public.inbox_items (id, company_id, kind, proposal, mail_subject, mail_from, created_by)
  values (p_id, p_to, p_to_kind, p_proposal, left(p_subject, 200), left(p_from_name || ' · via ERP', 200), p_actor);
  insert into public.exchange_documents (id, from_company, from_voucher, from_kind, from_number, to_company, to_kind, sent_by)
  values (p_id, p_from, p_voucher, p_from_kind, p_from_number, p_to, p_to_kind, p_actor);
  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, after, request_id)
  values (p_from, p_actor, 'exchange.send', 'voucher', p_voucher, jsonb_build_object('to', p_to, 'id', p_id), p_request_id);
  return jsonb_build_object('id', p_id);
end
$$;

-- Accepting a proposal posts a voucher under its id: a sent document is then 'accepted', with the number it got there.
create or replace function private.inbox_accepted() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.inbox_items where id = new.id and company_id = new.company_id;
  update public.exchange_documents
     set status = 'accepted', to_number = left(new.number, 60), decided_by = new.created_by, decided_at = now()
   where id = new.id and to_company = new.company_id and status = 'sent';
  return null;
end
$$;

-- Rejecting: as before, plus a sent document becomes 'rejected' with the reason given.
create or replace function public.inbox_discard(p_actor uuid, p_company uuid, p_request_id text, p_id uuid, p_reason text) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_item public.inbox_items;
begin
  select * into v_item from public.inbox_items where id = p_id and company_id = p_company for update;
  if not found then
    return jsonb_build_object('id', p_id, 'discarded', false);
  end if;
  if not private.actor_has_permission(p_actor, p_company, 'voucher.' || v_item.kind || '.post') then
    perform private.raise_issue('PERMISSION_DENIED', format('Not permitted: voucher.%s.post', v_item.kind));
  end if;
  delete from public.inbox_items where id = p_id;
  update public.exchange_documents
     set status = 'rejected', reason = nullif(left(btrim(coalesce(p_reason, '')), 200), ''), decided_by = p_actor, decided_at = now()
   where id = p_id and to_company = p_company and status = 'sent';
  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, after, request_id)
  values (p_company, p_actor, 'inbox.reject', 'inboxItem', p_id,
          jsonb_build_object('kind', v_item.kind, 'subject', v_item.mail_subject),
          case when coalesce(p_reason, '') = '' then null else jsonb_build_object('reason', left(p_reason, 200)) end,
          p_request_id);
  return jsonb_build_object('id', p_id, 'discarded', true);
end
$$;

-- What a company sent, and what became of each (newest first).
create function public.exchange_sent(p_actor uuid, p_company uuid) returns jsonb
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  if not private.actor_has_permission(p_actor, p_company, 'voucher.view') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: voucher.view');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'voucherId', e.from_voucher, 'kind', e.from_kind, 'number', e.from_number,
             'toCompany', c.name, 'toKind', e.to_kind, 'status', e.status, 'reason', e.reason, 'toNumber', e.to_number,
             'sentAt', e.sent_at, 'decidedAt', e.decided_at)
           order by e.sent_at desc, e.id)
      from public.exchange_documents e join public.companies c on c.id = e.to_company
     where e.from_company = p_company), '[]'::jsonb);
end
$$;

revoke all on function public.exchange_targets(uuid, text) from public, anon, authenticated;
revoke all on function public.exchange_send(uuid, text, uuid, uuid, uuid, text, text, uuid, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.exchange_sent(uuid, uuid) from public, anon, authenticated;
revoke all on function public.inbox_discard(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function private.inbox_accepted() from public, anon, authenticated;
grant execute on function public.exchange_targets(uuid, text) to service_role;
grant execute on function public.exchange_send(uuid, text, uuid, uuid, uuid, text, text, uuid, text, jsonb, text, text) to service_role;
grant execute on function public.exchange_sent(uuid, uuid) to service_role;
grant execute on function public.inbox_discard(uuid, uuid, text, uuid, text) to service_role;
grant all on public.exchange_documents to service_role;
