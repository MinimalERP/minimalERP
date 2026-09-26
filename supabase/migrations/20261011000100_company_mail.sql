-- Each company emails from its own Gmail (ADR-0025, step 3).
--
-- Until now every company's mail went through one Gmail script, set for the whole project (MAIL_SCRIPT_URL / MAIL_SCRIPT_SECRET). With
-- several businesses in one project, a company's mail must leave from that business's own Gmail and never from another's: the script's
-- address and secret now belong to the company, set by its owner (Utilities › Company Gmail). A company without one cannot email; there
-- is no project-wide fallback.
--
-- Kept in a table of its own, not on `companies`, because signed-in members may read their company's row (row-level security) and the
-- secret must not travel with it: only someone with company.admin can read this row, and the browser is only ever told the address.

create table public.company_mail_scripts (
  company_id  uuid primary key references public.companies (id) on delete cascade,
  url         text not null check (url ~ '^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$'),
  secret      text not null check (char_length(secret) between 8 and 200),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

alter table public.company_mail_scripts enable row level security;
revoke all on public.company_mail_scripts from public, anon, authenticated;
grant select on public.company_mail_scripts to authenticated;
create policy company_mail_scripts_select on public.company_mail_scripts
  for select to authenticated using (private.has_permission(company_id, 'company.admin'));

-- What the owner sees: the address, and whether a secret is set — never the secret.
create function public.company_mail_get(p_actor uuid, p_company uuid) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not private.actor_has_permission(p_actor, p_company, 'company.admin') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: company.admin');
  end if;
  select jsonb_build_object('url', s.url, 'updatedAt', s.updated_at) into v from public.company_mail_scripts s where s.company_id = p_company;
  return coalesce(v, 'null'::jsonb);
end
$$;

-- Sets the company's Gmail script. A blank address removes it (the company then cannot email); a blank secret keeps the one set before.
create function public.company_mail_set(p_actor uuid, p_company uuid, p_request_id text, p_url text, p_secret text) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
  v_secret text := btrim(coalesce(p_secret, ''));
begin
  if not private.actor_has_permission(p_actor, p_company, 'company.admin') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: company.admin');
  end if;
  if v_url = '' then
    delete from public.company_mail_scripts where company_id = p_company;
  else
    if v_url !~ '^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$' then
      perform private.raise_issue('SCHEMA_INVALID', 'The address is the Gmail script''s web app address: https://script.google.com/macros/s/…/exec');
    end if;
    if v_secret = '' then
      if not exists (select 1 from public.company_mail_scripts where company_id = p_company) then
        perform private.raise_issue('SCHEMA_INVALID', 'Enter the secret: the MAIL_SECRET set in that script''s properties');
      end if;
      update public.company_mail_scripts set url = v_url, updated_by = p_actor, updated_at = now() where company_id = p_company;
    else
      if char_length(v_secret) < 8 then
        perform private.raise_issue('SCHEMA_INVALID', 'The secret is too short: use at least 8 characters');
      end if;
      insert into public.company_mail_scripts (company_id, url, secret, updated_by) values (p_company, v_url, v_secret, p_actor)
      on conflict (company_id) do update set url = excluded.url, secret = excluded.secret, updated_by = excluded.updated_by, updated_at = now();
    end if;
  end if;
  -- who changed it, and to which address: never the secret
  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, after, request_id)
  values (p_company, p_actor, 'company.mail', 'company', p_company, case when v_url = '' then null else jsonb_build_object('url', v_url) end, p_request_id);
  return public.company_mail_get(p_actor, p_company);
end
$$;

-- The script to send a company's mail through, for the server alone (the caller is checked by the send action).
create function public.company_mail_script(p_company uuid) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('url', s.url, 'secret', s.secret) from public.company_mail_scripts s where s.company_id = p_company
$$;

revoke all on function public.company_mail_get(uuid, uuid) from public, anon, authenticated;
revoke all on function public.company_mail_set(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.company_mail_script(uuid) from public, anon, authenticated;
grant execute on function public.company_mail_get(uuid, uuid) to service_role;
grant execute on function public.company_mail_set(uuid, uuid, text, text, text) to service_role;
grant execute on function public.company_mail_script(uuid) to service_role;
grant all on public.company_mail_scripts to service_role;
