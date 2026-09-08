import { supabase } from './supabase';

// ---- types (mirror the database) --------------------------------------------
export type Role = 'owner' | 'manager' | 'cashier' | 'staff';
export type Profile = { id: string; name: string; role: Role; phone: string | null; active: boolean; has_login: boolean; created_at: string };
export type AccountKind = 'cash_drawer' | 'card_machine' | 'wallet' | 'bank' | 'owner_personal' | 'waw_fs';
export type Account = { id: string; name: string; kind: AccountKind; provider: string | null; active: boolean; sort_order: number };
export type Distributor = { id: string; name: string; rep_name: string | null; phone: string | null; delivery_days: string | null; opening_balance: number; active: boolean };
export type DistributorBalance = { id: string; name: string; pending: number; open_invoices: number; oldest_open: string | null };
export type Customer = { id: string; name: string; phone: string | null; note: string | null; active: boolean };
export type CustomerBalance = { id: string; name: string; phone: string | null; owed: number; since: string | null };
export type ExpenseCategory = { id: string; name: string; active: boolean; sort_order: number };
export type BusinessDay = { day: string; opening_cash: number; status: 'open' | 'closed' | 'approved'; closed_by: string | null; closed_at: string | null; approved_by: string | null; approved_at: string | null };
export type DailySale = { id: string; day: string; pos_total: number; credit_total: number; photo_id: string; pos_source: 'pos' | 'count'; counted_cash: number | null; denominations: Record<string, number> | null; entered_by: string; device: string | null; created_at: string };
export type SaleReceipt = { id: string; day: string; account_id: string; amount: number; note: string | null; photo_id: string; entered_by: string; device: string | null; created_at: string };
export type DailySaleLine = { id: string; daily_sale_id: string; account_id: string; amount: number; photo_id: string };
export type Invoice = { id: string; distributor_id: string; invoice_no: string; invoice_date: string | null; day: string; amount: number; photo_id: string; posted_in_pos: boolean; posted_at: string | null; posted_by: string | null; installments_planned: number | null; next_due: string | null; note: string | null; entered_by: string; device: string | null; created_at: string };
export type InvoiceStatus = Invoice & { paid: number; remaining: number; payments_made: number; distributor_name: string };
export type Payment = { id: string; invoice_id: string; day: string; amount: number; account_id: string; cash_source: 'today' | 'yesterday' | 'not_cash'; installment_no: number | null; photo_id: string; requested_by: string | null; entered_by: string; device: string | null; created_at: string };
export type Expense = { id: string; day: string; category_id: string; amount: number; note: string | null; account_id: string; cash_source: string; photo_id: string; entered_by: string; device: string | null; created_at: string };
export type StaffEntryKind = 'advance_sale_cash' | 'advance_purchase_cash' | 'medicine_credit' | 'salary_deduction' | 'cash_repayment';
export type StaffEntry = { id: string; staff_id: string; day: string; kind: StaffEntryKind; amount: number; bill_total: number | null; bill_no: string | null; note: string | null; photo_id: string; sale_id: string | null; entered_by: string; created_at: string };
export type StaffBalance = { id: string; name: string; role: Role; has_login: boolean; active: boolean; owed: number };
export type WawLoan = { id: string; day: string; kind: 'borrow' | 'repay'; amount: number; account_id: string; handled_by: string | null; note: string | null; photo_id: string; entered_by: string; created_at: string };
export type OwnerPaid = { payment_id: string; day: string; amount: number; invoice_id: string; invoice_no: string; distributor_name: string; settled: number; unsettled: number; requested_by: string | null; photo_id: string };
export type OwnerSettlement = { id: string; payment_id: string; day: string; kind: 'cash_return' | 'minus_receipts'; account_id: string | null; amount: number; photo_id: string; created_at: string };
export type Closing = { id: string; day: string; expected_cash: number; counted_cash: number; difference: number; drawer_photo_id: string; note: string | null; denominations: Record<string, number> | null; closed_by: string; device: string | null; created_at: string };
export type CreditBill = { id: string; customer_id: string; day: string; bill_no: string; amount: number; bill_total: number | null; photo_id: string; sale_id: string | null; entered_by: string; created_at: string };
export type CreditCollection = { id: string; customer_id: string; bill_id: string | null; day: string; amount: number; account_id: string; photo_id: string; entered_by: string; created_at: string };
export type Reminder = { id: string; invoice_id: string | null; title: string; amount: number | null; remind_at: string; notify_all: boolean; repeat_daily: boolean; created_by: string; done_at: string | null; last_fired_at: string | null; created_at: string };
export type Notification = { id: string; user_id: string; kind: string; title: string; body: string | null; ref_table: string | null; ref_id: string | null; created_at: string; read_at: string | null };
export type AuditRow = { id: number; at: string; user_id: string | null; action: string; table_name: string; row_id: string | null; before: unknown; after: unknown; reason: string | null; device: string | null };
export type CashBook = { opening_cash: number; pos_cash_sale: number; credit_collected_cash: number; distributor_paid_cash: number; expenses_cash: number; staff_advances_cash: number; waw_borrowed_cash: number; waw_repaid_cash: number; owner_cash_returns: number; customer_credit_given: number; expected_cash: number };
export type NonCashRow = { account_id: string; account_name: string; kind: AccountKind; received: number; minused: number; remaining: number };
export type RangeSummary = {
  pos_total: number; cash: number; credit_given: number; credit_collected: number;
  by_account: { account_id: string; name: string; kind: AccountKind; provider: string | null; amount: number }[];
  purchases_received: number; purchases_paid: number; expenses: number; expenses_by_category: { name: string; amount: number }[];
  staff_advances: number; staff_recovered: number; owed_to_distributors: number; owed_by_customers: number; owed_by_staff: number; owed_to_waw: number; owed_to_owner: number;
  closings: { day: string; expected: number; counted: number; difference: number; closed_by: string; status: string; denominations: Record<string, number> | null }[];
  days_closed: number; days_approved: number;
};
export type Photo = { id: string; storage_path: string; taken_by: string; taken_at: string; device: string | null };

