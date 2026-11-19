-- Foundation schema (build step 2).
--
-- Rules every later migration must keep:
--   * Row-level security is enabled AND forced on every table in `public`.
--   * Supabase grants `anon` and `authenticated` everything on new tables by
--     default, so each table's privileges are revoked and then granted back
--     one by one. `anon` gets nothing.
--   * Content columns end in `_enc` and hold ciphertext made by the
--     application. Plaintext content never appears in SQL.
--   * Exactly one function, claim_due_jobs, reads across people. It returns
--     ids and job names and nothing else.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- app_worker: the job runner's login. It owns nothing and can do nothing
--   until, inside one transaction, it becomes `authenticated` for one person.
-- app_dispatcher: the every-minute tick's login. It can call the three
--   dispatcher functions and touch no table.
-- Both are created without LOGIN. A password is set out of band, from an
-- environment variable, never in a migration.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_worker') then
    create role app_worker nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_dispatcher') then
    create role app_dispatcher nologin noinherit;
  end if;
end $$;
grant authenticated to app_worker;
grant usage on schema public to app_dispatcher;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.is_valid_timezone(p_tz text) returns boolean
language sql stable set search_path = pg_catalog as $$
  select exists (select 1 from pg_timezone_names where name = p_tz)
$$;

-- The next moment, strictly after p_after, at which the wall clock in p_tz
-- reads p_local on one of the ISO weekdays in p_days (1 = Monday).
create function public.next_occurrence(
  p_tz text, p_local time, p_days smallint[], p_after timestamptz
) returns timestamptz
language plpgsql stable set search_path = pg_catalog as $$
declare
  d date := (p_after at time zone p_tz)::date;
  candidate timestamptz;
begin
  for i in 0..8 loop
    candidate := ((d + i) + p_local) at time zone p_tz;
    if candidate > p_after
       and extract(isodow from (d + i))::smallint = any (p_days) then
      return candidate;
    end if;
  end loop;
  raise exception 'no occurrence within nine days for days %', p_days;
end $$;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  timezone     text not null default 'America/Chicago',
  is_operator  boolean not null default false,
  agent_paused boolean not null default false,
  created_at   timestamptz not null default now()
);

create function public.profiles_check_timezone() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
begin
  if not public.is_valid_timezone(new.timezone) then
    raise exception 'unknown time zone' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger profiles_check_timezone
  before insert or update of timezone on public.profiles
  for each row execute function public.profiles_check_timezone();

-- Invitations. Nobody but the server reads this table. The token itself is
-- never stored, only its hash.
create table public.invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (email = lower(email)),
  token_hash  bytea not null unique,
  created_by  uuid references auth.users (id) on delete set null, -- null: bootstrap of the first account
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at  timestamptz
);
create unique index invites_one_open_per_email
  on public.invites (email) where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- Keys and credentials
-- ---------------------------------------------------------------------------
-- One data key per person, stored only as wrapped by the key service.
create table public.user_keys (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  wrapped_dek bytea not null,
  kek_id      text not null,   -- which top key wrapped it, for rotation
  created_at  timestamptz not null default now()
);

