-- Rule tests for the Pro Aid database. Run with: psql ... -v ON_ERROR_STOP=1 -f tests/01_rules.sql
-- Each block asserts one rule the owner asked for. A failing assertion raises and stops the run.
\set ON_ERROR_STOP on
\set QUIET on

create or replace function t_expect_error(sql text, want_code text, label text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlstate = want_code then
      raise notice 'PASS  % (blocked with %: %)', label, sqlstate, sqlerrm;
      return;
    else
      raise exception 'FAIL  %: expected % but got % (%)', label, want_code, sqlstate, sqlerrm;
    end if;
  end;
  raise exception 'FAIL  %: expected error % but it succeeded', label, want_code;
end $$;

create or replace function t_ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond then raise notice 'PASS  %', label; else raise exception 'FAIL  %', label; end if;
end $$;

-- RLS hides rows from staff, so their UPDATE/DELETE touches nothing (no error, zero rows)
create or replace function t_no_rows(sql text, label text) returns void language plpgsql as $$
declare n int;
begin
  execute 'with r as (' || sql || ' returning 1) select count(*) from r' into n;
  if n = 0 then raise notice 'PASS  % (0 rows affected)', label; else raise exception 'FAIL  %: % rows affected', label, n; end if;
end $$;

create or replace function t_as(uid uuid, dev text default 'test device') returns void language sql as $$
  select set_config('app.uid', uid::text, false), set_config('app.device', dev, false), set_config('app.reason', '', false),
         set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false)
$$;

-- fresh photo helper: every entry needs its own proof
create or replace function t_photo(uid uuid) returns uuid language plpgsql as $$
declare pid uuid;
begin
  insert into photos(storage_path, taken_by, device) values ('test/' || gen_random_uuid(), uid, 'test') returning id into pid;
  return pid;
end $$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
insert into auth.users(id, phone) values
  ('00000000-0000-0000-0000-000000000001', '03000000001'),
  ('00000000-0000-0000-0000-000000000002', '03000000002'),
  ('00000000-0000-0000-0000-000000000003', '03000000003');
insert into profiles(id, name, role, phone) values
  ('00000000-0000-0000-0000-000000000001', 'Ayan', 'owner', '03000000001'),
  ('00000000-0000-0000-0000-000000000002', 'Bilal', 'manager', '03000000002'),
  ('00000000-0000-0000-0000-000000000003', 'Ahmed', 'cashier', '03000000003');

\set owner '''00000000-0000-0000-0000-000000000001'''
\set manager '''00000000-0000-0000-0000-000000000002'''
\set cashier '''00000000-0000-0000-0000-000000000003'''

-- run the rest as a non-superuser so RLS applies
create role app_user login;
grant usage on schema public, auth to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;
grant execute on all functions in schema public to app_user;
grant execute on all functions in schema auth to app_user;
set role app_user;

-- ---------------------------------------------------------------------------
-- reference rows (owner)
-- ---------------------------------------------------------------------------
select t_as(:owner, 'Windows laptop');
insert into distributors(name) values ('Getz Pharma'), ('Muller & Phipps');
insert into customers(name, phone) values ('Rashid Ali', '03012223344');

-- ---------------------------------------------------------------------------
-- 1. photo is mandatory, and one photo proves one entry only
-- ---------------------------------------------------------------------------
select t_as(:cashier, 'Own Android');
select t_expect_error(
  $q$ insert into invoices(distributor_id, invoice_no, day, amount, photo_id)
      values ((select id from distributors where name='Getz Pharma'), '55120', '2026-09-01', 53800, null) $q$,
  '23502', 'invoice without photo is rejected');

select set_config('t.photo1', t_photo(:cashier)::text, false);
insert into invoices(distributor_id, invoice_no, day, amount, photo_id)
  values ((select id from distributors where name='Getz Pharma'), '55120', '2026-09-01', 53800, current_setting('t.photo1')::uuid);
select t_ok((select used_by_table from photos where id = current_setting('t.photo1')::uuid) = 'invoices', 'photo is claimed by the invoice');

select t_expect_error(
  $q$ insert into invoices(distributor_id, invoice_no, day, amount, photo_id)
      values ((select id from distributors where name='Muller & Phipps'), '88213', '2026-09-01', 22400, current_setting('t.photo1')::uuid) $q$,
  '23505', 'reusing a photo for a second entry is rejected');

-- ---------------------------------------------------------------------------
-- 2. entries are stamped with who and which device; staff cannot edit or delete
-- ---------------------------------------------------------------------------
select t_ok((select entered_by = :cashier::uuid and device = 'Own Android' from invoices where invoice_no='55120'), 'invoice stamped with cashier and device');
select t_no_rows($q$ update invoices set amount = 1 where invoice_no='55120' $q$, 'cashier cannot edit an entry');
select t_no_rows($q$ delete from invoices where invoice_no='55120' $q$, 'cashier cannot delete an entry');
select t_ok((select amount from invoices where invoice_no='55120') = 53800, 'invoice unchanged after staff attempts');
select t_as(:manager, 'Pharmacy Android');
select t_no_rows($q$ update invoices set amount = 1 where invoice_no='55120' $q$, 'manager cannot edit an entry');

