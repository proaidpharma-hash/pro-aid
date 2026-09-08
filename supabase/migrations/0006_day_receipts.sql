-- 0006 · card / online receipts entered through the day (each with its slip or screenshot)
-- The cashier records every card sale and online transfer as it happens. At night the daily sale
-- picks these totals up automatically; only the POS total + photo and the drawer count remain.

create table if not exists sale_receipts (
  id uuid primary key default gen_random_uuid(),
  day date not null references business_days(day),
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  note text,
  photo_id uuid not null references photos(id),
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);
create index if not exists sale_receipts_day_idx on sale_receipts(day, account_id);

create trigger a_ensure_day before insert on sale_receipts for each row execute function trg_ensure_day();
create trigger a_stamp before insert on sale_receipts for each row execute function trg_stamp_entry();
create trigger b_locked before insert or update or delete on sale_receipts for each row execute function trg_reject_if_locked();
create trigger c_photo after insert on sale_receipts for each row execute function trg_claim_photo('photo_id');
create trigger d_audit after insert or update or delete on sale_receipts for each row execute function trg_audit_change();

-- a receipt must be a card machine, wallet or bank account, and cannot be added once the day's sale is recorded
create or replace function trg_receipt_check() returns trigger language plpgsql as $$
declare k account_kind;
begin
  select kind into k from accounts where id = new.account_id;
  if k not in ('card_machine', 'wallet', 'bank') then
    raise exception 'a receipt must go to a card machine, wallet or bank account' using errcode = 'PA004';
  end if;
  if tg_op = 'INSERT' and exists (select 1 from daily_sales where day = new.day) then
    raise exception 'the daily sale for % is already recorded — the owner can correct it from the Sales page', new.day using errcode = 'PA032';
  end if;
  return new;
end $$;
create trigger b_check before insert or update on sale_receipts for each row execute function trg_receipt_check();

-- receipts total per account for a day
create or replace function day_receipts(d date)
returns table (account_id uuid, amount numeric, receipts int) language sql stable as $$
  select account_id, sum(amount), count(*)::int from sale_receipts where day = d group by account_id
$$;

-- the cash part of a sale now also takes the day's receipts off the POS total
create or replace function sale_cash_part(sale_id uuid) returns numeric language sql stable as $$
  select s.pos_total - s.credit_total
       - coalesce((select sum(l.amount) from daily_sale_lines l where l.daily_sale_id = s.id), 0)
       - coalesce((select sum(r.amount) from sale_receipts r where r.day = s.day), 0)
  from daily_sales s where s.id = sale_id
$$;

-- an end-of-day line cannot double up with receipts already entered for the same account
create or replace function trg_sale_line_check() returns trigger language plpgsql as $$
declare k account_kind; sid uuid; d date;
begin
  sid := coalesce(new.daily_sale_id, old.daily_sale_id);
  select day into d from daily_sales where id = sid;
  if day_is_locked(d) then
    raise exception 'day is approved and locked' using errcode = 'PA001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  select kind into k from accounts where id = new.account_id;
  if k not in ('card_machine', 'wallet', 'bank') then
    raise exception 'a sale line must be a card machine, wallet or bank account' using errcode = 'PA004';
  end if;
  if exists (select 1 from sale_receipts r where r.day = d and r.account_id = new.account_id) then
    raise exception 'receipts were already entered for this account today — the total comes from them' using errcode = 'PA031';
  end if;
  return new;
end $$;

-- everything that counts non-cash received: end-of-day lines + receipts entered through the day
create or replace view v_non_cash_received as
  select l.id, s.day, l.account_id, l.amount, l.photo_id, 'line'::text as source from daily_sale_lines l join daily_sales s on s.id = l.daily_sale_id
  union all
  select r.id, r.day, r.account_id, r.amount, r.photo_id, 'receipt'::text from sale_receipts r;

