-- 0011 · control pack
--  1  anomaly alerts (morning job)            8  expense budgets per category
--  2  card-machine reconciliation             9  owner daily digest (+ Telegram when configured)
--  3  surprise drawer count                  11  staff scorecard
--  4  duplicate photo guard                  13  read-only "viewer" role
-- 14  new-device sign-in alerts             (10 month-end PDF and 12 photo backup live in the app / CI)

-- ---------------------------------------------------------------------------
-- 13. viewer role: sees everything the owner sees, can change nothing
-- ---------------------------------------------------------------------------
alter type app_role add value if not exists 'viewer';

-- my_role() is what every WRITE policy and RPC checks: a viewer has no writing role
create or replace function my_role() returns app_role language sql stable as $$
  select r from current_role_of(auth.uid()) r where r::text not in ('viewer', 'staff')
$$;
create or replace function is_viewer() returns boolean language sql stable as $$
  select coalesce(current_role_of(auth.uid())::text = 'viewer', false)
$$;
-- can_read(): any active login, viewer included (never staff-without-login — they cannot sign in anyway)
create or replace function can_read() returns boolean language sql stable as $$
  select coalesce(current_role_of(auth.uid())::text in ('owner', 'manager', 'cashier', 'viewer'), false)
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles','accounts','distributors','customers','expense_categories','photos','business_days',
    'daily_sales','daily_sale_lines','customer_credit_bills','customer_credit_collections','invoices','payments','expenses','waw_loans','closings','reminders',
    'sale_receipts','invoice_diff_settlements']
  loop
    execute format('drop policy if exists read_all on %I', t);
    execute format('create policy read_all on %I for select using (can_read())', t);
  end loop;
end $$;
drop policy if exists staff_read on staff_entries;
create policy staff_read on staff_entries for select using (is_owner() or is_viewer() or staff_id = auth.uid() or (is_manager_or_owner() and kind = 'medicine_credit'));
drop policy if exists settle_read on owner_settlements;
create policy settle_read on owner_settlements for select using (is_manager_or_owner() or is_viewer());
drop policy if exists audit_read on audit_log;
create policy audit_read on audit_log for select using (is_owner() or is_viewer());
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    execute 'drop policy if exists proofs_read on storage.objects';
    execute 'create policy proofs_read on storage.objects for select using (bucket_id = ''proofs'' and public.can_read())';
  end if;
end $$;
-- me() must still answer for a viewer (it reads profiles directly, fine); notifications stay per user

-- ---------------------------------------------------------------------------
-- 14. new-device sign-in alerts
-- ---------------------------------------------------------------------------
create or replace function touch_device(p_label text, p_platform text) returns void language plpgsql security definer set search_path = public as $$
declare who text; is_new boolean := false;
begin
  if auth.uid() is null then return; end if;
  if not exists (select 1 from devices where user_id = auth.uid() and label = p_label) then
    insert into devices(user_id, label, platform) values (auth.uid(), p_label, p_platform);
    is_new := true;
  end if;
  update devices set last_seen = now() where user_id = auth.uid() and label = p_label;
  if is_new then
    select name into who from profiles where id = auth.uid();
    perform set_config('app.internal', '1', true);
    insert into audit_log(user_id, action, table_name, row_id, after, device) values (auth.uid(), 'login', 'devices', null, jsonb_build_object('label', p_label, 'platform', p_platform), p_label);
    perform notify_owners('general', format('New device signed in · %s', who), format('%s signed in from a new device: %s. If this was not them, reset their PIN from Settings.', who, p_label), 'devices', null);
    perform notify_users(array[auth.uid()], 'general', 'New device', format('Your login was used on a new device: %s.', p_label), 'devices', null);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. duplicate photo guard: the same picture cannot be proof twice
-- ---------------------------------------------------------------------------
create unique index if not exists photos_sha256_unique on photos(sha256) where sha256 is not null;

-- ---------------------------------------------------------------------------
-- 8. expense budgets per category (monthly)
-- ---------------------------------------------------------------------------
alter table expense_categories add column if not exists monthly_budget numeric(14,2) check (monthly_budget is null or monthly_budget >= 0);