-- owner must give a reason; both versions land in the audit log
select t_as(:owner, 'Windows laptop');
select t_expect_error($q$ update invoices set note = 'x' where invoice_no='55120' $q$, 'PA002', 'owner edit without reason is rejected');
begin;
select set_config('app.reason', 'wrong note', true);
update invoices set note = 'corrected' where invoice_no='55120';
commit;
select t_ok((select count(*) from audit_log where table_name='invoices' and action='update' and reason='wrong note' and before is not null and after is not null) = 1, 'owner edit logged with before, after and reason');

-- ---------------------------------------------------------------------------
-- 3. duplicate invoice number, payments never exceed, installments numbered, duplicate payment blocked + owner notified
-- ---------------------------------------------------------------------------
select t_as(:cashier, 'Own Android');
select t_expect_error(
  $q$ insert into invoices(distributor_id, invoice_no, day, amount, photo_id)
      values ((select id from distributors where name='Getz Pharma'), '55120', '2026-09-02', 100, t_photo('00000000-0000-0000-0000-000000000003')) $q$,
  '23505', 'same distributor + invoice number twice is rejected');

insert into payments(invoice_id, day, amount, account_id, cash_source, photo_id)
  values ((select id from invoices where invoice_no='55120'), '2026-09-07', 27400, (select id from accounts where kind='cash_drawer'), 'yesterday', t_photo(:cashier));
select t_ok((select installment_no from payments where amount=27400) = 1, 'first payment is installment 1');
select t_ok((select remaining from v_invoice_status where invoice_no='55120') = 26400, 'remaining is 26,400 after 27,400');

select t_expect_error(
  $q$ insert into payments(invoice_id, day, amount, account_id, photo_id)
      values ((select id from invoices where invoice_no='55120'), '2026-09-07', 30000, (select id from accounts where kind='cash_drawer'), t_photo('00000000-0000-0000-0000-000000000003')) $q$,
  'PA007', 'paying more than remaining is rejected');

select t_ok(payment_warning((select id from invoices where invoice_no='55120'), 27400, '2026-09-07') is not null, 'same amount same distributor same day raises a warning');

insert into payments(invoice_id, day, amount, account_id, photo_id)
  values ((select id from invoices where invoice_no='55120'), '2026-09-08', 26400, (select id from accounts where name='UBL account'), t_photo(:cashier));
select t_ok((select installment_no from payments where amount=26400) = 2, 'second payment is installment 2');
select t_ok((select remaining from v_invoice_status where invoice_no='55120') = 0, 'invoice fully paid');

select t_expect_error(
  $q$ insert into payments(invoice_id, day, amount, account_id, photo_id)
      values ((select id from invoices where invoice_no='55120'), '2026-09-08', 100, (select id from accounts where kind='cash_drawer'), t_photo('00000000-0000-0000-0000-000000000003')) $q$,
  'PA006', 'paying a fully paid invoice again is blocked (direct insert)');
select t_ok((record_payment((select id from invoices where invoice_no='55120'), '2026-09-08', 100, (select id from accounts where kind='cash_drawer'), 'today', t_photo(:cashier)))->>'blocked' = 'true', 'record_payment reports the duplicate as blocked');
select t_ok((select count(*) from payments where invoice_id = (select id from invoices where invoice_no='55120')) = 2, 'no third payment was saved');
select t_as(:owner);
select t_ok((select count(*) from notifications where kind='duplicate_blocked' and user_id = :owner::uuid) = 1, 'owner notified of the blocked duplicate');
select t_ok((select count(*) from audit_log where action='blocked') = 1, 'blocked attempt is in the audit log');

-- ---------------------------------------------------------------------------
-- 4. daily sale split, cash part, closing formula, minus alert, closing immutable
-- ---------------------------------------------------------------------------
select t_as(:manager, 'Pharmacy Android');
select t_no_rows($q$ update business_days set opening_cash = 1 where day='2026-09-07' $q$, 'manager cannot change opening cash (owner only)');
select t_as(:owner, 'Windows laptop');
update business_days set opening_cash = 52800 where day = '2026-09-07';
select t_as(:manager, 'Pharmacy Android');
insert into daily_sales(day, pos_total, credit_total, photo_id) values ('2026-09-07', 104350, 2500, t_photo(:manager));
insert into daily_sale_lines(daily_sale_id, account_id, amount, photo_id) values
  ((select id from daily_sales where day='2026-09-07'), (select id from accounts where name='HBL card machine'), 3200, t_photo(:manager)),
  ((select id from daily_sales where day='2026-09-07'), (select id from accounts where name='UBL card machine'), 2100, t_photo(:manager)),
  ((select id from daily_sales where day='2026-09-07'), (select id from accounts where name='Alfalah card machine'), 1200, t_photo(:manager)),
  ((select id from daily_sales where day='2026-09-07'), (select id from accounts where name='EasyPaisa'), 2500, t_photo(:manager)),
  ((select id from daily_sales where day='2026-09-07'), (select id from accounts where name='JazzCash'), 1500, t_photo(:manager));
