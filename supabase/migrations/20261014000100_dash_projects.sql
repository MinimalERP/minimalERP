-- minimalDASH projects: one DASH for the owner, across all their companies.
--
-- minimalDASH is the owner's own control room (tasks, more and more AI-driven). It is not a company's book: a project belongs to the
-- person who owns the companies, not to one company, and nobody else sees it — not a company's extra user, not the Gmail add-on.
--   * dash_projects: a name and a kind (recurring or one-time). More (tasks, links to ERP documents) comes on top.
--   * Every change goes through dash_project_apply, called by the `dash` Edge Function; only someone who owns a company may make one.
--   * DASH's data is its own and DISPOSABLE: creating, renaming or deleting a project never touches the books, no table of the books
--     ever refers to a dash_* table, and everything DASH adds later hangs off its project (on delete cascade), so deleting a project
--     removes all of it. A test in packages/db-tests (dash_projects.db.test.ts) holds both rules.

create table public.dash_projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  kind        text not null check (kind in ('recurring', 'one_time')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- two projects of one owner never share a name (whatever its case or spacing)
create unique index dash_projects_name_idx on public.dash_projects (owner_id, lower(btrim(name)));

alter table public.dash_projects enable row level security;
revoke all on public.dash_projects from public, anon, authenticated;
grant select on public.dash_projects to authenticated;
create policy dash_projects_select on public.dash_projects for select to authenticated using (owner_id = (select auth.uid()));

-- Whether this person owns at least one company: minimalDASH is theirs alone.
create function private.owns_a_company(p_actor uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.company_members m where m.user_id = p_actor and m.role = 'owner')
$$;

-- op: project.create { name, kind } · project.rename { id, name } · project.kind { id, kind } · project.delete { id }
-- Answers the project as it now is ({ id, deleted: true } for a delete).
create function public.dash_project_apply(p_actor uuid, p_op text, p_payload jsonb) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_row public.dash_projects;
  v_id uuid;
  v_name text := btrim(coalesce(p_payload ->> 'name', ''));
  v_kind text := coalesce(p_payload ->> 'kind', '');
begin
  if not private.owns_a_company(p_actor) then
    perform private.raise_issue('PERMISSION_DENIED', 'minimalDASH is for the owner of the books');
  end if;
  if p_op <> 'project.create' then
    begin
      v_id := (p_payload ->> 'id')::uuid;
    exception when others then
      v_id := null;
    end;
    select * into v_row from public.dash_projects where id = v_id and owner_id = p_actor for update;
    if not found then
      perform private.raise_issue('MASTER_NOT_FOUND', 'That project no longer exists');
    end if;
  end if;
  if p_op in ('project.create', 'project.rename') and v_name = '' then
    perform private.raise_issue('SCHEMA_INVALID', 'Give the project a name');
  end if;
  if p_op in ('project.create', 'project.kind') and v_kind not in ('recurring', 'one_time') then
    perform private.raise_issue('SCHEMA_INVALID', 'A project is recurring or one-time');
  end if;
  if p_op in ('project.create', 'project.rename')
     and exists (select 1 from public.dash_projects where owner_id = p_actor and lower(btrim(name)) = lower(v_name) and id is distinct from v_id) then
    perform private.raise_issue('UNSUPPORTED_OPERATION', format('There is already a project called %s', v_name));
  end if;

  case p_op
    when 'project.create' then
      insert into public.dash_projects (owner_id, name, kind) values (p_actor, left(v_name, 120), v_kind) returning * into v_row;
    when 'project.rename' then
      update public.dash_projects set name = left(v_name, 120), updated_at = now() where id = v_id returning * into v_row;
    when 'project.kind' then
      update public.dash_projects set kind = v_kind, updated_at = now() where id = v_id returning * into v_row;
    when 'project.delete' then
      delete from public.dash_projects where id = v_id;
      return jsonb_build_object('id', v_id, 'deleted', true);
    else
      perform private.raise_issue('SCHEMA_INVALID', format('Unknown change %s', p_op));
  end case;
  return to_jsonb(v_row);
end
$$;

revoke all on function private.owns_a_company(uuid) from public, anon, authenticated;
revoke all on function public.dash_project_apply(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function private.owns_a_company(uuid) to service_role;
grant execute on function public.dash_project_apply(uuid, text, jsonb) to service_role;
grant all on public.dash_projects to service_role;