create or replace function expense_budget_status(p_month date default date_trunc('month', current_date)::date)
returns table (category_id uuid, name text, budget numeric, spent numeric, remaining numeric, over boolean) language sql stable as $$
  select c.id, c.name, c.monthly_budget,
         coalesce((select sum(e.amount) from expenses e where e.category_id = c.id and e.day >= date_trunc('month', p_month)::date and e.day < (date_trunc('month', p_month) + interval '1 month')::date), 0) as spent,
         case when c.monthly_budget is null then null else c.monthly_budget - coalesce((select sum(e.amount) from expenses e where e.category_id = c.id and e.day >= date_trunc('month', p_month)::date and e.day < (date_trunc('month', p_month) + interval '1 month')::date), 0) end as remaining,
         case when c.monthly_budget is null then false else coalesce((select sum(e.amount) from expenses e where e.category_id = c.id and e.day >= date_trunc('month', p_month)::date and e.day < (date_trunc('month', p_month) + interval '1 month')::date), 0) > c.monthly_budget end as over
  from expense_categories c where c.active order by c.sort_order
$$;

-- crossing the budget alerts the owner once per category per month
create or replace function trg_expense_budget() returns trigger language plpgsql security definer set search_path = public as $$
declare c expense_categories%rowtype; spent numeric; m date;
begin
  select * into c from expense_categories where id = new.category_id;
  if c.monthly_budget is null then return null; end if;
  m := date_trunc('month', new.day)::date;
  select coalesce(sum(amount), 0) into spent from expenses where category_id = c.id and day >= m and day < (m + interval '1 month')::date;
  if spent > c.monthly_budget and not exists (select 1 from notifications where kind = 'general' and ref_table = 'expense_categories' and ref_id = c.id and created_at >= m and title like 'Budget exceeded%') then
    perform notify_owners('general', format('Budget exceeded · %s', c.name), format('%s spent this month against a budget of %s.', spent, c.monthly_budget), 'expense_categories', c.id);
  end if;
  return null;
end $$;
drop trigger if exists f_budget on expenses;
create trigger f_budget after insert or update on expenses for each row execute function trg_expense_budget();

-- owner sets budgets (and adds categories) from the app
create or replace function set_expense_budget(p_category uuid, p_budget numeric) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  update expense_categories set monthly_budget = p_budget where id = p_category;
end $$;

-- ---------------------------------------------------------------------------
-- 3. surprise drawer count (any time of day, owner or manager)
-- ---------------------------------------------------------------------------
create table if not exists spot_counts (
  id uuid primary key default gen_random_uuid(),
  day date not null references business_days(day),
  pos_so_far numeric(14,2) not null check (pos_so_far >= 0),   -- POS running total at that moment
  pos_photo_id uuid not null references photos(id),
  expected_cash numeric(14,2) not null,
  counted_cash numeric(14,2) not null check (counted_cash >= 0),
  difference numeric(14,2) generated always as (counted_cash - expected_cash) stored,
  denominations jsonb,
  drawer_photo_id uuid not null references photos(id),
  note text,
  counted_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);
create trigger a_ensure_day before insert on spot_counts for each row execute function trg_ensure_day();
create trigger b_locked before insert or update or delete on spot_counts for each row execute function trg_reject_if_locked();
create trigger c_photo after insert on spot_counts for each row execute function trg_claim_photo('drawer_photo_id');
create trigger c_photo2 after insert on spot_counts for each row execute function trg_claim_photo('pos_photo_id');
create trigger d_audit after insert or update or delete on spot_counts for each row execute function trg_audit_change();
create trigger b_denominations before insert on spot_counts for each row execute function trg_denominations_check();
alter table spot_counts enable row level security;
create policy read_all on spot_counts for select using (can_read());
create policy spot_ins on spot_counts for insert with check (is_manager_or_owner());
grant select, insert on spot_counts to authenticated;

-- expected cash right now = cash before today's sale + cash part of the sale so far
-- (POS so far − card/online receipts so far − credit given so far)
create or replace function expected_cash_now(p_day date, p_pos_so_far numeric) returns numeric language sql stable as $$
  select cash_before_sale(p_day) + p_pos_so_far
       - coalesce((select sum(amount) from sale_receipts where day = p_day), 0)
       - coalesce((select sum(amount) from customer_credit_bills where day = p_day), 0)
       - coalesce((select sum(amount) from staff_entries where day = p_day and kind = 'medicine_credit'), 0)
$$;

