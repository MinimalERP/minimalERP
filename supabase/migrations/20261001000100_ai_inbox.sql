-- The AI Inbox (ADR-0023). A person chooses a mail in Gmail and sends it to the ERP ("Send to ERP → Sales Order"); the document is read
-- (Gemini) and matched against the masters on the server, and what comes out — a PROPOSAL, never a voucher — waits here until a person
-- opens it in the voucher window and accepts it (it is then posted like any other voucher) or rejects it.
--
-- What is kept, and for how long, is deliberately small:
--   * never the document itself, never the model's raw reading: only the proposal (the party and lines as matched, the document's own
--     text for what was not) and one line of the mail (subject, sender) to recognise it by;
--   * only until it is decided: accepting DELETES the row in the same transaction that posts the voucher (the voucher is now the record),
--     rejecting deletes it too. The table is as long as the pending list.
--
-- Who may do what:
--   * `automation` is a new role for the add-on's own sign-in: it may submit proposals and read the masters and reports (for the daily
--     report), and it can post nothing — no voucher.*.post permission.
--   * Anyone who may post a kind may accept (= post it) or reject a proposal of that kind; anyone who may see vouchers sees the inbox.

insert into public.app_roles (role) values ('automation') on conflict do nothing;

insert into public.role_permissions (role, permission)
values ('automation', 'inbox.submit'),
       ('automation', 'master.view'),
       ('automation', 'voucher.view'),
       ('automation', 'report.view'),
       -- the owner may send documents from the ERP itself (Upload) as well
       ('owner', 'inbox.submit'),
       ('accountant', 'inbox.submit')
on conflict do nothing;

create table public.inbox_items (
  id            uuid primary key,
  company_id    uuid not null references public.companies (id) on delete cascade,
  kind          text not null check (kind in ('salesOrder', 'sales', 'purchase', 'receipt', 'payment')),
  proposal      jsonb not null check (jsonb_typeof(proposal) = 'object' and octet_length(proposal::text) <= 200000),
  mail_subject  text check (char_length(mail_subject) <= 200),
  mail_from     text check (char_length(mail_from) <= 200),
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index inbox_items_company_idx on public.inbox_items (company_id, created_at);

alter table public.inbox_items enable row level security;
revoke all on public.inbox_items from public, anon, authenticated;
grant select on public.inbox_items to authenticated;
create policy inbox_items_select on public.inbox_items
  for select to authenticated using (private.has_permission(company_id, 'voucher.view'));

-- A duplicate customer PO is looked for among the company's orders by their reference.
create index vouchers_reference_idx on public.vouchers (company_id, (content ->> 'reference')) where content ? 'reference';

-- ---- submitting ------------------------------------------------------------------------------------------------------------------

-- At most this many proposals wait at once: the inbox is a short queue, not a store.
create function public.inbox_submit(
  p_actor uuid, p_company uuid, p_request_id text, p_id uuid, p_kind text, p_proposal jsonb, p_subject text, p_from text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not private.actor_has_permission(p_actor, p_company, 'inbox.submit') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: inbox.submit');
  end if;
  if (select count(*) from public.inbox_items where company_id = p_company) >= 500 then
    perform private.raise_issue('UNSUPPORTED_OPERATION', 'The AI Inbox is full (500 waiting): accept or reject some first');
  end if;
  -- the same id twice is the same submission (a retry): nothing new
  insert into public.inbox_items (id, company_id, kind, proposal, mail_subject, mail_from, created_by)
  values (p_id, p_company, p_kind, p_proposal, left(p_subject, 200), left(p_from, 200), p_actor)
  on conflict (id) do nothing;
  return jsonb_build_object('id', p_id);
end
$$;

-- ---- rejecting -------------------------------------------------------------------------------------------------------------------

create function public.inbox_discard(p_actor uuid, p_company uuid, p_request_id text, p_id uuid, p_reason text) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_item public.inbox_items;
begin
  select * into v_item from public.inbox_items where id = p_id and company_id = p_company for update;
  if not found then
    -- already accepted or rejected (by someone else, or a retry): the answer is the same
    return jsonb_build_object('id', p_id, 'discarded', false);
  end if;
  if not private.actor_has_permission(p_actor, p_company, 'voucher.' || v_item.kind || '.post') then
    perform private.raise_issue('PERMISSION_DENIED', format('Not permitted: voucher.%s.post', v_item.kind));
  end if;
  delete from public.inbox_items where id = p_id;
  -- one short line: who threw away what — not the proposal
  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, after, request_id)
  values (p_company, p_actor, 'inbox.reject', 'inboxItem', p_id,
          jsonb_build_object('kind', v_item.kind, 'subject', v_item.mail_subject),
          case when coalesce(p_reason, '') = '' then null else jsonb_build_object('reason', left(p_reason, 200)) end,
          p_request_id);
  return jsonb_build_object('id', p_id, 'discarded', true);
end
$$;

-- ---- accepting -------------------------------------------------------------------------------------------------------------------

-- An accepted proposal is posted under the inbox item's own id; the moment that voucher row exists, in the same transaction, the proposal
-- is gone. A failed post leaves it waiting.
create function private.inbox_accepted() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.inbox_items where id = new.id and company_id = new.company_id;
  return null;
end
$$;
create trigger vouchers_inbox_accepted after insert on public.vouchers
  for each row execute function private.inbox_accepted();

revoke all on function public.inbox_submit(uuid, uuid, text, uuid, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.inbox_discard(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function private.inbox_accepted() from public, anon, authenticated;
grant execute on function public.inbox_submit(uuid, uuid, text, uuid, text, jsonb, text, text) to service_role;
grant execute on function public.inbox_discard(uuid, uuid, text, uuid, text) to service_role;
