import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TopBar } from '../components/Shell';
import { Card, KPI, Button, Notice, Spinner, Pill, Chips, Empty, Field, Sheet, Icon, ProofLink } from '../components/ui';
import { useStore, useIsOwner } from '../lib/store';
import * as api from '../lib/api';
import { today, num, fmtShort, fmtDay, fmtDateTime } from '../lib/format';
import { createStaffLogin, isValidPhone, isValidPin } from '../lib/auth';
import { SettleSheet } from './Ledgers';
import { exportReportPdf } from '../lib/pdf';

type RangeKey = 'today' | 'week' | '15' | 'month' | 'lastmonth' | 'custom';
export function useRange(initial: RangeKey = 'month') {
  const [key, setKey] = useState<RangeKey>(initial);
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const range = useMemo(() => {
    const t = new Date(today());
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (key === 'today') return { from: today(), to: today() };
    if (key === 'week') { const f = new Date(t); f.setDate(f.getDate() - 6); return { from: iso(f), to: today() }; }
    if (key === '15') { const f = new Date(t); f.setDate(f.getDate() - 14); return { from: iso(f), to: today() }; }
    if (key === 'month') { const f = new Date(t); f.setDate(1); return { from: iso(f), to: today() }; }
    if (key === 'lastmonth') { const f = new Date(t.getFullYear(), t.getMonth() - 1, 1); const l = new Date(t.getFullYear(), t.getMonth(), 0); return { from: iso(f), to: iso(l) }; }
    return { from, to };
  }, [key, from, to]);
  const picker = (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <Chips options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'This week' }, { value: '15', label: 'Last 15 days' }, { value: 'month', label: 'This month' }, { value: 'lastmonth', label: 'Last month' }, { value: 'custom', label: 'Custom dates' }]} value={key} onChange={setKey} />
      {key === 'custom' && <><input className="input" type="date" style={{ width: 160 }} value={from} onChange={(e) => setFrom(e.target.value)} /><span className="muted">→</span><input className="input" type="date" style={{ width: 160 }} value={to} onChange={(e) => setTo(e.target.value)} /></>}
    </div>
  );
  return { range, picker, key };
}

// ---- Non-cash received & minus owner-paid invoices -----------------------------
export function NonCashPage() {
  const profile = useStore((s) => s.profile)!;
  const refreshKey = useStore((s) => s.refreshKey);
  const { range, picker } = useRange('month');
  const [pool, setPool] = useState<{ rows: api.NonCashRow[]; overallMinus: number } | null>(null);
  const [ownerPaid, setOwnerPaid] = useState<api.OwnerPaid[]>([]);
  const [settlements, setSettlements] = useState<api.OwnerSettlement[]>([]);
  const [settle, setSettle] = useState<api.OwnerPaid | null>(null);
  const accounts = useStore((s) => s.accounts);
  useEffect(() => { Promise.all([api.nonCashPool(range.from, range.to), api.ownerPaid(), api.listSettlements()]).then(([p, o, s]) => { setPool(p); setOwnerPaid(o); setSettlements(s); }).catch(() => undefined); }, [range, refreshKey]);
  if (!pool) return <><TopBar title="Non-cash received" /><Spinner /></>;
  const wallets = pool.rows.filter((r) => r.kind !== 'card_machine');
  const cards = pool.rows.filter((r) => r.kind === 'card_machine');
  const sum = (xs: api.NonCashRow[], k: 'received' | 'minused') => xs.reduce((s, r) => s + r[k], 0);
  const received = sum(pool.rows, 'received');
  const minused = sum(pool.rows, 'minused') + pool.overallMinus;
  return (
    <>
      <TopBar title="Non-cash received · minus owner-paid invoices" sub="Owner only · card machine and wallet money from customers, and what has been minused from it" right={<Button onClick={() => exportReportPdf({ title: 'Non-cash received', from: range.from, to: range.to, sections: [{ title: 'Online transfers', rows: wallets.map((r) => [r.account_name, num(r.received), num(r.minused), num(r.remaining)]), head: ['Account', 'Received', 'Minused', 'Remaining'] }, { title: 'Card machines', rows: cards.map((r) => [r.account_name, num(r.received), num(r.minused), num(r.remaining)]), head: ['Account', 'Received', 'Minused', 'Remaining'] }, { title: 'Totals', rows: [['Total non-cash received', num(received)], ['Minused for owner-paid invoices', num(minused)], ['Remaining in accounts', num(received - minused)]] }] })}><Icon.Download size={14} /> PDF</Button>} />
      <div className="content">
        {picker}
        <div className="grid grid-2 stack">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Card title="Online transfers from customers" right={<span className="num" style={{ fontWeight: 800 }}>{num(sum(wallets, 'received'))}</span>}>{wallets.map((r) => <div className="line" key={r.account_id}><span className="k">{r.account_name}</span><span className="v num">{num(r.received)}{r.minused > 0 && <span className="muted"> · minused {num(r.minused)}</span>}</span></div>)}</Card>
            <Card title="Card machine sales" right={<span className="num" style={{ fontWeight: 800 }}>{num(sum(cards, 'received'))}</span>}>{cards.map((r) => <div className="line" key={r.account_id}><span className="k">{r.account_name}</span><span className="v num">{num(r.received)}{r.minused > 0 && <span className="muted"> · minused {num(r.minused)}</span>}</span></div>)}</Card>
            <Card kind="accent"><div className="line" style={{ borderTop: 0 }}><span>Total non-cash received</span><span className="num">{num(received)}</span></div><div className="line"><span>− Minused for owner-paid invoices</span><span className="num">{num(minused)}</span></div><div className="line total" style={{ fontSize: 18, borderTopColor: 'rgba(255,255,255,0.3)' }}><span>Remaining in accounts</span><span className="num">Rs {num(received - minused)}</span></div></Card>
          </div>
          <Card title="Invoices paid from the owner's personal account" right={<span className="help">{ownerPaid.filter((o) => o.unsettled > 0).length} not yet minused</span>}>
            {ownerPaid.length === 0 ? <Empty>None</Empty> : ownerPaid.map((o) => <div className="row" key={o.payment_id}><div className="grow"><span className="t">{o.distributor_name} · Inv {o.invoice_no}</span><span className="s">{fmtShort(o.day)}{o.unsettled <= 0 ? <> · <span className="ok">minused {settlements.filter((s) => s.payment_id === o.payment_id).map((s) => `${fmtShort(s.day)} · ${s.kind === 'cash_return' ? 'cash' : s.account_id ? accounts.find((a) => a.id === s.account_id)?.name : 'overall'}`).join(', ')}</span></> : o.settled > 0 ? ` · ${num(o.settled)} minused · ${num(o.unsettled)} left` : ''}</span></div><span className="amt num">{num(o.amount)}</span>{o.unsettled > 0 && <Button size="sm" kind="primary" onClick={() => setSettle(o)}>Minus from…</Button>}</div>)}
          </Card>
        </div>
      </div>
      {settle && <SettleSheet item={settle} userId={profile.id} onClose={() => setSettle(null)} onSaved={() => { setSettle(null); useStore.getState().bump(); }} />}
    </>
  );
}