select t_ok(sale_cash_part((select id from daily_sales where day='2026-09-07')) = 91350, 'cash part of the sale is 91,350');
select t_expect_error(
  $q$ insert into daily_sale_lines(daily_sale_id, account_id, amount, photo_id) values
      ((select id from daily_sales where day='2026-09-07'), (select id from accounts where name='SadaPay'), 999999, t_photo('00000000-0000-0000-0000-000000000002')) $q$,
  'PA005', 'card/online/credit exceeding the POS total is rejected');
select t_expect_error(
  $q$ insert into daily_sale_lines(daily_sale_id, account_id, amount, photo_id) values
      ((select id from daily_sales where day='2026-09-07'), (select id from accounts where kind='cash_drawer'), 5, t_photo('00000000-0000-0000-0000-000000000002')) $q$,
  'PA004', 'cash drawer cannot be a sale line');

-- credit collection in cash, an expense in cash
insert into customer_credit_collections(customer_id, day, amount, account_id, photo_id)
  values ((select id from customers where name='Rashid Ali'), '2026-09-07', 1200, (select id from accounts where kind='cash_drawer'), t_photo(:manager));
select t_as(:cashier, 'Own Android');
insert into expenses(day, category_id, amount, note, account_id, photo_id)
  values ('2026-09-07', (select id from expense_categories where name='Bike fuel'), 4250, 'fuel', (select id from accounts where kind='cash_drawer'), t_photo(:cashier));

-- expected = 52,800 + 91,350 + 1,200 - 27,400 - 4,250 = 1,13,700
select t_ok((select expected_cash from cash_book('2026-09-07')) = 113700, 'drawer should hold 1,13,700');

-- cashier cannot close; manager can; minus alerts owner
select t_expect_error($q$ select submit_closing('2026-09-07', 113000, t_photo('00000000-0000-0000-0000-000000000003')) $q$, '42501', 'cashier cannot submit a closing');
select t_as(:manager, 'Pharmacy Android');
-- posting check: an unposted invoice without today's reason blocks the closing
select t_expect_error($q$ select submit_closing('2026-09-07', 114640, t_photo('00000000-0000-0000-0000-000000000002')) $q$, 'PA034', 'closing waits for unposted invoices');
select t_ok((select count(*) from closing_blockers('2026-09-07')) = 1, 'one invoice blocks the closing');
select t_expect_error($q$ select give_unposted_reason((select id from invoices where invoice_no='55120'), '2026-09-07', '  ') $q$, 'PA042', 'unposted reason cannot be blank');
select give_unposted_reason((select id from invoices where invoice_no='55120'), '2026-09-07', 'stock check still pending');
select t_ok((select count(*) from closing_blockers('2026-09-07')) = 0, 'reason given for today clears the block');
select t_ok((select count(*) from closing_blockers('2026-09-08')) = 1, 'the same invoice is asked about again at the next closing');
select t_ok((select unposted_reason_by_name from v_invoice_status where invoice_no='55120') = 'Bilal', 'reason records who gave it');
select submit_closing('2026-09-07', 114640, t_photo(:manager));
select t_ok((select difference from closings where day='2026-09-07') = 940, 'difference is +940');
select t_ok((select status from business_days where day='2026-09-07') = 'closed', 'day is closed');
select t_ok((select opening_cash from business_days where day='2026-09-08') = 114640, 'next day opens with the counted cash');
select t_as(:owner);
select t_ok((select count(*) from notifications where kind='closing_submitted') = 1, 'owner notified of the closing');
select t_no_rows($q$ update closings set counted_cash = 1 where day='2026-09-07' $q$, 'a closing cannot be edited even by the owner');
select t_no_rows($q$ delete from closings where day='2026-09-07' $q$, 'a closing cannot be deleted even by the owner');
select t_ok((select counted_cash from closings where day='2026-09-07') = 114640, 'closing unchanged');
select t_expect_error($q$ select submit_closing('2026-09-07', 1, t_photo('00000000-0000-0000-0000-000000000001')) $q$, '23505', 'a second closing for the same day is rejected');

-- ---------------------------------------------------------------------------
-- 5. approve & lock; locked day rejects everything; unlock needs a reason and is logged
-- ---------------------------------------------------------------------------
select t_as(:manager);
select t_expect_error($q$ select approve_day('2026-09-07') $q$, '42501', 'manager cannot approve a day');
select t_as(:owner, 'Windows laptop');
select approve_day('2026-09-07');
select t_ok(day_is_locked('2026-09-07'), 'day is locked');
select t_as(:cashier, 'Own Android');
select t_expect_error(
  $q$ insert into expenses(day, category_id, amount, account_id, photo_id)
      values ('2026-09-07', (select id from expense_categories where name='Other'), 10, (select id from accounts where kind='cash_drawer'), t_photo('00000000-0000-0000-0000-000000000003')) $q$,
  'PA001', 'no new entry on a locked day');
select t_as(:owner);
begin;
select set_config('app.reason', 'try', true);
select t_expect_error($q$ update expenses set amount = 1 where day='2026-09-07' $q$, 'PA001', 'owner cannot edit inside a locked day');
rollback;
select t_expect_error($q$ select unlock_day('2026-09-07', '') $q$, 'PA002', 'unlock without reason is rejected');
select unlock_day('2026-09-07', 'manager counted a note twice');
select t_ok(not day_is_locked('2026-09-07'), 'day unlocked');
select t_ok((select count(*) from closings where day='2026-09-07') = 0, 'old closing removed so it can be redone');
select t_ok((select count(*) from audit_log where action='unlock' and table_name='closings' and before is not null) = 1, 'old closing kept in the audit log');

