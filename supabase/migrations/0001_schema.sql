-- Pro Aid · database schema
-- Every rule the owner asked for lives here, not only in the screens:
--   * every money entry carries at least one photo (NOT NULL photo_id + a photo can be used once)
--   * staff can add, never edit or delete; owner edits require a reason and are logged with before/after
--   * an approved (locked) day rejects every change
--   * the same distributor + invoice number cannot be paid twice; payments can never exceed the invoice
--   * closings are immutable once submitted
--   * every row records who entered it, when, and from which device

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type app_role as enum ('owner', 'manager', 'cashier');
create type account_kind as enum ('cash_drawer', 'card_machine', 'wallet', 'bank', 'owner_personal', 'waw_fs');
create type day_status as enum ('open', 'closed', 'approved');
create type cash_source as enum ('today', 'yesterday', 'not_cash');
create type staff_entry_kind as enum ('advance_sale_cash', 'advance_purchase_cash', 'medicine_credit', 'salary_deduction', 'cash_repayment');
create type waw_kind as enum ('borrow', 'repay');
create type settlement_kind as enum ('cash_return', 'minus_receipts');
create type notification_kind as enum ('closing_submitted', 'closing_minus', 'duplicate_blocked', 'unposted_invoice', 'waw_outstanding', 'payment_reminder', 'owner_paid_request', 'day_approved', 'edit_made', 'general');

-- ---------------------------------------------------------------------------
-- Users, devices, session context
-- ---------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role app_role not null default 'cashier',
  phone text unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  label text not null,
  platform text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- helpers that read the caller's identity
create or replace function current_role_of(uid uuid) returns app_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = uid and active
$$;

create or replace function my_role() returns app_role language sql stable as $$
  select current_role_of(auth.uid())
$$;

create or replace function is_owner() returns boolean language sql stable as $$
  select coalesce(my_role() = 'owner', false)
$$;

create or replace function is_manager_or_owner() returns boolean language sql stable as $$
  select coalesce(my_role() in ('owner', 'manager'), false)
$$;

-- device label the client sets once per connection: select set_config('app.device', 'Pharmacy Android', false)
create or replace function current_device() returns text language sql stable as $$
  select nullif(current_setting('app.device', true), '')
$$;

-- a privileged function announces itself so audit rules let its own change through (still logged)
create or replace function system_action() returns text language sql stable as $$
  select nullif(current_setting('app.system_action', true), '')
$$;

-- reason the owner supplies for an edit/delete: select set_config('app.reason', '...', true) inside the transaction
create or replace function current_reason() returns text language sql stable as $$
  select nullif(current_setting('app.reason', true), '')
$$;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
create table accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind account_kind not null,
  provider text,               -- HBL, UBL, Alfalah, EasyPaisa, JazzCash, SadaPay ...
  active boolean not null default true,
  sort_order int not null default 100
);

create table distributors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  rep_name text,
  phone text,
  delivery_days text,
  opening_balance numeric(14,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  sort_order int not null default 100
);

-- ---------------------------------------------------------------------------
-- Photos: the proof behind every entry
-- ---------------------------------------------------------------------------
create table photos (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  taken_by uuid not null references profiles(id),
  taken_at timestamptz not null default now(),
  device text,
  sha256 text,
  used_by_table text,          -- set by trigger when an entry claims it; a photo is proof for exactly one entry
  used_by_id uuid
);

-- ---------------------------------------------------------------------------
-- Business days (the lock lives here)
-- ---------------------------------------------------------------------------
create table business_days (
  day date primary key,
  opening_cash numeric(14,2) not null default 0,
  status day_status not null default 'open',
  closed_by uuid references profiles(id),
  closed_at timestamptz,
  approved_by uuid references profiles(id),
  approved_at timestamptz,
  unlock_reason text,
  created_at timestamptz not null default now()
);

create or replace function day_is_locked(d date) returns boolean language sql stable as $$
  select coalesce((select status = 'approved' from business_days where day = d), false)
$$;

-- ---------------------------------------------------------------------------
-- Money entries
-- ---------------------------------------------------------------------------
-- Daily sale as read from the POS, split by how customers paid
create table daily_sales (
  id uuid primary key default gen_random_uuid(),
  day date not null unique references business_days(day),
  pos_total numeric(14,2) not null check (pos_total >= 0),
  credit_total numeric(14,2) not null default 0 check (credit_total >= 0),
  photo_id uuid not null references photos(id),     -- photo of the POS total screen
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);

-- one line per card machine / wallet with its slip or screenshot
create table daily_sale_lines (
  id uuid primary key default gen_random_uuid(),
  daily_sale_id uuid not null references daily_sales(id) on delete cascade,
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount >= 0),
  photo_id uuid not null references photos(id),
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now(),
  unique (daily_sale_id, account_id)
);

