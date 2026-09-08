-- 0008 · posting check at closing
-- Every invoice must be either posted in POS (with the amount actually posted) or carry a reason for not
-- being posted, given on the day of the closing. A posted amount lower than the invoice creates a
-- "difference" the distributor still owes (short items, rate difference, damaged goods) until settled.

alter table invoices add column if not exists posted_amount numeric(14,2);
alter table invoices add column if not exists post_diff_kind text check (post_diff_kind in ('short_items','rate_difference','damaged','other'));
alter table invoices add column if not exists post_diff_note text;
alter table invoices add column if not exists unposted_reason text;
alter table invoices add column if not exists unposted_reason_day date;
alter table invoices add column if not exists unposted_reason_by uuid references profiles(id);

-- settling a difference: goods came later, credit note, refund, adjusted in the next invoice
create table if not exists invoice_diff_settlements (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id),
  day date not null references business_days(day),
  kind text not null check (kind in ('goods_received','credit_note','refund','adjusted')),
  amount numeric(14,2) not null check (amount > 0),
  note text,
  photo_id uuid not null references photos(id),
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);
create trigger a_ensure_day before insert on invoice_diff_settlements for each row execute function trg_ensure_day();
create trigger a_stamp before insert on invoice_diff_settlements for each row execute function trg_stamp_entry();
create trigger b_locked before insert or update or delete on invoice_diff_settlements for each row execute function trg_reject_if_locked();
create trigger c_photo after insert on invoice_diff_settlements for each row execute function trg_claim_photo('photo_id');
create trigger d_audit after insert or update or delete on invoice_diff_settlements for each row execute function trg_audit_change();

create or replace function invoice_diff(inv uuid) returns numeric language sql stable as $$
  select case when i.posted_in_pos and i.posted_amount is not null then greatest(i.amount - i.posted_amount, 0) else 0 end from invoices i where i.id = inv
$$;
create or replace function invoice_diff_settled(inv uuid) returns numeric language sql stable as $$
  select coalesce(sum(amount), 0) from invoice_diff_settlements where invoice_id = inv
$$;

create or replace function trg_diff_settlement_check() returns trigger language plpgsql as $$
declare d numeric; s numeric;
begin
  d := invoice_diff(new.invoice_id); s := invoice_diff_settled(new.invoice_id);
  if d <= 0 then raise exception 'this invoice has no posting difference to settle' using errcode = 'PA041'; end if;
  if s + new.amount > d then raise exception 'settles more than the difference (% left)', d - s using errcode = 'PA041'; end if;
  return new;
end $$;
create trigger b_check before insert on invoice_diff_settlements for each row execute function trg_diff_settlement_check();

