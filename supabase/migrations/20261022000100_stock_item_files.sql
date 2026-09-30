-- Simple drawings and free-form notes/files on a stock item master.
alter table public.stock_items
  add column main_drawing jsonb,
  add column details jsonb not null default '[]'::jsonb;

-- Keep the existing master loader and add the larger optional document payload to its stock item rows.
alter function public.load_masters_json(uuid) rename to load_masters_json_without_item_files;

create function public.load_masters_json(p_company uuid) returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  with base as (select public.load_masters_json_without_item_files(p_company) as value)
  select jsonb_set(
    base.value,
    '{stock_items}',
    coalesce((
      select jsonb_agg(
        item.value || jsonb_build_object('main_drawing', stock.main_drawing, 'details', stock.details)
        order by stock.name
      )
      from jsonb_array_elements(base.value -> 'stock_items') as item(value)
      join public.stock_items stock on stock.id = (item.value ->> 'id')::uuid
    ), '[]'::jsonb)
  )
  from base
$$;

revoke execute on function public.load_masters_json(uuid) from public, anon, authenticated;
grant execute on function public.load_masters_json(uuid) to service_role;