-- Customer credit bills (pay later) and their collection
create table customer_credit_bills (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  day date not null references business_days(day),
  bill_no text not null,
  amount numeric(14,2) not null check (amount > 0),
  photo_id uuid not null references photos(id),
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now(),
  unique (customer_id, bill_no)
);

create table customer_credit_collections (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  bill_id uuid references customer_credit_bills(id),
  day date not null references business_days(day),
  amount numeric(14,2) not null check (amount > 0),
  account_id uuid not null references accounts(id),     -- cash drawer or a wallet/bank
  photo_id uuid not null references photos(id),
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);

-- Purchases (invoices received from distributors)
create table invoices (
  id uuid primary key default gen_random_uuid(),
  distributor_id uuid not null references distributors(id),
  invoice_no text not null,
  invoice_date date,
  day date not null references business_days(day),
  amount numeric(14,2) not null check (amount > 0),
  photo_id uuid not null references photos(id),
  posted_in_pos boolean not null default false,
  posted_at timestamptz,
  posted_by uuid references profiles(id),
  installments_planned int check (installments_planned is null or installments_planned >= 2),
  next_due date,
  note text,
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now(),
  unique (distributor_id, invoice_no)
);

-- Payments to distributors against an invoice
create table payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id),
  day date not null references business_days(day),
  amount numeric(14,2) not null check (amount > 0),
  account_id uuid not null references accounts(id),     -- cash drawer, pharmacy bank/wallet, owner personal
  cash_source cash_source not null default 'not_cash',   -- today / yesterday label when paid from drawer
  installment_no int,
  photo_id uuid not null references photos(id),          -- invoice photo, or transfer screenshot when online
  requested_by uuid references profiles(id),             -- who asked the owner to pay from his account
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);

-- Expenses
create table expenses (
  id uuid primary key default gen_random_uuid(),
  day date not null references business_days(day),
  category_id uuid not null references expense_categories(id),
  amount numeric(14,2) not null check (amount > 0),
  note text,
  account_id uuid not null references accounts(id),
  cash_source cash_source not null default 'today',
  photo_id uuid not null references photos(id),
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);

-- Staff accounts (owner-only writes)
create table staff_entries (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references profiles(id),
  day date not null references business_days(day),
  kind staff_entry_kind not null,
  amount numeric(14,2) not null check (amount > 0),
  bill_no text,
  note text,
  photo_id uuid not null references photos(id),
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);

-- WAW F/S loans
create table waw_loans (
  id uuid primary key default gen_random_uuid(),
  day date not null references business_days(day),
  kind waw_kind not null,
  amount numeric(14,2) not null check (amount > 0),
  account_id uuid not null references accounts(id),     -- cash drawer or bank
  handled_by text,                                       -- who took / handed over, free text
  note text,
  photo_id uuid not null references photos(id),
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);

-- Settling invoices the owner paid from his personal account
create table owner_settlements (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id),
  day date not null references business_days(day),
  kind settlement_kind not null,
  account_id uuid references accounts(id),               -- null = minus from the overall non-cash total
  amount numeric(14,2) not null check (amount > 0),
  photo_id uuid not null references photos(id),
  entered_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);

-- Daily closing (immutable once inserted)
create table closings (
  id uuid primary key default gen_random_uuid(),
  day date not null unique references business_days(day),
  expected_cash numeric(14,2) not null,
  counted_cash numeric(14,2) not null check (counted_cash >= 0),
  difference numeric(14,2) generated always as (counted_cash - expected_cash) stored,
  drawer_photo_id uuid not null references photos(id),
  note text,
  closed_by uuid not null references profiles(id),
  device text,
  created_at timestamptz not null default now()
);

-- Reminders and notifications
create table reminders (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id),
  title text not null,
  amount numeric(14,2),
  remind_at timestamptz not null,
  notify_all boolean not null default true,
  repeat_daily boolean not null default true,
  created_by uuid not null default auth.uid() references profiles(id),
  done_at timestamptz,
  last_fired_at timestamptz,
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  kind notification_kind not null,
  title text not null,
  body text,
  ref_table text,
  ref_id uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

-- Audit log: everything that happened
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,        -- insert / update / delete / blocked / approve / unlock / login
  table_name text not null,
  row_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  device text
);

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
-- stamp entered_by / device on insert
create or replace function trg_stamp_entry() returns trigger language plpgsql as $$
begin
  if new.entered_by is null then new.entered_by := auth.uid(); end if;
  if new.device is null then new.device := current_device(); end if;
  return new;
end $$;