-- ---------------------------------------------------------------------------
-- 6. staff accounts owner-only; WAW loans; owner-paid settlements; non-cash pool
-- ---------------------------------------------------------------------------
select t_as(:manager);
select t_expect_error(
  $q$ insert into staff_entries(staff_id, day, kind, amount, photo_id) values ('00000000-0000-0000-0000-000000000003', '2026-09-08', 'advance_sale_cash', 5000, t_photo('00000000-0000-0000-0000-000000000002')) $q$,
  '42501', 'manager cannot add a staff advance');
select t_as(:owner);
insert into staff_entries(staff_id, day, kind, amount, photo_id) values (:cashier, '2026-09-08', 'advance_sale_cash', 5000, t_photo(:owner));
insert into staff_entries(staff_id, day, kind, amount, photo_id, bill_no) values (:cashier, '2026-09-08', 'medicine_credit', 1350, t_photo(:owner), '4471');
insert into staff_entries(staff_id, day, kind, amount, photo_id) values (:cashier, '2026-09-08', 'salary_deduction', 2000, t_photo(:owner));
select t_ok((select owed from v_staff_balance where id = :cashier::uuid) = 4350, 'staff owes 4,350');
select t_as(:cashier);
select t_ok((select count(*) from staff_entries) = 3, 'cashier can see own staff entries');
select t_as(:manager);
select t_ok((select count(*) from staff_entries where kind <> 'medicine_credit') = 0, 'manager cannot see another staff member''s advances');
select t_ok((select count(*) from staff_entries where kind = 'medicine_credit') = 1, 'manager can see medicine-on-credit entries (they record them in the sale)');

-- WAW
select t_as(:cashier, 'Own Android');
select t_expect_error(
  $q$ insert into waw_loans(day, kind, amount, account_id, photo_id) values ('2026-09-08', 'repay', 100, (select id from accounts where kind='cash_drawer'), t_photo('00000000-0000-0000-0000-000000000003')) $q$,
  'PA008', 'cannot repay WAW more than owed');
insert into waw_loans(day, kind, amount, account_id, handled_by, photo_id) values ('2026-09-08', 'borrow', 40000, (select id from accounts where kind='cash_drawer'), 'Ahmed', t_photo(:cashier));
insert into waw_loans(day, kind, amount, account_id, handled_by, photo_id) values ('2026-09-08', 'repay', 5000, (select id from accounts where kind='cash_drawer'), 'Bilal', t_photo(:cashier));
select t_ok(waw_outstanding() = 35000, 'WAW outstanding is 35,000');
select t_ok((select waw_borrowed_cash - waw_repaid_cash from cash_book('2026-09-08')) = 35000, 'WAW cash movement is in the cash book');
select t_as(:owner);
select run_daily_jobs();
select t_ok((select count(*) from notifications where kind='waw_outstanding') = 1, 'owner gets the WAW daily reminder');

-- owner-paid invoice and settlement against receipts
select t_as(:cashier, 'Own Android');
insert into invoices(distributor_id, invoice_no, day, amount, photo_id)
  values ((select id from distributors where name='Muller & Phipps'), '30412', '2026-09-08', 28500, t_photo(:cashier));
insert into payments(invoice_id, day, amount, account_id, photo_id)
  values ((select id from invoices where invoice_no='30412'), '2026-09-08', 28500, (select id from accounts where kind='owner_personal'), t_photo(:cashier));
select t_ok((select requested_by from payments where amount=28500) = :cashier::uuid, 'owner-paid request records who asked');
select t_as(:owner);
select t_ok((select count(*) from notifications where kind='owner_paid_request') = 1, 'owner notified of the personal-account payment');
select t_ok((select unsettled from v_owner_paid where invoice_no='30412') = 28500, 'owed to owner is 28,500');
select t_expect_error(
  $q$ insert into owner_settlements(payment_id, day, kind, account_id, amount, photo_id)
      values ((select payment_id from v_owner_paid where invoice_no='30412'), '2026-09-08', 'minus_receipts', (select id from accounts where kind='cash_drawer'), 100, t_photo('00000000-0000-0000-0000-000000000001')) $q$,
  'PA011', 'minus must come from a card machine, wallet or bank');
insert into owner_settlements(payment_id, day, kind, account_id, amount, photo_id)
  values ((select payment_id from v_owner_paid where invoice_no='30412'), '2026-09-08', 'minus_receipts', (select id from accounts where name='UBL card machine'), 28500, t_photo(:owner));
select t_ok((select unsettled from v_owner_paid where invoice_no='30412') = 0, 'settled in full by minusing from UBL machine');
select t_expect_error(
  $q$ insert into owner_settlements(payment_id, day, kind, account_id, amount, photo_id)
      values ((select payment_id from v_owner_paid where invoice_no='30412'), '2026-09-08', 'cash_return', null, 1, t_photo('00000000-0000-0000-0000-000000000001')) $q$,
  'PA010', 'cannot settle more than the payment');
