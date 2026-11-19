-- Test-only stand-ins for what a hosted Supabase project already has, so the
-- real migrations can run unchanged against a plain Postgres. Never applied
-- to the hosted project.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_auth_admin nologin;

create schema auth;
create table auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- Supabase's auth.uid() reads the subject of the request's verified token.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ), ''
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase's default privileges: every new table, function and sequence in
-- `public` is granted to these three roles. The migrations have to undo this
-- for themselves, and the tests check that they did.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
