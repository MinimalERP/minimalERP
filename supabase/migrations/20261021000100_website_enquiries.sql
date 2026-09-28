-- Website enquiries: the quote form on micro-components.com writes straight into this project (the website repo's supabase/schema.sql
-- made the table `website_enquiries` and the private bucket `website-enquiry-drawings`, with anon INSERT-only policies). This makes them
-- the ERP's: the company the website belongs to, reading them (and their drawings), a status, and turning one into a Gateway enquiry.
--
-- THE WEBSITE DEPENDS ON: the table and bucket names, the columns it writes (name, phone, email, requirement, attachment_path, source,
-- context), status defaulting to 'new', and the two anon INSERT policies. Those are kept exactly; the table is created here only where it
-- does not exist yet (a fresh database, the tests), the same as the website made it.
--
-- As everywhere in the ERP, a signed-in user READS (row-level security) and the server WRITES: a status change or a conversion goes
-- through the post-voucher function, which calls the functions below as the person. The one exception to "anon holds nothing" is this
-- table's INSERT and the bucket's upload: that is the public form.

create table if not exists public.website_enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  company text,
  phone text not null,
  email text not null,
  requirement text not null,
  quantity text,
  material text,
  message text,
  attachment_path text,
  source text,
  context text,
  status text not null default 'new'
);
create index if not exists website_enquiries_created_at_idx on public.website_enquiries (created_at desc);
create index if not exists website_enquiries_status_idx on public.website_enquiries (status);
alter table public.website_enquiries enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'website_enquiries' and policyname = 'Website can submit enquiries') then
    create policy "Website can submit enquiries" on public.website_enquiries for insert to anon with check (status = 'new');
  end if;
end
$$;

-- The status the ERP moves it through, and the Gateway enquiry it became (tasks are disposable: when that one is deleted, the link goes).
alter table public.website_enquiries add constraint website_enquiries_status_check check (status in ('new', 'contacted', 'quoted', 'won', 'lost'));
alter table public.website_enquiries add column erp_task_id uuid references public.tasks (id) on delete set null;

-- Supabase gave anon and authenticated every privilege on the new table (TRUNCATE is not stopped by row-level security). The form needs
-- INSERT alone (it asks for nothing back); the ERP's people read.
revoke all on public.website_enquiries from public, anon, authenticated;
grant insert on public.website_enquiries to anon;
grant select on public.website_enquiries to authenticated;
grant all on public.website_enquiries to service_role;

-- Which company the website belongs to: one row. Micro Components (found by its GSTIN) where it exists; otherwise set it once by SQL.
create table public.website_enquiry_company (
  one        boolean primary key default true check (one),
  company_id uuid not null references public.companies (id) on delete cascade
);
alter table public.website_enquiry_company enable row level security;
revoke all on public.website_enquiry_company from public, anon, authenticated;
grant select on public.website_enquiry_company to authenticated;
grant all on public.website_enquiry_company to service_role;
create policy website_enquiry_company_select on public.website_enquiry_company
  for select to authenticated using (private.has_permission(company_id, 'master.view'));
insert into public.website_enquiry_company (company_id)
  select id from public.companies where gstin = '27ABUFM9776A1ZL' limit 1;

create policy website_enquiries_select on public.website_enquiries
  for select to authenticated
  using (exists (select 1 from public.website_enquiry_company w where private.has_permission(w.company_id, 'master.view')));

-- The drawings: that company's people may read them (a signed download link). Only where Supabase Storage exists (not in the tests).
do $$
begin
  if to_regclass('storage.objects') is not null then
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ERP can read enquiry drawings') then
      execute $p$
        create policy "ERP can read enquiry drawings" on storage.objects for select to authenticated
          using (bucket_id = 'website-enquiry-drawings'
                 and exists (select 1 from public.website_enquiry_company w where private.has_permission(w.company_id, 'master.view')))
      $p$;
    end if;
  end if;
end
$$;

-- A Gateway enquiry can come from the website.
alter table public.tasks drop constraint tasks_source_check;
alter table public.tasks add constraint tasks_source_check check (source in ('typed', 'gmail', 'assistant', 'website'));

