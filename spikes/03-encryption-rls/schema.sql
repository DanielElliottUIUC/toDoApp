-- Spike 03: schema that mimics the parts of Supabase the design depends on.
-- Run as the Postgres superuser against a throwaway database.

-- --- Supabase stand-ins -----------------------------------------------------
-- Supabase ships an `authenticated` role and an auth.uid() that reads the
-- request's JWT claims. Reproduce both so the policies below are the real ones.
create role authenticated nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid
$$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;

-- --- Roles the app adds ------------------------------------------------------
-- The background worker logs in as app_worker. It has no BYPASSRLS and no table
-- privileges of its own; all it can do is become `authenticated` for one user
-- inside a transaction, or call the dispatcher function.
create role app_worker login password 'worker' noinherit;
grant authenticated to app_worker;

-- --- Tables ------------------------------------------------------------------
create table public.user_keys (
  user_id      uuid primary key,
  wrapped_dek  bytea not null,          -- data key, wrapped by the KMS key
  kek_version  int   not null,
  created_at   timestamptz not null default now()
);

create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  -- clear columns: what code needs for scheduling and load arithmetic
  due_at        timestamptz,
  est_minutes   int,
  status        text not null default 'open',
  -- content: ciphertext only
  title_enc     bytea not null,
  notes_enc     bytea
);

create table public.job_schedule (
  user_id   uuid not null,
  job_type  text not null,
  next_run  timestamptz not null,
  paused    boolean not null default false,
  primary key (user_id, job_type)
);

create table public.audit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  at         timestamptz not null default now(),
  actor      text not null,              -- 'agent' | 'user' | 'operator'
  action     text not null,
  target     text
);

-- --- Row-level security: on, and forced, on every table ----------------------
alter table public.user_keys    enable row level security;
alter table public.tasks        enable row level security;
alter table public.job_schedule enable row level security;
alter table public.audit_log    enable row level security;
alter table public.user_keys    force row level security;
alter table public.tasks        force row level security;
alter table public.job_schedule force row level security;
alter table public.audit_log    force row level security;

create policy own_rows on public.user_keys    for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_rows on public.tasks        for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_rows on public.job_schedule for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Audit log is append-only: a person can add and read their own entries, and
-- nobody (including the worker acting as them) can change or remove one.
create policy own_select on public.audit_log for select to authenticated
  using (user_id = auth.uid());
create policy own_insert on public.audit_log for insert to authenticated
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.tasks, public.job_schedule to authenticated;
grant select, insert                 on public.user_keys                  to authenticated;
grant select, insert                 on public.audit_log                  to authenticated;

-- --- The one cross-user question ---------------------------------------------
-- The dispatcher must ask "who is due?". It gets ids and nothing else, through
-- a function that cannot return content because it never selects any.
create function public.due_users(p_job_type text, p_now timestamptz)
returns table (user_id uuid)
language sql security definer set search_path = public as $$
  select s.user_id from public.job_schedule s
  where s.job_type = p_job_type and s.next_run <= p_now and not s.paused
$$;
revoke all on function public.due_users(text, timestamptz) from public;
grant execute on function public.due_users(text, timestamptz) to app_worker;
