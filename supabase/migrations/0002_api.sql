-- Pro Aid · API conveniences: device/reason from request headers, owner edits via RPC, realtime, storage policies

-- device label arrives as the X-Device header on every API call (set once by the app);
-- tests and server-side code may still use set_config('app.device', ...)
create or replace function current_device() returns text language plpgsql stable as $$
declare h text;
begin
  h := nullif(current_setting('app.device', true), '');
  if h is not null then return h; end if;
  begin
    return nullif(current_setting('request.headers', true)::json->>'x-device', '');
  exception when others then
    return null;
  end;
end $$;

-- owner corrections go through one door: allowed tables and columns only, reason mandatory, fully audited
create or replace function owner_edit(p_table text, p_id uuid, p_patch jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare allowed jsonb := '{
  "invoices": ["invoice_no","invoice_date","amount","note","installments_planned","next_due","distributor_id"],
  "payments": ["amount","account_id","cash_source","day"],
  "expenses": ["amount","note","category_id","account_id","cash_source","day"],
  "daily_sales": ["pos_total","credit_total"],
  "daily_sale_lines": ["amount","account_id"],
  "customer_credit_bills": ["amount","bill_no","customer_id","day"],
  "customer_credit_collections": ["amount","account_id","day"],
  "staff_entries": ["amount","kind","bill_no","note","day"],
  "waw_loans": ["amount","kind","account_id","handled_by","note","day"],
  "owner_settlements": ["amount","account_id","day"]
}'::jsonb;
declare cols jsonb; k text; sets text := ''; row_after jsonb;
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'a reason is required to change a saved entry' using errcode = 'PA002'; end if;
  cols := allowed->p_table;
  if cols is null then raise exception 'table % cannot be edited', p_table using errcode = 'PA020'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not cols ? k then raise exception 'column % of % cannot be edited', k, p_table using errcode = 'PA021'; end if;
    sets := sets || case when sets = '' then '' else ', ' end || format('%I = (%L)::%s', k, p_patch->>k,
      (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = p_table::regclass and a.attname = k));
  end loop;
  if sets = '' then raise exception 'nothing to change' using errcode = 'PA022'; end if;
  perform set_config('app.reason', p_reason, true);
  execute format('update %I set %s where id = $1 returning to_jsonb(%I.*)', p_table, sets, p_table) into row_after using p_id;
  if row_after is null then raise exception 'entry not found' using errcode = 'PA023'; end if;
  return row_after;
end $$;

