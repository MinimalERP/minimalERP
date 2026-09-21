-- Test-only: emulates the parts of the Supabase platform that our migrations rely on, so the
-- migrations can be exercised on plain PostgreSQL. On real Supabase these already exist — this
-- file is never applied there.
--
-- What it reproduces, faithfully enough for the security tests to mean something:
--   * the anon / authenticated / service_role roles (service_role bypasses RLS)
--   * auth.users, auth.uid(), auth.role(), auth.jwt() reading the PostgREST-style request.jwt.claims GUC
--   * Supabase's DEFAULT PRIVILEGES: new public objects are granted to all three roles. That is
--     precisely why our RLS/privileges migration begins by revoking, and why we test that it did.
--   * the `extensions` schema

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists extensions;
create schema auth;

create table auth.users (
  id     uuid primary key default gen_random_uuid(),
  email  text
);

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;

grant usage on schema public, extensions, auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
