-- minimalDASH: the control room for jobs (enquiries and recurring projects), their drawings and their mail, in the ERP's own database
-- so a job can link the company's Sales Orders and Purchase Orders directly (github.com/MinimalERP/minimalDASH is its front end).
--
-- Same rules as the books: every row belongs to a company; members read what their role allows (dash.view) through RLS; nobody
-- writes a table directly: every change goes through public.dash_apply (called by the `dash` Edge Function), which checks dash.edit.
-- Drawings and other files are never stored here, only their Google Drive links. A mail's own text is (cut of the quoted history).

insert into public.role_permissions (role, permission)
values ('owner', 'dash.view'), ('owner', 'dash.edit'),
       ('accountant', 'dash.view'), ('accountant', 'dash.edit'),
       ('clerk', 'dash.view'), ('clerk', 'dash.edit'),
       ('viewer', 'dash.view'),
       -- the Gmail add-on files mails and Gemini's readings
       ('automation', 'dash.view'), ('automation', 'dash.edit')
on conflict do nothing;

create table public.dash_jobs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  title            text not null check (char_length(title) between 1 and 200),
  customer         text not null default '' check (char_length(customer) <= 200),
  contact          text not null default '' check (char_length(contact) <= 200),
  asked            text not null default '' check (char_length(asked) <= 1000),      -- what the customer wants now, in one line
  whose_move       text not null default 'us' check (whose_move in ('us', 'customer', 'vendor')),
  move_since       date not null default current_date,
  due_date         date,
  status           text not null default 'open' check (status in ('open', 'won', 'lost', 'closed')),
  drive_folder_url text check (char_length(drive_folder_url) <= 500),
  gmail_thread_id  text check (char_length(gmail_thread_id) <= 100),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  unique (company_id, id)
);
create index dash_jobs_open_idx on public.dash_jobs (company_id, status);
create unique index dash_jobs_thread_idx on public.dash_jobs (company_id, gmail_thread_id) where gmail_thread_id is not null;

create table public.dash_parts (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  job_id         uuid not null,
  drawing_no     text not null check (char_length(drawing_no) between 1 and 100),
  name           text not null default '' check (char_length(name) <= 300),
  rev            text not null default '' check (char_length(rev) <= 50),
  material       text not null default '' check (char_length(material) <= 300),
  finish         text not null default '' check (char_length(finish) <= 500),
  next_assy      text not null default '' check (char_length(next_assy) <= 100),
  qty            text not null default '' check (char_length(qty) <= 50),
  drive_file_url text check (char_length(drive_file_url) <= 500),
  created_at     timestamptz not null default now(),
  foreign key (company_id, job_id) references public.dash_jobs (company_id, id) on delete cascade
);
-- one row per drawing number in a job, however it is written (mo-sh-024 = MO-SH-024)
create unique index dash_parts_drawing_idx on public.dash_parts (company_id, job_id, upper(drawing_no));

create table public.dash_events (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  job_id           uuid not null,
  at               timestamptz not null default now(),
  who              text not null check (who in ('customer', 'us', 'vendor', 'note')),
  summary          text not null check (char_length(summary) between 1 and 2000),
  gmail_message_id text check (char_length(gmail_message_id) <= 300),
  mail_from        text not null default '' check (char_length(mail_from) <= 300),   -- or how it came: WhatsApp, Phone call…
  mail_to          text not null default '' check (char_length(mail_to) <= 2000),
  mail_subject     text not null default '' check (char_length(mail_subject) <= 500),
  body             text not null default '' check (char_length(body) <= 100000),
  file_links       jsonb not null default '[]' check (jsonb_typeof(file_links) = 'array' and octet_length(file_links::text) <= 100000),
  created_by       uuid,
  foreign key (company_id, job_id) references public.dash_jobs (company_id, id) on delete cascade
);
create index dash_events_job_idx on public.dash_events (company_id, job_id, at);
create unique index dash_events_mail_idx on public.dash_events (company_id, job_id, gmail_message_id) where gmail_message_id is not null;