-- a photo is proof for exactly one entry
create or replace function trg_claim_photo() returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid; col text;
begin
  col := coalesce(tg_argv[0], 'photo_id');
  execute format('select ($1).%I', col) into pid using new;
  if pid is null then raise exception 'photo required for %', tg_table_name using errcode = '23502'; end if;
  update photos set used_by_table = tg_table_name, used_by_id = new.id
   where id = pid and (used_by_id is null or used_by_id = new.id);
  if not found then
    raise exception 'photo already used as proof for another entry' using errcode = '23505';
  end if;
  return new;
end $$;

-- a locked (approved) day rejects every change
create or replace function trg_reject_if_locked() returns trigger language plpgsql as $$
declare d date;
begin
  if tg_op = 'DELETE' then d := old.day; else d := new.day; end if;
  if day_is_locked(d) then
    raise exception 'day % is approved and locked', d using errcode = 'PA001';
  end if;
  if tg_op = 'UPDATE' and old.day <> new.day and day_is_locked(old.day) then
    raise exception 'day % is approved and locked', old.day using errcode = 'PA001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- staff never edit or delete; the owner must give a reason, and both versions are logged
create or replace function trg_audit_change() returns trigger language plpgsql security definer set search_path = public as $$
declare r text; rid uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') and system_action() is not null then
    if tg_op = 'DELETE' then rid := old.id; else rid := new.id; end if;
    insert into audit_log(user_id, action, table_name, row_id, before, after, reason, device)
    values (auth.uid(), system_action(), tg_table_name, rid, to_jsonb(old), case when tg_op = 'UPDATE' then to_jsonb(new) end, current_reason(), current_device());
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    if not is_owner() then
      raise exception 'entries cannot be edited or deleted by staff' using errcode = '42501';
    end if;
    r := current_reason();
    if r is null then
      raise exception 'a reason is required to change a saved entry' using errcode = 'PA002';
    end if;
  end if;
  if tg_op = 'DELETE' then rid := old.id; else rid := new.id; end if;
  insert into audit_log(user_id, action, table_name, row_id, before, after, reason, device)
  values (auth.uid(), lower(tg_op), tg_table_name, rid,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
          r, current_device());
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- business day auto-creation and opening cash carry-forward
create or replace function ensure_business_day(d date) returns void language plpgsql security definer set search_path = public as $$
declare prev_close numeric(14,2);
begin
  if exists (select 1 from business_days where day = d) then return; end if;
  select c.counted_cash into prev_close
    from closings c where c.day < d order by c.day desc limit 1;
  insert into business_days(day, opening_cash) values (d, coalesce(prev_close, 0))
  on conflict do nothing;
end $$;

create or replace function trg_ensure_day() returns trigger language plpgsql as $$
begin
  perform ensure_business_day(new.day);
  return new;
end $$;

-- attach the generic triggers to every money table
do $$
declare t text;
begin
  foreach t in array array['daily_sales','customer_credit_bills','customer_credit_collections','invoices','payments','expenses','staff_entries','waw_loans','owner_settlements','closings']
  loop
    execute format('create trigger a_ensure_day before insert on %I for each row execute function trg_ensure_day()', t);
    execute format('create trigger b_locked before insert or update or delete on %I for each row execute function trg_reject_if_locked()', t);
    execute format('create trigger d_audit after insert or update or delete on %I for each row execute function trg_audit_change()', t);
  end loop;
  foreach t in array array['daily_sales','daily_sale_lines','customer_credit_bills','customer_credit_collections','invoices','payments','expenses','staff_entries','waw_loans','owner_settlements']
  loop
    execute format('create trigger a_stamp before insert on %I for each row execute function trg_stamp_entry()', t);
    execute format('create trigger c_photo after insert on %I for each row execute function trg_claim_photo(''photo_id'')', t);
  end loop;
  -- closings use closed_by / drawer_photo_id
  execute 'create trigger c_photo after insert on closings for each row execute function trg_claim_photo(''drawer_photo_id'')';
  -- daily sale lines carry no day column; they follow their parent day
  execute 'create trigger d_audit after insert or update or delete on daily_sale_lines for each row execute function trg_audit_change()';
end $$;

-- closings: once submitted, nobody edits (not even the owner) — only an unlock + new closing
create or replace function trg_closing_immutable() returns trigger language plpgsql as $$
begin
  if system_action() = 'unlock' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'a submitted closing cannot be changed; the owner can unlock the day and close it again' using errcode = 'PA003';
end $$;
create trigger e_immutable before update or delete on closings for each row execute function trg_closing_immutable();

-- ---------------------------------------------------------------------------
-- Domain rules
-- ---------------------------------------------------------------------------
-- daily sale: cash part can never be negative and lines cannot exceed the POS total
create or replace function sale_cash_part(sale_id uuid) returns numeric language sql stable as $$
  select s.pos_total - s.credit_total - coalesce((select sum(l.amount) from daily_sale_lines l where l.daily_sale_id = s.id), 0)
  from daily_sales s where s.id = sale_id