-- A person's own model-provider API key, encrypted with their data key.
create table public.provider_credentials (
  user_id    uuid not null references auth.users (id) on delete cascade,
  provider   text not null check (provider in ('anthropic')),
  key_enc    bytea not null,
  key_last4  text not null check (char_length(key_last4) = 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

-- ---------------------------------------------------------------------------
-- Audit log: append-only, one per person
-- ---------------------------------------------------------------------------
-- `meta` holds ids, counts and names of things. Never content.
create table public.audit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  at         timestamptz not null default now(),
  actor      text not null check (actor in ('user', 'agent', 'operator', 'system')),
  action     text not null,
  target     text,
  target_id  uuid,
  meta       jsonb not null default '{}'::jsonb,
  undo_of    bigint references public.audit_log (id)
);
create index audit_log_user_at on public.audit_log (user_id, at desc);

-- ---------------------------------------------------------------------------
-- Jobs: schedules and the durable queue of runs
-- ---------------------------------------------------------------------------
create table public.job_schedules (
  user_id      uuid not null references auth.users (id) on delete cascade,
  job_type     text not null,
  local_time   time not null,
  days         smallint[] not null default '{1,2,3,4,5,6,7}'
               check (days <@ '{1,2,3,4,5,6,7}'::smallint[] and cardinality(days) > 0),
  enabled      boolean not null default true,
  -- A run this late is not worth sending (a morning message at 5pm). It is
  -- marked expired and the schedule moves on.
  max_lateness interval not null default interval '3 hours',
  next_run_at  timestamptz not null,
  last_run_at  timestamptz,
  primary key (user_id, job_type)
);
create index job_schedules_due on public.job_schedules (next_run_at) where enabled;

create table public.job_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  job_type        text not null,
  scheduled_for   timestamptz not null,
  idempotency_key text not null unique,
  status          text not null default 'pending'
                  check (status in ('pending', 'triggered', 'running', 'succeeded', 'failed', 'expired')),
  attempts        integer not null default 0,   -- times the job runner refused to accept it
  last_error_code text,                         -- a code, never a message with content in it
  external_run_id text,
  created_at      timestamptz not null default now(),
  triggered_at    timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz
);
create index job_runs_pending on public.job_runs (scheduled_for) where status = 'pending';
create index job_runs_user on public.job_runs (user_id, scheduled_for desc);

-- ---------------------------------------------------------------------------
-- Messages: preferences and the outbound queue
-- ---------------------------------------------------------------------------
create table public.message_prefs (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  soft_cap     integer not null default 5  check (soft_cap between 0 and 50),
  hard_cap     integer not null default 10 check (hard_cap between 0 and 50),
  breakout_cap integer not null default 2  check (breakout_cap between 0 and 10),
  quiet_start  time not null default '22:00',
  quiet_end    time not null default '07:00',
  one_batch_a_day boolean not null default false,   -- the quiet mode
  check (soft_cap <= hard_cap)
);

create table public.outbound_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  created_at      timestamptz not null default now(),
  delivery        text not null check (delivery in ('reply', 'breakout', 'batch')),
  breakout_reason text check (breakout_reason in ('start_cue', 'calendar_change')),
  lane            text not null default 'reminder' check (lane in ('capture', 'reminder', 'digest')),
  message_type    text not null,
  body_enc        bytea not null,
  status          text not null default 'queued' check (status in ('queued', 'sent', 'dropped', 'failed')),
  batch_slot      text check (batch_slot in ('morning', 'afternoon', 'evening')),
  hold_until      timestamptz,
  channel         text check (channel in ('telegram', 'in_app', 'web_push')),
  counted         boolean not null default true,    -- false for replies to the person's own message
  sent_at         timestamptz,
  drop_reason     text,
  check ((delivery = 'breakout') = (breakout_reason is not null))
);
create index outbound_messages_queue on public.outbound_messages (user_id, status, hold_until);
create index outbound_messages_sent on public.outbound_messages (user_id, sent_at) where status = 'sent';

-- ---------------------------------------------------------------------------
-- Spend
-- ---------------------------------------------------------------------------
-- Shared reference data, not anyone's content: readable by every signed-in
-- person, writable by none.
create table public.model_prices (
  model                    text not null,
  effective_from           date not null,
  input_per_mtok           numeric(10, 4) not null,
  output_per_mtok          numeric(10, 4) not null,
  cache_write_5m_per_mtok  numeric(10, 4) not null,
  cache_write_1h_per_mtok  numeric(10, 4) not null,
  cache_read_per_mtok      numeric(10, 4) not null,
  -- Some models charge more once the prompt passes a size. Null: one price.
  long_prompt_threshold    integer,
  long_input_per_mtok          numeric(10, 4),
  long_output_per_mtok         numeric(10, 4),
  long_cache_write_5m_per_mtok numeric(10, 4),
  long_cache_write_1h_per_mtok numeric(10, 4),
  long_cache_read_per_mtok     numeric(10, 4),
  batch_multiplier         numeric(4, 3) not null default 0.5,
  primary key (model, effective_from)
);