select t_ok((select received from non_cash_pool('2026-09-01','2026-09-30') where account_name='UBL card machine') = 2100, 'non-cash pool shows UBL machine receipts');
select t_ok((select minused from non_cash_pool('2026-09-01','2026-09-30') where account_name='UBL card machine') = 28500, 'non-cash pool shows the minus');

-- ---------------------------------------------------------------------------
-- 7. reminders, posted-in-POS, distributor balance view
-- ---------------------------------------------------------------------------
select t_as(:cashier);
insert into reminders(invoice_id, title, amount, remind_at, notify_all) values ((select id from invoices where invoice_no='30412'), 'Pay M&P', 1000, now() - interval '1 minute', true);
select t_as(:owner);
select run_daily_jobs();
select t_ok((select count(*) from reminders where done_at is null) = 1, 'reminder set (invoice was paid before reminder existed, so still open)');
select t_ok((select count(*) from notifications where kind='payment_reminder' and user_id = :owner::uuid) = 1, 'reminder fired to owner');
select t_as(:cashier);
select t_ok((select count(*) from notifications where kind='payment_reminder' and user_id = :cashier::uuid) = 1, 'reminder fired to cashier too (notify all)');
select t_expect_error($q$ select mark_posted((select id from invoices where invoice_no='30412')) $q$, '42501', 'cashier cannot mark posted in POS');
select t_as(:manager);
select mark_posted((select id from invoices where invoice_no='30412'));
select t_ok((select posted_in_pos and posted_amount = amount from invoices where invoice_no='30412'), 'manager marked invoice posted in POS at the full amount');
-- 55120 (53,800, fully paid) posts at 51,800: two items short → 2,000 difference the distributor owes
select t_expect_error($q$ select mark_posted((select id from invoices where invoice_no='55120'), 51800) $q$, 'PA040', 'a lower posted amount needs a reason');
select mark_posted((select id from invoices where invoice_no='55120'), 51800, 'short_items', 'two packs of Panadol missing');
select t_ok((select post_diff from v_invoice_status where invoice_no='55120') = 2000 and (select diff_pending from v_invoice_status where invoice_no='55120') = 2000, 'posting difference of 2,000 recorded');
select t_ok((select diff_pending from v_distributor_balance where name='Getz Pharma') = 2000, 'distributor owes the difference');
select t_as(:owner);
select t_ok((select count(*) from notifications where kind='unposted_invoice' and title like 'Posted with a difference%' and user_id = :owner::uuid) = 1, 'owner alerted about the difference');
select t_as(:manager);
select t_expect_error($q$ insert into invoice_diff_settlements(invoice_id, day, kind, amount, photo_id) values ((select id from invoices where invoice_no='55120'), '2026-09-09', 'goods_received', 2500, t_photo('00000000-0000-0000-0000-000000000002')) $q$, 'PA041', 'cannot settle more than the difference');
insert into invoice_diff_settlements(invoice_id, day, kind, amount, photo_id) values ((select id from invoices where invoice_no='55120'), '2026-09-09', 'goods_received', 2000, t_photo(:manager));
select t_ok((select diff_pending from v_distributor_balance where name='Getz Pharma') = 0, 'difference settled when the goods arrive');
select t_ok((range_summary('2026-09-01','2026-09-30')->>'distributor_diff_pending')::numeric = 0, 'reports show no pending difference');
select t_ok((select pending from v_distributor_balance where name='Getz Pharma') = 0 and (select pending from v_distributor_balance where name='Muller & Phipps') = 0, 'distributor balances are zero after full payment');

reset role;
select 'ALL RULE TESTS PASSED' as result;

-- ---------------------------------------------------------------------------
-- 8. owner_edit / owner_delete / range_summary
-- ---------------------------------------------------------------------------
set role app_user;
select t_as(:manager);
select t_expect_error($q$ select owner_edit('expenses', (select id from expenses limit 1), '{"amount": 1}', 'x') $q$, '42501', 'manager cannot use owner_edit');
select t_as(:owner);
select t_expect_error($q$ select owner_edit('expenses', (select id from expenses limit 1), '{"amount": 1}', '') $q$, 'PA002', 'owner_edit needs a reason');
select t_expect_error($q$ select owner_edit('expenses', (select id from expenses limit 1), '{"entered_by": "00000000-0000-0000-0000-000000000001"}', 'r') $q$, 'PA021', 'owner_edit cannot change who entered it');
select t_ok((owner_edit('expenses', (select id from expenses limit 1), '{"amount": 1500}', 'typed 4250 by mistake')->>'amount')::numeric = 1500, 'owner_edit changes the amount');
select t_ok((select count(*) from audit_log where table_name='expenses' and action='update' and reason='typed 4250 by mistake') = 1, 'owner_edit is audited with the reason');
select t_ok((range_summary('2026-09-01','2026-09-30')->>'expenses')::numeric = 1500, 'range summary reflects the correction');
select t_ok((range_summary('2026-09-01','2026-09-30')->>'owed_to_waw')::numeric = 35000, 'range summary shows WAW owed');
reset role;
select 'ALL RULE TESTS PASSED (incl. api)' as result;

