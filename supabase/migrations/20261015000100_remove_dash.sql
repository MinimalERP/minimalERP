-- minimalDASH is removed entirely, at the owner's request (2026-09-26: "delete this DASH project completely … have a different plan").
-- Its tables, functions and permissions go; the `dash` Edge Function is deleted from the project, and its front end repository with it.
-- Nothing in the books referred to DASH data, so no book changes. (Migrations 20261009000100, 20261014000100 and 20261014000200 stay
-- in the history because they were applied; this one undoes them.)

drop function if exists public.dash_project_apply(uuid, text, jsonb);
drop function if exists private.owns_a_company(uuid);
drop function if exists public.dash_apply(uuid, uuid, text, jsonb);
drop table if exists public.dash_events, public.dash_parts, public.dash_jobs, public.dash_projects;
delete from public.role_permissions where permission in ('dash.view', 'dash.edit');
