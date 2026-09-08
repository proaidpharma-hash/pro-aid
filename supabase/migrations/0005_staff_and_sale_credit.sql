-- 0005 · staff members without an app login, credit lines inside the daily sale, count-first sale
-- (each statement runs in its own transaction when applied with psql -f; the new enum value is never
--  referenced by name in this file, only through ::text comparisons, so it is safe either way)

-- ---------------------------------------------------------------------------
-- 1. Staff members without a login
-- ---------------------------------------------------------------------------
alter type app_role add value if not exists 'staff';

-- a profile no longer has to be an auth user (lower-level staff get an account but no login)
alter table profiles drop constraint if exists profiles_id_fkey;
alter table profiles add column if not exists has_login boolean not null default true;

-- owner adds a staff member (no phone/PIN needed); the account shows up in Staff and in the sale's credit list
create or replace function add_staff_member(p_name text, p_phone text default null)
returns profiles language plpgsql security definer set search_path = public as $$
declare pr profiles;
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name is required' using errcode = 'PA030'; end if;
  insert into profiles(id, name, role, phone, active, has_login)
  values (gen_random_uuid(), trim(p_name), 'staff'::text::app_role, nullif(trim(p_phone), ''), true, false)
  returning * into pr;
  return pr;
end $$;

-- upsert_profile keeps has_login as it is (true for logins created through auth)
create or replace function upsert_profile(p_id uuid, p_name text, p_role app_role, p_phone text, p_active boolean default true) returns profiles
language plpgsql security definer set search_path = public as $$
declare pr profiles;
begin
  if (select count(*) from profiles) > 0 and not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  insert into profiles(id, name, role, phone, active) values (p_id, p_name, p_role, nullif(p_phone, ''), p_active)
  on conflict (id) do update set name = excluded.name, role = excluded.role, phone = excluded.phone, active = excluded.active
  returning * into pr;
  return pr;
end $$;

-- notifications never go to accounts that cannot sign in
create or replace function notify_everyone(p_kind notification_kind, p_title text, p_body text, p_ref_table text, p_ref_id uuid)
returns void language sql as $$
  select notify_users(array(select id from profiles where active and has_login), p_kind, p_title, p_body, p_ref_table, p_ref_id)
$$;

-- the staff ledger shows everyone except the owner
drop view if exists v_staff_balance;
create view v_staff_balance as
select p.id, p.name, p.role, p.has_login, p.active,
  coalesce(sum(case when e.kind in ('advance_sale_cash','advance_purchase_cash','medicine_credit') then e.amount else -e.amount end), 0) as owed
from profiles p left join staff_entries e on e.staff_id = p.id
where p.role::text <> 'owner'
group by p.id, p.name, p.role, p.has_login, p.active;

-- ---------------------------------------------------------------------------
-- 2. Credit lines inside the daily sale
-- ---------------------------------------------------------------------------
-- a credit bill can be part of a bigger bill (partial credit) and can belong to the day's sale
alter table customer_credit_bills add column if not exists bill_total numeric(14,2) check (bill_total is null or bill_total >= amount);
alter table customer_credit_bills add column if not exists sale_id uuid references daily_sales(id) on delete set null;
alter table staff_entries add column if not exists bill_total numeric(14,2) check (bill_total is null or bill_total >= amount);
alter table staff_entries add column if not exists sale_id uuid references daily_sales(id) on delete set null;

-- medicine on credit for a staff member may be entered by the manager while recording the sale;
-- cash advances and settlements stay owner-only
create or replace function trg_staff_entry_guard() returns trigger language plpgsql as $$
begin
  if new.kind = 'medicine_credit' then
    if not is_manager_or_owner() then raise exception 'manager or owner only' using errcode = '42501'; end if;
  elsif not is_owner() then
    raise exception 'owner only' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists b_owner_only on staff_entries;
create trigger b_owner_only before insert on staff_entries for each row execute function trg_staff_entry_guard();
drop policy if exists staff_write on staff_entries;
create policy staff_write on staff_entries for insert with check (is_owner() or (is_manager_or_owner() and kind = 'medicine_credit'));
drop policy if exists staff_read on staff_entries;
create policy staff_read on staff_entries for select using (is_owner() or staff_id = auth.uid() or (is_manager_or_owner() and kind = 'medicine_credit'));

-- the sale's credit total must be covered by bills that name a customer or a staff member
create or replace function sale_credit_entered(p_sale uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount) from customer_credit_bills where sale_id = p_sale), 0)
       + coalesce((select sum(amount) from staff_entries where sale_id = p_sale and kind = 'medicine_credit'), 0)
$$;

-- ---------------------------------------------------------------------------
-- 3. Count-first sale (the drawer count decides the cash sale)
-- ---------------------------------------------------------------------------
alter table daily_sales add column if not exists pos_source text not null default 'pos' check (pos_source in ('pos', 'count'));
alter table daily_sales add column if not exists counted_cash numeric(14,2);

-- cash that should be in the drawer before today's cash sale is known
create or replace function cash_before_sale(d date) returns numeric language sql stable as $$
  select coalesce((select opening_cash from business_days where day = d), 0)
       + coalesce((select sum(amount) from customer_credit_collections where day = d and account_id = cash_drawer_id()), 0)
       + coalesce((select sum(amount) from waw_loans where day = d and kind = 'borrow' and account_id = cash_drawer_id()), 0)
       - coalesce((select sum(amount) from payments where day = d and account_id = cash_drawer_id()), 0)
       - coalesce((select sum(amount) from expenses where day = d and account_id = cash_drawer_id()), 0)
       - coalesce((select sum(amount) from staff_entries where day = d and kind in ('advance_sale_cash','advance_purchase_cash')), 0)
       + coalesce((select sum(amount) from staff_entries where day = d and kind = 'cash_repayment'), 0)
       - coalesce((select sum(amount) from waw_loans where day = d and kind = 'repay' and account_id = cash_drawer_id()), 0)
       - coalesce((select sum(amount) from owner_settlements where day = d and kind = 'cash_return'), 0)
$$;

-- owner corrections may touch the new columns (same door as before): allowed tables and columns only, reason mandatory, fully audited
create or replace function owner_edit(p_table text, p_id uuid, p_patch jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare allowed jsonb := '{
  "invoices": ["invoice_no","invoice_date","amount","note","installments_planned","next_due","distributor_id"],
  "payments": ["amount","account_id","cash_source","day"],
  "expenses": ["amount","note","category_id","account_id","cash_source","day"],
  "daily_sales": ["pos_total","credit_total","pos_source","counted_cash"],
  "daily_sale_lines": ["amount","account_id"],
  "customer_credit_bills": ["amount","bill_no","customer_id","day","bill_total"],
  "customer_credit_collections": ["amount","account_id","day"],
  "staff_entries": ["amount","kind","bill_no","note","day","bill_total"],
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

grant execute on function add_staff_member(text, text) to authenticated;
grant execute on function sale_credit_entered(uuid) to authenticated;
grant execute on function cash_before_sale(date) to authenticated;
grant select on v_staff_balance to authenticated;