// ---- helpers ----------------------------------------------------------------
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
function must<T>(r: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (r.error) throw new ApiError(r.error.message, r.error.code);
  return r.data as T;
}
export class ApiError extends Error { code?: string; constructor(m: string, code?: string) { super(friendly(m)); this.code = code; } }
function friendly(m: string) {
  if (/JSON object requested/.test(m)) return 'Not found';
  if (/duplicate key.*invoices_distributor_id_invoice_no/.test(m)) return 'This invoice number already exists for this distributor';
  if (/duplicate key.*customer_credit_bills/.test(m)) return 'This bill number already exists for this customer';
  if (/row-level security/.test(m)) return 'You are not allowed to do that';
  return m;
}
const numify = <T extends Record<string, unknown>>(row: T, keys: (keyof T)[]): T => { const r = { ...row }; for (const k of keys) (r as Record<string, unknown>)[k as string] = n(r[k]); return r; };

// ---- session ----------------------------------------------------------------
export const me = async () => (await supabase.rpc('me')).data as Profile | null;
export const touchDevice = (label: string, platform: string) => supabase.rpc('touch_device', { p_label: label, p_platform: platform });

// ---- reference --------------------------------------------------------------
export const listAccounts = async () => must(await supabase.from('accounts').select('*').eq('active', true).order('sort_order')) as Account[];
export const addAccount = async (a: { name: string; kind: AccountKind; provider: string | null }) => must(await supabase.from('accounts').insert({ ...a, sort_order: 50 }).select('*').single()) as Account;
export const listAllAccounts = async () => must(await supabase.from('accounts').select('*').order('sort_order')) as Account[];
export const listDistributors = async () => must(await supabase.from('distributors').select('*').eq('active', true).order('name')) as Distributor[];
export const distributorBalances = async () => (must(await supabase.from('v_distributor_balance').select('*').order('pending', { ascending: false })) as DistributorBalance[]).map((d) => numify(d, ['pending', 'open_invoices']));
export const addDistributor = async (d: Partial<Distributor>) => must(await supabase.from('distributors').insert(d).select('*').single()) as Distributor;
export const updateDistributor = async (id: string, d: Partial<Distributor>) => must(await supabase.from('distributors').update(d).eq('id', id).select('*').single()) as Distributor;
export const listCustomers = async () => must(await supabase.from('customers').select('*').eq('active', true).order('name')) as Customer[];
export const customerBalances = async () => (must(await supabase.from('v_customer_balance').select('*').order('owed', { ascending: false })) as CustomerBalance[]).map((c) => numify(c, ['owed']));
export const addCustomer = async (c: Partial<Customer>) => must(await supabase.from('customers').insert(c).select('*').single()) as Customer;
export const listCategories = async () => must(await supabase.from('expense_categories').select('*').eq('active', true).order('sort_order')) as ExpenseCategory[];
export const listProfiles = async () => must(await supabase.from('profiles').select('*').order('role').order('name')) as Profile[];
export const upsertProfile = async (p: { id: string; name: string; role: Role; phone: string; active: boolean }) => must(await supabase.rpc('upsert_profile', { p_id: p.id, p_name: p.name, p_role: p.role, p_phone: p.phone, p_active: p.active })) as Profile;
export const addStaffMember = async (name: string, phone?: string) => must(await supabase.rpc('add_staff_member', { p_name: name, p_phone: phone || null })) as Profile;
export const listDevices = async () => must(await supabase.from('devices').select('*').order('last_seen', { ascending: false })) as { id: string; user_id: string; label: string; platform: string | null; last_seen: string }[];

