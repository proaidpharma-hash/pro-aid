-- 0010 · one invoice, several payment sources
-- A payment line can come from the drawer (today's / yesterday's cash), a card machine / wallet / bank account,
-- the owner's personal account, a WAW F/S loan (the loan is booked automatically), or by adjusting a
-- difference the distributor already owes us. Each line carries its own proof and note.

alter table payments add column if not exists note text;
alter table payments add column if not exists adjust_from_invoice_id uuid references invoices(id);
alter table waw_loans add column if not exists payment_id uuid references payments(id);
alter table invoice_diff_settlements add column if not exists payment_id uuid references payments(id);

-- an "adjustment" account so the adjusted amount shows up like every other source
alter type account_kind add value if not exists 'adjustment';
insert into accounts(name, kind, provider, sort_order)
select 'Adjusted against distributor difference', 'adjustment'::text::account_kind, null, 95
where not exists (select 1 from accounts where kind::text = 'adjustment');

-- proof photos: an adjustment line and the entries the system books on its behalf carry no photo of their own
alter table payments alter column photo_id drop not null;
alter table payments drop constraint if exists payments_photo_required;
alter table payments add constraint payments_photo_required check (photo_id is not null or adjust_from_invoice_id is not null);
alter table waw_loans alter column photo_id drop not null;
alter table waw_loans drop constraint if exists waw_photo_required;
alter table waw_loans add constraint waw_photo_required check (photo_id is not null or payment_id is not null);
alter table invoice_diff_settlements alter column photo_id drop not null;
alter table invoice_diff_settlements drop constraint if exists diff_photo_required;
alter table invoice_diff_settlements add constraint diff_photo_required check (photo_id is not null or payment_id is not null);
drop trigger if exists c_photo on payments;
create trigger c_photo after insert on payments for each row when (new.photo_id is not null) execute function trg_claim_photo('photo_id');
drop trigger if exists c_photo on waw_loans;
create trigger c_photo after insert on waw_loans for each row when (new.photo_id is not null) execute function trg_claim_photo('photo_id');
drop trigger if exists c_photo on invoice_diff_settlements;
create trigger c_photo after insert on invoice_diff_settlements for each row when (new.photo_id is not null) execute function trg_claim_photo('photo_id');

-- a settlement booked by an adjustment payment skips the "difference to settle" check only in amount terms — still guarded
-- (the payment function checks the pending difference before inserting)

-- payment rules: adjustment lines must name a source invoice of the same distributor with enough pending difference
create or replace function trg_payment_check() returns trigger language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype; src invoices%rowtype; paid numeric; k account_kind; n int;
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
  if k::text = 'adjustment' then
    if new.adjust_from_invoice_id is null then raise exception 'say which invoice difference is being adjusted' using errcode = 'PA060'; end if;
    select * into src from invoices where id = new.adjust_from_invoice_id;
    if src.id is null or src.distributor_id <> inv.distributor_id then raise exception 'the adjusted difference must belong to the same distributor' using errcode = 'PA060'; end if;
    if src.id = inv.id then raise exception 'an invoice cannot adjust against itself' using errcode = 'PA060'; end if;
    if invoice_diff(src.id) - invoice_diff_settled(src.id) < new.amount then
      raise exception 'only % of difference is pending on invoice %', invoice_diff(src.id) - invoice_diff_settled(src.id), src.invoice_no using errcode = 'PA061';
    end if;
  elsif new.adjust_from_invoice_id is not null then
    raise exception 'adjust_from_invoice_id is only for adjustment lines' using errcode = 'PA060';
  end if;
  if k = 'cash_drawer' and new.cash_source = 'not_cash' then new.cash_source := 'today'; end if;
  if k <> 'cash_drawer' then new.cash_source := 'not_cash'; end if;
  if k = 'owner_personal' and new.requested_by is null then new.requested_by := auth.uid(); end if;
  return new;
end $$;

