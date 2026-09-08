import * as api from './api';
import { exportReportPdf, type PdfSection } from './pdf';
import { num, fmtTime } from './format';
import { denominationsText } from '../components/ui';

// One day on paper: sale split, cash book, closing with the note count, every entry of the day, the posting check,
// and the photos behind the key figures — for the owner's file or the manager's signature.
export async function exportDayPdf(day: string) {
  const [sale, book, closing, bday, accounts, profiles, receipts, payments, expenses, invoices, bills, staffCredits, collections, customers, staff, categories, waw] = await Promise.all([
    api.getDailySale(day), api.cashBook(day), api.getClosing(day), api.getDay(day), api.listAllAccounts(), api.listProfiles(),
    api.listReceipts(day, day), api.listPayments({ from: day, to: day }), api.listExpenses(day, day), api.invoiceStatus(),
    api.listCreditBills().then((b) => b.filter((x) => x.day === day)), api.listStaffCreditForDay(day).catch(() => [] as api.StaffEntry[]),
    api.listCreditCollections().then((c) => c.filter((x) => x.day === day)), api.listCustomers(), api.staffBalances().catch(() => [] as api.StaffBalance[]), api.listCategories(), api.listWaw().then((w) => w.filter((x) => x.day === day)),
  ]);
  const lines = sale ? await api.getSaleLines(sale.id) : [];
  const acc = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';
  const who = (id: string | null) => profiles.find((p) => p.id === id)?.name ?? '';
  const inv = (id: string) => invoices.find((i) => i.id === id);
  const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);
  const nonCash = sum(lines) + sum(receipts);
  const sections: PdfSection[] = [];
  sections.push({ title: 'Day', rows: [['Status', bday?.status === 'approved' ? `Approved & locked by ${who(bday.approved_by)}` : bday?.status === 'closed' ? 'Closed · awaiting owner approval' : 'Open'], ['Sale recorded by', sale ? `${who(sale.entered_by)} · ${sale.device ?? ''}` : '—'], ['Closed by', closing ? `${who(closing.closed_by)} · ${closing.device ?? ''}` : '—']] });
  if (sale) sections.push({ title: sale.pos_source === 'count' ? 'Sale (worked out from the drawer count)' : 'POS sale', rows: [['Total', num(sale.pos_total)], ['Cash', num(book.pos_cash_sale)], ['Card / online', num(nonCash)], ['Credit bills', num(sale.credit_total)]] });
  sections.push({ title: 'Cash book', rows: [['Opening cash', num(book.opening_cash)], ['+ POS cash sale', num(book.pos_cash_sale)], ['+ Credit collected in cash', num(book.credit_collected_cash)], ['+ Borrowed from WAW F/S (cash)', num(book.waw_borrowed_cash)], ['− Distributor payments (cash)', num(book.distributor_paid_cash)], ['− Expenses (cash)', num(book.expenses_cash)], ['− Staff advances · WAW repaid · returned to owner', num(book.staff_advances_cash + book.waw_repaid_cash + book.owner_cash_returns)], ['= Drawer should hold', num(book.expected_cash)]] });
  if (closing) sections.push({ title: 'Closing', rows: [['Expected', num(closing.expected_cash)], ['Counted', num(closing.counted_cash)], ['Difference', num(closing.difference, true)], ['Notes counted', denominationsText(closing.denominations) || '—'], ['Note', closing.note ?? '—']] });
  const cardOnline = [...lines.map((l) => [acc(l.account_id), 'end-of-day total', num(l.amount)]), ...receipts.map((r) => [acc(r.account_id), `${r.note ?? ''} · ${fmtTime(r.created_at)} · ${who(r.entered_by)}`, num(r.amount)])];
  if (cardOnline.length) sections.push({ title: 'Card machines and online transfers', head: ['Account', 'Detail', 'Amount'], rows: cardOnline });
  const credit = [...bills.map((b) => [customers.find((c) => c.id === b.customer_id)?.name ?? 'Customer', `bill ${b.bill_no}${b.bill_total && b.bill_total > b.amount ? ` of ${num(b.bill_total)}` : ''}`, num(b.amount)]), ...staffCredits.map((e) => [`${staff.find((s) => s.id === e.staff_id)?.name ?? 'Staff'} (staff)`, `bill ${e.bill_no ?? '—'}`, num(e.amount)])];
  if (credit.length) sections.push({ title: 'Credit given today', head: ['Who', 'Bill', 'Amount'], rows: credit });
  if (collections.length) sections.push({ title: 'Credit collected today', head: ['Customer', 'Into', 'Amount'], rows: collections.map((c) => [customers.find((x) => x.id === c.customer_id)?.name ?? '', acc(c.account_id), num(c.amount)]) });
  if (payments.length) sections.push({ title: 'Distributor payments', head: ['Distributor · invoice', 'From', 'By', 'Amount'], rows: payments.map((p) => [`${inv(p.invoice_id)?.distributor_name ?? ''} · Inv ${inv(p.invoice_id)?.invoice_no ?? ''}`, accounts.find((a) => a.id === p.account_id)?.kind === 'cash_drawer' ? (p.cash_source === 'yesterday' ? "yesterday's cash" : "today's cash") : acc(p.account_id), who(p.entered_by), num(p.amount)]) });
  if (expenses.length) sections.push({ title: 'Expenses', head: ['Category', 'Note', 'By', 'Amount'], rows: expenses.map((e) => [categories.find((c) => c.id === e.category_id)?.name ?? '', e.note ?? '', who(e.entered_by), num(e.amount)]) });
  if (waw.length) sections.push({ title: 'WAW F/S', head: ['Kind', 'Account', 'Amount'], rows: waw.map((w) => [w.kind === 'borrow' ? 'Borrowed' : 'Repaid', acc(w.account_id), num(w.amount)]) });
  const received = invoices.filter((i) => i.day === day);
  if (received.length) sections.push({ title: 'Stock received today', head: ['Distributor', 'Invoice', 'POS', 'Amount'], rows: received.map((i) => [i.distributor_name, i.invoice_no, i.posted_in_pos ? (i.post_diff > 0 ? `posted ${num(i.posted_amount)} · ${num(i.post_diff)} short` : 'posted') : `NOT posted${i.unposted_reason ? ` — ${i.unposted_reason}` : ''}`, num(i.amount)]) });
  const unposted = invoices.filter((i) => !i.posted_in_pos && i.day <= day);
  if (unposted.length) sections.push({ title: 'Invoices not posted in POS at this closing', head: ['Distributor', 'Invoice', 'Received', 'Reason', 'Amount'], rows: unposted.map((i) => [i.distributor_name, i.invoice_no, i.day, `${i.unposted_reason ?? '—'}${i.unposted_reason_by_name ? ` (${i.unposted_reason_by_name})` : ''}`, num(i.amount)]) });
  const photoIds = [...(sale ? [{ label: sale.pos_source === 'count' ? 'Drawer photo (count-first sale)' : 'POS screen', id: sale.photo_id }] : []), ...(closing ? [{ label: 'Drawer at closing', id: closing.drawer_photo_id }] : []), ...lines.map((l) => ({ label: `${acc(l.account_id)} · end-of-day`, id: l.photo_id })), ...receipts.map((r) => ({ label: `${acc(r.account_id)} · ${num(r.amount)}`, id: r.photo_id })), ...payments.map((p) => ({ label: `Payment · ${inv(p.invoice_id)?.distributor_name ?? ''} · ${num(p.amount)}`, id: p.photo_id })), ...expenses.map((e) => ({ label: `Expense · ${e.note ?? ''} · ${num(e.amount)}`, id: e.photo_id })), ...bills.map((b) => ({ label: `Credit bill ${b.bill_no} · ${num(b.amount)}`, id: b.photo_id }))];
  const photos = await api.getPhotos(photoIds.map((p) => p.id));
  await exportReportPdf({ title: `Day sheet ${day}`, from: day, to: day, sections, photos: photoIds.map((p) => ({ label: p.label, storagePath: photos.find((x) => x.id === p.id)?.storage_path ?? '' })).filter((p) => p.storagePath) });
}