// ---- days, sale, closing ----------------------------------------------------
export const getDay = async (day: string) => (await supabase.from('business_days').select('*').eq('day', day).maybeSingle()).data as BusinessDay | null;
export const listDays = async (from: string, to: string) => must(await supabase.from('business_days').select('*').gte('day', from).lte('day', to).order('day', { ascending: false })) as BusinessDay[];
export const setOpeningCash = async (day: string, amount: number) => must(await supabase.from('business_days').upsert({ day, opening_cash: amount }, { onConflict: 'day' }).select('*').single()) as BusinessDay;
export const cashBook = async (day: string) => { const rows = must(await supabase.rpc('cash_book', { d: day })) as CashBook[]; const r = (Array.isArray(rows) ? rows[0] : rows) as CashBook; return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, n(v)])) as CashBook; };
export const getDailySale = async (day: string) => { const s = (await supabase.from('daily_sales').select('*').eq('day', day).maybeSingle()).data as DailySale | null; return s ? { ...numify(s, ['pos_total', 'credit_total']), counted_cash: s.counted_cash === null ? null : n(s.counted_cash) } : null; };
export const getSaleLines = async (saleId: string) => (must(await supabase.from('daily_sale_lines').select('*').eq('daily_sale_id', saleId)) as DailySaleLine[]).map((l) => numify(l, ['amount']));
export type SaleCreditLine = { who: 'customer' | 'staff'; id: string; bill_no: string; amount: number; bill_total: number | null; photo_id: string };
export async function saveDailySale(input: { day: string; pos_total: number; credit_total: number; photo_id: string; pos_source?: 'pos' | 'count'; counted_cash?: number | null; denominations?: Record<string, number> | null; lines: { account_id: string; amount: number; photo_id: string }[]; credits?: SaleCreditLine[] }) {
  const sale = must(await supabase.from('daily_sales').insert({ day: input.day, pos_total: input.pos_total, credit_total: input.credit_total, photo_id: input.photo_id, pos_source: input.pos_source ?? 'pos', counted_cash: input.counted_cash ?? null, denominations: input.denominations ?? null }).select('*').single()) as DailySale;
  const lines = input.lines.filter((l) => l.amount > 0);
  if (lines.length) must(await supabase.from('daily_sale_lines').insert(lines.map((l) => ({ ...l, daily_sale_id: sale.id }))).select('id'));
  for (const c of input.credits ?? []) {
    if (c.who === 'customer') must(await supabase.from('customer_credit_bills').insert({ customer_id: c.id, day: input.day, bill_no: c.bill_no, amount: c.amount, bill_total: c.bill_total, photo_id: c.photo_id, sale_id: sale.id }).select('id'));
    else must(await supabase.from('staff_entries').insert({ staff_id: c.id, day: input.day, kind: 'medicine_credit', amount: c.amount, bill_total: c.bill_total, bill_no: c.bill_no, photo_id: c.photo_id, sale_id: sale.id }).select('id'));
  }
  return sale;
}
export const listReceipts = async (from: string, to: string) => (must(await supabase.from('sale_receipts').select('*').gte('day', from).lte('day', to).order('created_at', { ascending: false })) as SaleReceipt[]).map((r) => numify(r, ['amount']));
export const addReceipt = async (r: { day: string; account_id: string; amount: number; note?: string | null; photo_id: string }) => must(await supabase.from('sale_receipts').insert(r).select('*').single()) as SaleReceipt;
export const dayReceipts = async (day: string) => (must(await supabase.rpc('day_receipts', { d: day })) as { account_id: string; amount: number; receipts: number }[]).map((x) => ({ ...x, amount: n(x.amount) }));
export const dayCredit = async (day: string) => { const rows = must(await supabase.rpc('day_credit', { d: day })) as { customer_credit: number; staff_credit: number; bills: number }[]; const r = Array.isArray(rows) ? rows[0] : rows; return { customer_credit: n(r.customer_credit), staff_credit: n(r.staff_credit), bills: Number(r.bills) }; };
export const cashBeforeSale = async (day: string) => n(must(await supabase.rpc('cash_before_sale', { d: day })));
export const getClosing = async (day: string) => { const c = (await supabase.from('closings').select('*').eq('day', day).maybeSingle()).data as Closing | null; return c ? numify(c, ['expected_cash', 'counted_cash', 'difference']) : null; };
export const submitClosing = async (day: string, counted: number, photoId: string, note?: string, denominations?: Record<string, number> | null) => numify(must(await supabase.rpc('submit_closing', { p_day: day, p_counted: counted, p_drawer_photo: photoId, p_note: note ?? null, p_denominations: denominations ?? null })) as Closing, ['expected_cash', 'counted_cash', 'difference']);
export const approveDay = async (day: string) => must(await supabase.rpc('approve_day', { p_day: day }));
export const unlockDay = async (day: string, reason: string) => must(await supabase.rpc('unlock_day', { p_day: day, p_reason: reason }));
export const listClosings = async (from: string, to: string) => (must(await supabase.from('closings').select('*').gte('day', from).lte('day', to).order('day', { ascending: false })) as Closing[]).map((c) => numify(c, ['expected_cash', 'counted_cash', 'difference']));

