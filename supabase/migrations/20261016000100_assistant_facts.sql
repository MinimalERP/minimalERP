-- The floating assistant's taught facts (v1).
--
-- What the owner teaches the assistant in chat ("we keep 50 blanks of 14188") is kept HERE, in the company's own books — not in the AI
-- model — so it stays ours whatever model answers. Every fact goes into the assistant's instructions, numbered by age (1 = oldest).
-- Members who may see the masters read them; those who may change the masters teach and forget. Nothing else of the conversation is
-- stored.

create table public.assistant_facts (
  id          uuid primary key,
  company_id  uuid not null references public.companies (id) on delete cascade,
  text        text not null check (char_length(btrim(text)) between 1 and 500),
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index assistant_facts_company_idx on public.assistant_facts (company_id, created_at, id);

alter table public.assistant_facts enable row level security;
revoke all on public.assistant_facts from public, anon, authenticated;
grant select on public.assistant_facts to authenticated;
create policy assistant_facts_select on public.assistant_facts
  for select to authenticated using (private.has_permission(company_id, 'master.view'));

-- The company's facts, oldest first: [{ id, number, text, createdAt }].
create function public.assistant_facts_get(p_actor uuid, p_company uuid) returns jsonb
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.view') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: master.view');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', f.id, 'number', f.n, 'text', f.text, 'createdAt', f.created_at) order by f.n)
      from (select a.*, row_number() over (order by a.created_at, a.id) as n from public.assistant_facts a where a.company_id = p_company) f
  ), '[]'::jsonb);
end
$$;

-- Teaches one fact (at most 200 per company). Returns the facts.
create function public.assistant_fact_add(p_actor uuid, p_company uuid, p_request_id text, p_id uuid, p_text text) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: master.write');
  end if;
  if char_length(btrim(coalesce(p_text, ''))) not between 1 and 500 then
    perform private.raise_issue('SCHEMA_INVALID', 'A fact is one short sentence (at most 500 characters)');
  end if;
  if (select count(*) from public.assistant_facts where company_id = p_company) >= 200 then
    perform private.raise_issue('SCHEMA_INVALID', 'The assistant already knows 200 facts: forget some first');
  end if;
  insert into public.assistant_facts (id, company_id, text, created_by) values (p_id, p_company, btrim(p_text), p_actor);
  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, after, request_id)
  values (p_company, p_actor, 'assistant.teach', 'assistantFact', p_id, jsonb_build_object('text', btrim(p_text)), p_request_id);
  return public.assistant_facts_get(p_actor, p_company);
end
$$;

-- Forgets one fact. Returns the facts.
create function public.assistant_fact_remove(p_actor uuid, p_company uuid, p_request_id text, p_id uuid) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_text text;
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: master.write');
  end if;
  delete from public.assistant_facts where id = p_id and company_id = p_company returning text into v_text;
  if v_text is null then
    perform private.raise_issue('MASTER_NOT_FOUND', 'No such fact');
  end if;
  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, request_id)
  values (p_company, p_actor, 'assistant.forget', 'assistantFact', p_id, jsonb_build_object('text', v_text), p_request_id);
  return public.assistant_facts_get(p_actor, p_company);
end
$$;

revoke all on function public.assistant_facts_get(uuid, uuid) from public, anon, authenticated;
revoke all on function public.assistant_fact_add(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.assistant_fact_remove(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.assistant_facts_get(uuid, uuid) to service_role;
grant execute on function public.assistant_fact_add(uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.assistant_fact_remove(uuid, uuid, text, uuid) to service_role;
grant all on public.assistant_facts to service_role;