$$;

create or replace function trg_sale_line_check() returns trigger language plpgsql as $$
declare k account_kind; sid uuid;
begin
  sid := coalesce(new.daily_sale_id, old.daily_sale_id);
  if day_is_locked((select day from daily_sales where id = sid)) then
    raise exception 'day is approved and locked' using errcode = 'PA001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  select kind into k from accounts where id = new.account_id;
  if k not in ('card_machine', 'wallet', 'bank') then
    raise exception 'a sale line must be a card machine, wallet or bank account' using errcode = 'PA004';
  end if;
  return new;
end $$;
create trigger b_check before insert or update or delete on daily_sale_lines for each row execute function trg_sale_line_check();

create or replace function trg_sale_lines_total() returns trigger language plpgsql as $$
declare sid uuid; cashpart numeric;
begin
  sid := coalesce(new.daily_sale_id, old.daily_sale_id);
  cashpart := sale_cash_part(sid);
  if cashpart < 0 then
    raise exception 'card, online and credit amounts exceed the POS total by %', -cashpart using errcode = 'PA005';
  end if;
  return null;
end $$;
create trigger e_total after insert or update or delete on daily_sale_lines for each row execute function trg_sale_lines_total();

-- payments: duplicate guard + never exceed the invoice + installment numbering + owner-personal request tracking
create or replace function invoice_paid(inv uuid) returns numeric language sql stable as $$
  select coalesce(sum(amount), 0) from payments where invoice_id = inv
$$;

create or replace function trg_payment_check() returns trigger language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype; paid numeric; k account_kind; n int;
begin
  select * into inv from invoices where id = new.invoice_id;
  if inv.id is null then raise exception 'invoice not found'; end if;
  paid := invoice_paid(inv.id);
  if paid >= inv.amount then
    insert into audit_log(user_id, action, table_name, row_id, after, device)
    values (auth.uid(), 'blocked', 'payments', inv.id, jsonb_build_object('reason', 'invoice already fully paid', 'invoice_no', inv.invoice_no, 'distributor_id', inv.distributor_id, 'attempted', new.amount), current_device());
    perform notify_owners('duplicate_blocked', 'Duplicate payment blocked',
      format('Invoice %s is already fully paid (%s). Attempted %s.', inv.invoice_no, inv.amount, new.amount), 'invoices', inv.id);
    raise exception 'invoice % is already fully paid — duplicate payment blocked', inv.invoice_no using errcode = 'PA006';
  end if;
  if paid + new.amount > inv.amount then
    raise exception 'payment % would exceed the invoice: % already paid of %', new.amount, paid, inv.amount using errcode = 'PA007';
  end if;
  select count(*) + 1 into n from payments where invoice_id = inv.id;
  new.installment_no := n;
  select kind into k from accounts where id = new.account_id;
  if k = 'cash_drawer' and new.cash_source = 'not_cash' then new.cash_source := 'today'; end if;
  if k <> 'cash_drawer' then new.cash_source := 'not_cash'; end if;
  if k = 'owner_personal' and new.requested_by is null then new.requested_by := auth.uid(); end if;
  return new;
end $$;
create trigger b_payment_check before insert on payments for each row execute function trg_payment_check();