create or replace function spot_count(p_day date, p_pos_so_far numeric, p_pos_photo uuid, p_counted numeric, p_denominations jsonb, p_drawer_photo uuid, p_note text default null)
returns spot_counts language plpgsql security definer set search_path = public as $$
declare exp numeric; sc spot_counts; who text;
begin
  if not is_manager_or_owner() then raise exception 'manager or owner only' using errcode = '42501'; end if;
  if exists (select 1 from daily_sales where day = p_day) then raise exception 'the sale for this day is already recorded — use the closing' using errcode = 'PA070'; end if;
  perform ensure_business_day(p_day);
  perform set_config('app.internal', '1', true);
  exp := expected_cash_now(p_day, p_pos_so_far);
  insert into spot_counts(day, pos_so_far, pos_photo_id, expected_cash, counted_cash, denominations, drawer_photo_id, note, counted_by, device)
  values (p_day, p_pos_so_far, p_pos_photo, exp, p_counted, p_denominations, p_drawer_photo, p_note, auth.uid(), current_device())
  returning * into sc;
  select name into who from profiles where id = auth.uid();
  perform notify_owners((case when sc.difference < 0 then 'closing_minus' else 'closing_submitted' end)::notification_kind,
    case when sc.difference < 0 then format('MINUS at surprise count · %s · %s', p_day, sc.difference) else format('Surprise count · %s · +%s', p_day, sc.difference) end,
    format('POS so far %s · expected in drawer %s · counted %s. Counted by %s.', p_pos_so_far, exp, p_counted, who), 'spot_counts', sc.id);
  return sc;
end $$;
grant execute on function spot_count(date, numeric, uuid, numeric, jsonb, uuid, text) to authenticated;
grant execute on function expected_cash_now(date, numeric) to authenticated;
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then alter publication supabase_realtime add table spot_counts; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. card-machine reconciliation: what the bank actually paid in for a day's receipts
-- ---------------------------------------------------------------------------
create table if not exists bank_settlements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  day date not null references business_days(day),          -- the receipts day being settled
  amount numeric(14,2) not null check (amount >= 0),
  note text,
  photo_id uuid not null references photos(id),              -- bank statement / app screenshot
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now(),
  unique (account_id, day)
);
create trigger a_ensure_day before insert on bank_settlements for each row execute function trg_ensure_day();
create trigger a_stamp before insert on bank_settlements for each row execute function trg_stamp_entry();
create trigger c_photo after insert on bank_settlements for each row execute function trg_claim_photo('photo_id');
create trigger d_audit after insert or update or delete on bank_settlements for each row execute function trg_audit_change();
create or replace function trg_settlement_account() returns trigger language plpgsql as $$
declare k account_kind;
begin
  select kind into k from accounts where id = new.account_id;
  if k <> 'card_machine' then raise exception 'settlements are recorded for card machines' using errcode = 'PA071'; end if;
  return new;
end $$;
create trigger b_check before insert or update on bank_settlements for each row execute function trg_settlement_account();
alter table bank_settlements enable row level security;
create policy read_all on bank_settlements for select using (can_read());
create policy bs_ins on bank_settlements for insert with check (is_manager_or_owner());
create policy bs_upd on bank_settlements for update using (is_owner());
create policy bs_del on bank_settlements for delete using (is_owner());
grant select, insert, update, delete on bank_settlements to authenticated;

-- per machine per day: machine receipts vs bank settlement
create or replace function card_reconciliation(p_from date, p_to date)
returns table (day date, account_id uuid, account_name text, machine numeric, settled numeric, difference numeric, settlement_id uuid, note text)
language sql stable as $$
  with days as (
    select v.day, v.account_id, sum(v.amount) as machine from v_non_cash_received v join accounts a on a.id = v.account_id
    where a.kind = 'card_machine' and v.day between p_from and p_to group by v.day, v.account_id
  ), all_rows as (
    select d.day, d.account_id, d.machine, s.amount as settled, s.id as sid, s.note from days d left join bank_settlements s on s.account_id = d.account_id and s.day = d.day
    union
    select s.day, s.account_id, coalesce(d.machine, 0), s.amount, s.id, s.note from bank_settlements s left join days d on d.account_id = s.account_id and d.day = s.day
    where s.day between p_from and p_to and d.day is null
  )
  select r.day, r.account_id, a.name, r.machine, r.settled, case when r.settled is null then null else r.settled - r.machine end, r.sid, r.note
  from all_rows r join accounts a on a.id = r.account_id order by r.day desc, a.sort_order
