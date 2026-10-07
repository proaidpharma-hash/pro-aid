-- 0013 · Supabase Security Advisor clean-up (report of 3 Oct 2026: 1 error, 97 warnings)
--  1. ERROR   rls_disabled_in_public      — public._migrations (created by the deploy workflow) had no RLS
--  2. WARNING function_search_path_mutable — 44 helper / trigger functions had no fixed search_path
--  3. WARNING public/anon can execute SECURITY DEFINER functions — default EXECUTE crept back onto
--             functions (re)created after 0009; trigger functions and internal helpers were callable by API roles
-- Nothing here changes a business rule; it only tightens who may call what.

-- 1. the migration bookkeeping table: nobody reaches it through the API
create table if not exists public._migrations(name text primary key, applied_at timestamptz default now());
alter table public._migrations enable row level security;
revoke all on table public._migrations from public, anon, authenticated;

-- 2. every function in public gets a fixed search_path (the linter only asks that it is set)
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;

-- 3a. the public / anonymous role can call nothing except the two first-run functions
revoke execute on all functions in schema public from public, anon;
alter default privileges for role postgres in schema public revoke execute on functions from public;
grant execute on function setup_needed() to anon;
grant execute on function upsert_profile(uuid, text, app_role, text, boolean) to anon;   -- guarded inside: only while no profile exists

-- 3b. trigger functions are fired by the database, never called by a user
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

-- 3c. anomaly helpers run only inside run_daily_jobs (as its definer) or from pg_cron — not from the API.
--     ensure_business_day / notify_users stay callable by signed-in users because invoker triggers
--     (trg_ensure_day, notify_owners, notify_everyone) call them on the caller's behalf; both refuse misuse inside.
revoke execute on function anomaly_alert(text, text, text) from public, anon, authenticated;
revoke execute on function run_anomaly_checks(date) from public, anon, authenticated;