-- Confirmed against the official pricing page on 2026-11-17 (docs/spikes/10-model-prices.md).
insert into public.model_prices
  (model, effective_from, input_per_mtok, output_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok,
   long_prompt_threshold, long_input_per_mtok, long_output_per_mtok, long_cache_write_5m_per_mtok, long_cache_write_1h_per_mtok, long_cache_read_per_mtok)
values
  ('claude-haiku-5-5',  '2026-11-17', 0.10, 0.50, 0.125, 0.20, 0.01, 100000, 0.50, 2.50, 0.625, 1.00, 0.05),
  ('claude-sonnet-5-5', '2026-11-17', 2,    10,   2.50,  4,    0.10, null, null, null, null, null, null),
  ('claude-opus-5-5',   '2026-11-17', 4,    20,   5,     8,    0.20, null, null, null, null, null, null),
  ('claude-fable-5-2',  '2026-11-17', 8,    40,   10,    16,   0.20, null, null, null, null, null, null);

create table public.spend_events (
  id                    bigint generated always as identity primary key,
  user_id               uuid not null references auth.users (id) on delete cascade,
  at                    timestamptz not null default now(),
  job_type              text not null,
  model                 text not null,
  input_tokens          integer not null default 0 check (input_tokens >= 0),
  output_tokens         integer not null default 0 check (output_tokens >= 0),
  cache_write_5m_tokens integer not null default 0 check (cache_write_5m_tokens >= 0),
  cache_write_1h_tokens integer not null default 0 check (cache_write_1h_tokens >= 0),
  cache_read_tokens     integer not null default 0 check (cache_read_tokens >= 0),
  batch                 boolean not null default false,
  cost_usd              numeric(12, 6) not null check (cost_usd >= 0)
);
create index spend_events_user_at on public.spend_events (user_id, at desc);

-- ---------------------------------------------------------------------------
-- Row-level security: enabled and forced everywhere
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

-- profiles: read your own; change only your time zone and the pause switch.
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on public.profiles to authenticated;
grant update (timezone, agent_paused) on public.profiles to authenticated;

-- invites: no policy and no grant. Reached only through the functions below.

-- user_keys: read and create your own. A wrapped key is never edited in place.
create policy user_keys_select on public.user_keys for select to authenticated
  using (user_id = (select auth.uid()));
create policy user_keys_insert on public.user_keys for insert to authenticated
  with check (user_id = (select auth.uid()));
grant select, insert on public.user_keys to authenticated;

-- provider_credentials: fully yours, including removing it.
create policy provider_credentials_all on public.provider_credentials for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.provider_credentials to authenticated;

-- audit_log: append and read. No update, no delete, for anyone acting as a person.
create policy audit_log_select on public.audit_log for select to authenticated
  using (user_id = (select auth.uid()));
create policy audit_log_insert on public.audit_log for insert to authenticated
  with check (user_id = (select auth.uid()));
grant select, insert on public.audit_log to authenticated;

-- job_schedules: yours to set.
create policy job_schedules_all on public.job_schedules for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.job_schedules to authenticated;

-- job_runs: created only by the dispatcher. The worker, acting as the person,
-- may report progress on that person's runs.
create policy job_runs_select on public.job_runs for select to authenticated
  using (user_id = (select auth.uid()));
create policy job_runs_update on public.job_runs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on public.job_runs to authenticated;
grant update (status, started_at, finished_at, last_error_code) on public.job_runs to authenticated;

-- message_prefs: yours to set.
create policy message_prefs_all on public.message_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on public.message_prefs to authenticated;

-- outbound_messages: yours. Never deleted; a message that will not be sent is marked dropped.
create policy outbound_messages_select on public.outbound_messages for select to authenticated
  using (user_id = (select auth.uid()));
