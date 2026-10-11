-- The stock item master loses "Main drawing" and "Item details and files", and gains two free-text TAG fields.
--
-- The files were kept INSIDE each item's row (base64 in main_drawing / details), and load_masters_json handed every one of them to the app
-- each time a company was opened: a few customer PDFs made every start slower for everyone. An item's drawings are MinimalCAD files now
-- (public.cad_files, read one at a time). Each save of an item also copied the whole row, files and all, into audit_log twice.
--
-- Nothing already stored is thrown away here: what the two columns held moves to private.stock_item_files_archive, out of the way of
-- every read, until it is exported or deleted on purpose.

create table private.stock_item_files_archive (
  item_id      uuid primary key,
  company_id   uuid not null,
  main_drawing jsonb,
  details      jsonb,
  archived_at  timestamptz not null default now()
);
revoke all on private.stock_item_files_archive from public, anon, authenticated;

insert into private.stock_item_files_archive (item_id, company_id, main_drawing, details)
select id, company_id, main_drawing, details
  from public.stock_items
 where main_drawing is not null or details <> '[]'::jsonb;

-- The loader goes back to being the plain one, plus the tags.
drop function public.load_masters_json(uuid);
alter function public.load_masters_json_without_item_files(uuid) rename to load_masters_json_base;

alter table public.stock_items
  drop column main_drawing,
  drop column details,
  add column tags1 text check (tags1 is null or length(tags1) <= 200),
  add column tags2 text check (tags2 is null or length(tags2) <= 200);

create function public.load_masters_json(p_company uuid) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  with base as (select public.load_masters_json_base(p_company) as value)
  select jsonb_set(
    base.value,
    '{stock_items}',
    coalesce((
      select jsonb_agg(item.value || jsonb_build_object('tags1', stock.tags1, 'tags2', stock.tags2) order by stock.name)
      from jsonb_array_elements(base.value -> 'stock_items') as item(value)
      join public.stock_items stock on stock.id = (item.value ->> 'id')::uuid
    ), '[]'::jsonb)
  )
  from base
$$;

revoke execute on function public.load_masters_json(uuid) from public, anon, authenticated;
grant execute on function public.load_masters_json(uuid) to service_role;