// ---- Insights --------------------------------------------------------------------
export function InsightsPage() {
  const refreshKey = useStore((s) => s.refreshKey);
  const { range, picker } = useRange('month');
  const [s, setS] = useState<api.RangeSummary | null>(null);
  useEffect(() => { api.rangeSummary(range.from, range.to).then(setS).catch(() => undefined); }, [range, refreshKey]);
  if (!s) return <><TopBar title="Insights" /><Spinner /></>;
  const card = s.by_account.filter((a) => a.kind === 'card_machine');
  const online = s.by_account.filter((a) => a.kind !== 'card_machine');
  const sum = (xs: { amount: number }[]) => xs.reduce((t, x) => t + x.amount, 0);
  const days = Math.max(1, Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / 86400000) + 1);
  const net = s.pos_total - s.purchases_received - s.expenses - (s.staff_advances - s.staff_recovered);
  const maxAbs = Math.max(1, ...s.closings.map((c) => Math.abs(c.difference)));
  const minusDays = s.closings.filter((c) => c.difference < 0);
  const avg = s.closings.length ? s.closings.reduce((t, c) => t + c.difference, 0) / s.closings.length : 0;
  return (
    <>
      <TopBar title="Insights · ask any date range" sub="Owner only · every figure links to the entries and photos behind it" right={<Button onClick={() => exportReportPdf({ title: 'Insights', from: range.from, to: range.to, sections: [{ title: 'Sales', rows: [['Total sale', num(s.pos_total)], ['Cash', num(s.cash)], ['Card machines', num(sum(card))], ['Online received', num(sum(online))], ['Credit bills', num(s.credit_given)]] }, { title: 'Money-based status', rows: [['Sales', num(s.pos_total)], ['− Purchases received', num(s.purchases_received)], ['− Expenses', num(s.expenses)], ['− Staff advances not recovered', num(s.staff_advances - s.staff_recovered)], ['= Sales minus purchases and expenses', num(net)]] }, { title: 'Where things stand', rows: [['Owed to distributors', num(s.owed_to_distributors)], ['Owed by customers', num(s.owed_by_customers)], ['Owed by staff', num(s.owed_by_staff)], ['Owed to WAW F/S', num(s.owed_to_waw)], ['Owed to owner', num(s.owed_to_owner)]] }] })}><Icon.Download size={14} /> PDF</Button>} />
      <div className="content">
        {picker}
        <div className="grid grid-5">
          <KPI kind="accent" label={`Total sale · ${fmtShort(range.from)} – ${fmtShort(range.to)}`} value={num(s.pos_total)} hint={`${days} days · avg ${num(Math.round(s.pos_total / days))} / day · ${s.days_approved} approved`} />
          <KPI label="Cash" value={num(s.cash)} hint={s.pos_total ? `${Math.round((s.cash / s.pos_total) * 100)}%` : ''} />
          <KPI label="Card machines" value={num(sum(card))} hint={card.map((a) => `${a.provider ?? a.name} ${num(a.amount)}`).join(' · ') || '—'} />
          <KPI label="Online received" value={num(sum(online))} hint={online.map((a) => `${a.provider ?? a.name} ${num(a.amount)}`).join(' · ') || '—'} />
          <KPI kind="warn" label="Credit bills" value={num(s.credit_given)} hint={`Collected ${num(s.credit_collected)} · still owed ${num(s.owed_by_customers)}`} />
        </div>
        <div className="grid grid-2 stack">
          <Card title="Money-based status" right={<span className="help">not stock-adjusted</span>}>
            <div className="line"><span className="k">Sales (all methods)</span><span className="v num ok">{num(s.pos_total)}</span></div>
            <div className="line"><span className="k">− Purchases received (all invoices)</span><span className="v num danger">{num(s.purchases_received)}</span></div>
            <div className="line"><span className="k">− Expenses</span><span className="v num danger">{num(s.expenses)}</span></div>
            <div className="line"><span className="k">− Staff advances given, not yet recovered</span><span className="v num danger">{num(Math.max(0, s.staff_advances - s.staff_recovered))}</span></div>
            <div className="line total" style={{ fontSize: 16 }}><span className="k">Sales minus purchases and expenses</span><span className="v num accent">Rs {num(net)}</span></div>
            <div className="help">Money-based figure. True profit also depends on stock still on the shelf, which this app does not count.</div>
            {s.expenses_by_category.length > 0 && <><div className="section-title">Expenses by category</div>{s.expenses_by_category.map((c) => <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}><span style={{ width: 120, fontWeight: 600 }}>{c.name}</span><div className="bar" style={{ flex: 1 }}><div style={{ width: `${(c.amount / s.expenses_by_category[0].amount) * 100}%` }} /></div><span className="num" style={{ width: 70, textAlign: 'right', fontWeight: 700 }}>{num(c.amount)}</span></div>)}</>}
          </Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Card title={`Where things stand on ${fmtShort(range.to)}`}>
              <div className="tiles">
                <div className="tile"><span>Owed to distributors</span><b className="num warn">{num(s.owed_to_distributors)}</b></div>
                <div className="tile"><span>Owed by customers (credit)</span><b className="num">{num(s.owed_by_customers)}</b></div>
                <div className="tile"><span>Owed by staff</span><b className="num">{num(s.owed_by_staff)}</b></div>
                <div className="tile"><span>Owed to WAW F/S</span><b className={`num ${s.owed_to_waw > 0 ? 'danger' : ''}`}>{num(s.owed_to_waw)}</b></div>
                <div className="tile"><span>Owed to owner (personal account)</span><b className="num accent">{num(s.owed_to_owner)}</b></div>
                <div className="tile"><span>Purchases paid in this period</span><b className="num">{num(s.purchases_paid)}</b></div>
              </div>
            </Card>
            <Card title="Cash difference · closings in this period">
              {s.closings.length === 0 ? <Empty>No closings yet</Empty> : <>
                <div className="sparkbars">{s.closings.map((c) => <div key={c.day} className={c.difference < 0 ? 'neg' : ''} style={{ height: `${Math.max(6, (Math.abs(c.difference) / maxAbs) * 100)}%` }} title={`${fmtShort(c.day)} · ${num(c.difference, true)} · ${c.closed_by}`} />)}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700 }} className="muted"><span>{s.closings.length - minusDays.length} days plus · {minusDays.length} days minus{minusDays.length > 0 && ` (${minusDays.map((c) => `${fmtShort(c.day)} ${c.closed_by}`).join(', ')})`}</span><span>avg {num(Math.round(avg), true)}</span></div>
              </>}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