-- the app records payments through this function so a blocked duplicate is LOGGED and the owner NOTIFIED
-- (a raise inside a trigger would roll those back). Direct inserts stay guarded by the trigger above.
create or replace function record_payment(p_invoice uuid, p_day date, p_amount numeric, p_account uuid, p_cash_source cash_source, p_photo uuid, p_requested_by uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype; paid numeric; pay payments;
begin
  if my_role() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into inv from invoices where id = p_invoice;
  if inv.id is null then raise exception 'invoice not found'; end if;
  paid := invoice_paid(inv.id);
  if paid >= inv.amount then
    insert into audit_log(user_id, action, table_name, row_id, after, device)
    values (auth.uid(), 'blocked', 'payments', inv.id, jsonb_build_object('reason', 'invoice already fully paid', 'invoice_no', inv.invoice_no, 'distributor_id', inv.distributor_id, 'attempted', p_amount), current_device());
    perform notify_owners('duplicate_blocked', 'Duplicate payment blocked',
      format('%s tried to pay invoice %s again (already fully paid, %s). Attempted %s.', (select name from profiles where id = auth.uid()), inv.invoice_no, inv.amount, p_amount), 'invoices', inv.id);
    return jsonb_build_object('blocked', true, 'code', 'PA006', 'message', format('Invoice %s is already fully paid — duplicate payment blocked. The owner has been notified.', inv.invoice_no));
  end if;
  if paid + p_amount > inv.amount then
    return jsonb_build_object('blocked', true, 'code', 'PA007', 'message', format('Payment %s would exceed the invoice: %s already paid of %s (%s remaining).', p_amount, paid, inv.amount, inv.amount - paid));
  end if;
  insert into payments(invoice_id, day, amount, account_id, cash_source, photo_id, requested_by, entered_by, device)
  values (p_invoice, p_day, p_amount, p_account, p_cash_source, p_photo, p_requested_by, auth.uid(), current_device())
  returning * into pay;
  return jsonb_build_object('blocked', false, 'payment', to_jsonb(pay));
end $$;

-- soft warning the client asks for before saving: same distributor, same amount, same day
create or replace function payment_warning(p_invoice uuid, p_amount numeric, p_day date) returns text language sql stable as $$
  select case when exists (
    select 1 from payments p join invoices i on i.id = p.invoice_id
    where i.distributor_id = (select distributor_id from invoices where id = p_invoice)
      and p.day = p_day and p.amount = p_amount)
    then 'Same amount already paid to this distributor today' end
$$;

-- staff entries: owner only (also enforced by RLS)
create or replace function trg_owner_only() returns trigger language plpgsql as $$
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  return new;
end $$;
create trigger b_owner_only before insert on staff_entries for each row execute function trg_owner_only();
create trigger b_owner_only before insert on owner_settlements for each row execute function trg_owner_only();

-- WAW repayment cannot exceed what is owed
create or replace function waw_outstanding() returns numeric language sql stable as $$
  select coalesce(sum(case when kind = 'borrow' then amount else -amount end), 0) from waw_loans
$$;
create or replace function trg_waw_check() returns trigger language plpgsql as $$
begin
  if new.kind = 'repay' and new.amount > waw_outstanding() then
    raise exception 'repayment % exceeds the % owed to WAW F/S', new.amount, waw_outstanding() using errcode = 'PA008';
  end if;
  return new;
end $$;
create trigger b_waw_check before insert on waw_loans for each row execute function trg_waw_check();

-- owner settlements cannot exceed the payment they settle
create or replace function trg_settlement_check() returns trigger language plpgsql as $$
declare p payments%rowtype; k account_kind; settled numeric;
begin
  select * into p from payments where id = new.payment_id;
  select kind into k from accounts where id = p.account_id;
  if k <> 'owner_personal' then raise exception 'only payments made from the owner''s personal account can be settled' using errcode = 'PA009'; end if;
  select coalesce(sum(amount), 0) into settled from owner_settlements where payment_id = p.id;
  if settled + new.amount > p.amount then
    raise exception 'settlement exceeds the payment: % already settled of %', settled, p.amount using errcode = 'PA010';
  end if;
  if new.kind = 'minus_receipts' and new.account_id is not null then
    select kind into k from accounts where id = new.account_id;
    if k not in ('card_machine', 'wallet', 'bank') then raise exception 'minus must come from a card machine, wallet or bank account' using errcode = 'PA011'; end if;
  end if;
  if new.kind = 'cash_return' then
    select id into new.account_id from accounts where kind = 'cash_drawer' limit 1;
  end if;
  return new;
end $$;
create trigger b_settlement_check before insert on owner_settlements for each row execute function trg_settlement_check();

-- ---------------------------------------------------------------------------
-- The cash book and the closing
-- ---------------------------------------------------------------------------
create or replace function cash_drawer_id() returns uuid language sql stable as $$
  select id from accounts where kind = 'cash_drawer' limit 1
$$;

-- what the drawer should hold at the end of a day
create or replace function cash_book(d date)
returns table (
  opening_cash numeric, pos_cash_sale numeric, credit_collected_cash numeric,
  distributor_paid_cash numeric, expenses_cash numeric, staff_advances_cash numeric,
  waw_borrowed_cash numeric, waw_repaid_cash numeric, owner_cash_returns numeric, customer_credit_given numeric,
  expected_cash numeric
) language sql stable as $$
  with s as (select coalesce(sale_cash_part(id), 0) as cash from daily_sales where day = d),
  vals as (
    select
      coalesce((select opening_cash from business_days where day = d), 0) as opening_cash,
      coalesce((select cash from s), 0) as pos_cash_sale,
      coalesce((select sum(amount) from customer_credit_collections where day = d and account_id = cash_drawer_id()), 0) as credit_collected_cash,
      coalesce((select sum(amount) from payments where day = d and account_id = cash_drawer_id()), 0) as distributor_paid_cash,
      coalesce((select sum(amount) from expenses where day = d and account_id = cash_drawer_id()), 0) as expenses_cash,
      coalesce((select sum(amount) from staff_entries where day = d and kind in ('advance_sale_cash','advance_purchase_cash')), 0)
        - coalesce((select sum(amount) from staff_entries where day = d and kind = 'cash_repayment'), 0) as staff_advances_cash,
      coalesce((select sum(amount) from waw_loans where day = d and kind = 'borrow' and account_id = cash_drawer_id()), 0) as waw_borrowed_cash,
      coalesce((select sum(amount) from waw_loans where day = d and kind = 'repay' and account_id = cash_drawer_id()), 0) as waw_repaid_cash,
      coalesce((select sum(amount) from owner_settlements where day = d and kind = 'cash_return'), 0) as owner_cash_returns,
      coalesce((select credit_total from daily_sales where day = d), 0) as customer_credit_given
  )
  select v.*,
    v.opening_cash + v.pos_cash_sale + v.credit_collected_cash + v.waw_borrowed_cash
      - v.distributor_paid_cash - v.expenses_cash - v.staff_advances_cash - v.waw_repaid_cash - v.owner_cash_returns as expected_cash
  from vals v
$$;

-- submit the closing: computes expected cash server-side, stores the count, closes the day, alerts the owner
create or replace function submit_closing(p_day date, p_counted numeric, p_drawer_photo uuid, p_note text default null)
returns closings language plpgsql security definer set search_path = public as $$
declare exp numeric; c closings; diff numeric;
begin
  if not is_manager_or_owner() then raise exception 'manager or owner only' using errcode = '42501'; end if;
  if not exists (select 1 from daily_sales where day = p_day) then
    raise exception 'record the daily sale before closing' using errcode = 'PA012';
  end if;
  perform ensure_business_day(p_day);
  select expected_cash into exp from cash_book(p_day);
  insert into closings(day, expected_cash, counted_cash, drawer_photo_id, note, closed_by, device)
  values (p_day, exp, p_counted, p_drawer_photo, p_note, auth.uid(), current_device())
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

-- owner approves and locks a day
create or replace function approve_day(p_day date) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if not exists (select 1 from closings where day = p_day) then raise exception 'day has no closing yet' using errcode = 'PA013'; end if;
  update business_days set status = 'approved', approved_by = auth.uid(), approved_at = now() where day = p_day;
  insert into audit_log(user_id, action, table_name, row_id, after, device)
  values (auth.uid(), 'approve', 'business_days', null, jsonb_build_object('day', p_day), current_device());
  perform ensure_business_day(p_day + 1);
end $$;

-- owner unlocks a day (reason required); the old closing is deleted through a privileged path and kept in the audit log
create or replace function unlock_day(p_day date, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare c closings;
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'a reason is required to unlock a day' using errcode = 'PA002'; end if;
  perform set_config('app.reason', p_reason, true);
  update business_days set status = 'open', approved_by = null, approved_at = null, unlock_reason = p_reason where day = p_day;
  perform set_config('app.system_action', 'unlock', true);
  delete from closings where day = p_day;   -- logged by the audit trigger as action 'unlock' with the full old row
  perform set_config('app.system_action', '', true);
  insert into audit_log(user_id, action, table_name, row_id, after, reason, device)
  values (auth.uid(), 'unlock', 'business_days', null, jsonb_build_object('day', p_day), p_reason, current_device());
end $$;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create or replace function notify_users(p_users uuid[], p_kind notification_kind, p_title text, p_body text, p_ref_table text, p_ref_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into notifications(user_id, kind, title, body, ref_table, ref_id)
  select unnest(p_users), p_kind, p_title, p_body, p_ref_table, p_ref_id
$$;

create or replace function notify_owners(p_kind notification_kind, p_title text, p_body text, p_ref_table text, p_ref_id uuid)
returns void language sql as $$
  select notify_users(array(select id from profiles where role = 'owner' and active), p_kind, p_title, p_body, p_ref_table, p_ref_id)
$$;

create or replace function notify_everyone(p_kind notification_kind, p_title text, p_body text, p_ref_table text, p_ref_id uuid)
returns void language sql as $$
  select notify_users(array(select id from profiles where active), p_kind, p_title, p_body, p_ref_table, p_ref_id)
$$;

-- owner-personal payments tell the owner
create or replace function trg_payment_after() returns trigger language plpgsql security definer set search_path = public as $$
declare k account_kind; inv invoices%rowtype;
begin
  select kind into k from accounts where id = new.account_id;
  select * into inv from invoices where id = new.invoice_id;
  if k = 'owner_personal' then
    perform notify_owners('owner_paid_request', format('Paid from your account · %s', (select name from distributors where id = inv.distributor_id)),
      format('Invoice %s · Rs %s · requested by %s', inv.invoice_no, new.amount, (select name from profiles where id = new.requested_by)), 'payments', new.id);
  end if;
  -- reminders on this invoice are done once it is fully paid
  if invoice_paid(inv.id) >= inv.amount then
    update reminders set done_at = now() where invoice_id = inv.id and done_at is null;
  end if;
  return null;
end $$;
create trigger e_payment_after after insert on payments for each row execute function trg_payment_after();

-- daily jobs (called by a scheduled function every morning): WAW reminder, due reminders, unposted invoices
create or replace function run_daily_jobs() returns void language plpgsql security definer set search_path = public as $$
declare r reminders; owed numeric; n int;
begin
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
end $$;

-- ---------------------------------------------------------------------------
-- Reporting views (read-only helpers; the app filters by date range)
-- ---------------------------------------------------------------------------
create or replace view v_invoice_status as
select i.*, invoice_paid(i.id) as paid, i.amount - invoice_paid(i.id) as remaining,
       (select count(*) from payments p where p.invoice_id = i.id) as payments_made,
       d.name as distributor_name
from invoices i join distributors d on d.id = i.distributor_id;

create or replace view v_distributor_balance as
select d.id, d.name, d.opening_balance + coalesce(sum(i.amount - invoice_paid(i.id)), 0) as pending,
       count(i.id) filter (where i.amount > invoice_paid(i.id)) as open_invoices,
       min(i.day) filter (where i.amount > invoice_paid(i.id)) as oldest_open
from distributors d left join invoices i on i.distributor_id = d.id
group by d.id, d.name, d.opening_balance;

create or replace view v_customer_balance as
select c.id, c.name, c.phone,
       coalesce((select sum(amount) from customer_credit_bills b where b.customer_id = c.id), 0)
       - coalesce((select sum(amount) from customer_credit_collections x where x.customer_id = c.id), 0) as owed,
       (select min(day) from customer_credit_bills b where b.customer_id = c.id) as since
from customers c;

create or replace view v_staff_balance as
select p.id, p.name, p.role,
  coalesce(sum(case when e.kind in ('advance_sale_cash','advance_purchase_cash','medicine_credit') then e.amount else -e.amount end), 0) as owed
from profiles p left join staff_entries e on e.staff_id = p.id
group by p.id, p.name, p.role;

-- non-cash received per account within a range, and what has been minused from it
create or replace function non_cash_pool(p_from date, p_to date)
returns table (account_id uuid, account_name text, kind account_kind, received numeric, minused numeric, remaining numeric)
language sql stable as $$
  select a.id, a.name, a.kind,
    coalesce((select sum(l.amount) from daily_sale_lines l join daily_sales s on s.id = l.daily_sale_id where l.account_id = a.id and s.day between p_from and p_to), 0)
      + coalesce((select sum(x.amount) from customer_credit_collections x where x.account_id = a.id and x.day between p_from and p_to), 0) as received,
    coalesce((select sum(o.amount) from owner_settlements o where o.kind = 'minus_receipts' and o.account_id = a.id and o.day between p_from and p_to), 0) as minused,
    0::numeric as remaining
  from accounts a where a.kind in ('card_machine','wallet','bank') and a.active
  order by a.sort_order
$$;
-- (remaining is computed in the app as received - minused, plus any 'overall' minus with account_id null)

create or replace view v_owner_paid as
select p.id as payment_id, p.day, p.amount, p.invoice_id, i.invoice_no, d.name as distributor_name,
       coalesce((select sum(amount) from owner_settlements s where s.payment_id = p.id), 0) as settled,
       p.amount - coalesce((select sum(amount) from owner_settlements s where s.payment_id = p.id), 0) as unsettled,
       p.requested_by, p.photo_id
from payments p join invoices i on i.id = p.invoice_id join distributors d on d.id = i.distributor_id
join accounts a on a.id = p.account_id where a.kind = 'owner_personal';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles','devices','accounts','distributors','customers','expense_categories','photos','business_days',
    'daily_sales','daily_sale_lines','customer_credit_bills','customer_credit_collections','invoices','payments','expenses',
    'staff_entries','waw_loans','owner_settlements','closings','reminders','notifications','audit_log']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- everyone signed in and active can read operational data
do $$
declare t text;
begin
  foreach t in array array['profiles','accounts','distributors','customers','expense_categories','photos','business_days',
    'daily_sales','daily_sale_lines','customer_credit_bills','customer_credit_collections','invoices','payments','expenses','waw_loans','closings','reminders']
  loop
    execute format('create policy read_all on %I for select using (my_role() is not null)', t);
  end loop;
end $$;

-- staff account entries: the owner sees all; a staff member sees only their own
create policy staff_read on staff_entries for select using (is_owner() or staff_id = auth.uid());
create policy staff_write on staff_entries for insert with check (is_owner());
create policy staff_change on staff_entries for update using (is_owner());
create policy staff_del on staff_entries for delete using (is_owner());

-- owner-only tables
create policy settle_read on owner_settlements for select using (is_owner() or is_manager_or_owner());
create policy settle_write on owner_settlements for insert with check (is_owner());
create policy settle_change on owner_settlements for update using (is_owner());
create policy settle_del on owner_settlements for delete using (is_owner());
create policy audit_read on audit_log for select using (is_owner());

-- notifications: yours only
create policy notif_read on notifications for select using (user_id = auth.uid());
create policy notif_update on notifications for update using (user_id = auth.uid());

-- devices: yours, owner sees all
create policy dev_read on devices for select using (is_owner() or user_id = auth.uid());
create policy dev_write on devices for insert with check (user_id = auth.uid());
create policy dev_update on devices for update using (user_id = auth.uid());

-- photos: anyone active can add proof
create policy photo_write on photos for insert with check (taken_by = auth.uid() and my_role() is not null);

-- reference data: owner manages, everyone reads
do $$
declare t text;
begin
  foreach t in array array['accounts','distributors','customers','expense_categories','profiles']
  loop
    execute format('create policy %I_owner_ins on %I for insert with check (is_owner())', t, t);
    execute format('create policy %I_owner_upd on %I for update using (is_owner())', t, t);
    execute format('create policy %I_owner_del on %I for delete using (is_owner())', t, t);
  end loop;
end $$;
-- managers and cashiers may add a distributor or customer on the spot (owner can tidy later)
create policy dist_staff_ins on distributors for insert with check (my_role() is not null);
create policy cust_staff_ins on customers for insert with check (my_role() is not null);

-- money entries: everyone active can add; only the owner can change (triggers still demand a reason)
do $$
declare t text;
begin
  foreach t in array array['customer_credit_bills','customer_credit_collections','invoices','payments','expenses','waw_loans']
  loop
    execute format('create policy %I_ins on %I for insert with check (my_role() is not null)', t, t);
    execute format('create policy %I_upd on %I for update using (is_owner())', t, t);
    execute format('create policy %I_del on %I for delete using (is_owner())', t, t);
  end loop;
end $$;
-- daily sale and closing: manager or owner
create policy sale_ins on daily_sales for insert with check (is_manager_or_owner());
create policy sale_upd on daily_sales for update using (is_owner());
create policy sale_del on daily_sales for delete using (is_owner());
create policy saleline_ins on daily_sale_lines for insert with check (is_manager_or_owner());
create policy saleline_upd on daily_sale_lines for update using (is_owner());
create policy saleline_del on daily_sale_lines for delete using (is_owner());
create policy closing_ins on closings for insert with check (is_manager_or_owner());
-- business days are managed through functions; owner may set opening cash
create policy day_upd on business_days for update using (is_owner());
create policy day_ins on business_days for insert with check (my_role() is not null);
-- reminders: anyone can set; creator or owner can finish
create policy rem_ins on reminders for insert with check (my_role() is not null);
create policy rem_upd on reminders for update using (is_owner() or created_by = auth.uid());

-- invoices: marking "posted in POS" is allowed for manager/owner without a reason (it is a status, not money)
create or replace function mark_posted(p_invoice uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_manager_or_owner() then raise exception 'manager or owner only' using errcode = '42501'; end if;
  perform set_config('app.system_action', 'posted_in_pos', true);
  update invoices set posted_in_pos = true, posted_at = now(), posted_by = auth.uid() where id = p_invoice and not posted_in_pos;
  perform set_config('app.system_action', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- Seed reference data
-- ---------------------------------------------------------------------------
insert into accounts(name, kind, provider, sort_order) values
  ('Cash drawer', 'cash_drawer', null, 1),
  ('HBL card machine', 'card_machine', 'HBL', 10),
  ('UBL card machine', 'card_machine', 'UBL', 11),
  ('Alfalah card machine', 'card_machine', 'Bank Alfalah', 12),
  ('EasyPaisa', 'wallet', 'EasyPaisa', 20),
  ('JazzCash', 'wallet', 'JazzCash', 21),
  ('SadaPay', 'wallet', 'SadaPay', 22),
  ('UBL account', 'bank', 'UBL', 23),
  ('Owner personal account', 'owner_personal', null, 90),
  ('WAW F/S', 'waw_fs', null, 91);

insert into expense_categories(name, sort_order) values
  ('Bike fuel', 1), ('Bike service', 2), ('Stationery', 3), ('Refreshments', 4), ('Utility', 5), ('Salary', 6), ('Other', 99);