-- ---------------------------------------------------------------------------
-- 9. staff without login · credit lines in the sale · count-first
-- ---------------------------------------------------------------------------
set role app_user;
select t_as(:manager);
select t_expect_error($q$ select add_staff_member('Salman (helper)') $q$, '42501', 'manager cannot add a staff member');
select t_as(:owner);
select t_expect_error($q$ select add_staff_member('   ') $q$, 'PA030', 'staff member needs a name');
select t_ok((select role::text = 'staff' and has_login = false and phone is null from add_staff_member('Salman (helper)', '')), 'owner adds a staff member with no login');
select t_ok((select count(*) from v_staff_balance where name = 'Salman (helper)') = 1, 'staff member without login appears in the staff ledger');
select t_ok((select count(*) from v_staff_balance where role::text = 'owner') = 0, 'owner is not listed as staff');
-- notify_everyone skips accounts that cannot sign in
select notify_everyone('payment_reminder', 't', 'b', null, null);
select t_ok((select count(*) from notifications where title = 't' and user_id = (select id from profiles where name = 'Salman (helper)')) = 0, 'no notifications for accounts without a login');
-- the manager records medicine on credit for the staff member as part of the sale
select t_as(:manager);
insert into daily_sales(day, pos_total, credit_total, photo_id) values ('2026-09-10', 50000, 4000, t_photo(:manager));
insert into staff_entries(staff_id, day, kind, amount, bill_total, bill_no, photo_id, sale_id)
  values ((select id from profiles where name = 'Salman (helper)'), '2026-09-10', 'medicine_credit', 1500, 2100, 'S-1', t_photo(:manager), (select id from daily_sales where day = '2026-09-10'));
select t_expect_error($q$ insert into staff_entries(staff_id, day, kind, amount, photo_id)
  values ((select id from profiles where name = 'Salman (helper)'), '2026-09-10', 'advance_sale_cash', 500, t_photo('00000000-0000-0000-0000-000000000002')) $q$, '42501', 'manager still cannot give a cash advance');
insert into customer_credit_bills(customer_id, day, bill_no, amount, bill_total, photo_id, sale_id)
  values ((select id from customers where name = 'Rashid Ali'), '2026-09-10', 'C-77', 2500, 6000, t_photo(:manager), (select id from daily_sales where day = '2026-09-10'));
select t_expect_error($q$ insert into customer_credit_bills(customer_id, day, bill_no, amount, bill_total, photo_id)
  values ((select id from customers where name = 'Rashid Ali'), '2026-09-10', 'C-78', 2500, 2000, t_photo('00000000-0000-0000-0000-000000000002')) $q$, '23514', 'credit part cannot exceed the bill total');
select t_ok(sale_credit_entered((select id from daily_sales where day = '2026-09-10')) = 4000, 'credit lines add up to the sale credit total');
select t_ok((select owed from v_staff_balance where name = 'Salman (helper)') = 1500, 'staff member owes the medicine credit');
-- count-first: cash before the sale is opening ± the day''s cash movements
select t_ok(cash_before_sale('2026-09-07') = 52800 + 0 - 27400 + 0 - (select coalesce(sum(amount),0) from expenses where day='2026-09-07' and account_id = cash_drawer_id()) - (select coalesce(sum(amount),0) from staff_entries where day='2026-09-07' and kind in ('advance_sale_cash','advance_purchase_cash')) + (select coalesce(sum(amount),0) from waw_loans where day='2026-09-07' and kind='borrow' and account_id=cash_drawer_id()) - (select coalesce(sum(amount),0) from waw_loans where day='2026-09-07' and kind='repay' and account_id=cash_drawer_id()) - (select coalesce(sum(amount),0) from owner_settlements where day='2026-09-07' and kind='cash_return') + (select coalesce(sum(amount),0) from customer_credit_collections where day='2026-09-07' and account_id=cash_drawer_id()), 'cash before the sale matches the cash book');
select t_ok((select expected_cash from cash_book('2026-09-07')) = cash_before_sale('2026-09-07') + (select pos_cash_sale from cash_book('2026-09-07')), 'expected cash = cash before sale + cash sale');
reset role;
select 'ALL RULE TESTS PASSED (incl. staff & sale credit)' as result;

