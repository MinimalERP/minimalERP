-- One extra person per company (ADR-0025, step 2).
--
-- The owner runs several companies; each may have ONE more person, who has full use of that company and nothing else:
--   * the role `member` holds every permission the owner holds except `company.admin` (they cannot give anyone access, and — checked in
--     `company-create` — cannot create companies);
--   * a member belongs to exactly one company: making someone the member of a second company is refused;
--   * the account itself is made by the owner in Supabase (Authentication › Users › Add user, with a password); the ERP only links that
--     email to the company (Company Settings › Company User). No invitation is sent from here.
-- Every later migration that gives the owner a new permission must give it to `member` too (a test holds the two together).

insert into public.app_roles (role) values ('member') on conflict do nothing;

insert into public.role_permissions (role, permission)
select 'member', permission from public.role_permissions where role = 'owner' and permission <> 'company.admin'
on conflict do nothing;

-- The account with this email, if any. SECURITY DEFINER so it can read auth.users whoever calls it; only the server may call it.
create function private.user_by_email(p_email text) returns uuid
language sql stable security definer set search_path = ''
as $$
  select u.id from auth.users u where lower(u.email) = lower(btrim(p_email)) order by u.id limit 1
$$;

-- The company's extra person: { email, since } or null. Only for someone who may manage the company's access.
create function public.company_member_get(p_actor uuid, p_company uuid) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not private.actor_has_permission(p_actor, p_company, 'company.admin') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: company.admin');
  end if;
  select jsonb_build_object('email', u.email, 'since', m.created_at) into v
    from public.company_members m join auth.users u on u.id = m.user_id
   where m.company_id = p_company and m.role = 'member'
   order by m.created_at limit 1;
  return coalesce(v, 'null'::jsonb);
end
$$;

-- Sets the company's extra person to the account with this email (replacing whoever it was), or removes them when the email is blank.
create function public.company_member_set(p_actor uuid, p_company uuid, p_request_id text, p_email text) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_before jsonb;
begin
  if not private.actor_has_permission(p_actor, p_company, 'company.admin') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: company.admin');
  end if;
  select jsonb_build_object('user', m.user_id) into v_before from public.company_members m where m.company_id = p_company and m.role = 'member' limit 1;

  if coalesce(btrim(p_email), '') = '' then
    delete from public.company_members where company_id = p_company and role = 'member';
  else
    v_user := private.user_by_email(p_email);
    if v_user is null then
      perform private.raise_issue('MASTER_NOT_FOUND', format('No account with the email %s. Add it in Supabase (Authentication › Users › Add user) first.', btrim(p_email)));
    end if;
    if exists (select 1 from public.company_members where company_id = p_company and user_id = v_user and role <> 'member') then
      perform private.raise_issue('UNSUPPORTED_OPERATION', 'That account already has its own access to this company');
    end if;
    if exists (select 1 from public.company_members where user_id = v_user and company_id <> p_company) then
      perform private.raise_issue('UNSUPPORTED_OPERATION', 'That account already has access to another company. A company''s user sees only that company: use a different email.');
    end if;
    delete from public.company_members where company_id = p_company and role = 'member' and user_id <> v_user;
    insert into public.company_members (company_id, user_id, role) values (p_company, v_user, 'member') on conflict (company_id, user_id) do nothing;
  end if;

  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, before, after, request_id)
  values (p_company, p_actor, 'company.member', 'company', p_company, v_before,
          case when v_user is null then null else jsonb_build_object('user', v_user) end, p_request_id);
  return public.company_member_get(p_actor, p_company);
end
$$;

revoke all on function private.user_by_email(text) from public, anon, authenticated;
revoke all on function public.company_member_get(uuid, uuid) from public, anon, authenticated;
revoke all on function public.company_member_set(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function private.user_by_email(text) to service_role;
grant execute on function public.company_member_get(uuid, uuid) to service_role;
grant execute on function public.company_member_set(uuid, uuid, text, text) to service_role;
