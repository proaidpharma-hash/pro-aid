import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TopBar, LiveBadge } from '../components/Shell';
import { KPI, Card, Money, Pill, Icon, Spinner, Empty } from '../components/ui';
import { useStore, useIsOwner } from '../lib/store';
import * as api from '../lib/api';
import { today, fmtDay, fmtTime, num } from '../lib/format';

type Entry = { at: string; kind: string; title: string; sub: string; amount: number; sign: '-' | '+' | '' ; pill: 'ok' | 'warn' | 'danger' | 'accent' };

export default function Today() {
  const profile = useStore((s) => s.profile)!;
  const accounts = useStore((s) => s.accounts);
  const refreshKey = useStore((s) => s.refreshKey);
  const isOwner = useIsOwner();
  const day = today();
  const [data, setData] = useState<{ book: api.CashBook; sale: api.DailySale | null; closing: api.Closing | null; bday: api.BusinessDay | null; pending: number; unposted: number; waw: number; entries: Entry[]; nonCashSoFar: number; receiptCount: number; creditSoFar: number; creditCount: number } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [book, sale, closing, bday, balances, unposted, waw, payments, expenses, invoices, wawRows, profiles, receipts, bills, customers, dayCredit] = await Promise.all([
        api.cashBook(day), api.getDailySale(day), api.getClosing(day), api.getDay(day), api.distributorBalances(), api.invoiceStatus({ unposted: true }), api.wawOutstanding(),
        api.listPayments({ from: day, to: day }), api.listExpenses(day, day), api.invoiceStatus(), api.listWaw(), api.listProfiles(),
        api.listReceipts(day, day).catch(() => [] as api.SaleReceipt[]), api.listCreditBills().then((b) => b.filter((x) => x.day === day)), api.listCustomers(), api.dayCredit(day).catch(() => ({ customer_credit: 0, staff_credit: 0, bills: 0 })),
      ]);
      const who = (id: string) => profiles.find((p) => p.id === id)?.name ?? '';
      const acc = (id: string) => accounts.find((a) => a.id === id);
      const entries: Entry[] = [
        ...payments.map((p) => { const inv = invoices.find((i) => i.id === p.invoice_id); const a = acc(p.account_id); return { at: p.created_at, kind: 'Payment', title: `${inv?.distributor_name ?? ''} · Inv ${inv?.invoice_no ?? ''}`, sub: `${a?.kind === 'cash_drawer' ? (p.cash_source === 'yesterday' ? "Yesterday's cash" : "Today's cash") : a?.name ?? ''} · ${who(p.entered_by)} · ${p.device ?? ''}`, amount: p.amount, sign: '-' as const, pill: 'accent' as const }; }),
        ...expenses.map((e) => ({ at: e.created_at, kind: 'Expense', title: e.note || 'Expense', sub: `${acc(e.account_id)?.kind === 'cash_drawer' ? 'Cash' : acc(e.account_id)?.name} · ${who(e.entered_by)} · ${e.device ?? ''}`, amount: e.amount, sign: '-' as const, pill: 'danger' as const })),
        ...invoices.filter((i) => i.day === day).map((i) => ({ at: i.created_at, kind: 'Purchase', title: `${i.distributor_name} · Inv ${i.invoice_no}${i.remaining > 0 ? ' · pending' : ''}${i.posted_in_pos ? '' : ' · not posted in POS'}`, sub: `${who(i.entered_by)} · ${i.device ?? ''}`, amount: i.amount, sign: '' as const, pill: 'warn' as const })),
        ...receipts.map((r) => ({ at: r.created_at, kind: acc(r.account_id)?.kind === 'card_machine' ? 'Card' : 'Online', title: `${acc(r.account_id)?.name ?? ''}${r.note ? ' · ' + r.note : ''}`, sub: `${who(r.entered_by)} · ${r.device ?? ''}`, amount: r.amount, sign: '+' as const, pill: 'ok' as const })),
        ...bills.map((b) => ({ at: b.created_at, kind: 'Credit', title: `${customers.find((c) => c.id === b.customer_id)?.name ?? 'Customer'} · bill ${b.bill_no}`, sub: `pay later · ${who(b.entered_by)}`, amount: b.amount, sign: '' as const, pill: 'warn' as const })),
        ...wawRows.filter((w) => w.day === day).map((w) => ({ at: w.created_at, kind: w.kind === 'borrow' ? 'WAW borrow' : 'WAW repay', title: `WAW F/S · ${w.kind === 'borrow' ? 'borrowed' : 'repaid'}${w.handled_by ? ' · ' + w.handled_by : ''}`, sub: `${who(w.entered_by)}`, amount: w.amount, sign: w.kind === 'borrow' ? '+' as const : '-' as const, pill: 'warn' as const })),
      ].sort((a, b) => b.at.localeCompare(a.at));
      if (alive) setData({ book, sale, closing, bday, pending: balances.reduce((s, d) => s + d.pending, 0), unposted: unposted.length, waw, entries, nonCashSoFar: receipts.reduce((s, r) => s + r.amount, 0), receiptCount: receipts.length, creditSoFar: dayCredit.customer_credit + dayCredit.staff_credit, creditCount: dayCredit.bills });
    })().catch((e) => useStore.getState().toast((e as Error).message, 'danger'));
    return () => { alive = false; };
  }, [day, refreshKey, accounts]);

  if (!data) return <><TopBar title="Today" sub={fmtDay(day)} right={<LiveBadge />} /><Spinner /></>;
  const { book, sale, closing, bday, entries } = data;
  const posCash = sale ? book.pos_cash_sale : null;
  const saleCashCounted = closing && posCash !== null ? posCash + closing.difference : null;
  const status = bday?.status ?? 'open';
  return (
    <>
      <TopBar title="Today" sub={fmtDay(day)} right={<>
        <LiveBadge />
        {status === 'approved' ? <Pill kind="ok"><Icon.Lock size={12} /> Day approved</Pill> : status === 'closed' ? <Pill kind="warn">Closed · awaiting approval</Pill> : <Pill kind="neutral">Day open</Pill>}
        <span className="desktop-only actions">
          <Link className="btn primary" to="/receipts/new" data-testid="add-receipt">+ Card / online</Link>
          <Link className="btn" to="/credit/new" data-testid="add-credit-bill">+ Credit bill</Link>
          <Link className="btn" to="/pay">+ Payment</Link>
          <Link className="btn" to="/expenses/new">+ Expense</Link>
          <Link className="btn" to="/purchases/new">+ Purchase</Link>
          {profile.role !== 'cashier' && <Link className="btn" to="/sales/new">{sale ? 'Sale' : '+ Sale (night)'}</Link>}
        </span>
      </>} />
      <div className="content">
        <div className="grid grid-4">
          <KPI label={sale ? 'POS system sale' : 'Card / online so far'} value={sale ? <Money v={sale.pos_total} /> : <Money v={data.nonCashSoFar} />} hint={sale ? `Cash ${num(posCash)} · Card/online ${num(sale.pos_total - sale.credit_total - (posCash ?? 0))} · Credit ${num(sale.credit_total)}` : `${data.receiptCount} receipt${data.receiptCount === 1 ? '' : 's'} · credit ${num(data.creditSoFar)} (${data.creditCount}) · sale not recorded yet`} />
          <KPI label={closing ? 'Cash counted in drawer' : 'Drawer should hold'} value={<Money v={closing ? closing.counted_cash : book.expected_cash} />} hint={closing ? `Expected ${num(closing.expected_cash)}` : `Opening ${num(book.opening_cash)} + sale cash − payouts`} kind={closing ? undefined : 'accent'} />
          <KPI label="Difference (cash − system)" value={closing ? <Money v={closing.difference} sign /> : '—'} hint={closing ? (closing.difference < 0 ? 'MINUS — drawer is short' : `Sale cash ${num(saleCashCounted)} vs system ${num(posCash)}`) : 'After closing'} kind={closing ? (closing.difference < 0 ? 'danger' : 'ok') : undefined} />
          <KPI label="Pending to distributors" value={<Money v={data.pending} />} hint={<>{data.unposted > 0 ? <Link to="/purchases?tab=unposted" className="accent">{data.unposted} not posted in POS →</Link> : 'All invoices posted in POS'}{data.waw > 0 && <> · <Link to="/waw" className="danger">WAW owed {num(data.waw)}</Link></>}</>} kind={data.waw > 0 ? 'warn' : undefined} />
        </div>
        <div className="grid grid-2 stack">
          <Card title="Cash book · today" right={<Link to="/closing" className="accent" style={{ fontSize: 12, fontWeight: 700 }}>{closing ? 'View closing' : (profile.role === 'cashier' ? '' : 'Close the day')}</Link>}>
            <div className="line"><span className="k">Opening cash (from yesterday)</span><span className="v num">{num(book.opening_cash)}</span></div>
            <div className="line"><span className="k">+ POS cash sale</span><span className="v num ok">+ {num(book.pos_cash_sale)}</span></div>
            <div className="line"><span className="k">+ Credit bills collected (cash)</span><span className="v num ok">+ {num(book.credit_collected_cash)}</span></div>
            {book.waw_borrowed_cash > 0 && <div className="line"><span className="k">+ Borrowed from WAW F/S (cash)</span><span className="v num ok">+ {num(book.waw_borrowed_cash)}</span></div>}
            <div className="line"><span className="k">− Distributor payments (cash)</span><span className="v num danger">− {num(book.distributor_paid_cash)}</span></div>
            <div className="line"><span className="k">− Expenses (cash)</span><span className="v num danger">− {num(book.expenses_cash)}</span></div>
            <div className="line"><span className="k">− Staff advances · WAW repaid · returned to owner</span><span className="v num">{num(book.staff_advances_cash + book.waw_repaid_cash + book.owner_cash_returns)}</span></div>
            <div className="line total"><span className="k">= Drawer should hold</span><span className="v num accent">{num(book.expected_cash)}</span></div>
          </Card>
          <Card title="Today's entries" right={<span className="help">who · device</span>}>
            {entries.length === 0 ? <Empty>No entries yet today</Empty> : entries.slice(0, 12).map((e, i) => (
              <div className="row" key={i}>
                <div className="grow"><span className="t">{e.title}</span><span className="s">{fmtTime(e.at)} · {e.sub}</span></div>
                <Pill kind={e.pill}>{e.kind}</Pill>
                <span className="amt num">{e.sign === '-' ? '− ' : e.sign === '+' ? '+ ' : ''}{num(e.amount)}</span>
              </div>
            ))}
          </Card>
        </div>
        {isOwner && status === 'closed' && <Card kind="warn"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><b>Closing submitted — review and approve to lock the day.</b><Link to="/closing" className="btn primary">Review closing</Link></div></Card>}
        <div className="phone-only grid grid-2">
          <Link className="btn primary" to="/receipts/new">+ Card / online</Link>
          <Link className="btn" to="/credit/new">+ Credit bill</Link>
          <Link className="btn" to="/pay">+ Payment</Link>
          <Link className="btn" to="/expenses/new">+ Expense</Link>
          <Link className="btn" to="/purchases/new">+ Purchase</Link>
          {profile.role !== 'cashier' && <Link className="btn" to="/sales/new">{sale ? 'Sale' : '+ Sale (night)'}</Link>}
        </div>
      </div>
    </>
  );
}