create policy outbound_messages_insert on public.outbound_messages for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy outbound_messages_update on public.outbound_messages for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on public.outbound_messages to authenticated;

-- model_prices: shared reference data. Readable by any signed-in person.
create policy model_prices_select on public.model_prices for select to authenticated using (true);
grant select on public.model_prices to authenticated;

-- spend_events: append and read.
create policy spend_events_select on public.spend_events for select to authenticated
  using (user_id = (select auth.uid()));
create policy spend_events_insert on public.spend_events for insert to authenticated
  with check (user_id = (select auth.uid()));
grant select, insert on public.spend_events to authenticated;

-- The spend meter: cost by day and job type, in the person's own time zone.
-- security_invoker makes the view obey the reader's row-level security.
create view public.spend_daily with (security_invoker = true) as
  select e.user_id,
         (e.at at time zone p.timezone)::date as day,
         e.job_type,
         count(*)::integer as calls,
         sum(e.cost_usd) as cost_usd
  from public.spend_events e
  join public.profiles p on p.user_id = e.user_id
  group by e.user_id, (e.at at time zone p.timezone)::date, e.job_type;
revoke all on public.spend_daily from anon, authenticated;
grant select on public.spend_daily to authenticated;

-- ---------------------------------------------------------------------------
-- Sign-up gate
-- ---------------------------------------------------------------------------
-- Supabase Auth calls this before creating any account. No open invitation
-- for that address means no account, whatever the sign-up toggle says.
create function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_email text := lower(coalesce(event -> 'user' ->> 'email', ''));
begin
  if v_email <> '' and exists (
    select 1 from public.invites i
    where i.email = v_email and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'This app is invite-only.'));
end $$;

-- When an account is created: mark the invitation used and set the person up
-- with defaults. Runs as the definer because the new person has no session yet.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_tz constant text := 'America/Chicago';
begin
  update public.invites
     set accepted_at = now(), accepted_by = new.id
   where email = lower(new.email) and accepted_at is null and revoked_at is null;

  insert into public.profiles (user_id, timezone) values (new.id, v_tz);
  insert into public.message_prefs (user_id) values (new.id);

  -- The three daily batches. The person changes the times in settings.
  insert into public.job_schedules (user_id, job_type, local_time, next_run_at)
  select new.id, j.job_type, j.local_time,
         public.next_occurrence(v_tz, j.local_time, '{1,2,3,4,5,6,7}', now())
  from (values ('batch_morning', time '07:30'),
               ('batch_afternoon', time '15:00'),
               ('batch_evening', time '20:30')) as j (job_type, local_time);

  insert into public.audit_log (user_id, actor, action) values (new.id, 'system', 'account.created');
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The operator invites someone. The caller must be signed in and be an operator.
-- The token is made by the server; only its hash arrives here.
create function public.create_invite(p_email text, p_token_hash bytea) returns uuid
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_caller uuid := auth.uid();
  v_id uuid;
begin
  if v_caller is null or not exists (
    select 1 from public.profiles where user_id = v_caller and is_operator
  ) then
    raise exception 'only an operator may invite' using errcode = '42501';
  end if;
  insert into public.invites (email, token_hash, created_by)
  values (lower(trim(p_email)), p_token_hash, v_caller)
  returning id into v_id;
  insert into public.audit_log (user_id, actor, action, target, target_id)
  values (v_caller, 'operator', 'invite.created', 'invites', v_id);
  return v_id;
end $$;

-- The server looks an invitation up by the hash of the token in the link.
create function public.invite_for_token(p_token_hash bytea)
returns table (invite_id uuid, email text)
language sql stable security definer set search_path = public, pg_catalog as $$
  select i.id, i.email from public.invites i
  where i.token_hash = p_token_hash
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
$$;

