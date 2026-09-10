-- 0012 · owner delete: explain what is attached instead of a raw foreign-key error
-- An invoice with payments, a payment that booked a WAW loan / owner settlement / difference settlement,
-- cannot simply vanish — the owner is told exactly what to remove first (or to correct the entry instead).
-- Reminders hanging off a deleted invoice are removed with it (they carry no money).

create or replace function owner_delete(p_table text, p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare n int; n2 int; n3 int;
begin
  if not is_owner() then raise exception 'owner only' using errcode = '42501'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'a reason is required to delete a saved entry' using errcode = 'PA002'; end if;
  if p_table not in ('invoices','payments','expenses','daily_sale_lines','sale_receipts','invoice_diff_settlements','customer_credit_bills','customer_credit_collections','staff_entries','waw_loans','owner_settlements','reminders') then
    raise exception 'table % cannot be deleted from', p_table using errcode = 'PA020';
  end if;
  perform set_config('app.reason', p_reason, true);

  if p_table = 'invoices' then
    select count(*) into n from payments where invoice_id = p_id;
    select count(*) into n2 from payments where adjust_from_invoice_id = p_id;
    select count(*) into n3 from invoice_diff_settlements where invoice_id = p_id;
    if n > 0 then
      raise exception 'This invoice has % payment(s) recorded. Delete those payments first (Ledgers → distributor → payments), or just correct the amount with Edit instead of deleting.', n using errcode = 'PA024';
    end if;
    if n2 > 0 then
      raise exception 'A later payment adjusts a difference from this invoice. Delete that payment line first.' using errcode = 'PA024';
    end if;
    if n3 > 0 then
      raise exception 'This invoice has % difference settlement(s). Delete those first (Ledgers → distributor → differences).', n3 using errcode = 'PA024';
    end if;
    delete from reminders where invoice_id = p_id;
  elsif p_table = 'payments' then
    select count(*) into n from owner_settlements where payment_id = p_id;
    select count(*) into n3 from invoice_diff_settlements where payment_id = p_id;
    if n > 0 then
      raise exception 'This payment was already settled with the owner (% settlement(s)). Delete the settlement first (Ledgers → owner).', n using errcode = 'PA024';
    end if;
    -- the WAW loan and the difference settlement were booked automatically by this payment — remove them with it
    delete from invoice_diff_settlements where payment_id = p_id;
    delete from waw_loans where payment_id = p_id;
  elsif p_table = 'waw_loans' then
    if exists (select 1 from waw_loans where id = p_id and payment_id is not null) then
      raise exception 'This loan was booked by a distributor payment. Delete that payment instead — the loan goes with it.' using errcode = 'PA024';
    end if;
  end if;

  execute format('delete from %I where id = $1', p_table) using p_id;
exception
  when foreign_key_violation then
    raise exception 'This entry is still referenced by another entry — delete that one first.' using errcode = 'PA024';
end $$;
