-- Tasks on the Gateway: what someone has to do — a task, or a project enquiry followed from first contact to won or lost with short dated
-- notes. A task is for the owner or the company's user; it may come from the Gateway, the Gmail side panel (with a link back to the mail)
-- or the assistant. What is due this week is NOT stored: the Gateway reads it from the books. The rules here are the domain's `applyTask`
-- (packages/domain/src/tasks/tasks.ts), which the browser's own books use.
--
-- They are DISPOSABLE: nothing in the books refers to them (what came of an enquiry is in the books as its quotation, order or invoice).
-- A task can be deleted at any time, one closed (done, won or lost) is deleted a week after it was closed, and nothing about them goes to
-- the audit log.

create table public.tasks (
  id          uuid primary key,
  company_id  uuid not null references public.companies (id) on delete cascade,
  kind        text not null check (kind in ('task', 'enquiry')),
  title       text not null check (char_length(btrim(title)) between 1 and 200),
  status      text not null,
  assignee    uuid references auth.users (id) on delete set null,
  due_date    date,
  source      text not null default 'typed' check (source in ('typed', 'gmail', 'assistant')),
  mail_link   text check (mail_link is null or mail_link ~ '^https://mail\.google\.com/'),
  notes       jsonb not null default '[]'::jsonb check (jsonb_typeof(notes) = 'array'),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  done_at     timestamptz,
  constraint task_status_of_kind check (
    (kind = 'task' and status in ('open', 'done')) or (kind = 'enquiry' and status in ('new', 'working', 'quoted', 'won', 'lost')))
);
create index tasks_company_idx on public.tasks (company_id, created_at);

alter table public.tasks enable row level security;
revoke all on public.tasks from public, anon, authenticated;
grant select on public.tasks to authenticated;
create policy tasks_select on public.tasks
  for select to authenticated using (private.has_permission(company_id, 'master.view'));

-- who may keep the list: everyone who enters vouchers (the owner, the accountant, the company's user, a clerk)
insert into public.role_permissions (role, permission)
  select r.role, 'task.write' from (values ('owner'), ('accountant'), ('member'), ('clerk')) as r(role)
  on conflict do nothing;

-- The list: every open task and enquiry, and those closed in the last week; and the people a task can be for. What was closed more
-- than a week ago is deleted first.
create function public.tasks_get(p_actor uuid, p_company uuid) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.view') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: master.view');
  end if;
  delete from public.tasks where company_id = p_company and done_at < now() - interval '7 days';
  return jsonb_build_object(
    'tasks', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'id', t.id, 'kind', t.kind, 'title', t.title, 'status', t.status, 'assignee', t.assignee, 'dueDate', t.due_date,
               'source', t.source, 'mailLink', t.mail_link, 'notes', t.notes, 'createdAt', t.created_at, 'createdBy', t.created_by,
               'doneAt', t.done_at)) order by t.created_at)
        from public.tasks t
       where t.company_id = p_company and (t.done_at is null or t.done_at > now() - interval '7 days')), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.user_id, 'email', u.email, 'role', m.role) order by m.role <> 'owner', u.email)
        from public.company_members m join auth.users u on u.id = m.user_id
       where m.company_id = p_company and m.role <> 'automation'), '[]'::jsonb));
end
$$;

-- One change to the list (create / update / note / delete), checked. Returns the list.
create function public.task_apply(p_actor uuid, p_company uuid, p_request_id text, p_cmd jsonb) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_op     text := p_cmd ->> 'op';
  v_id     uuid := (p_cmd ->> 'id')::uuid;
  v_task   public.tasks;
  v_email  text;
  v_status text;
begin
  if not private.actor_has_permission(p_actor, p_company, 'task.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: task.write');
  end if;
  if p_cmd ? 'assignee' and p_cmd ->> 'assignee' is not null
     and not exists (select 1 from public.company_members m where m.company_id = p_company and m.user_id = (p_cmd ->> 'assignee')::uuid and m.role <> 'automation') then
    perform private.raise_issue('SCHEMA_INVALID', 'A task is for someone of this company');
  end if;
  select email into v_email from auth.users where id = p_actor;

  if v_op = 'create' then
    if exists (select 1 from public.tasks where id = v_id) then
      perform private.raise_issue('IDEMPOTENCY_CONFLICT', 'That task already exists');
    end if;
    insert into public.tasks (id, company_id, kind, title, status, assignee, due_date, source, mail_link, notes, created_by)
    values (v_id, p_company, p_cmd ->> 'kind', btrim(p_cmd ->> 'title'),
            case p_cmd ->> 'kind' when 'task' then 'open' else 'new' end,
            -- for whoever adds it (when they are a person of the company), unless someone else is named
            case when p_cmd ? 'assignee' then (p_cmd ->> 'assignee')::uuid
                 when exists (select 1 from public.company_members m where m.company_id = p_company and m.user_id = p_actor and m.role <> 'automation') then p_actor end,
            (p_cmd ->> 'dueDate')::date, coalesce(p_cmd ->> 'source', 'typed'), p_cmd ->> 'mailLink',
            case when coalesce(btrim(p_cmd ->> 'note'), '') = '' then '[]'::jsonb
                 else jsonb_build_array(jsonb_build_object('at', now(), 'by', coalesce(v_email, ''), 'text', btrim(p_cmd ->> 'note'))) end,
            p_actor)
    returning * into v_task;
  else
    select * into v_task from public.tasks where id = v_id and company_id = p_company for update;
    if not found then
      perform private.raise_issue('MASTER_NOT_FOUND', 'No such task');
    end if;
    if v_op = 'note' then
      if char_length(btrim(coalesce(p_cmd ->> 'text', ''))) not between 1 and 500 then
        perform private.raise_issue('SCHEMA_INVALID', 'A note is one short line (at most 500 characters)');
      end if;
      update public.tasks
         set notes = notes || jsonb_build_array(jsonb_build_object('at', now(), 'by', coalesce(v_email, ''), 'text', btrim(p_cmd ->> 'text')))
       where id = v_id;
    elsif v_op = 'delete' then
      delete from public.tasks where id = v_id;
    elsif v_op = 'update' then
      v_status := coalesce(p_cmd ->> 'status', v_task.status);
      if not ((v_task.kind = 'task' and v_status in ('open', 'done')) or (v_task.kind = 'enquiry' and v_status in ('new', 'working', 'quoted', 'won', 'lost'))) then
        perform private.raise_issue('SCHEMA_INVALID', case v_task.kind when 'task' then 'A task is open or done' else 'An enquiry is new, working, quoted, won or lost' end);
      end if;
      update public.tasks
         set title    = coalesce(btrim(p_cmd ->> 'title'), title),
             status   = v_status,
             assignee = case when p_cmd ? 'assignee' then (p_cmd ->> 'assignee')::uuid else assignee end,
             due_date = case when p_cmd ? 'dueDate' then (p_cmd ->> 'dueDate')::date else due_date end,
             done_at  = case when v_status in ('done', 'won', 'lost') then coalesce(done_at, now()) else null end
       where id = v_id;
    else
      perform private.raise_issue('SCHEMA_INVALID', format('Unknown task change %s', v_op));
    end if;
  end if;

  return public.tasks_get(p_actor, p_company);
end
$$;

revoke all on function public.tasks_get(uuid, uuid), public.task_apply(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.tasks_get(uuid, uuid), public.task_apply(uuid, uuid, text, jsonb) to service_role;