alter table public.dash_jobs enable row level security;
alter table public.dash_parts enable row level security;
alter table public.dash_events enable row level security;
revoke all on public.dash_jobs, public.dash_parts, public.dash_events from public, anon, authenticated;
grant select on public.dash_jobs, public.dash_parts, public.dash_events to authenticated;
create policy dash_jobs_select on public.dash_jobs for select to authenticated using (private.has_permission(company_id, 'dash.view'));
create policy dash_parts_select on public.dash_parts for select to authenticated using (private.has_permission(company_id, 'dash.view'));
create policy dash_events_select on public.dash_events for select to authenticated using (private.has_permission(company_id, 'dash.view'));

-- ---- the one way in for changes -------------------------------------------------------------------------------------------------
--
--   job.create    { title, customer?, contact?, whose_move?, move_since?, gmail_thread_id? }   a thread already a job: that job
--   job.update    { id, <any of the job's fields> }                                           only the fields given change
--   event.add     { job_id, who, summary, at?, gmail_message_id?, mail_from?, mail_to?, mail_subject?, body?, file_links? }
--                 the same mail added to the same job again: that entry is refreshed, not doubled
--   event.update  { id, summary?, file_links? }
--   part.save     { job_id, drawing_no, name?, rev?, material?, finish?, next_assy?, qty?, drive_file_url? }
--                 by drawing number: a new one is added; a known one takes only the values given that are not empty
-- Returns the row as it now is.

create function public.dash_apply(p_actor uuid, p_company uuid, p_op text, p_payload jsonb) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  p constant jsonb := coalesce(p_payload, '{}');
  v_job public.dash_jobs;
  v_event public.dash_events;
  v_part public.dash_parts;
begin
  if not private.actor_has_permission(p_actor, p_company, 'dash.edit') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: dash.edit');
  end if;

  if p_op = 'job.create' then
    if p ? 'gmail_thread_id' then
      select * into v_job from public.dash_jobs where company_id = p_company and gmail_thread_id = p ->> 'gmail_thread_id';
      if found then return to_jsonb(v_job); end if;
    end if;
    insert into public.dash_jobs (company_id, title, customer, contact, whose_move, move_since, gmail_thread_id, created_by)
    values (p_company, trim(p ->> 'title'), coalesce(trim(p ->> 'customer'), ''), coalesce(trim(p ->> 'contact'), ''),
            coalesce(p ->> 'whose_move', 'us'), coalesce((p ->> 'move_since')::date, current_date), p ->> 'gmail_thread_id', p_actor)
    returning * into v_job;
    return to_jsonb(v_job);

  elsif p_op = 'job.update' then
    update public.dash_jobs j set
      title            = case when p ? 'title' then trim(p ->> 'title') else j.title end,
      customer         = case when p ? 'customer' then coalesce(trim(p ->> 'customer'), '') else j.customer end,
      contact          = case when p ? 'contact' then coalesce(trim(p ->> 'contact'), '') else j.contact end,
      asked            = case when p ? 'asked' then coalesce(p ->> 'asked', '') else j.asked end,
      whose_move       = case when p ? 'whose_move' then p ->> 'whose_move' else j.whose_move end,
      move_since       = case when p ? 'move_since' then coalesce((p ->> 'move_since')::date, current_date) else j.move_since end,
      due_date         = case when p ? 'due_date' then (p ->> 'due_date')::date else j.due_date end,
      status           = case when p ? 'status' then p ->> 'status' else j.status end,
      drive_folder_url = case when p ? 'drive_folder_url' then p ->> 'drive_folder_url' else j.drive_folder_url end,
      gmail_thread_id  = case when p ? 'gmail_thread_id' then p ->> 'gmail_thread_id' else j.gmail_thread_id end
    where j.company_id = p_company and j.id = (p ->> 'id')::uuid
    returning * into v_job;
    if not found then perform private.raise_issue('NOT_FOUND', 'No such job'); end if;
    return to_jsonb(v_job);

  elsif p_op = 'event.add' then
    if p ? 'gmail_message_id' then
      update public.dash_events e set
        at = coalesce((p ->> 'at')::timestamptz, e.at), who = p ->> 'who',
        mail_from = coalesce(p ->> 'mail_from', ''), mail_to = coalesce(p ->> 'mail_to', ''),
        mail_subject = coalesce(p ->> 'mail_subject', ''), body = coalesce(p ->> 'body', ''),
        file_links = coalesce(p -> 'file_links', '[]')
      where e.company_id = p_company and e.job_id = (p ->> 'job_id')::uuid and e.gmail_message_id = p ->> 'gmail_message_id'
      returning * into v_event;
      if found then return to_jsonb(v_event); end if;
    end if;
    insert into public.dash_events (company_id, job_id, at, who, summary, gmail_message_id, mail_from, mail_to, mail_subject, body, file_links, created_by)
    values (p_company, (p ->> 'job_id')::uuid, coalesce((p ->> 'at')::timestamptz, now()), p ->> 'who', left(p ->> 'summary', 2000),
            p ->> 'gmail_message_id', coalesce(p ->> 'mail_from', ''), coalesce(p ->> 'mail_to', ''), coalesce(p ->> 'mail_subject', ''),
            coalesce(p ->> 'body', ''), coalesce(p -> 'file_links', '[]'), p_actor)
    returning * into v_event;
    return to_jsonb(v_event);

  elsif p_op = 'event.update' then
    update public.dash_events e set
      summary    = case when p ? 'summary' then left(p ->> 'summary', 2000) else e.summary end,
      file_links = case when p ? 'file_links' then p -> 'file_links' else e.file_links end
    where e.company_id = p_company and e.id = (p ->> 'id')::uuid
    returning * into v_event;
    if not found then perform private.raise_issue('NOT_FOUND', 'No such timeline entry'); end if;
    return to_jsonb(v_event);

  elsif p_op = 'part.save' then
    select * into v_part from public.dash_parts
     where company_id = p_company and job_id = (p ->> 'job_id')::uuid and upper(drawing_no) = upper(trim(p ->> 'drawing_no'))
     for update;
    if found then
      update public.dash_parts x set
        name           = coalesce(nullif(trim(p ->> 'name'), ''), x.name),
        rev            = coalesce(nullif(trim(p ->> 'rev'), ''), x.rev),
        material       = coalesce(nullif(trim(p ->> 'material'), ''), x.material),
        finish         = coalesce(nullif(trim(p ->> 'finish'), ''), x.finish),
        next_assy      = coalesce(nullif(trim(p ->> 'next_assy'), ''), x.next_assy),
        qty            = coalesce(nullif(trim(p ->> 'qty'), ''), x.qty),
        drive_file_url = coalesce(nullif(p ->> 'drive_file_url', ''), x.drive_file_url)
      where x.id = v_part.id
      returning * into v_part;
    else
      insert into public.dash_parts (company_id, job_id, drawing_no, name, rev, material, finish, next_assy, qty, drive_file_url)
      values (p_company, (p ->> 'job_id')::uuid, upper(trim(p ->> 'drawing_no')), coalesce(trim(p ->> 'name'), ''), coalesce(trim(p ->> 'rev'), ''),
              coalesce(trim(p ->> 'material'), ''), coalesce(trim(p ->> 'finish'), ''), coalesce(trim(p ->> 'next_assy'), ''),
              coalesce(trim(p ->> 'qty'), ''), nullif(p ->> 'drive_file_url', ''))
      returning * into v_part;
    end if;
    return to_jsonb(v_part);

  else
    perform private.raise_issue('UNSUPPORTED_OPERATION', format('Unknown operation: %s', p_op));
  end if;
end
$$;

revoke all on function public.dash_apply(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.dash_apply(uuid, uuid, text, jsonb) to service_role;