// ---- invoices & payments ----------------------------------------------------
export const invoiceStatus = async (filter?: { distributor_id?: string; unpaid?: boolean; unposted?: boolean; installments?: boolean }) => {
  let q = supabase.from('v_invoice_status').select('*').order('day', { ascending: false }).order('created_at', { ascending: false });
  if (filter?.distributor_id) q = q.eq('distributor_id', filter.distributor_id);
  if (filter?.unpaid) q = q.gt('remaining', 0);
  if (filter?.unposted) q = q.eq('posted_in_pos', false);
  if (filter?.installments) q = q.not('installments_planned', 'is', null);
  return (must(await q) as InvoiceStatus[]).map((i) => numify(i, ['amount', 'paid', 'remaining', 'payments_made']));
};
export const getInvoice = async (id: string) => numify(must(await supabase.from('v_invoice_status').select('*').eq('id', id).single()) as InvoiceStatus, ['amount', 'paid', 'remaining', 'payments_made']);
export const addInvoice = async (i: { distributor_id: string; invoice_no: string; day: string; amount: number; photo_id: string; invoice_date?: string | null; installments_planned?: number | null; next_due?: string | null; note?: string | null; posted_in_pos?: boolean }) => must(await supabase.from('invoices').insert(i).select('*').single()) as Invoice;
export const markPosted = async (id: string) => must(await supabase.rpc('mark_posted', { p_invoice: id }));
export const listPayments = async (filter: { invoice_id?: string; distributor_id?: string; from?: string; to?: string; account_kind?: AccountKind }) => {
  let q = supabase.from('payments').select('*').order('day', { ascending: false }).order('created_at', { ascending: false });
  if (filter.invoice_id) q = q.eq('invoice_id', filter.invoice_id);
  if (filter.from) q = q.gte('day', filter.from);
  if (filter.to) q = q.lte('day', filter.to);
  return (must(await q) as Payment[]).map((p) => numify(p, ['amount']));
};
export const paymentWarning = async (invoiceId: string, amount: number, day: string) => (await supabase.rpc('payment_warning', { p_invoice: invoiceId, p_amount: amount, p_day: day })).data as string | null;
export async function recordPayment(p: { invoice_id: string; day: string; amount: number; account_id: string; cash_source: 'today' | 'yesterday' | 'not_cash'; photo_id: string; requested_by?: string | null }) {
  const r = must(await supabase.rpc('record_payment', { p_invoice: p.invoice_id, p_day: p.day, p_amount: p.amount, p_account: p.account_id, p_cash_source: p.cash_source, p_photo: p.photo_id, p_requested_by: p.requested_by ?? null })) as { blocked: boolean; code?: string; message?: string; payment?: Payment };
  if (r.blocked) throw new ApiError(r.message || 'Payment blocked', r.code);
  return r.payment as Payment;
}

