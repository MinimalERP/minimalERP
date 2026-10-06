-- MinimalCAD (the drawing application, its own site) uses this database and this sign-in.
--
--   item_cad_files  a stock item's CAD files (.jcad documents): any number per item, each with a name of its own. MinimalCAD's parts library
--                   IS the item master: it lists the company's items, opens a file, and saves it back — the ERP's item form shows the same rows.
--   cad_drawings    a person's own drawings in MinimalCAD (not tied to an item), and their one autosave slot.
--
-- As everywhere here, a browser only READS these tables (row-level security decides which rows); every write goes through the `cad` Edge
-- Function, which calls the functions below as the signed-in person. A file is saved over as it is: no versions are kept.

create table public.item_cad_files (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  item_id     uuid not null,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  -- a .jcad document: { "entities": [...], "constraints": [...], ... }
  document    jsonb not null check (jsonb_typeof(document) = 'object'),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (item_id, name),
  constraint item_cad_files_item_fk foreign key (company_id, item_id) references public.stock_items (company_id, id) on delete cascade
);
create index item_cad_files_company_idx on public.item_cad_files (company_id, item_id);

alter table public.item_cad_files enable row level security;
revoke all on public.item_cad_files from public, anon, authenticated;
grant select on public.item_cad_files to authenticated;
create policy item_cad_files_select on public.item_cad_files
  for select to authenticated using (private.has_permission(company_id, 'master.view'));

create table public.cad_drawings (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  name         text not null default 'Untitled' check (char_length(btrim(name)) between 1 and 120),
  document     jsonb not null check (jsonb_typeof(document) = 'object'),
  is_autosave  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index cad_drawings_owner_idx on public.cad_drawings (owner_id, updated_at desc);
-- one autosave slot per person
create unique index cad_drawings_one_autosave on public.cad_drawings (owner_id) where is_autosave;

alter table public.cad_drawings enable row level security;
revoke all on public.cad_drawings from public, anon, authenticated;
grant select on public.cad_drawings to authenticated;
create policy cad_drawings_select on public.cad_drawings
  for select to authenticated using (owner_id = (select auth.uid()));

-- A document is a JSON object, and not absurdly large (a real drawing of several thousand entities is a few MB).
create function private.assert_cad_document(p_document jsonb) returns void
language plpgsql
as $$
begin
  if p_document is null or jsonb_typeof(p_document) <> 'object' then
    perform private.raise_issue('SCHEMA_INVALID', 'That is not a MinimalCAD drawing');
  end if;
  if octet_length(p_document::text) > 20000000 then
    perform private.raise_issue('SCHEMA_INVALID', 'That drawing is too large to keep (20 MB at most)');
  end if;
end
$$;

-- Saves a CAD file on a stock item. With p_id: that file is saved over (and renamed, if the name differs). Without: a new file of that name
-- is added to the item — refused if the item already has one so named (saving over a file is done by its id, never by accident).
create function public.cad_item_file_save(p_actor uuid, p_company uuid, p_item uuid, p_id uuid, p_name text, p_document jsonb) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_row  public.item_cad_files;
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted to change masters');
  end if;
  if v_name = '' or char_length(v_name) > 120 then
    perform private.raise_issue('SCHEMA_INVALID', 'Give the file a name (120 characters at most)');
  end if;
  perform private.assert_cad_document(p_document);

  if p_id is not null then
    select * into v_row from public.item_cad_files where id = p_id and company_id = p_company;
    if not found then
      perform private.raise_issue('MASTER_NOT_FOUND', 'That file is no longer on the item (it was deleted in MinimalERP)');
    end if;
    if exists (select 1 from public.item_cad_files f where f.item_id = v_row.item_id and f.name = v_name and f.id <> p_id) then
      perform private.raise_issue('MASTER_NAME_TAKEN', format('This item already has a file named "%s"', v_name));
    end if;
    update public.item_cad_files set name = v_name, document = p_document, updated_at = now(), updated_by = p_actor
     where id = p_id returning * into v_row;
  else
    if not exists (select 1 from public.stock_items i where i.company_id = p_company and i.id = p_item) then
      perform private.raise_issue('MASTER_NOT_FOUND', 'That stock item does not exist in this company');
    end if;
    if exists (select 1 from public.item_cad_files f where f.item_id = p_item and f.name = v_name) then
      perform private.raise_issue('MASTER_NAME_TAKEN', format('This item already has a file named "%s"', v_name));
    end if;
    insert into public.item_cad_files (company_id, item_id, name, document, updated_by)
    values (p_company, p_item, v_name, p_document, p_actor) returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'item_id', v_row.item_id, 'name', v_row.name, 'updated_at', v_row.updated_at);