// ---- Reports ---------------------------------------------------------------------
export function ReportsPage() {
  const refreshKey = useStore((s) => s.refreshKey);
  const accounts = useStore((s) => s.accounts);
  const { range, picker } = useRange('week');
  const [s, setS] = useState<api.RangeSummary | null>(null);
  const [pool, setPool] = useState<{ rows: api.NonCashRow[]; overallMinus: number } | null>(null);
  const [pays, setPays] = useState<api.Payment[]>([]);
  const [invoices, setInvoices] = useState<api.InvoiceStatus[]>([]);
  const [photos, setPhotos] = useState<api.Photo[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { Promise.all([api.rangeSummary(range.from, range.to), api.nonCashPool(range.from, range.to), api.listPayments({ from: range.from, to: range.to }), api.invoiceStatus()]).then(async ([a, b, c, d]) => { setS(a); setPool(b); setPays(c); setInvoices(d); setPhotos(await api.getPhotos(c.map((p) => p.photo_id))); }).catch(() => undefined); }, [range, refreshKey]);
  if (!s || !pool) return <><TopBar title="Reports" /><Spinner /></>;
  const online = pays.filter((p) => ['bank', 'wallet', 'card_machine'].includes(accounts.find((a) => a.id === p.account_id)?.kind ?? ''));
  const nonCashReceived = pool.rows.reduce((t, r) => t + r.received, 0);
  const minused = pool.rows.reduce((t, r) => t + r.minused, 0) + pool.overallMinus;
  const inv = (id: string) => invoices.find((i) => i.id === id);
  const pdf = async () => {
    setBusy(true);
    try {
      await exportReportPdf({
        title: 'Pro Aid report', from: range.from, to: range.to,
        sections: [
          { title: 'Summary', rows: [['Sales (all methods)', num(s.pos_total)], ['Purchases received', num(s.purchases_received)], ['Purchases paid', num(s.purchases_paid)], ['Expenses', num(s.expenses)], ['Owed to distributors', num(s.owed_to_distributors)], ['Non-cash received', num(nonCashReceived)], ['Cash difference (closings)', num(s.closings.reduce((t, c) => t + c.difference, 0), true)]] },
          { title: 'Daily closing · system vs drawer', head: ['Date', 'Expected', 'Counted', 'Difference', 'Closed by', 'Status'], rows: s.closings.map((c) => [fmtShort(c.day), num(c.expected), num(c.counted), num(c.difference, true), c.closed_by, c.status]) },
          { title: 'Non-cash received from customers', head: ['Account', 'Received', 'Minused', 'Remaining'], rows: [...pool.rows.map((r) => [r.account_name, num(r.received), num(r.minused), num(r.remaining)]), ['Total', num(nonCashReceived), num(minused), num(nonCashReceived - minused)]] },
          { title: 'Paid to distributors online', head: ['Date', 'Distributor', 'Invoice', 'Via', 'Amount'], rows: online.map((p) => [fmtShort(p.day), inv(p.invoice_id)?.distributor_name ?? '', inv(p.invoice_id)?.invoice_no ?? '', accounts.find((a) => a.id === p.account_id)?.name ?? '', num(p.amount)]) },
          { title: 'Expenses by category', head: ['Category', 'Amount'], rows: s.expenses_by_category.map((c) => [c.name, num(c.amount)]) },
          { title: 'Customer credit', rows: [['Given in period', num(s.credit_given)], ['Collected in period', num(s.credit_collected)], ['Still owed by customers', num(s.owed_by_customers)]] },
        ],
        photos: photos.map((p) => ({ label: `Payment proof · ${fmtShort(pays.find((x) => x.photo_id === p.id)?.day ?? range.to)}`, storagePath: p.storage_path })),
      });
    } finally { setBusy(false); }
  };
  return (
    <>
      <TopBar title="Reports" sub={`${fmtDay(range.from)} – ${fmtDay(range.to)} · ${s.days_approved} days approved`} right={<Button kind="primary" disabled={busy} onClick={pdf}><Icon.Download size={14} /> {busy ? 'Building PDF…' : 'Export PDF with photos'}</Button>} />
      <div className="content">
        {picker}
        <div className="grid grid-5">
          <KPI label="Sales (all methods)" value={num(s.pos_total)} />
          <KPI label="Purchases" value={num(s.purchases_received)} hint={`paid ${num(s.purchases_paid)}`} />
          <KPI label="Expenses" value={num(s.expenses)} />
          <KPI kind="warn" label="Owed to distributors" value={num(s.owed_to_distributors)} />
          <KPI kind={s.closings.reduce((t, c) => t + c.difference, 0) < 0 ? 'danger' : 'ok'} label={`Cash difference · ${s.closings.length} closings`} value={num(s.closings.reduce((t, c) => t + c.difference, 0), true)} />
        </div>
        <div className="grid grid-2 stack">
          <Card title="Daily closing · system vs drawer">
            <div className="scroll-x"><table className="table"><thead><tr><th>Date</th><th className="r">Expected</th><th className="r">Counted</th><th className="r">Difference</th><th>Closed by</th><th>Status</th></tr></thead><tbody>{s.closings.length === 0 ? <tr><td colSpan={6}><Empty>No closings in this period</Empty></td></tr> : [...s.closings].reverse().map((c) => <tr key={c.day} className={c.difference < 0 ? 'hl' : ''}><td className="num">{fmtShort(c.day)}</td><td className="r num">{num(c.expected)}</td><td className="r num">{num(c.counted)}</td><td className={`r num ${c.difference < 0 ? 'danger' : 'ok'}`} style={{ fontWeight: 800 }}>{num(c.difference, true)}</td><td>{c.closed_by}</td><td>{c.status === 'approved' ? <Pill kind="ok">Approved</Pill> : <Pill kind="warn">Awaiting</Pill>}</td></tr>)}</tbody></table></div>
            <div className="grid grid-2" style={{ paddingTop: 8, borderTop: '1px solid var(--line)' }}>
              <div><div className="section-title">Expenses · {num(s.expenses)}</div>{s.expenses_by_category.map((c) => <div className="line" key={c.name} style={{ padding: '4px 0', fontSize: 12 }}><span className="k">{c.name}</span><span className="v num">{num(c.amount)}</span></div>)}</div>
              <div><div className="section-title">Customer credit bills</div><div className="line" style={{ padding: '4px 0', fontSize: 12 }}><span className="k">Given in period</span><span className="v num">{num(s.credit_given)}</span></div><div className="line" style={{ padding: '4px 0', fontSize: 12 }}><span className="k">Collected</span><span className="v num ok">{num(s.credit_collected)}</span></div><div className="line" style={{ padding: '4px 0', fontSize: 12 }}><span className="k" style={{ fontWeight: 800 }}>Still owed by customers</span><span className="v num warn">{num(s.owed_by_customers)}</span></div></div>
            </div>
          </Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Card title="Non-cash received from customers" right={<span className="num" style={{ fontWeight: 800 }}>{num(nonCashReceived)}</span>}>
              <div className="grid grid-2">
                <div><div className="line" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}><span className="k muted">Card machines</span><span className="v num">{num(pool.rows.filter((r) => r.kind === 'card_machine').reduce((t, r) => t + r.received, 0))}</span></div>{pool.rows.filter((r) => r.kind === 'card_machine').map((r) => <div className="line" key={r.account_id}><span className="k">{r.account_name}</span><span className="v num">{num(r.received)}</span></div>)}</div>
                <div><div className="line" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}><span className="k muted">Online transfers</span><span className="v num">{num(pool.rows.filter((r) => r.kind !== 'card_machine').reduce((t, r) => t + r.received, 0))}</span></div>{pool.rows.filter((r) => r.kind !== 'card_machine').map((r) => <div className="line" key={r.account_id}><span className="k">{r.account_name}</span><span className="v num">{num(r.received)}</span></div>)}</div>
              </div>
              <div className="line" style={{ borderTop: '1px solid var(--line)' }}><span className="k muted">Minused for owner-paid invoices</span><span className="v num">{num(minused)}</span></div>
              <div className="line total"><span className="k">Remaining in accounts</span><span className="v num accent">{num(nonCashReceived - minused)}</span></div>
            </Card>
            <Card title="Paid to distributors online · screenshots" right={<span className="num" style={{ fontWeight: 800 }}>{num(online.reduce((t, p) => t + p.amount, 0))}</span>}>
              {online.length === 0 ? <Empty>None in this period</Empty> : online.map((p) => <div className="row" key={p.id}><div className="grow"><span className="t">{inv(p.invoice_id)?.distributor_name} · Inv {inv(p.invoice_id)?.invoice_no}</span><span className="s">{fmtShort(p.day)} · {accounts.find((a) => a.id === p.account_id)?.name}</span></div><ProofLink storagePath={photos.find((x) => x.id === p.photo_id)?.storage_path} /><span className="amt num">{num(p.amount)}</span></div>)}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