-- ---------------------------------------------------------------------------
-- 10. receipts through the day feed the sale
-- ---------------------------------------------------------------------------
set role app_user;
select t_as(:cashier, 'cashier phone');
insert into sale_receipts(day, account_id, amount, photo_id) values ('2026-09-12', (select id from accounts where name='HBL card machine'), 3000, t_photo(:cashier));
insert into sale_receipts(day, account_id, amount, note, photo_id) values ('2026-09-12', (select id from accounts where name='EasyPaisa'), 1250, 'Rashid', t_photo(:cashier));
insert into sale_receipts(day, account_id, amount, photo_id) values ('2026-09-12', (select id from accounts where name='HBL card machine'), 2000, t_photo(:cashier));
select t_expect_error($q$ insert into sale_receipts(day, account_id, amount, photo_id) values ('2026-09-12', cash_drawer_id(), 100, t_photo('00000000-0000-0000-0000-000000000003')) $q$, 'PA004', 'a receipt cannot go to the cash drawer');
select t_expect_error($q$ insert into sale_receipts(day, account_id, amount) values ('2026-09-12', (select id from accounts where name='HBL card machine'), 100) $q$, '23502', 'a receipt needs its photo');
select t_ok((select amount from day_receipts('2026-09-12') where account_id = (select id from accounts where name='HBL card machine')) = 5000, 'receipts add up per account');
select t_ok((select entered_by from sale_receipts limit 1) = :cashier and (select device from sale_receipts limit 1) = 'cashier phone', 'receipts are stamped with who and which device');
select t_no_rows($q$ update sale_receipts set amount = 1 $q$, 'cashier cannot change a receipt');
select t_as(:manager);
insert into daily_sales(day, pos_total, credit_total, photo_id) values ('2026-09-12', 40000, 0, t_photo(:manager));
select t_expect_error($q$ insert into daily_sale_lines(daily_sale_id, account_id, amount, photo_id) values ((select id from daily_sales where day='2026-09-12'), (select id from accounts where name='HBL card machine'), 5000, t_photo('00000000-0000-0000-0000-000000000002')) $q$, 'PA031', 'no end-of-day line on top of receipts for the same account');
insert into daily_sale_lines(daily_sale_id, account_id, amount, photo_id) values ((select id from daily_sales where day='2026-09-12'), (select id from accounts where name='JazzCash'), 750, t_photo(:manager));
select t_ok(sale_cash_part((select id from daily_sales where day='2026-09-12')) = 40000 - 5000 - 1250 - 750, 'cash part takes receipts and lines off the POS total');
select t_expect_error($q$ insert into sale_receipts(day, account_id, amount, photo_id) values ('2026-09-12', (select id from accounts where name='HBL card machine'), 100, t_photo('00000000-0000-0000-0000-000000000002')) $q$, 'PA032', 'no receipts after the sale is recorded');
select t_ok((select received from non_cash_pool('2026-09-12','2026-09-12') where account_name='HBL card machine') = 5000, 'non-cash pool counts receipts');
select t_ok((select sum((x->>'amount')::numeric) from jsonb_array_elements(range_summary('2026-09-12','2026-09-12')->'by_account') x) = 7000, 'range summary by account counts receipts and lines');
reset role;
select 'ALL RULE TESTS PASSED (incl. receipts)' as result;

-- ---------------------------------------------------------------------------
-- 11. note-by-note drawer count
-- ---------------------------------------------------------------------------
set role app_user;
select t_as(:manager);
select t_ok(denominations_total('{"5000": 2, "1000": 3, "500": 1, "20": 2, "1": 5}') = 13545, 'notes add up');
select t_expect_error($q$ select submit_closing('2026-09-12', 30000, t_photo('00000000-0000-0000-0000-000000000002'), null, '{"5000": 5}') $q$, 'PA033', 'notes must add up to the counted cash');
select t_ok((select denominations->>'5000' from submit_closing('2026-09-12', 30000, t_photo(:manager), null, '{"5000": 6}')) = '6', 'closing stores the note breakdown');
select t_ok((select (x->'denominations'->>'5000')::int from jsonb_array_elements(range_summary('2026-09-12','2026-09-12')->'closings') x) = 6, 'reports carry the breakdown');
reset role;
select 'ALL RULE TESTS PASSED (incl. denominations)' as result;