$$;
grant execute on function card_reconciliation(date, date) to authenticated;

-- an alert when the bank paid in less than the machine took
create or replace function trg_settlement_after() returns trigger language plpgsql security definer set search_path = public as $$
declare m numeric; aname text;
begin
  select coalesce(sum(amount), 0) into m from v_non_cash_received where account_id = new.account_id and day = new.day;
  select name into aname from accounts where id = new.account_id;
  if new.amount < m then
    perform notify_owners('general', format('Card settlement short · %s · %s', aname, new.day), format('Machine took %s, bank paid in %s — %s short.', m, new.amount, m - new.amount), 'bank_settlements', new.id);
  end if;
  return null;
end $$;
create trigger e_after after insert on bank_settlements for each row execute function trg_settlement_after();

-- ---------------------------------------------------------------------------
-- 11. staff scorecard
-- ---------------------------------------------------------------------------
create or replace function staff_scorecard(p_from date, p_to date)
returns table (user_id uuid, name text, role text, days_closed int, avg_difference numeric, minus_days int, late_closings int, entries int, owner_corrections int, blocked_attempts int)
language sql stable as $$
  select p.id, p.name, p.role::text,
    (select count(*) from closings c where c.closed_by = p.id and c.day between p_from and p_to)::int,
    (select round(avg(c.difference)) from closings c where c.closed_by = p.id and c.day between p_from and p_to),
    (select count(*) from closings c where c.closed_by = p.id and c.day between p_from and p_to and c.difference < 0)::int,
    -- closed after 4 am Pakistan time (i.e. the next morning) instead of at night
    (select count(*) from closings c where c.closed_by = p.id and c.day between p_from and p_to and (c.created_at at time zone 'Asia/Karachi')::date > c.day and extract(hour from c.created_at at time zone 'Asia/Karachi') >= 4)::int,
    ((select count(*) from payments x where x.entered_by = p.id and x.day between p_from and p_to)
     + (select count(*) from expenses x where x.entered_by = p.id and x.day between p_from and p_to)
     + (select count(*) from invoices x where x.entered_by = p.id and x.day between p_from and p_to)
     + (select count(*) from sale_receipts x where x.entered_by = p.id and x.day between p_from and p_to)
     + (select count(*) from customer_credit_bills x where x.entered_by = p.id and x.day between p_from and p_to))::int,
    (select count(*) from audit_log a where a.action = 'update' and a.at::date between p_from and p_to and a.before->>'entered_by' = p.id::text)::int,
    (select count(*) from audit_log a where a.action = 'blocked' and a.user_id = p.id and a.at::date between p_from and p_to)::int
  from profiles p where p.active and p.has_login and p.role::text in ('manager', 'cashier') order by p.name
$$;
grant execute on function staff_scorecard(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. owner daily digest + Telegram delivery (optional, configured by the owner)
-- ---------------------------------------------------------------------------
create table if not exists app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);
alter table app_settings enable row level security;
create policy settings_owner on app_settings for all using (is_owner()) with check (is_owner());
grant select, insert, update, delete on app_settings to authenticated;