// ---- Settings --------------------------------------------------------------------
export function SettingsPage() {
  const isOwner = useIsOwner();
  const toast = useStore((s) => s.toast);
  const refreshKey = useStore((s) => s.refreshKey);
  const [tab, setTab] = useState<'users' | 'accounts' | 'distributors' | 'audit' | 'days'>('users');
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [devices, setDevices] = useState<{ id: string; user_id: string; label: string; platform: string | null; last_seen: string }[]>([]);
  const [audit, setAudit] = useState<api.AuditRow[]>([]);
  const [days, setDays] = useState<api.BusinessDay[]>([]);
  const [accounts, setAccounts] = useState<api.Account[]>([]);
  const [dists, setDists] = useState<api.Distributor[]>([]);
  const [addUser, setAddUser] = useState(false);
  const [nu, setNu] = useState({ name: '', phone: '', pin: '', role: 'cashier' as 'cashier' | 'manager' | 'owner' });
  const [addStaff, setAddStaff] = useState(false);
  const [ns, setNs] = useState({ name: '', phone: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!isOwner) return; const f = new Date(); f.setDate(f.getDate() - 60); Promise.all([api.listProfiles(), api.listDevices(), api.auditLog(200), api.listDays(f.toISOString().slice(0, 10), today()), api.listAllAccounts(), api.listDistributors()]).then(([p, d, a, bd, ac, ds]) => { setProfiles(p); setDevices(d); setAudit(a); setDays(bd); setAccounts(ac); setDists(ds); }).catch((e) => toast((e as Error).message, 'danger')); }, [isOwner, refreshKey, toast]);
  if (!isOwner) return <><TopBar title="Settings" /><div className="content"><Notice kind="warn">Owner only</Notice></div></>;
  const create = async () => {
    if (!nu.name.trim() || !isValidPhone(nu.phone) || !isValidPin(nu.pin)) return toast('Name, a valid phone and a 6-digit PIN are needed', 'danger');
    setBusy(true);
    try { await createStaffLogin({ name: nu.name.trim(), phone: nu.phone, pin: nu.pin, role: nu.role }); toast(`${nu.name} can now sign in with ${nu.phone} and their PIN`, 'ok'); setAddUser(false); setNu({ name: '', phone: '', pin: '', role: 'cashier' }); useStore.getState().bump(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  const createStaff = async () => {
    if (!ns.name.trim()) return toast('A name is needed', 'danger');
    setBusy(true);
    try { await api.addStaffMember(ns.name.trim(), ns.phone.trim() || undefined); toast(`${ns.name} added — credit bills and advances can now go to their account`, 'ok'); setAddStaff(false); setNs({ name: '', phone: '' }); useStore.getState().bump(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  const toggleActive = async (p: api.Profile) => { try { await api.upsertProfile({ id: p.id, name: p.name, role: p.role, phone: p.phone ?? '', active: !p.active }); useStore.getState().bump(); } catch (e) { toast((e as Error).message, 'danger'); } };
  const toggleAccount = async (a: api.Account) => { try { const { supabase } = await import('../lib/supabase'); await supabase.from('accounts').update({ active: !a.active }).eq('id', a.id); useStore.getState().bump(); } catch (e) { toast((e as Error).message, 'danger'); } };
  const who = (id: string | null) => profiles.find((p) => p.id === id)?.name ?? '—';
  return (
    <>
      <TopBar title="Settings" sub="Owner only · users, accounts, rules, and the audit log" right={<Chips options={[{ value: 'users', label: 'Users' }, { value: 'accounts', label: 'Accounts & wallets' }, { value: 'distributors', label: 'Distributors' }, { value: 'days', label: 'Locked days' }, { value: 'audit', label: 'Audit log' }]} value={tab} onChange={setTab} />} />
      <div className="content">
        {tab === 'users' && <div className="grid grid-2 stack">
          <Card title="Users & staff" right={<><Button size="sm" onClick={() => setAddStaff(true)} data-testid="add-staff">+ Staff (no login)</Button><Button kind="primary" size="sm" onClick={() => setAddUser(true)}>+ Add login</Button></>}>
            <div className="scroll-x"><table className="table"><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Devices</th><th></th></tr></thead><tbody>{profiles.map((p) => <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}><td><b>{p.name}</b></td><td><Pill kind={p.role === 'owner' ? 'accent' : p.role === 'manager' ? 'warn' : 'neutral'}>{p.role === 'staff' ? 'staff · no login' : p.role}</Pill></td><td className="num">{p.phone ?? '—'}</td><td className="muted">{p.has_login === false ? 'account only — cannot sign in' : devices.filter((d) => d.user_id === p.id).map((d) => `${d.label} · ${fmtDateTime(d.last_seen)}`).join(', ') || '—'}</td><td>{p.role !== 'owner' && <Button size="sm" onClick={() => toggleActive(p)}>{p.active ? 'Disable' : 'Enable'}</Button>}</td></tr>)}</tbody></table></div>
            <div className="help">Staff without a login (helpers, salesmen) still get an account: their credit bills and advances are recorded against them, but they cannot open the app.</div>
            <div className="help">To reset someone's PIN: disable the user, add them again with a new PIN, or reset it from the Supabase dashboard (Authentication → Users).</div>
          </Card>
          <Card title="What each role can do">
            <div className="scroll-x"><table className="table"><thead><tr><th></th><th style={{ textAlign: 'center' }}>Cashier</th><th style={{ textAlign: 'center' }}>Manager</th><th style={{ textAlign: 'center' }}>Owner</th></tr></thead><tbody>
              {[['Add purchases, payments, expenses, credit (with photo)', 'Yes', 'Yes', 'Yes'], ['Record daily sale and closing · staff medicine on credit', 'No', 'Yes', 'Yes'], ['Mark invoice posted in POS', 'No', 'Yes', 'Yes'], ['Edit or delete any saved entry', 'No', 'No', 'With reason'], ['Approve & lock a day · staff advances · minus from receipts · Insights', 'No', 'No', 'Yes'], ['See own staff account · set reminders', 'Yes', 'Yes', 'Yes']].map((r) => <tr key={r[0]}><td>{r[0]}</td>{r.slice(1).map((c, i) => <td key={i} style={{ textAlign: 'center', fontWeight: 800 }} className={c === 'No' ? 'danger' : c === 'Yes' ? 'ok' : 'warn'}>{c}</td>)}</tr>)}
            </tbody></table></div>
          </Card>
        </div>}
        {tab === 'accounts' && <Card title="Accounts & wallets" right={<span className="help">card machines, wallets, bank accounts</span>}>{accounts.map((a) => <div className="row" key={a.id}><div className="grow"><span className="t">{a.name}</span><span className="s">{a.kind.replace('_', ' ')}{a.provider ? ` · ${a.provider}` : ''}</span></div>{!['cash_drawer', 'owner_personal', 'waw_fs'].includes(a.kind) && <Button size="sm" onClick={() => toggleAccount(a)}>{a.active ? 'Disable' : 'Enable'}</Button>}</div>)}<div className="help">Need a new machine or wallet? Ask Claude to add it, or insert a row in the accounts table.</div></Card>}
        {tab === 'distributors' && <Card title="Distributors">{dists.map((d) => <div className="row" key={d.id}><div className="grow"><span className="t">{d.name}</span><span className="s">{[d.rep_name, d.phone, d.delivery_days].filter(Boolean).join(' · ') || 'no details'}{d.opening_balance > 0 ? ` · opening balance ${num(d.opening_balance)}` : ''}</span></div><Link className="btn sm" to={`/distributors/${d.id}`}>Open</Link></div>)}</Card>}
        {tab === 'days' && <Card title="Days · last 60" right={<span className="help">approved days are locked</span>}>{days.map((d) => <div className="row" key={d.day}><div className="grow"><span className="t">{fmtDay(d.day)}</span><span className="s">opening {num(d.opening_cash)}{d.closed_at ? ` · closed by ${who(d.closed_by)}` : ''}{d.approved_at ? ` · approved by ${who(d.approved_by)} ${fmtDateTime(d.approved_at)}` : ''}</span></div>{d.status === 'approved' ? <Pill kind="ok"><Icon.Lock size={12} /> Locked</Pill> : d.status === 'closed' ? <Pill kind="warn">Awaiting approval</Pill> : <Pill kind="neutral">Open</Pill>}<Link className="btn sm" to={`/closing?day=${d.day}`}>Open</Link></div>)}</Card>}
        {tab === 'audit' && <Card title="Audit log · everything that happened" right={<span className="help">latest 200</span>}><div className="scroll-x"><table className="table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Reason</th><th>Device</th></tr></thead><tbody>{audit.map((a) => <tr key={a.id}><td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.at)}</td><td>{who(a.user_id)}</td><td><b className={a.action === 'blocked' ? 'danger' : a.action === 'update' || a.action === 'delete' || a.action === 'unlock' ? 'warn' : ''}>{a.action}</b> {a.table_name}{a.action === 'update' && a.before && a.after ? <span className="muted"> · {diffSummary(a.before as Record<string, unknown>, a.after as Record<string, unknown>)}</span> : a.action === 'blocked' ? <span className="muted"> · {(a.after as { invoice_no?: string; attempted?: number })?.invoice_no} attempted {num((a.after as { attempted?: number })?.attempted ?? 0)}</span> : a.action === 'insert' ? <span className="muted"> · {num(Number((a.after as { amount?: number })?.amount ?? (a.after as { pos_total?: number })?.pos_total ?? (a.after as { counted_cash?: number })?.counted_cash ?? 0))}</span> : ''}</td><td>{a.reason}</td><td className="muted">{a.device}</td></tr>)}</tbody></table></div></Card>}
      </div>
      {addStaff && <Sheet title="Add staff member (no login)" onClose={() => setAddStaff(false)}>
        <Notice kind="info">For lower-level staff who don't use the app. Their medicine on credit and cash advances are tracked under Staff accounts.</Notice>
        <Field label="Name"><input className="input" value={ns.name} onChange={(e) => setNs({ ...ns, name: e.target.value })} data-testid="staff-name" /></Field>
        <Field label="Phone (optional)"><input className="input" inputMode="tel" value={ns.phone} onChange={(e) => setNs({ ...ns, phone: e.target.value })} /></Field>
        <Button kind="primary" size="big" disabled={busy} onClick={createStaff} data-testid="staff-save">Add staff member</Button>
      </Sheet>}
      {addUser && <Sheet title="Add login" onClose={() => setAddUser(false)}>
        <Field label="Name"><input className="input" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} /></Field>
        <Field label="Phone number (their login)"><input className="input" inputMode="tel" value={nu.phone} onChange={(e) => setNu({ ...nu, phone: e.target.value })} placeholder="03001234567" /></Field>
        <Field label="PIN (6 digits)"><input className="input num" inputMode="numeric" maxLength={6} value={nu.pin} onChange={(e) => setNu({ ...nu, pin: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Role"><Chips options={[{ value: 'cashier', label: 'Cashier' }, { value: 'manager', label: 'Manager' }, { value: 'owner', label: 'Owner' }]} value={nu.role} onChange={(v) => setNu({ ...nu, role: v })} /></Field>
        <Button kind="primary" size="big" disabled={busy} onClick={create}>Create login</Button>
      </Sheet>}
    </>
  );
}

function diffSummary(b: Record<string, unknown>, a: Record<string, unknown>) {
  return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !['created_at'].includes(k)).map((k) => `${k}: ${String(b[k])} → ${String(a[k])}`).join(', ');
}

// ---- Notifications ---------------------------------------------------------------
export function NotificationsPage() {
  const notifications = useStore((s) => s.notifications);
  const load = useStore((s) => s.loadNotifications);
  const [tab, setTab] = useState<'all' | 'alerts' | 'reminders' | 'approvals'>('all');
  const kinds: Record<typeof tab, string[] | null> = { all: null, alerts: ['closing_minus', 'duplicate_blocked', 'waw_outstanding', 'unposted_invoice'], reminders: ['payment_reminder'], approvals: ['closing_submitted', 'owner_paid_request', 'day_approved'] };
  const list = notifications.filter((n) => !kinds[tab] || kinds[tab]!.includes(n.kind));
  const link = (n: api.Notification) => n.ref_table === 'closings' ? '/closing' : n.ref_table === 'invoices' ? (n.kind === 'unposted_invoice' ? '/purchases?tab=unposted' : '/purchases') : n.ref_table === 'waw_loans' ? '/waw' : n.ref_table === 'payments' ? '/waw' : n.ref_table === 'reminders' ? '/purchases?tab=unpaid' : '/';
  const markAll = async () => { const ids = notifications.filter((n) => !n.read_at).map((n) => n.id); if (ids.length) { await api.markRead(ids); await load(); } };
  const isAlert = (k: string) => ['closing_minus', 'duplicate_blocked'].includes(k);
  return (
    <>
      <TopBar title="Notifications" sub={`${notifications.filter((n) => !n.read_at).length} unread`} right={<Button size="sm" onClick={markAll}>Mark all read</Button>} />
      <div className="content">
        <Chips options={[{ value: 'all', label: 'All' }, { value: 'alerts', label: 'Alerts' }, { value: 'reminders', label: 'Reminders' }, { value: 'approvals', label: 'Approvals' }]} value={tab} onChange={setTab} />
        <Card>{list.length === 0 ? <Empty>Nothing here</Empty> : list.map((n) => <Link to={link(n)} className="row" key={n.id} style={{ color: 'inherit', alignItems: 'flex-start' }} onClick={() => { if (!n.read_at) api.markRead([n.id]).then(load); }}><div className={`avatar ${isAlert(n.kind) ? 'danger' : n.kind === 'waw_outstanding' || n.kind === 'unposted_invoice' ? 'warn' : ''}`}><Icon.Bell size={16} /></div><div className="grow"><span className="t" style={{ fontWeight: n.read_at ? 700 : 800 }}>{n.title}</span><span className="s">{n.body}</span></div><span className="s" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(n.created_at)}</span></Link>)}</Card>
      </div>
    </>
  );
}

// ---- phone hubs ------------------------------------------------------------------
export function LedgersHub() {
  const isOwner = useIsOwner();
  return <><TopBar title="Ledgers" /><div className="content"><Card>
    <Link className="row" to="/distributors" style={{ color: 'inherit' }}><div className="avatar"><Icon.Distributors /></div><div className="grow"><span className="t">Distributors</span><span className="s">pending invoices, ledgers, reminders</span></div></Link>
    <Link className="row" to="/purchases" style={{ color: 'inherit' }}><div className="avatar"><Icon.Purchases /></div><div className="grow"><span className="t">Purchases</span><span className="s">invoices received, not posted in POS</span></div></Link>
    <Link className="row" to="/customers" style={{ color: 'inherit' }}><div className="avatar"><Icon.Customers /></div><div className="grow"><span className="t">Customer credit</span><span className="s">who owes the pharmacy</span></div></Link>
    <Link className="row" to="/staff" style={{ color: 'inherit' }}><div className="avatar"><Icon.Staff /></div><div className="grow"><span className="t">Staff accounts</span><span className="s">advances and medicine on credit</span></div></Link>
    <Link className="row" to="/waw" style={{ color: 'inherit' }}><div className="avatar"><Icon.Waw /></div><div className="grow"><span className="t">WAW F/S & owner money</span><span className="s">loans, invoices paid by the owner</span></div></Link>
    {isOwner && <Link className="row" to="/noncash" style={{ color: 'inherit' }}><div className="avatar"><Icon.Payments /></div><div className="grow"><span className="t">Non-cash received</span><span className="s">card and wallet money, minus owner-paid invoices</span></div></Link>}
  </Card></div></>;
}
export function MoreHub() {
  const profile = useStore((s) => s.profile)!;
  const unread = useStore((s) => s.notifications.filter((n) => !n.read_at).length);
  return <><TopBar title="More" sub={`${profile.name} · ${profile.role}`} /><div className="content"><Card>
    <Link className="row" to="/notifications" style={{ color: 'inherit' }}><div className="avatar"><Icon.Bell /></div><div className="grow"><span className="t">Notifications</span><span className="s">{unread} unread</span></div>{unread > 0 && <span className="badge danger">{unread}</span>}</Link>
    {profile.role !== 'cashier' && <Link className="row" to="/sales" style={{ color: 'inherit' }}><div className="avatar"><Icon.Sales /></div><div className="grow"><span className="t">Daily sale</span><span className="s">breakdown by day</span></div></Link>}
    {profile.role !== 'cashier' && <Link className="row" to="/reports" style={{ color: 'inherit' }}><div className="avatar"><Icon.Reports /></div><div className="grow"><span className="t">Reports</span><span className="s">any period, PDF with photos</span></div></Link>}
    {profile.role === 'owner' && <Link className="row" to="/insights" style={{ color: 'inherit' }}><div className="avatar"><Icon.Insights /></div><div className="grow"><span className="t">Insights</span><span className="s">ask any date range</span></div></Link>}
    {profile.role === 'owner' && <Link className="row" to="/settings" style={{ color: 'inherit' }}><div className="avatar"><Icon.Settings /></div><div className="grow"><span className="t">Settings</span><span className="s">users, roles, audit log</span></div></Link>}
    <a className="row" href="#" style={{ color: 'inherit' }} onClick={async (e) => { e.preventDefault(); const { signOut } = await import('../lib/auth'); await signOut(); location.href = '/login'; }}><div className="avatar danger"><Icon.X /></div><div className="grow"><span className="t">Sign out</span></div></a>
  </Card></div></>;
}