// ---- expenses ---------------------------------------------------------------
export const listExpenses = async (from: string, to: string) => (must(await supabase.from('expenses').select('*').gte('day', from).lte('day', to).order('day', { ascending: false }).order('created_at', { ascending: false })) as Expense[]).map((e) => numify(e, ['amount']));
export const addExpense = async (e: { day: string; category_id: string; amount: number; note?: string | null; account_id: string; cash_source: 'today' | 'yesterday' | 'not_cash'; photo_id: string }) => must(await supabase.from('expenses').insert(e).select('*').single()) as Expense;

// ---- customer credit --------------------------------------------------------
export const listCreditBills = async (customerId?: string) => { let q = supabase.from('customer_credit_bills').select('*').order('day', { ascending: false }); if (customerId) q = q.eq('customer_id', customerId); return (must(await q) as CreditBill[]).map((b) => numify(b, ['amount'])); };
export const listCreditCollections = async (customerId?: string) => { let q = supabase.from('customer_credit_collections').select('*').order('day', { ascending: false }); if (customerId) q = q.eq('customer_id', customerId); return (must(await q) as CreditCollection[]).map((b) => numify(b, ['amount'])); };
export const addCreditBill = async (b: { customer_id: string; day: string; bill_no: string; amount: number; bill_total?: number | null; photo_id: string }) => must(await supabase.from('customer_credit_bills').insert(b).select('*').single()) as CreditBill;
export const addCreditCollection = async (c: { customer_id: string; bill_id?: string | null; day: string; amount: number; account_id: string; photo_id: string }) => must(await supabase.from('customer_credit_collections').insert(c).select('*').single()) as CreditCollection;

// ---- staff ------------------------------------------------------------------
export const staffBalances = async () => (must(await supabase.from('v_staff_balance').select('*').order('name')) as StaffBalance[]).map((s) => numify(s, ['owed']));
export const listStaffCreditForDay = async (day: string) => (must(await supabase.from('staff_entries').select('*').eq('day', day).eq('kind', 'medicine_credit')) as StaffEntry[]).map((e) => numify(e, ['amount']));
export const listStaffEntries = async (staffId: string) => (must(await supabase.from('staff_entries').select('*').eq('staff_id', staffId).order('day', { ascending: false }).order('created_at', { ascending: false })) as StaffEntry[]).map((e) => numify(e, ['amount']));
export const addStaffEntry = async (e: { staff_id: string; day: string; kind: StaffEntryKind; amount: number; bill_total?: number | null; bill_no?: string | null; note?: string | null; photo_id: string }) => must(await supabase.from('staff_entries').insert(e).select('*').single()) as StaffEntry;

// ---- WAW F/S ----------------------------------------------------------------
export const listWaw = async () => (must(await supabase.from('waw_loans').select('*').order('day', { ascending: false }).order('created_at', { ascending: false })) as WawLoan[]).map((w) => numify(w, ['amount']));
export const wawOutstanding = async () => n(must(await supabase.rpc('waw_outstanding')));
export const addWaw = async (w: { day: string; kind: 'borrow' | 'repay'; amount: number; account_id: string; handled_by?: string | null; note?: string | null; photo_id: string }) => must(await supabase.from('waw_loans').insert(w).select('*').single()) as WawLoan;