create or replace function non_cash_pool(p_from date, p_to date)
returns table (account_id uuid, account_name text, kind account_kind, received numeric, minused numeric, remaining numeric)
language sql stable as $$
  select a.id, a.name, a.kind,
    coalesce((select sum(v.amount) from v_non_cash_received v where v.account_id = a.id and v.day between p_from and p_to), 0)
      + coalesce((select sum(x.amount) from customer_credit_collections x where x.account_id = a.id and x.day between p_from and p_to), 0) as received,
    coalesce((select sum(o.amount) from owner_settlements o where o.kind = 'minus_receipts' and o.account_id = a.id and o.day between p_from and p_to), 0) as minused,
    0::numeric as remaining
  from accounts a where a.kind in ('card_machine','wallet','bank') and a.active
  order by a.sort_order
$$;

-- credit given through the day (bills not tied to a recorded sale yet), so the sale form can prefill it
create or replace function day_credit(d date)
returns table (customer_credit numeric, staff_credit numeric, bills int) language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount) from customer_credit_bills where day = d), 0),
         coalesce((select sum(amount) from staff_entries where day = d and kind = 'medicine_credit'), 0),
         (select count(*) from customer_credit_bills where day = d)::int + (select count(*) from staff_entries where day = d and kind = 'medicine_credit')::int
$$;

-- RLS: everyone signed in reads and adds; only the owner changes (with a reason, audited)
alter table sale_receipts enable row level security;
create policy read_all on sale_receipts for select using (my_role() is not null);
create policy sale_receipts_ins on sale_receipts for insert with check (my_role() is not null);
create policy sale_receipts_upd on sale_receipts for update using (is_owner());
create policy sale_receipts_del on sale_receipts for delete using (is_owner());
grant select, insert, update, delete on sale_receipts to authenticated;
grant select on v_non_cash_received to authenticated;
grant execute on function day_receipts(date) to authenticated;
grant execute on function day_credit(date) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table sale_receipts;
  end if;
end $$;

-- reports include receipts
-- summary for a date range (Insights and Reports read this)
create or replace function range_summary(p_from date, p_to date) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'pos_total', coalesce((select sum(pos_total) from daily_sales where day between p_from and p_to), 0),
    'cash', coalesce((select sum(sale_cash_part(id)) from daily_sales where day between p_from and p_to), 0),
    'credit_given', coalesce((select sum(credit_total) from daily_sales where day between p_from and p_to), 0),
    'credit_collected', coalesce((select sum(amount) from customer_credit_collections where day between p_from and p_to), 0),
    'by_account', coalesce((select jsonb_agg(jsonb_build_object('account_id', a.id, 'name', a.name, 'kind', a.kind, 'provider', a.provider, 'amount', x.amt) order by a.sort_order)
                   from (select v.account_id, sum(v.amount) amt from v_non_cash_received v where v.day between p_from and p_to group by v.account_id) x
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

-- owner corrections may touch the new columns (same door as before): allowed tables and columns only, reason mandatory, fully audited
create or replace function owner_edit(p_table text, p_id uuid, p_patch jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare allowed jsonb := '{
  "invoices": ["invoice_no","invoice_date","amount","note","installments_planned","next_due","distributor_id"],
  "payments": ["amount","account_id","cash_source","day"],
  "expenses": ["amount","note","category_id","account_id","cash_source","day"],
  "daily_sales": ["pos_total","credit_total","pos_source","counted_cash"],
  "daily_sale_lines": ["amount","account_id"],
  "sale_receipts": ["amount","account_id","day","note"],
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

create or replace function owner_delete(p_table text, p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'a reason is required to delete a saved entry' using errcode = 'PA002'; end if;
  if p_table not in ('invoices','payments','expenses','daily_sale_lines','sale_receipts','customer_credit_bills','customer_credit_collections','staff_entries','waw_loans','owner_settlements','reminders') then
    raise exception 'table % cannot be deleted from', p_table using errcode = 'PA020';
  end if;
  perform set_config('app.reason', p_reason, true);
  execute format('delete from %I where id = $1', p_table) using p_id;
end $$;