-- ---------------------------------------------------------------------------
-- 12. security hardening
-- ---------------------------------------------------------------------------
set role app_user;
select t_as(:cashier);
select t_expect_error($q$ select notify_users(array['00000000-0000-0000-0000-000000000001'::uuid], 'closing_submitted', 'fake', 'x', null, null) $q$, '42501', 'staff cannot forge a notification');
select t_expect_error($q$ select notify_owners('closing_minus', 'fake minus', 'x', null, null) $q$, '42501', 'staff cannot forge an owner alert');
select t_expect_error($q$ select run_daily_jobs() $q$, '42501', 'staff cannot run the daily jobs');
select t_expect_error($q$ select reset_login_pin('00000000-0000-0000-0000-000000000002', 'abcdefghijklmnopqrstuvwxyz') $q$, '42501', 'staff cannot reset a PIN');
select t_as(:owner);
select t_expect_error($q$ select reset_login_pin('00000000-0000-0000-0000-000000000001', 'abcdefghijklmnopqrstuvwxyz') $q$, 'PA050', 'owner changes own PIN elsewhere');
select reset_login_pin('00000000-0000-0000-0000-000000000002', 'abcdefghijklmnopqrstuvwxyz0123456789');
select t_ok((select count(*) from audit_log where action = 'reset_pin' and row_id = '00000000-0000-0000-0000-000000000002') = 1, 'PIN reset is audited');
reset role;
select t_ok((select encrypted_password = crypt('abcdefghijklmnopqrstuvwxyz0123456789', encrypted_password) from auth.users where id = '00000000-0000-0000-0000-000000000002'), 'new PIN stored as bcrypt like Supabase Auth');
-- anonymous role: only the setup check is callable
select t_ok(has_function_privilege('anon', 'setup_needed()', 'execute'), 'anon may check setup');
select t_ok(not has_function_privilege('anon', 'cash_book(date)', 'execute') and not has_function_privilege('anon', 'notify_users(uuid[], notification_kind, text, text, text, uuid)', 'execute') and not has_function_privilege('anon', 'range_summary(date, date)', 'execute'), 'anon cannot call the API');
select t_ok(not has_function_privilege('authenticated', 'record_payment_impl(uuid, date, numeric, uuid, cash_source, uuid, uuid, text, uuid)', 'execute'), 'internal implementations are not callable');
select t_ok((select bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'), 'row-level security is on for every table');
select 'ALL RULE TESTS PASSED (incl. security)' as result;

-- ---------------------------------------------------------------------------
-- 13. one invoice, several sources: owner account + WAW loan + adjustment + pending due date
-- ---------------------------------------------------------------------------
set role app_user;
select t_as(:manager);
insert into invoices(distributor_id, invoice_no, day, amount, photo_id) values ((select id from distributors where name='Getz Pharma'), '77001', '2026-09-13', 10000, t_photo(:manager));
insert into invoices(distributor_id, invoice_no, day, amount, photo_id) values ((select id from distributors where name='Getz Pharma'), '77002', '2026-09-13', 5000, t_photo(:manager));
insert into invoices(distributor_id, invoice_no, day, amount, photo_id) values ((select id from distributors where name='Muller & Phipps'), '77003', '2026-09-13', 8000, t_photo(:manager));
select mark_posted((select id from invoices where invoice_no='77001'), 9000, 'short_items', 'one pack missing');
select t_ok((select diff_pending from v_invoice_status where invoice_no='77001') = 1000, 'invoice 77001 carries a 1,000 difference');
-- 77002 (5,000): 1,000 adjusted against the 77001 difference, 2,500 from WAW F/S, rest pending
select t_expect_error($q$ select record_payment((select id from invoices where invoice_no='77002'), '2026-09-13', 1000, (select id from accounts where kind::text='adjustment'), 'not_cash', null, null, null, null) $q$, 'PA060', 'adjustment needs the source invoice');
select t_expect_error($q$ select record_payment((select id from invoices where invoice_no='77002'), '2026-09-13', 1000, (select id from accounts where kind::text='adjustment'), 'not_cash', null, null, null, (select id from invoices where invoice_no='77003')) $q$, 'PA060', 'adjustment must be the same distributor');
select t_expect_error($q$ select record_payment((select id from invoices where invoice_no='77002'), '2026-09-13', 1500, (select id from accounts where kind::text='adjustment'), 'not_cash', null, null, null, (select id from invoices where invoice_no='77001')) $q$, 'PA061', 'cannot adjust more than the pending difference');
select t_ok((record_payment((select id from invoices where invoice_no='77002'), '2026-09-13', 1000, (select id from accounts where kind::text='adjustment'), 'not_cash', null, null, 'short pack from last week', (select id from invoices where invoice_no='77001')))->>'blocked' = 'false', 'adjustment line saved without a photo');
select t_ok((select diff_pending from v_invoice_status where invoice_no='77001') = 0 and (select count(*) from invoice_diff_settlements where kind='adjusted' and payment_id is not null) = 1, 'the difference is settled by the adjustment');
select t_ok((select count(*) from payments where invoice_id = (select id from invoices where invoice_no='77002') and note = 'short pack from last week') = 1, 'payment note is stored');
select t_expect_error($q$ select record_payment((select id from invoices where invoice_no='77002'), '2026-09-13', 2500, (select id from accounts where kind='waw_fs'), 'not_cash', null) $q$, '23514', 'a WAW line needs its proof photo');
select set_config('t.waw_before', waw_outstanding()::text, false);
select t_ok((record_payment((select id from invoices where invoice_no='77002'), '2026-09-13', 2500, (select id from accounts where kind='waw_fs'), 'not_cash', t_photo(:manager), null, 'rep Kamran, transferred by WAW'))->>'blocked' = 'false', 'WAW F/S line saved');
select t_ok(waw_outstanding() = current_setting('t.waw_before')::numeric + 2500, 'WAW loan booked automatically for the WAW line');
select t_ok((select count(*) from waw_loans where payment_id is not null and kind='borrow' and amount=2500) = 1, 'the booked loan points at the payment');
select t_ok((select remaining from v_invoice_status where invoice_no='77002') = 1500, '1,500 still pending on 77002');
select set_invoice_due((select id from invoices where invoice_no='77002'), '2026-09-20');
select t_ok((select next_due from invoices where invoice_no='77002') = '2026-09-20' and (select count(*) from reminders where invoice_id=(select id from invoices where invoice_no='77002') and done_at is null and amount=1500 and repeat_daily) = 1, 'due date set with a daily reminder for the remainder');
select t_ok((record_payment((select id from invoices where invoice_no='77002'), '2026-09-13', 1500, (select id from accounts where kind='owner_personal'), 'not_cash', t_photo(:manager)))->>'blocked' = 'false', 'remainder paid from the owner account');
select t_ok((select count(*) from reminders where invoice_id=(select id from invoices where invoice_no='77002') and done_at is null) = 0, 'reminder closes itself once fully paid');
select t_ok((select expected_cash from cash_book('2026-09-13')) = (select opening_cash from business_days where day='2026-09-13'), 'none of these lines touched the drawer');
select t_expect_error($q$ select set_invoice_due((select id from invoices where invoice_no='77002'), '2026-09-21') $q$, 'PA062', 'no due date on a fully paid invoice');
reset role;
select 'ALL RULE TESTS PASSED (incl. multi-source payments)' as result;