create or replace function set_setting(p_key text, p_value text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if p_key not in ('telegram_bot_token', 'telegram_chat_id', 'digest_hour') then raise exception 'unknown setting' using errcode = 'PA072'; end if;
  insert into app_settings(key, value, updated_by) values (p_key, nullif(trim(p_value), ''), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
end $$;
grant execute on function set_setting(text, text) to authenticated;

-- send a Telegram message when a bot token + chat id are configured and pg_net is available; otherwise do nothing
create or replace function send_telegram(p_text text) returns boolean language plpgsql security definer set search_path = public as $$
declare tok text; chat text; fn regprocedure;
begin
  select value into tok from app_settings where key = 'telegram_bot_token';
  select value into chat from app_settings where key = 'telegram_chat_id';
  if tok is null or chat is null then return false; end if;
  select oid into fn from pg_proc where proname = 'http_post' and pronamespace = (select oid from pg_namespace where nspname = 'net') limit 1;
  if fn is null then return false; end if;
  execute format('select net.http_post(url := %L, body := %L::jsonb, headers := %L::jsonb)',
    'https://api.telegram.org/bot' || tok || '/sendMessage',
    jsonb_build_object('chat_id', chat, 'text', p_text, 'disable_web_page_preview', true)::text,
    '{"Content-Type": "application/json"}');
  return true;
end $$;

-- owner alerts also go to Telegram
create or replace function notify_users(p_users uuid[], p_kind notification_kind, p_title text, p_body text, p_ref_table text, p_ref_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if is_api_request() and not (pg_trigger_depth() > 0 or is_owner() or current_setting('app.internal', true) = '1') then
    raise exception 'notifications are created by the system only' using errcode = '42501';
  end if;
  insert into notifications(user_id, kind, title, body, ref_table, ref_id)
  select unnest(p_users), p_kind, p_title, p_body, p_ref_table, p_ref_id;
  if exists (select 1 from profiles where id = any(p_users) and role = 'owner') and p_kind::text in ('closing_minus', 'closing_submitted', 'duplicate_blocked', 'owner_paid_request', 'unposted_invoice', 'waw_outstanding', 'general') then
    begin
      perform send_telegram(p_title || E'\n' || coalesce(p_body, ''));
    exception when others then null;   -- delivery problems never break the entry
    end;
  end if;
end $$;

create or replace function daily_digest(p_day date) returns text language plpgsql stable security definer set search_path = public as $$
declare s jsonb; c closings; t text; unposted int; diffp numeric; waw numeric; owner_owed numeric; sc spot_counts;
begin
  s := range_summary(p_day, p_day);
  select * into c from closings where day = p_day;
  select count(*) into unposted from invoices where not posted_in_pos;
  diffp := (s->>'distributor_diff_pending')::numeric;
  waw := waw_outstanding();
  owner_owed := (s->>'owed_to_owner')::numeric;
  t := format('Pro Aid · %s', to_char(p_day, 'Dy DD Mon'));
  t := t || E'\n' || format('Sale %s · cash %s · card/online %s · credit %s', (s->>'pos_total')::numeric, (s->>'cash')::numeric,
        coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(s->'by_account') x), 0), (s->>'credit_given')::numeric);
  if c.id is not null then
    t := t || E'\n' || format('Closing: expected %s · counted %s · %s%s', c.expected_cash, c.counted_cash, case when c.difference < 0 then 'MINUS ' else 'plus ' end, c.difference);
  else
    t := t || E'\n' || 'Closing: NOT DONE';
  end if;
  t := t || E'\n' || format('Purchases %s · paid %s · expenses %s', (s->>'purchases_received')::numeric, (s->>'purchases_paid')::numeric, (s->>'expenses')::numeric);
  t := t || E'\n' || format('Unposted invoices %s · distributors owe us %s · WAW owed %s · owed to owner %s', unposted, diffp, waw, owner_owed);
  return t;
end $$;
grant execute on function daily_digest(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. anomaly checks (run every morning for the previous day; each rule fires once per day)
-- ---------------------------------------------------------------------------
create or replace function anomaly_alert(p_key text, p_title text, p_body text) returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from notifications where kind = 'general' and ref_table = 'anomaly' and title = p_title and created_at > now() - interval '20 hours') then return; end if;
  perform notify_owners('general', p_title, p_body, 'anomaly', null);
end $$;

create or replace function run_anomaly_checks(p_day date) returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; r record; c closings; avg_all numeric; avg_user numeric; wk numeric; base numeric; hr int;
begin
  perform set_config('app.internal', '1', true);
  -- a. closing with no plus at all (a drawer that is never over is suspicious in this shop)
  select * into c from closings where day = p_day;
  if c.id is not null and c.difference = 0 then
    perform anomaly_alert('zero', format('Anomaly · exactly zero difference · %s', p_day), 'The drawer matched the system to the rupee. In this shop the drawer is normally slightly over; an exact match can mean the count was made to fit.'); n := n + 1;
  end if;
  -- b. the person closing has a much lower average plus than everyone else (last 30 days, at least 5 closings each)
  select avg(difference) into avg_all from closings where day between p_day - 29 and p_day;
  if c.id is not null then
    select avg(difference) into avg_user from closings where closed_by = c.closed_by and day between p_day - 29 and p_day;
    if (select count(*) from closings where closed_by = c.closed_by and day between p_day - 29 and p_day) >= 5
       and (select count(*) from closings where closed_by <> c.closed_by and day between p_day - 29 and p_day) >= 5
       and avg_all > 0 and avg_user < avg_all * 0.5 then
      perform anomaly_alert('user-avg', format('Anomaly · low plus for %s', (select name from profiles where id = c.closed_by)),
        format('Average difference on their closings (30 days): %s, everyone: %s.', round(avg_user), round(avg_all))); n := n + 1;
    end if;
  end if;
  -- c. expenses this week far above the previous four weeks
  select coalesce(sum(amount), 0) into wk from expenses where day between p_day - 6 and p_day;
  select coalesce(sum(amount), 0) / 4 into base from expenses where day between p_day - 34 and p_day - 7;
  if base > 0 and wk > base * 1.5 and wk - base > 2000 then
    perform anomaly_alert('expenses', format('Anomaly · expenses up sharply · week to %s', p_day), format('This week %s vs %s per week before (+%s%%).', wk, round(base), round((wk / base - 1) * 100))); n := n + 1;
  end if;
  -- d. same distributor, same amount, paid twice within 30 days (different invoices)
  for r in select d.name, p.amount, count(*) as k from payments p join invoices i on i.id = p.invoice_id join distributors d on d.id = i.distributor_id
           where p.day between p_day - 29 and p_day and p.amount >= 1000 group by d.name, p.amount having count(distinct p.invoice_id) > 1 and count(*) > 1
  loop
    perform anomaly_alert('same-amount', format('Anomaly · %s paid %s more than once', r.name, r.amount), format('%s payments of exactly %s to %s in 30 days on different invoices — check they are not the same bill.', r.k, r.amount, r.name)); n := n + 1;
  end loop;
  -- e. closing done the next morning instead of at night
  if c.id is not null then
    hr := extract(hour from c.created_at at time zone 'Asia/Karachi');
    if (c.created_at at time zone 'Asia/Karachi')::date > c.day and hr >= 4 then
      perform anomaly_alert('late', format('Anomaly · late closing · %s', p_day), format('The day was closed at %s the next morning by %s, not at night.', to_char(c.created_at at time zone 'Asia/Karachi', 'HH24:MI'), (select name from profiles where id = c.closed_by))); n := n + 1;
    end if;
  elsif p_day < current_date then
    perform anomaly_alert('noclose', format('No closing · %s', p_day), 'The day has no closing yet.'); n := n + 1;
  end if;
  -- f. drawer count used instead of the POS total
  if exists (select 1 from daily_sales where day = p_day and pos_source = 'count') then
    perform anomaly_alert('count', format('Sale worked out from the drawer count · %s', p_day), 'No POS total was typed for this day — compare with the POS report.'); n := n + 1;
  end if;
  return n;
end $$;

-- morning job: everything as before + anomaly checks + digest for yesterday
create or replace function run_daily_jobs_impl() returns void language plpgsql security definer set search_path = public as $$
declare r reminders; owed numeric; n int; y date; d text;
begin
  perform set_config('app.internal', '1', true);
  owed := waw_outstanding();
  if owed > 0 then
    perform notify_owners('waw_outstanding', format('WAW F/S still owed Rs %s', owed), 'Daily reminder until repaid in full.', 'waw_loans', null);
  end if;
  for r in select * from reminders where done_at is null and remind_at <= now()
           and (last_fired_at is null or (repeat_daily and last_fired_at < now() - interval '20 hours'))
  loop
    if r.notify_all then
      perform notify_everyone('payment_reminder', r.title, coalesce('Rs ' || r.amount, ''), 'reminders', r.id);
    else
      perform notify_users(array[r.created_by], 'payment_reminder', r.title, coalesce('Rs ' || r.amount, ''), 'reminders', r.id);
    end if;
    update reminders set last_fired_at = now() where id = r.id;
  end loop;
  select count(*) into n from invoices where not posted_in_pos;
  if n > 0 then
    perform notify_owners('unposted_invoice', format('%s invoices not yet posted in POS', n), 'Open Purchases → Not posted in POS.', 'invoices', null);
  end if;
  -- yesterday (Pakistan time), once per day
  y := ((now() at time zone 'Asia/Karachi')::date - 1);
  if not exists (select 1 from notifications where kind = 'general' and ref_table = 'digest' and title = format('Daily digest · %s', y)) then
    perform run_anomaly_checks(y);
    d := daily_digest(y);
    perform notify_owners('general', format('Daily digest · %s', y), d, 'digest', null);
  end if;
end $$;