end
$$;

create function public.cad_item_file_delete(p_actor uuid, p_company uuid, p_id uuid) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted to change masters');
  end if;
  delete from public.item_cad_files where id = p_id and company_id = p_company;
  return jsonb_build_object('id', p_id);
end
$$;

-- A person's own drawing: with p_id it is saved over (theirs only); without, a new one. p_autosave writes the one autosave slot instead.
create function public.cad_drawing_save(p_actor uuid, p_id uuid, p_name text, p_document jsonb, p_autosave boolean) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_row  public.cad_drawings;
begin
  if p_actor is null then
    perform private.raise_issue('PERMISSION_DENIED', 'Sign in first');
  end if;
  if v_name = '' then v_name := 'Untitled'; end if;
  v_name := left(v_name, 120);
  perform private.assert_cad_document(p_document);

  if coalesce(p_autosave, false) then
    insert into public.cad_drawings (owner_id, name, document, is_autosave)
    values (p_actor, 'Autosave', p_document, true)
    on conflict (owner_id) where is_autosave do update set document = excluded.document, updated_at = now()
    returning * into v_row;
  elsif p_id is not null then
    update public.cad_drawings set document = p_document, updated_at = now()
     where id = p_id and owner_id = p_actor and not is_autosave returning * into v_row;
    if not found then
      perform private.raise_issue('MASTER_NOT_FOUND', 'That drawing no longer exists');
    end if;
  else
    insert into public.cad_drawings (owner_id, name, document) values (p_actor, v_name, p_document) returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'updated_at', v_row.updated_at);
end
$$;

create function public.cad_drawing_rename(p_actor uuid, p_id uuid, p_name text) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 120);
begin
  if v_name = '' then
    perform private.raise_issue('SCHEMA_INVALID', 'Give the drawing a name');
  end if;
  update public.cad_drawings set name = v_name, updated_at = now() where id = p_id and owner_id = p_actor and not is_autosave;
  if not found then
    perform private.raise_issue('MASTER_NOT_FOUND', 'That drawing no longer exists');
  end if;
  return jsonb_build_object('id', p_id, 'name', v_name);
end
$$;

-- Deletes a person's own drawing — or, asked for it, their autosave slot.
create function public.cad_drawing_delete(p_actor uuid, p_id uuid, p_autosave boolean) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_autosave, false) then
    delete from public.cad_drawings where owner_id = p_actor and is_autosave;
  else
    delete from public.cad_drawings where id = p_id and owner_id = p_actor and not is_autosave;
  end if;
  return jsonb_build_object('id', p_id);
end
$$;

revoke all on function
  private.assert_cad_document(jsonb),
  public.cad_item_file_save(uuid, uuid, uuid, uuid, text, jsonb),
  public.cad_item_file_delete(uuid, uuid, uuid),
  public.cad_drawing_save(uuid, uuid, text, jsonb, boolean),
  public.cad_drawing_rename(uuid, uuid, text),
  public.cad_drawing_delete(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function
  private.assert_cad_document(jsonb),
  public.cad_item_file_save(uuid, uuid, uuid, uuid, text, jsonb),
  public.cad_item_file_delete(uuid, uuid, uuid),
  public.cad_drawing_save(uuid, uuid, text, jsonb, boolean),
  public.cad_drawing_rename(uuid, uuid, text),
  public.cad_drawing_delete(uuid, uuid, boolean)
  to service_role;
grant select, insert, update, delete on public.item_cad_files, public.cad_drawings to service_role;