-- ---------------------------------------------------------------------------
-- Dispatcher: the one place a query spans people
-- ---------------------------------------------------------------------------
-- Called by the tick. Turns every due schedule into a pending run (once),
-- retires runs that are too late to be worth sending, and hands back every
-- run still waiting to be started. It returns who and what, never content.
create function public.claim_due_jobs(p_now timestamptz, p_limit integer default 200)
returns table (run_id uuid, user_id uuid, job_type text, scheduled_for timestamptz, idempotency_key text)
language plpgsql security definer set search_path = public, pg_catalog as $$
#variable_conflict use_column
begin
  insert into public.job_runs (user_id, job_type, scheduled_for, idempotency_key)
  select s.user_id, s.job_type, s.next_run_at,
         s.user_id::text || ':' || s.job_type || ':' ||
           to_char(s.next_run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from public.job_schedules s
  join public.profiles p on p.user_id = s.user_id
  where s.enabled and not p.agent_paused and s.next_run_at <= p_now
  on conflict on constraint job_runs_idempotency_key_key do nothing;

  -- Too late to be useful: expire the run and move the schedule on.
  with late as (
    update public.job_runs r
       set status = 'expired', finished_at = p_now
      from public.job_schedules s
     where r.status = 'pending'
       and s.user_id = r.user_id and s.job_type = r.job_type
       and r.scheduled_for + s.max_lateness < p_now
    returning r.user_id, r.job_type, r.scheduled_for
  )
  update public.job_schedules s
     set next_run_at = public.next_occurrence(p.timezone, s.local_time, s.days, p_now)
    from late l
    join public.profiles p on p.user_id = l.user_id
   where s.user_id = l.user_id and s.job_type = l.job_type and s.next_run_at <= p_now;

  return query
    select r.id, r.user_id, r.job_type, r.scheduled_for, r.idempotency_key
    from public.job_runs r
    join public.profiles p on p.user_id = r.user_id
    where r.status = 'pending' and not p.agent_paused
    order by r.scheduled_for
    limit p_limit;
end $$;

-- The job runner accepted the run. Only now does the schedule move on.
create function public.mark_job_triggered(p_run_id uuid, p_external_run_id text, p_now timestamptz)
returns boolean
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_run public.job_runs%rowtype;
begin
  update public.job_runs
     set status = 'triggered', external_run_id = p_external_run_id, triggered_at = p_now
   where id = p_run_id and status = 'pending'
  returning * into v_run;
  if not found then
    return false;
  end if;
  update public.job_schedules s
     set last_run_at = v_run.scheduled_for,
         next_run_at = public.next_occurrence(p.timezone, s.local_time, s.days, greatest(v_run.scheduled_for, p_now))
    from public.profiles p
   where p.user_id = s.user_id
     and s.user_id = v_run.user_id and s.job_type = v_run.job_type
     and s.next_run_at <= v_run.scheduled_for;
  return true;
end $$;

-- The job runner refused the run. It stays pending and the next tick retries.
create function public.mark_job_rejected(p_run_id uuid, p_error_code text)
returns void
language sql security definer set search_path = public, pg_catalog as $$
  update public.job_runs
     set attempts = attempts + 1, last_error_code = left(p_error_code, 64)
   where id = p_run_id and status = 'pending'
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
-- Functions are executable by everyone unless revoked, and Supabase also
-- grants them to anon and authenticated by default. Lock each one down.
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.create_invite(text, bytea) from public, anon;
revoke all on function public.invite_for_token(bytea) from public, anon, authenticated;
revoke all on function public.claim_due_jobs(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.mark_job_triggered(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.mark_job_rejected(uuid, text) from public, anon, authenticated;
revoke all on function public.profiles_check_timezone() from public, anon, authenticated;

grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
grant execute on function public.create_invite(text, bytea) to authenticated;
grant execute on function public.invite_for_token(bytea) to service_role;
grant execute on function public.claim_due_jobs(timestamptz, integer) to app_dispatcher;
grant execute on function public.mark_job_triggered(uuid, text, timestamptz) to app_dispatcher;
grant execute on function public.mark_job_rejected(uuid, text) to app_dispatcher;