-- The enquiries, newest first, for the company the website belongs to (another company gets `site: false` and none).
create function public.website_enquiries_get(p_actor uuid, p_company uuid) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.view') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: master.view');
  end if;
  if not exists (select 1 from public.website_enquiry_company where company_id = p_company) then
    return jsonb_build_object('site', false, 'enquiries', '[]'::jsonb);
  end if;
  return jsonb_build_object('site', true, 'enquiries', coalesce((
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'id', e.id, 'createdAt', e.created_at, 'name', e.name, 'company', e.company, 'phone', e.phone, 'email', e.email,
             'requirement', e.requirement, 'quantity', e.quantity, 'material', e.material, 'message', e.message,
             'drawing', e.attachment_path, 'source', e.source, 'context', e.context, 'status', e.status, 'taskId', e.erp_task_id))
           order by e.created_at desc)
      from public.website_enquiries e), '[]'::jsonb));
end
$$;

-- One change: { op: 'status', id, status }, { op: 'convert', id } (a Gateway enquiry with the customer's details as its first note) or
-- { op: 'delete', id } (erased for good; the server then removes its drawing from the bucket). Returns the list.
create function public.website_enquiry_apply(p_actor uuid, p_company uuid, p_request_id text, p_cmd jsonb) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_op    text := p_cmd ->> 'op';
  v_e     public.website_enquiries;
  v_task  uuid;
  v_email text;
begin
  if not private.actor_has_permission(p_actor, p_company, 'task.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: task.write');
  end if;
  if not exists (select 1 from public.website_enquiry_company where company_id = p_company) then
    perform private.raise_issue('PERMISSION_DENIED', 'The website''s enquiries belong to another company');
  end if;
  select * into v_e from public.website_enquiries where id = (p_cmd ->> 'id')::uuid for update;
  if not found then
    perform private.raise_issue('MASTER_NOT_FOUND', 'No such enquiry');
  end if;

  if v_op = 'status' then
    if coalesce(p_cmd ->> 'status', '') not in ('new', 'contacted', 'quoted', 'won', 'lost') then
      perform private.raise_issue('SCHEMA_INVALID', 'An enquiry is new, contacted, quoted, won or lost');
    end if;
    update public.website_enquiries set status = p_cmd ->> 'status' where id = v_e.id;
  elsif v_op = 'convert' then
    if v_e.erp_task_id is not null then
      perform private.raise_issue('IDEMPOTENCY_CONFLICT', 'It is already on the Gateway');
    end if;
    select email into v_email from auth.users where id = p_actor;
    v_task := gen_random_uuid();
    insert into public.tasks (id, company_id, kind, title, status, assignee, source, notes, created_by)
    values (v_task, p_company, 'enquiry', left(btrim(v_e.name || ': ' || coalesce(nullif(btrim(v_e.context), ''), v_e.requirement)), 200), 'new',
            case when exists (select 1 from public.company_members m where m.company_id = p_company and m.user_id = p_actor and m.role <> 'automation') then p_actor end,
            'website',
            jsonb_build_array(jsonb_build_object('at', v_e.created_at, 'by', coalesce(v_email, ''), 'text',
              left(concat_ws(' · ', v_e.requirement, 'Phone ' || v_e.phone, v_e.email, case when v_e.attachment_path is not null then 'drawing attached' end), 500))),
            p_actor);
    update public.website_enquiries set erp_task_id = v_task where id = v_e.id;
  elsif v_op = 'delete' then
    delete from public.website_enquiries where id = v_e.id;
  else
    perform private.raise_issue('SCHEMA_INVALID', format('Unknown enquiry change %s', v_op));
  end if;
  return public.website_enquiries_get(p_actor, p_company);
end
$$;

-- An enquiry's drawing (its name in the bucket), for the server to sign a download link; null when it has none.
create function public.website_enquiry_drawing(p_actor uuid, p_company uuid, p_id uuid) returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_path text;
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.view')
     or not exists (select 1 from public.website_enquiry_company where company_id = p_company) then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: master.view');
  end if;
  select attachment_path into v_path from public.website_enquiries where id = p_id;
  return v_path;
end
$$;

revoke all on function public.website_enquiries_get(uuid, uuid), public.website_enquiry_apply(uuid, uuid, text, jsonb),
  public.website_enquiry_drawing(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.website_enquiries_get(uuid, uuid), public.website_enquiry_apply(uuid, uuid, text, jsonb),
  public.website_enquiry_drawing(uuid, uuid, uuid) to service_role;
