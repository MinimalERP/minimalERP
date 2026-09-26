-- A print layout per company (ADR-0025, step 4).
--
-- Each company may print its vouchers with its own simple HTML layout (placeholders filled from the voucher: see
-- packages/domain/src/print/template.ts) instead of the built-in one, and put its own logo and signature on them.
--   * templates: { "invoice": "<html…>", "invoice.purchaseOrder": "…", "ledger": "…", "ledger.payment": "…" } — by document shape, and
--     optionally by voucher kind (the kind's own wins over the shape's). A shape left out prints the built-in layout.
--   * images:    { "logo": "data:image/png;base64,…", "signature": "…" } — small pictures kept with the layout (no file storage needed).
-- Everyone who may see the company's vouchers prints with it; whoever may change its masters may change it. One row per company, so
-- one business's layout can never be another's.

create table public.company_print_layouts (
  company_id  uuid primary key references public.companies (id) on delete cascade,
  templates   jsonb not null default '{}'::jsonb check (jsonb_typeof(templates) = 'object' and octet_length(templates::text) <= 400000),
  images      jsonb not null default '{}'::jsonb check (jsonb_typeof(images) = 'object' and octet_length(images::text) <= 450000),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

alter table public.company_print_layouts enable row level security;
revoke all on public.company_print_layouts from public, anon, authenticated;
grant select on public.company_print_layouts to authenticated;
create policy company_print_layouts_select on public.company_print_layouts
  for select to authenticated using (private.has_permission(company_id, 'voucher.view'));

create function public.print_layout_get(p_actor uuid, p_company uuid) returns jsonb
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not private.actor_has_permission(p_actor, p_company, 'voucher.view') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: voucher.view');
  end if;
  select jsonb_build_object('templates', l.templates, 'images', l.images, 'updatedAt', l.updated_at) into v
    from public.company_print_layouts l where l.company_id = p_company;
  return coalesce(v, jsonb_build_object('templates', '{}'::jsonb, 'images', '{}'::jsonb));
end
$$;

-- Replaces the company's layouts and images (the editor sends them whole). Only well-formed keys and pictures are kept.
create function public.print_layout_set(p_actor uuid, p_company uuid, p_request_id text, p_templates jsonb, p_images jsonb) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  k text;
  v jsonb;
begin
  if not private.actor_has_permission(p_actor, p_company, 'master.write') then
    perform private.raise_issue('PERMISSION_DENIED', 'Not permitted: master.write');
  end if;
  if jsonb_typeof(p_templates) <> 'object' or jsonb_typeof(p_images) <> 'object' then
    perform private.raise_issue('SCHEMA_INVALID', 'Layouts and images are given by name');
  end if;
  for k, v in select * from jsonb_each(p_templates) loop
    if k !~ '^(invoice|ledger)(\.[A-Za-z]+)?$' or jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 60000 then
      perform private.raise_issue('SCHEMA_INVALID', format('Layout %s: a layout is HTML text of at most 60,000 characters, named invoice[.kind] or ledger[.kind]', k));
    end if;
  end loop;
  for k, v in select * from jsonb_each(p_images) loop
    if k not in ('logo', 'signature') or jsonb_typeof(v) <> 'string'
       or (v #>> '{}') !~ '^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$' or char_length(v #>> '{}') > 210000 then
      perform private.raise_issue('SCHEMA_INVALID', format('Picture %s: a PNG, JPEG, GIF or WebP of at most 150 KB', k));
    end if;
  end loop;
  insert into public.company_print_layouts (company_id, templates, images, updated_by)
  values (p_company, p_templates, p_images, p_actor)
  on conflict (company_id) do update set templates = excluded.templates, images = excluded.images, updated_by = excluded.updated_by, updated_at = now();
  -- which layouts and pictures there are now: not their content
  insert into public.audit_log (company_id, actor, action, entity_type, entity_id, after, request_id)
  values (p_company, p_actor, 'company.printLayout', 'company', p_company,
          jsonb_build_object('templates', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_object_keys(p_templates) x),
                             'images', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_object_keys(p_images) x)),
          p_request_id);
  return public.print_layout_get(p_actor, p_company);
end
$$;

revoke all on function public.print_layout_get(uuid, uuid) from public, anon, authenticated;
revoke all on function public.print_layout_set(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.print_layout_get(uuid, uuid) to service_role;
grant execute on function public.print_layout_set(uuid, uuid, text, jsonb, jsonb) to service_role;
grant all on public.company_print_layouts to service_role;
