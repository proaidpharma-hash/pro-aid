-- 0007 · note-by-note drawer count
-- Wherever drawer cash is counted (closing, or the count-first sale) the app stores how many of each
-- note and coin were counted; the total must equal the counted cash.

alter table closings add column if not exists denominations jsonb;
alter table daily_sales add column if not exists denominations jsonb;

-- {"5000": 12, "1000": 8, ...} → rupees
create or replace function denominations_total(d jsonb) returns numeric language sql immutable as $$
  select coalesce(sum((k)::numeric * (v)::numeric), 0) from jsonb_each_text(coalesce(d, '{}'::jsonb)) as e(k, v)
$$;

create or replace function trg_denominations_check() returns trigger language plpgsql as $$
declare total numeric; col numeric;
begin
  if new.denominations is null then return new; end if;
  if jsonb_typeof(new.denominations) <> 'object' then raise exception 'denominations must be an object' using errcode = 'PA033'; end if;
  total := denominations_total(new.denominations);
  col := case tg_table_name when 'closings' then new.counted_cash else new.counted_cash end;
  if col is not null and total <> col then
    raise exception 'notes add up to % but counted cash is %', total, col using errcode = 'PA033';
  end if;
  return new;
end $$;
drop trigger if exists b_denominations on closings;
create trigger b_denominations before insert on closings for each row execute function trg_denominations_check();
drop trigger if exists b_denominations on daily_sales;
create trigger b_denominations before insert or update on daily_sales for each row execute function trg_denominations_check();

-- submit_closing now takes the note breakdown (old signature dropped to avoid ambiguity)
drop function if exists submit_closing(date, numeric, uuid, text);
create or replace function submit_closing(p_day date, p_counted numeric, p_drawer_photo uuid, p_note text default null, p_denominations jsonb default null)
returns closings language plpgsql security definer set search_path = public as $$
declare exp numeric; c closings; diff numeric;
begin
  if not is_manager_or_owner() then raise exception 'manager or owner only' using errcode = '42501'; end if;
  if not exists (select 1 from daily_sales where day = p_day) then
    raise exception 'record the daily sale before closing' using errcode = 'PA012';
  end if;
  perform ensure_business_day(p_day);
  select expected_cash into exp from cash_book(p_day);
  insert into closings(day, expected_cash, counted_cash, drawer_photo_id, note, closed_by, device, denominations)
  values (p_day, exp, p_counted, p_drawer_photo, p_note, auth.uid(), current_device(), p_denominations)
  returning * into c;
  update business_days set status = 'closed', closed_by = auth.uid(), closed_at = now() where day = p_day;
  update business_days set opening_cash = p_counted where day = p_day + 1 and status <> 'approved';
  diff := c.difference;
  perform notify_owners((case when diff < 0 then 'closing_minus' else 'closing_submitted' end)::notification_kind,
    case when diff < 0 then format('MINUS at closing · %s · %s', p_day, diff) else format('Closing submitted · %s · +%s', p_day, diff) end,
    format('Expected %s, counted %s. Closed by %s.', exp, p_counted, (select name from profiles where id = auth.uid())),
    'closings', c.id);
  return c;
end $$;
grant execute on function submit_closing(date, numeric, uuid, text, jsonb) to authenticated;
grant execute on function denominations_total(jsonb) to authenticated;

-- reports carry the breakdown
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
    'days_closed', (select count(*) from closings where day between p_from and p_to),
    'days_approved', (select count(*) from business_days where day between p_from and p_to and status = 'approved')
  )
$$;