// ---- owner paid & non-cash pool --------------------------------------------
export const ownerPaid = async () => (must(await supabase.from('v_owner_paid').select('*').order('day', { ascending: false })) as OwnerPaid[]).map((o) => numify(o, ['amount', 'settled', 'unsettled']));
export const listSettlements = async (paymentId?: string) => { let q = supabase.from('owner_settlements').select('*').order('day', { ascending: false }); if (paymentId) q = q.eq('payment_id', paymentId); return (must(await q) as OwnerSettlement[]).map((s) => numify(s, ['amount'])); };
export const addSettlement = async (s: { payment_id: string; day: string; kind: 'cash_return' | 'minus_receipts'; account_id: string | null; amount: number; photo_id: string }) => must(await supabase.from('owner_settlements').insert(s).select('*').single()) as OwnerSettlement;
export const nonCashPool = async (from: string, to: string) => {
  const rows = (must(await supabase.rpc('non_cash_pool', { p_from: from, p_to: to })) as NonCashRow[]).map((r) => numify(r, ['received', 'minused']));
  const overall = (must(await supabase.from('owner_settlements').select('amount').eq('kind', 'minus_receipts').is('account_id', null).gte('day', from).lte('day', to)) as { amount: number }[]).reduce((a, b) => a + n(b.amount), 0);
  return { rows: rows.map((r) => ({ ...r, remaining: r.received - r.minused })), overallMinus: overall };
};

// ---- insights & reports -----------------------------------------------------
export const rangeSummary = async (from: string, to: string) => {
  const s = must(await supabase.rpc('range_summary', { p_from: from, p_to: to })) as RangeSummary;
  const out: RangeSummary = { ...s };
  for (const k of ['pos_total', 'cash', 'credit_given', 'credit_collected', 'purchases_received', 'purchases_paid', 'expenses', 'staff_advances', 'staff_recovered', 'owed_to_distributors', 'owed_by_customers', 'owed_by_staff', 'owed_to_waw', 'owed_to_owner', 'days_closed', 'days_approved'] as const) (out as unknown as Record<string, number>)[k] = n(s[k]);
  out.by_account = (s.by_account || []).map((a) => ({ ...a, amount: n(a.amount) }));
  out.expenses_by_category = (s.expenses_by_category || []).map((a) => ({ ...a, amount: n(a.amount) }));
  out.closings = (s.closings || []).map((c) => ({ ...c, expected: n(c.expected), counted: n(c.counted), difference: n(c.difference) }));
  return out;
};

// ---- reminders & notifications ---------------------------------------------
export const listReminders = async () => (must(await supabase.from('reminders').select('*').is('done_at', null).order('remind_at')) as Reminder[]).map((r) => numify(r, ['amount']));
export const addReminder = async (r: { invoice_id?: string | null; title: string; amount?: number | null; remind_at: string; notify_all: boolean; repeat_daily: boolean }) => must(await supabase.from('reminders').insert(r).select('*').single()) as Reminder;
export const finishReminder = async (id: string) => must(await supabase.rpc('finish_reminder', { p_id: id }));
export const listNotifications = async (limit = 100) => must(await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(limit)) as Notification[];
export const markRead = async (ids: string[]) => must(await supabase.rpc('mark_read', { p_ids: ids }));
export const runDailyJobs = async () => must(await supabase.rpc('run_daily_jobs'));

// ---- owner corrections & audit ---------------------------------------------
export const ownerEdit = async (table: string, id: string, patch: Record<string, unknown>, reason: string) => must(await supabase.rpc('owner_edit', { p_table: table, p_id: id, p_patch: patch, p_reason: reason }));
export const ownerDelete = async (table: string, id: string, reason: string) => must(await supabase.rpc('owner_delete', { p_table: table, p_id: id, p_reason: reason }));
export const auditLog = async (from: string, to: string, limit = 2000) => {
  const end = new Date(to); end.setDate(end.getDate() + 1);
  return must(await supabase.from('audit_log').select('*').gte('at', `${from}T00:00:00`).lt('at', `${end.toISOString().slice(0, 10)}T00:00:00`).order('at', { ascending: false }).limit(limit)) as AuditRow[];
};
export const getPhoto = async (id: string) => (await supabase.from('photos').select('*').eq('id', id).maybeSingle()).data as Photo | null;
export const getPhotos = async (ids: string[]) => (ids.length ? (must(await supabase.from('photos').select('*').in('id', ids)) as Photo[]) : []);