-- mark posted with the amount actually posted; a lower amount needs a reason and alerts the owner
drop function if exists mark_posted(uuid);
create or replace function mark_posted(p_invoice uuid, p_posted_amount numeric default null, p_diff_kind text default null, p_diff_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype; amt numeric;
begin
  if not is_manager_or_owner() then raise exception 'manager or owner only' using errcode = '42501'; end if;
  select * into inv from invoices where id = p_invoice;
  if inv.id is null then raise exception 'invoice not found' using errcode = 'PA023'; end if;
  if inv.posted_in_pos then return; end if;
  amt := coalesce(p_posted_amount, inv.amount);
  if amt < 0 then raise exception 'posted amount cannot be negative' using errcode = 'PA040'; end if;
  if amt <> inv.amount and p_diff_kind is null then
    raise exception 'posted amount differs from the invoice — say why (short items, rate difference, damaged, other)' using errcode = 'PA040';
  end if;
  perform set_config('app.system_action', 'posted_in_pos', true);
  update invoices set posted_in_pos = true, posted_at = now(), posted_by = auth.uid(), posted_amount = amt,
    post_diff_kind = case when amt <> inv.amount then p_diff_kind end, post_diff_note = case when amt <> inv.amount then p_diff_note end
    where id = p_invoice;
  perform set_config('app.system_action', '', true);
  if amt < inv.amount then
    perform notify_owners('unposted_invoice', format('Posted with a difference · %s · Inv %s · Rs %s short', (select name from distributors where id = inv.distributor_id), inv.invoice_no, inv.amount - amt),
      format('Invoice %s, posted %s (%s%s). By %s.', inv.amount, amt, p_diff_kind, case when p_diff_note is not null then ' · ' || p_diff_note else '' end, (select name from profiles where id = auth.uid())), 'invoices', inv.id);
  end if;
end $$;

-- reason for an invoice still not posted (asked at every closing)
create or replace function give_unposted_reason(p_invoice uuid, p_day date, p_reason text) returns void language plpgsql security definer set search_path = public as $$
begin
  if my_role() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required' using errcode = 'PA042'; end if;
  perform set_config('app.system_action', 'unposted_reason', true);
  update invoices set unposted_reason = trim(p_reason), unposted_reason_day = p_day, unposted_reason_by = auth.uid() where id = p_invoice and not posted_in_pos;
  perform set_config('app.system_action', '', true);
end $$;

-- invoices that still block the closing of a day: not posted and no reason given for that day
create or replace function closing_blockers(p_day date)
returns table (id uuid, invoice_no text, distributor_name text, amount numeric, day date, unposted_reason text, unposted_reason_day date) language sql stable as $$
  select i.id, i.invoice_no, d.name, i.amount, i.day, i.unposted_reason, i.unposted_reason_day
  from invoices i join distributors d on d.id = i.distributor_id
  where not i.posted_in_pos and i.day <= p_day and (i.unposted_reason_day is null or i.unposted_reason_day <> p_day)
  order by i.day, d.name
$$;

-- the closing waits until every unposted invoice has today's reason
create or replace function submit_closing(p_day date, p_counted numeric, p_drawer_photo uuid, p_note text default null, p_denominations jsonb default null)
returns closings language plpgsql security definer set search_path = public as $$
declare exp numeric; c closings; diff numeric; nb int; np int; nd int;
begin
  if not is_manager_or_owner() then raise exception 'manager or owner only' using errcode = '42501'; end if;
  if not exists (select 1 from daily_sales where day = p_day) then
    raise exception 'record the daily sale before closing' using errcode = 'PA012';
  end if;
  select count(*) into nb from closing_blockers(p_day);
  if nb > 0 then
    raise exception '% invoice(s) are not posted in POS and have no reason for today — mark them posted or give the reason first', nb using errcode = 'PA034';
  end if;
  perform ensure_business_day(p_day);
  select expected_cash into exp from cash_book(p_day);
  insert into closings(day, expected_cash, counted_cash, drawer_photo_id, note, closed_by, device, denominations)
  values (p_day, exp, p_counted, p_drawer_photo, p_note, auth.uid(), current_device(), p_denominations)
  returning * into c;
  update business_days set status = 'closed', closed_by = auth.uid(), closed_at = now() where day = p_day;
  update business_days set opening_cash = p_counted where day = p_day + 1 and status <> 'approved';
  diff := c.difference;
  select count(*) into np from invoices where not posted_in_pos and day <= p_day;
  select count(*) into nd from invoices where posted_in_pos and posted_at::date = p_day and posted_amount < amount;
  perform notify_owners((case when diff < 0 then 'closing_minus' else 'closing_submitted' end)::notification_kind,
    case when diff < 0 then format('MINUS at closing · %s · %s', p_day, diff) else format('Closing submitted · %s · +%s', p_day, diff) end,
    format('Expected %s, counted %s. Closed by %s.%s%s', exp, p_counted, (select name from profiles where id = auth.uid()),
      case when np > 0 then format(' %s invoice(s) not posted in POS (reasons given).', np) else '' end,
      case when nd > 0 then format(' %s invoice(s) posted with a difference.', nd) else '' end),
    'closings', c.id);
  return c;
end $$;

-- views carry the posting figures
drop view if exists v_invoice_status;
create view v_invoice_status as
select i.*, invoice_paid(i.id) as paid, i.amount - invoice_paid(i.id) as remaining,
       (select count(*) from payments p where p.invoice_id = i.id) as payments_made,
       d.name as distributor_name,
       invoice_diff(i.id) as post_diff, invoice_diff_settled(i.id) as diff_settled, invoice_diff(i.id) - invoice_diff_settled(i.id) as diff_pending,
       (select name from profiles where id = i.unposted_reason_by) as unposted_reason_by_name
from invoices i join distributors d on d.id = i.distributor_id;

drop view if exists v_distributor_balance;
create view v_distributor_balance as
select d.id, d.name, d.opening_balance + coalesce(sum(i.amount - invoice_paid(i.id)), 0) as pending,
       count(i.id) filter (where i.amount > invoice_paid(i.id)) as open_invoices,
       min(i.day) filter (where i.amount > invoice_paid(i.id)) as oldest_open,
       coalesce(sum(invoice_diff(i.id) - invoice_diff_settled(i.id)), 0) as diff_pending
from distributors d left join invoices i on i.distributor_id = d.id
group by d.id, d.name, d.opening_balance;

-- RLS
alter table invoice_diff_settlements enable row level security;
create policy read_all on invoice_diff_settlements for select using (my_role() is not null);
create policy diff_ins on invoice_diff_settlements for insert with check (is_manager_or_owner());
create policy diff_upd on invoice_diff_settlements for update using (is_owner());
create policy diff_del on invoice_diff_settlements for delete using (is_owner());
grant select, insert, update, delete on invoice_diff_settlements to authenticated;
grant select on v_invoice_status, v_distributor_balance to authenticated;
grant execute on function mark_posted(uuid, numeric, text, text) to authenticated;
grant execute on function give_unposted_reason(uuid, date, text) to authenticated;
grant execute on function closing_blockers(date) to authenticated;
grant execute on function invoice_diff(uuid) to authenticated;
grant execute on function invoice_diff_settled(uuid) to authenticated;
grant execute on function submit_closing(date, numeric, uuid, text, jsonb) to authenticated;
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table invoice_diff_settlements;
  end if;
end $$;

-- reports: pending differences and unposted count
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
    'closings', coalesce((select jsonb_agg(jsonb_build_object('day', c.day, 'expected', c.expected_cash, 'counted', c.counted_cash, 'difference', c.difference, 'closed_by', p.name, 'status', b.status, 'denominations', c.denominations) order by c.day)
                   from closings c join profiles p on p.id = c.closed_by join business_days b on b.day = c.day where c.day between p_from and p_to), '[]'::jsonb),
    'distributor_diff_pending', coalesce((select sum(invoice_diff(id) - invoice_diff_settled(id)) from invoices), 0),
    'unposted_invoices', (select count(*) from invoices where not posted_in_pos),
    'days_closed', (select count(*) from closings where day between p_from and p_to),
    'days_approved', (select count(*) from business_days where day between p_from and p_to and status = 'approved')
  )
$$;

create or replace function owner_delete(p_table text, p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'a reason is required to delete a saved entry' using errcode = 'PA002'; end if;
  if p_table not in ('invoices','payments','expenses','daily_sale_lines','sale_receipts','invoice_diff_settlements','customer_credit_bills','customer_credit_collections','staff_entries','waw_loans','owner_settlements','reminders') then
    raise exception 'table % cannot be deleted from', p_table using errcode = 'PA020';
  end if;
  perform set_config('app.reason', p_reason, true);
  execute format('delete from %I where id = $1', p_table) using p_id;
end $$;
