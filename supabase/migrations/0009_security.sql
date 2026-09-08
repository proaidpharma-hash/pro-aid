-- 0009 · security hardening
--  1. no function is callable by the public / anonymous role except the first-time setup check
--  2. internal helpers (notifications, day creation, jobs) cannot be called directly from the API
--  3. views respect row-level security of the caller
--  4. uploads may only go into the uploader's own folder; nothing in the bucket can be changed or deleted
--  5. the owner can reset a login's PIN from inside the app (audited)

-- 1. functions: default EXECUTE for PUBLIC is removed; only signed-in users may call the API
revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke execute on functions from public;
grant execute on all functions in schema public to authenticated;
grant execute on function setup_needed() to anon;
grant execute on function upsert_profile(uuid, text, app_role, text, boolean) to anon;   -- guarded inside: only while no profile exists

-- 2. internal helpers refuse direct API calls. Notifications may be created inside a trigger, by the owner,
--    or by one of the entry points below, which flag themselves as internal before doing their work.
-- true when the call comes in through the API (PostgREST sets the JWT claims); false for the scheduler and migrations
create or replace function is_api_request() returns boolean language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true), '') <> ''
$$;

create or replace function notify_users(p_users uuid[], p_kind notification_kind, p_title text, p_body text, p_ref_table text, p_ref_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if is_api_request() and not (pg_trigger_depth() > 0 or is_owner() or current_setting('app.internal', true) = '1') then
    raise exception 'notifications are created by the system only' using errcode = '42501';
  end if;
  insert into notifications(user_id, kind, title, body, ref_table, ref_id)
  select unnest(p_users), p_kind, p_title, p_body, p_ref_table, p_ref_id;
end $$;

alter function record_payment(uuid, date, numeric, uuid, cash_source, uuid, uuid) rename to record_payment_impl;
create or replace function record_payment(p_invoice uuid, p_day date, p_amount numeric, p_account uuid, p_cash_source cash_source, p_photo uuid, p_requested_by uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.internal', '1', true);
  return record_payment_impl(p_invoice, p_day, p_amount, p_account, p_cash_source, p_photo, p_requested_by);
end $$;

alter function submit_closing(date, numeric, uuid, text, jsonb) rename to submit_closing_impl;
create or replace function submit_closing(p_day date, p_counted numeric, p_drawer_photo uuid, p_note text default null, p_denominations jsonb default null)
returns closings language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.internal', '1', true);
  return submit_closing_impl(p_day, p_counted, p_drawer_photo, p_note, p_denominations);
end $$;

alter function mark_posted(uuid, numeric, text, text) rename to mark_posted_impl;
create or replace function mark_posted(p_invoice uuid, p_posted_amount numeric default null, p_diff_kind text default null, p_diff_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.internal', '1', true);
  perform mark_posted_impl(p_invoice, p_posted_amount, p_diff_kind, p_diff_note);
end $$;

-- the daily jobs run from the scheduler (as postgres) or by the owner
alter function run_daily_jobs() rename to run_daily_jobs_impl;
create or replace function run_daily_jobs() returns void language plpgsql security definer set search_path = public as $$
begin
  if is_api_request() and not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  perform set_config('app.internal', '1', true);
  perform run_daily_jobs_impl();
end $$;

-- the *_impl functions are never called from the API
revoke execute on function record_payment_impl(uuid, date, numeric, uuid, cash_source, uuid, uuid) from public, anon, authenticated;
revoke execute on function submit_closing_impl(date, numeric, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function mark_posted_impl(uuid, numeric, text, text) from public, anon, authenticated;
revoke execute on function run_daily_jobs_impl() from public, anon, authenticated;

create or replace function ensure_business_day(d date) returns void language plpgsql security definer set search_path = public as $$
declare prev_close numeric(14,2);
begin
  if is_api_request() and my_role() is null and pg_trigger_depth() = 0 then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if exists (select 1 from business_days where day = d) then return; end if;
  select c.counted_cash into prev_close from closings c where c.day < d order by c.day desc limit 1;
  insert into business_days(day, opening_cash) values (d, coalesce(prev_close, 0)) on conflict do nothing;
end $$;

-- 3. views run with the caller's rights (staff balances: a cashier only sees their own entries)
alter view v_staff_balance set (security_invoker = true);
alter view v_owner_paid set (security_invoker = true);
alter view v_non_cash_received set (security_invoker = true);
alter view v_invoice_status set (security_invoker = true);
alter view v_distributor_balance set (security_invoker = true);
alter view v_customer_balance set (security_invoker = true);

-- 4. storage: a user may only upload into their own folder (yyyy/mm/<uid>/file); nothing is ever updated or deleted
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    execute 'drop policy if exists proofs_write on storage.objects';
    execute 'create policy proofs_write on storage.objects for insert with check (bucket_id = ''proofs'' and public.my_role() is not null and (storage.foldername(name))[3] = auth.uid()::text)';
  end if;
end $$;

-- 5. owner resets a login's PIN. The app sends the derived password; it is stored with bcrypt exactly as Supabase Auth does.
create extension if not exists pgcrypto;
create or replace function reset_login_pin(p_user uuid, p_password text) returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'change your own PIN from the Settings page' using errcode = 'PA050'; end if;
  if length(coalesce(p_password, '')) < 20 then raise exception 'bad password' using errcode = 'PA050'; end if;
  if not exists (select 1 from profiles where id = p_user and has_login) then raise exception 'no login for this user' using errcode = 'PA050'; end if;
  if to_regclass('auth.users') is not null and exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password') then
    update auth.users set encrypted_password = crypt(p_password, gen_salt('bf', 10)), updated_at = now() where id = p_user;
  end if;
  if to_regclass('auth.local_creds') is not null then
    update auth.local_creds set pass_hash = encode(digest(p_password, 'sha256'), 'hex') where user_id = p_user;
  end if;
  insert into audit_log(user_id, action, table_name, row_id, after, device)
  values (auth.uid(), 'reset_pin', 'profiles', p_user, jsonb_build_object('user', p_user), current_device());
end $$;
revoke execute on function reset_login_pin(uuid, text) from public, anon;
grant execute on function reset_login_pin(uuid, text) to authenticated;