create or replace function owner_delete(p_table text, p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'a reason is required to delete a saved entry' using errcode = 'PA002'; end if;
  if p_table not in ('invoices','payments','expenses','daily_sale_lines','customer_credit_bills','customer_credit_collections','staff_entries','waw_loans','owner_settlements','reminders') then
    raise exception 'table % cannot be deleted from', p_table using errcode = 'PA020';
  end if;
  perform set_config('app.reason', p_reason, true);
  execute format('delete from %I where id = $1', p_table) using p_id;
end $$;

-- owner-only: create or update a staff profile after the auth user exists
create or replace function upsert_profile(p_id uuid, p_name text, p_role app_role, p_phone text, p_active boolean default true) returns profiles
language plpgsql security definer set search_path = public as $$
declare pr profiles;
begin
  if (select count(*) from profiles) > 0 and not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  insert into profiles(id, name, role, phone, active) values (p_id, p_name, p_role, p_phone, p_active)
  on conflict (id) do update set name = excluded.name, role = excluded.role, phone = excluded.phone, active = excluded.active
  returning * into pr;
  return pr;
end $$;

-- who am I (one round trip after sign-in)
create or replace function me() returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(p) from profiles p where p.id = auth.uid()
$$;

-- register / touch the calling device
create or replace function touch_device(p_label text, p_platform text) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into devices(user_id, label, platform) select auth.uid(), p_label, p_platform
  where not exists (select 1 from devices where user_id = auth.uid() and label = p_label);
  update devices set last_seen = now() where user_id = auth.uid() and label = p_label;
end $$;

-- mark notifications read
create or replace function mark_read(p_ids uuid[]) returns void language sql security definer set search_path = public as $$
  update notifications set read_at = now() where user_id = auth.uid() and id = any(p_ids) and read_at is null
$$;

-- settle a reminder by hand
create or replace function finish_reminder(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  update reminders set done_at = now() where id = p_id and (is_owner() or created_by = auth.uid());
end $$;

-- summary for a date range (Insights and Reports read this)
create or replace function range_summary(p_from date, p_to date) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'pos_total', coalesce((select sum(pos_total) from daily_sales where day between p_from and p_to), 0),
    'cash', coalesce((select sum(sale_cash_part(id)) from daily_sales where day between p_from and p_to), 0),
    'credit_given', coalesce((select sum(credit_total) from daily_sales where day between p_from and p_to), 0),
    'credit_collected', coalesce((select sum(amount) from customer_credit_collections where day between p_from and p_to), 0),
    'by_account', coalesce((select jsonb_agg(jsonb_build_object('account_id', a.id, 'name', a.name, 'kind', a.kind, 'provider', a.provider, 'amount', x.amt) order by a.sort_order)
                   from (select l.account_id, sum(l.amount) amt from daily_sale_lines l join daily_sales s on s.id = l.daily_sale_id where s.day between p_from and p_to group by l.account_id) x
                   join accounts a on a.id = x.account_id), '[]'::jsonb),
    'purchases_received', coalesce((select sum(amount) from invoices where day between p_from and p_to), 0),
    'purchases_paid', coalesce((select sum(amount) from payments where day between p_from and p_to), 0),
    'expenses', coalesce((select sum(amount) from expenses where day between p_from and p_to), 0),
    'expenses_by_category', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'amount', x.amt) order by x.amt desc)
                   from (select category_id, sum(amount) amt from expenses where day between p_from and p_to group by category_id) x join expense_categories c on c.id = x.category_id), '[]'::jsonb),
    'staff_advances', coalesce((select sum(amount) from staff_entries where day between p_from and p_to and kind in ('advance_sale_cash','advance_purchase_cash','medicine_credit')), 0),
    'staff_recovered', coalesce((select sum(amount) from staff_entries where day between p_from and p_to and kind in ('salary_deduction','cash_repayment')), 0),
    'owed_to_distributors', coalesce((select sum(pending) from v_distributor_balance), 0),
    'owed_by_customers', coalesce((select sum(owed) from v_customer_balance), 0),
    'owed_by_staff', coalesce((select sum(owed) from v_staff_balance where owed > 0), 0),
    'owed_to_waw', waw_outstanding(),
    'owed_to_owner', coalesce((select sum(unsettled) from v_owner_paid), 0),
    'closings', coalesce((select jsonb_agg(jsonb_build_object('day', c.day, 'expected', c.expected_cash, 'counted', c.counted_cash, 'difference', c.difference, 'closed_by', p.name, 'status', b.status) order by c.day)
                   from closings c join profiles p on p.id = c.closed_by join business_days b on b.day = c.day where c.day between p_from and p_to), '[]'::jsonb),
    'days_closed', (select count(*) from closings where day between p_from and p_to),
    'days_approved', (select count(*) from business_days where day between p_from and p_to and status = 'approved')
  )
$$;

-- realtime: the app listens to these tables
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table notifications, business_days, closings, invoices, payments, expenses, daily_sales, daily_sale_lines, waw_loans, reminders, customer_credit_bills, customer_credit_collections, staff_entries, owner_settlements;
  end if;
end $$;

-- storage: private bucket "proofs"; any active user may upload; everyone active may read; nobody deletes
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('proofs', 'proofs', false, 10485760, array['image/jpeg','image/png','image/webp'])
    on conflict (id) do nothing;
    execute 'create policy proofs_read on storage.objects for select using (bucket_id = ''proofs'' and public.my_role() is not null)';
    execute 'create policy proofs_write on storage.objects for insert with check (bucket_id = ''proofs'' and public.my_role() is not null)';
  end if;
end $$;

-- allow the API roles to use everything above
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant execute on functions to authenticated;
