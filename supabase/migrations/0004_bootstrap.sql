-- First-time setup: the app may create the very first owner when no profiles exist yet.
create or replace function setup_needed() returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles)
$$;
grant execute on function setup_needed() to anon, authenticated;
grant execute on function upsert_profile(uuid, text, app_role, text, boolean) to anon, authenticated;