-- after a payment: owner alert (personal account), WAW loan booked (WAW source), difference settled (adjustment), reminders done
create or replace function trg_payment_after() returns trigger language plpgsql security definer set search_path = public as $$
declare k account_kind; inv invoices%rowtype; dname text;
begin
  select kind into k from accounts where id = new.account_id;
  select * into inv from invoices where id = new.invoice_id;
  select name into dname from distributors where id = inv.distributor_id;
  if k = 'owner_personal' then
    perform notify_owners('owner_paid_request', format('Paid from your account · %s', dname),
      format('Invoice %s · Rs %s · requested by %s', inv.invoice_no, new.amount, (select name from profiles where id = new.requested_by)), 'payments', new.id);
  elsif k = 'waw_fs' then
    insert into waw_loans(day, kind, amount, account_id, note, payment_id, entered_by, device)
    values (new.day, 'borrow', new.amount, new.account_id, format('Paid to %s · Inv %s', dname, inv.invoice_no), new.id, new.entered_by, new.device);
    perform notify_owners('waw_outstanding', format('Borrowed from WAW F/S · Rs %s', new.amount),
      format('Paid straight to %s for invoice %s. WAW F/S is now owed %s.', dname, inv.invoice_no, waw_outstanding()), 'waw_loans', null);
  elsif k::text = 'adjustment' then
    insert into invoice_diff_settlements(invoice_id, day, kind, amount, note, payment_id, entered_by, device)
    values (new.adjust_from_invoice_id, new.day, 'adjusted', new.amount, format('Adjusted in invoice %s', inv.invoice_no), new.id, new.entered_by, new.device);
  end if;
  if invoice_paid(inv.id) >= inv.amount then
    update reminders set done_at = now() where invoice_id = inv.id and done_at is null;
  end if;
  return null;
end $$;

-- the adjustment settlement check must not double-count the line being inserted
create or replace function trg_diff_settlement_check() returns trigger language plpgsql as $$
declare d numeric; s numeric;
begin
  d := invoice_diff(new.invoice_id); s := invoice_diff_settled(new.invoice_id);
  if d <= 0 then raise exception 'this invoice has no posting difference to settle' using errcode = 'PA041'; end if;
  if s + new.amount > d then raise exception 'settles more than the difference (% left)', d - s using errcode = 'PA041'; end if;
  return new;
end $$;

-- record_payment: note + adjustment source; sets the invoice due date when a remainder stays pending
drop function if exists record_payment(uuid, date, numeric, uuid, cash_source, uuid, uuid);
drop function if exists record_payment_impl(uuid, date, numeric, uuid, cash_source, uuid, uuid);
create or replace function record_payment_impl(p_invoice uuid, p_day date, p_amount numeric, p_account uuid, p_cash_source cash_source, p_photo uuid, p_requested_by uuid, p_note text, p_adjust_from uuid)
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
  insert into payments(invoice_id, day, amount, account_id, cash_source, photo_id, requested_by, note, adjust_from_invoice_id, entered_by, device)
  values (p_invoice, p_day, p_amount, p_account, p_cash_source, p_photo, p_requested_by, nullif(trim(coalesce(p_note, '')), ''), p_adjust_from, auth.uid(), current_device())
  returning * into pay;
  return jsonb_build_object('blocked', false, 'payment', to_jsonb(pay));
end $$;
create or replace function record_payment(p_invoice uuid, p_day date, p_amount numeric, p_account uuid, p_cash_source cash_source, p_photo uuid, p_requested_by uuid default null, p_note text default null, p_adjust_from uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.internal', '1', true);
  return record_payment_impl(p_invoice, p_day, p_amount, p_account, p_cash_source, p_photo, p_requested_by, p_note, p_adjust_from);
end $$;
revoke execute on function record_payment_impl(uuid, date, numeric, uuid, cash_source, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function record_payment(uuid, date, numeric, uuid, cash_source, uuid, uuid, text, uuid) to authenticated;

-- pending remainder: due date on the invoice + a daily reminder to everyone until it is paid
create or replace function set_invoice_due(p_invoice uuid, p_due date) returns void language plpgsql security definer set search_path = public as $$
declare inv invoices%rowtype; rem numeric;
begin
  if my_role() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into inv from invoices where id = p_invoice;
  if inv.id is null then raise exception 'invoice not found' using errcode = 'PA023'; end if;
  rem := inv.amount - invoice_paid(inv.id);
  if rem <= 0 then raise exception 'invoice is fully paid' using errcode = 'PA062'; end if;
  perform set_config('app.system_action', 'due_date', true);
  update invoices set next_due = p_due where id = p_invoice;
  perform set_config('app.system_action', '', true);
  update reminders set done_at = now() where invoice_id = p_invoice and done_at is null;
  insert into reminders(invoice_id, title, amount, remind_at, notify_all, repeat_daily, created_by)
  values (p_invoice, format('Pay %s · Inv %s · %s pending', (select name from distributors where id = inv.distributor_id), inv.invoice_no, rem), rem, p_due::timestamptz, true, true, auth.uid());
end $$;
grant execute on function set_invoice_due(uuid, date) to authenticated;

-- owner corrections may touch the note
create or replace function owner_edit(p_table text, p_id uuid, p_patch jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare allowed jsonb := '{
  "invoices": ["invoice_no","invoice_date","amount","note","installments_planned","next_due","distributor_id"],
  "payments": ["amount","account_id","cash_source","day","note"],
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
