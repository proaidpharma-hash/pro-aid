import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TopBar } from '../components/Shell';
import { Card, Field, AmountInput, amountOf, PhotoPicker, Button, Notice, Spinner, Pill, ProofLink, Chips, Empty, Sheet, Icon } from '../components/ui';
import { useStore, useIsOwner } from '../lib/store';
import * as api from '../lib/api';
import { DiffSettleSheet } from '../components/Posting';
import { today, num, fmtShort, initials, fmtDay } from '../lib/format';
import type { ProofPhoto } from '../lib/photos';

// ---- Distributors ---------------------------------------------------------------
export function DistributorsPage() {
  const refreshKey = useStore((s) => s.refreshKey);
  const [rows, setRows] = useState<api.DistributorBalance[] | null>(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'all' | 'pending' | 'overdue' | 'clear'>('all');
  useEffect(() => { api.distributorBalances().then(setRows).catch(() => undefined); }, [refreshKey]);
  const days = (d: string | null) => (d ? Math.round((new Date(today()).getTime() - new Date(d).getTime()) / 86400000) : 0);
  const list = (rows ?? []).filter((r) => r.name.toLowerCase().includes(q.toLowerCase())).filter((r) => tab === 'all' || (tab === 'pending' && r.pending > 0) || (tab === 'overdue' && days(r.oldest_open) >= 7 && r.pending > 0) || (tab === 'clear' && r.pending <= 0));
  const total = (rows ?? []).reduce((s, r) => s + r.pending, 0);
  return (
    <>
      <TopBar title="Distributors" sub={`${rows?.length ?? 0} active · ${num(total)} pending in total`} right={<Link to="/purchases/new" className="btn primary">+ Add purchase</Link>} />
      <div className="content">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="Search distributor" value={q} onChange={(e) => setQ(e.target.value)} />
          <Chips options={[{ value: 'all', label: 'All' }, { value: 'pending', label: 'Pending' }, { value: 'overdue', label: 'Overdue 7d+' }, { value: 'clear', label: 'Clear' }]} value={tab} onChange={setTab} />
        </div>
        <Card>{!rows ? <Spinner /> : list.length === 0 ? <Empty>No distributors</Empty> : list.map((r) => <Link to={`/distributors/${r.id}`} className="row" key={r.id} style={{ color: 'inherit' }}><div className="avatar">{initials(r.name)}</div><div className="grow"><span className="t">{r.name}</span><span className="s">{r.pending > 0 ? `${r.open_invoices} pending · oldest ${days(r.oldest_open)} days` : 'Clear'}{r.diff_pending > 0 ? <> · <b className="danger">they owe {num(r.diff_pending)} (posting difference)</b></> : ''}</span></div><span className={`amt num ${r.pending > 0 ? 'warn' : 'ok'}`}>{num(r.pending)}</span></Link>)}</Card>
      </div>
    </>
  );
}

export function DistributorDetail() {
  const { id } = useParams();
  const accounts = useStore((s) => s.accounts);
  const refreshKey = useStore((s) => s.refreshKey);
  const isOwner = useIsOwner();
  const toast = useStore((s) => s.toast);
  const [d, setD] = useState<api.Distributor | null>(null);
  const [invoices, setInvoices] = useState<api.InvoiceStatus[]>([]);
  const [payments, setPayments] = useState<api.Payment[]>([]);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [photos, setPhotos] = useState<api.Photo[]>([]);
  const [reminder, setReminder] = useState<api.InvoiceStatus | null>(null);
  const [settle, setSettle] = useState<api.InvoiceStatus | null>(null);
  const profile = useStore((s) => s.profile)!;
  useEffect(() => {
    if (!id) return;
    (async () => {
      const [ds, inv, prof] = await Promise.all([api.listDistributors(), api.invoiceStatus({ distributor_id: id }), api.listProfiles()]);
      setD(ds.find((x) => x.id === id) ?? null); setInvoices(inv); setProfiles(prof);
      const pays = (await Promise.all(inv.map((i) => api.listPayments({ invoice_id: i.id })))).flat();
      setPayments(pays);
      setPhotos(await api.getPhotos([...inv.map((i) => i.photo_id), ...pays.map((p) => p.photo_id)]));
    })().catch((e) => toast((e as Error).message, 'danger'));
  }, [id, refreshKey, toast]);
  if (!d) return <><TopBar title="Distributor" back /><Spinner /></>;
  const pending = invoices.reduce((s, i) => s + i.remaining, 0) + d.opening_balance;
  const diffPending = invoices.reduce((s, i) => s + i.diff_pending, 0);
  const diffInvoices = invoices.filter((i) => i.diff_pending > 0);
  const month = today().slice(0, 7);
  const purchasedMonth = invoices.filter((i) => i.day.startsWith(month)).reduce((s, i) => s + i.amount, 0);
  const paidMonth = payments.filter((p) => p.day.startsWith(month)).reduce((s, p) => s + p.amount, 0);
  const who = (uid: string) => profiles.find((p) => p.id === uid)?.name ?? '';
  const acc = (aid: string) => accounts.find((a) => a.id === aid);
  const ph = (pid: string) => photos.find((p) => p.id === pid)?.storage_path;
  type Row = { at: string; day: string; kind: 'invoice' | 'payment'; inv: api.InvoiceStatus; pay?: api.Payment };
  const rows: Row[] = [...invoices.map((i) => ({ at: i.created_at, day: i.day, kind: 'invoice' as const, inv: i })), ...payments.map((p) => ({ at: p.created_at, day: p.day, kind: 'payment' as const, inv: invoices.find((i) => i.id === p.invoice_id)!, pay: p }))].sort((a, b) => (b.day + b.at).localeCompare(a.day + a.at));
  return (
    <>
      <TopBar title={d.name} sub={[d.rep_name && `Rep: ${d.rep_name}`, d.phone, d.delivery_days && `delivers ${d.delivery_days}`].filter(Boolean).join(' · ')} back right={<><Link className="btn" to={`/purchases/new?distributor=${d.id}`}>Add purchase</Link><Link className="btn primary" to={`/pay?distributor=${d.id}`}>Record payment</Link></>} />
      <div className="content">
        <div className="grid grid-3">
          <div className="card kpi warn"><div className="label">Pending now</div><div className="value num">{num(pending)}</div>{d.opening_balance > 0 && <div className="hint">includes opening balance {num(d.opening_balance)}</div>}</div>
          <div className="card kpi"><div className="label">Purchased this month</div><div className="value num">{num(purchasedMonth)}</div></div>
          <div className="card kpi ok"><div className="label">Paid this month</div><div className="value num">{num(paidMonth)}</div></div>
        </div>
        {diffInvoices.length > 0 && <Card kind="danger" title={`They owe us · posting differences · ${num(diffPending)}`} right={<span className="help">paid in full, but less was posted in POS</span>}>
          {diffInvoices.map((i) => <div className="row wrap" key={i.id}><div className="grow"><span className="t">Inv {i.invoice_no} · invoice {num(i.amount)} · posted {num(i.posted_amount)}</span><span className="s">{i.post_diff_kind ? api.DIFF_KIND_LABEL[i.post_diff_kind] : ''}{i.post_diff_note ? ` · ${i.post_diff_note}` : ''}{i.diff_settled > 0 ? ` · ${num(i.diff_settled)} already settled` : ''}</span></div><span className="amt num danger">{num(i.diff_pending)}</span>{(profile.role === 'owner' || profile.role === 'manager') && <Button size="sm" kind="primary" onClick={() => setSettle(i)}>Settle…</Button>}</div>)}
        </Card>}
        <Card title="Ledger">
          {rows.length === 0 ? <Empty>No invoices yet</Empty> : rows.map((r, idx) => {
            if (r.kind === 'invoice') return <div className="row" key={idx}><div className="datebox"><b>{fmtShort(r.day).split(' ')[0]}</b><span>{fmtShort(r.day).split(' ')[1].toUpperCase()}</span></div><div className="grow"><span className="t">Stock · Inv {r.inv.invoice_no}{!r.inv.posted_in_pos && <> · <span className="danger">not posted in POS</span></>}</span><span className="s">{r.inv.remaining <= 0 ? <span className="ok">Paid in full</span> : r.inv.installments_planned ? <span className="warn">Installments {r.inv.payments_made}/{r.inv.installments_planned} · {num(r.inv.remaining)} left{r.inv.next_due ? ` · next ${fmtShort(r.inv.next_due)}` : ''}</span> : r.inv.paid > 0 ? <span className="warn">Part paid · {num(r.inv.remaining)} left</span> : <span className="warn">Pending {num(r.inv.remaining)}</span>} · {who(r.inv.entered_by)}</span></div><span style={{ display: 'flex', gap: 4 }}><ProofLink storagePath={ph(r.inv.photo_id)} />{r.inv.remaining > 0 && <button type="button" className="btn ghost sm" onClick={() => setReminder(r.inv)} title="Set reminder"><Icon.Bell size={14} /></button>}{isOwner && <Link className="btn ghost sm" to={`?edit=invoices:${r.inv.id}`}>Edit</Link>}</span><span className="amt num">{num(r.inv.amount)}</span></div>;
            const p = r.pay!; const a = acc(p.account_id);
            return <div className="row" key={idx}><div className="datebox"><b>{fmtShort(r.day).split(' ')[0]}</b><span>{fmtShort(r.day).split(' ')[1].toUpperCase()}</span></div><div className="grow"><span className="t">Payment · Inv {r.inv.invoice_no}{p.installment_no && r.inv.installments_planned ? ` · ${p.installment_no} of ${r.inv.installments_planned}` : ''}</span><span className="s">{a?.kind === 'cash_drawer' ? (p.cash_source === 'yesterday' ? "Yesterday's cash" : "Today's cash") : a?.kind === 'owner_personal' ? "Owner's personal account" : a?.name} · by {who(p.entered_by)}{p.device ? ` · ${p.device}` : ''}</span></div><span style={{ display: 'flex', gap: 4 }}><ProofLink storagePath={ph(p.photo_id)} />{isOwner && <Link className="btn ghost sm" to={`?edit=payments:${p.id}`}>Edit</Link>}</span><span className="amt num ok">− {num(p.amount)}</span></div>;
          })}
        </Card>
      </div>
      {settle && <DiffSettleSheet invoice={settle} userId={profile.id} onClose={() => setSettle(null)} onSaved={() => { setSettle(null); useStore.getState().bump(); }} />}
      {reminder && <ReminderSheet invoice={reminder} onClose={() => setReminder(null)} />}
    </>
  );
}

export function ReminderSheet({ invoice, onClose }: { invoice: api.InvoiceStatus; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [date, setDate] = useState(invoice.next_due || today());
  const [time, setTime] = useState('09:00');
  const [amount, setAmount] = useState(String(Math.round(invoice.installments_planned ? invoice.remaining / Math.max(1, invoice.installments_planned - invoice.payments_made) : invoice.remaining)));
  const [all, setAll] = useState<'all' | 'me'>('all');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.addReminder({ invoice_id: invoice.id, title: `Payment due · ${invoice.distributor_name} · Inv ${invoice.invoice_no}`, amount: amountOf(amount) || null, remind_at: new Date(`${date}T${time}:00`).toISOString(), notify_all: all === 'all', repeat_daily: true }); toast('Reminder set', 'ok'); onClose(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return <Sheet title="Remind about this payment" onClose={onClose}>
    <div className="help">{invoice.distributor_name} · Inv {invoice.invoice_no} · {num(invoice.remaining)} remaining</div>
    <div className="grid grid-2"><Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field><Field label="Time"><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field></div>
    <div className="chips"><button type="button" className="chip" onClick={() => { const d = new Date(); d.setDate(d.getDate() + 1); setDate(d.toISOString().slice(0, 10)); }}>Tomorrow</button>{invoice.next_due && <button type="button" className="chip" onClick={() => setDate(invoice.next_due!)}>Next installment due</button>}<button type="button" className="chip" onClick={() => { const d = new Date(); d.setDate(d.getDate() + 7); setDate(d.toISOString().slice(0, 10)); }}>In 1 week</button></div>
    <Field label="Amount to clear"><AmountInput big={false} value={amount} onChange={setAmount} /></Field>
    <Field label="Notify"><Chips options={[{ value: 'all', label: 'Everyone' }, { value: 'me', label: 'Only me' }]} value={all} onChange={setAll} /></Field>
    <div className="help">Repeats every morning until the payment is recorded, then clears itself.</div>
    <Button kind="primary" size="big" disabled={busy} onClick={save}>Set reminder</Button>
  </Sheet>;
}

// ---- Customers (credit) ----------------------------------------------------------
export function CustomersPage() {
  const profile = useStore((s) => s.profile)!;
  const accounts = useStore((s) => s.accounts);
  const refreshKey = useStore((s) => s.refreshKey);
  const toast = useStore((s) => s.toast);
  const [rows, setRows] = useState<api.CustomerBalance[] | null>(null);
  const [bills, setBills] = useState<api.CreditBill[]>([]);
  const [colls, setColls] = useState<api.CreditCollection[]>([]);
  const [photos, setPhotos] = useState<api.Photo[]>([]);
  const [tab, setTab] = useState<'owing' | 'old' | 'clear'>('owing');
  const [sheet, setSheet] = useState<'bill' | 'collect' | null>(null);
  const [customers, setCustomers] = useState<api.Customer[]>([]);
  const load = async () => { const [r, b, c, cu] = await Promise.all([api.customerBalances(), api.listCreditBills(), api.listCreditCollections(), api.listCustomers()]); setRows(r); setBills(b); setColls(c); setCustomers(cu); setPhotos(await api.getPhotos([...b, ...c].slice(0, 100).map((x) => x.photo_id))); };
  useEffect(() => { load().catch((e) => toast((e as Error).message, 'danger')); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = (d: string | null) => (d ? Math.round((new Date(today()).getTime() - new Date(d).getTime()) / 86400000) : 0);
  const list = (rows ?? []).filter((r) => (tab === 'owing' && r.owed > 0) || (tab === 'old' && r.owed > 0 && days(r.since) >= 15) || (tab === 'clear' && r.owed <= 0));
  const total = (rows ?? []).reduce((s, r) => s + Math.max(0, r.owed), 0);
  const ph = (pid: string) => photos.find((p) => p.id === pid)?.storage_path;
  return (
    <>
      <TopBar title="Customer credit" sub={`Who owes the pharmacy · ${num(total)}`} right={<><Button onClick={() => setSheet('bill')}>New credit bill</Button><Button kind="primary" onClick={() => setSheet('collect')}>Collect payment</Button></>} />
      <div className="content">
        <Chips options={[{ value: 'owing', label: 'Owing' }, { value: 'old', label: 'Over 15 days' }, { value: 'clear', label: 'Cleared' }]} value={tab} onChange={setTab} />
        {!rows ? <Spinner /> : list.length === 0 ? <Card><Empty>Nobody here</Empty></Card> : list.map((c) => (
          <Card key={c.id} title={<span>{c.name}{c.phone ? <span className="muted"> · {c.phone}</span> : ''}</span>} right={c.owed > 0 ? <span className="num warn" style={{ fontWeight: 800 }}>owes {num(c.owed)}</span> : <Pill kind="ok">Clear</Pill>}>
            {[...bills.filter((b) => b.customer_id === c.id).map((b) => ({ day: b.day, k: 'bill' as const, b })), ...colls.filter((x) => x.customer_id === c.id).map((x) => ({ day: x.day, k: 'coll' as const, x }))].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 6).map((r, i) => r.k === 'bill'
              ? <div className="row" key={i}><div className="datebox"><b>{fmtShort(r.b.day).split(' ')[0]}</b><span>{fmtShort(r.b.day).split(' ')[1].toUpperCase()}</span></div><div className="grow"><span className="t">Bill {r.b.bill_no}</span><span className="s">{days(r.b.day)} days ago</span></div><ProofLink storagePath={ph(r.b.photo_id)} /><span className="amt num warn">{num(r.b.amount)}</span></div>
              : <div className="row" key={i}><div className="datebox"><b>{fmtShort(r.x.day).split(' ')[0]}</b><span>{fmtShort(r.x.day).split(' ')[1].toUpperCase()}</span></div><div className="grow"><span className="t">Collected · {accounts.find((a) => a.id === r.x.account_id)?.kind === 'cash_drawer' ? 'cash' : accounts.find((a) => a.id === r.x.account_id)?.name}</span><span className="s">receipt photo</span></div><ProofLink storagePath={ph(r.x.photo_id)} /><span className="amt num ok">− {num(r.x.amount)}</span></div>)}
          </Card>
        ))}
      </div>
      {sheet && <CreditSheet kind={sheet} customers={customers} balances={rows ?? []} userId={profile.id} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); useStore.getState().bump(); }} />}
    </>
  );
}

function CreditSheet({ kind, customers, balances, userId, onClose, onSaved }: { kind: 'bill' | 'collect'; customers: api.Customer[]; balances: api.CustomerBalance[]; userId: string; onClose: () => void; onSaved: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const toast = useStore((s) => s.toast);
  const [custId, setCustId] = useState('');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [billNo, setBillNo] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState(accounts.find((a) => a.kind === 'cash_drawer')?.id ?? '');
  const [day, setDay] = useState(today());
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const owed = balances.find((b) => b.id === custId)?.owed ?? 0;
  const amt = amountOf(amount);
  const canSave = (custId || newName.trim()) && amt > 0 && photo && (kind === 'bill' ? billNo.trim() : accountId && amt <= owed) && !busy;
  const save = async () => {
    if (!canSave || !photo) return;
    setBusy(true);
    try {
      let cid = custId;
      if (!cid) { const c = await api.addCustomer({ name: newName.trim(), phone: newPhone || null }); cid = c.id; }
      if (kind === 'bill') await api.addCreditBill({ customer_id: cid, day, bill_no: billNo.trim(), amount: amt, photo_id: photo.id });
      else await api.addCreditCollection({ customer_id: cid, day, amount: amt, account_id: accountId, photo_id: photo.id });
      toast(kind === 'bill' ? 'Credit bill saved' : 'Collection saved', 'ok'); onSaved();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return <Sheet title={kind === 'bill' ? 'New credit bill' : 'Collect credit payment'} onClose={onClose}>
    <Field label="Customer"><select className="select" value={custId} onChange={(e) => setCustId(e.target.value)}><option value="">{kind === 'bill' ? 'New customer…' : 'Choose…'}</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}{(balances.find((b) => b.id === c.id)?.owed ?? 0) > 0 ? ` · owes ${num(balances.find((b) => b.id === c.id)!.owed)}` : ''}</option>)}</select></Field>
    {!custId && kind === 'bill' && <div className="grid grid-2"><Field label="Name"><input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} /></Field><Field label="Phone"><input className="input" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} /></Field></div>}
    {kind === 'bill' && <Field label="Bill no"><input className="input num" value={billNo} onChange={(e) => setBillNo(e.target.value)} /></Field>}
    <Field label="Amount" error={kind === 'collect' && custId && amt > owed ? `More than owed (${num(owed)})` : undefined}><AmountInput big={false} value={amount} onChange={setAmount} /></Field>
    {kind === 'collect' && <Field label="Received as"><Chips options={accounts.filter((a) => ['cash_drawer', 'wallet', 'bank'].includes(a.kind)).map((a) => ({ value: a.id, label: a.kind === 'cash_drawer' ? 'Cash into drawer' : a.name }))} value={accountId} onChange={setAccountId} /></Field>}
    <Field label="Date"><input className="input" type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} /></Field>
    <PhotoPicker label={kind === 'bill' ? 'Bill photo' : 'Receipt / screenshot'} value={photo} onChange={setPhoto} userId={userId} />
    <Button kind="primary" size="big" disabled={!canSave} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
  </Sheet>;
}

// ---- Staff ------------------------------------------------------------------
export function StaffPage() {
  const refreshKey = useStore((s) => s.refreshKey);
  const profile = useStore((s) => s.profile)!;
  const [rows, setRows] = useState<api.StaffBalance[] | null>(null);
  useEffect(() => { api.staffBalances().then(setRows).catch(() => undefined); }, [refreshKey]);
  const list = (rows ?? []).filter((r) => profile.role === 'owner' || r.id === profile.id);
  return (
    <>
      <TopBar title="Staff accounts" sub={profile.role === 'owner' ? 'Advances and medicine on credit · added by the owner only' : 'Your account'} />
      <div className="content"><Card>{!rows ? <Spinner /> : list.map((r) => <Link to={`/staff/${r.id}`} className="row" key={r.id} style={{ color: 'inherit' }}><div className="avatar">{initials(r.name)}</div><div className="grow"><span className="t">{r.name}</span><span className="s">{r.role === 'staff' ? 'staff · no login' : r.role}{r.active ? '' : ' · disabled'}</span></div><span className={`amt num ${r.owed > 0 ? 'warn' : 'ok'}`}>{r.owed > 0 ? `owes ${num(r.owed)}` : 'Clear'}</span></Link>)}</Card></div>
    </>
  );
}

export function StaffDetail() {
  const { id } = useParams();
  const isOwner = useIsOwner();
  const profile = useStore((s) => s.profile)!;
  const refreshKey = useStore((s) => s.refreshKey);
  const toast = useStore((s) => s.toast);
  const [staff, setStaff] = useState<api.StaffBalance | null>(null);
  const [entries, setEntries] = useState<api.StaffEntry[]>([]);
  const [photos, setPhotos] = useState<api.Photo[]>([]);
  const [sheet, setSheet] = useState<'advance' | 'settle' | null>(null);
  useEffect(() => { if (!id) return; (async () => { const [b, e] = await Promise.all([api.staffBalances(), api.listStaffEntries(id)]); setStaff(b.find((x) => x.id === id) ?? null); setEntries(e); setPhotos(await api.getPhotos(e.map((x) => x.photo_id))); })().catch((e) => toast((e as Error).message, 'danger')); }, [id, refreshKey, toast]);
  if (!staff) return <><TopBar title="Staff" back /><Spinner /></>;
  const advances = entries.filter((e) => e.kind === 'advance_sale_cash' || e.kind === 'advance_purchase_cash').reduce((s, e) => s + e.amount, 0);
  const medicine = entries.filter((e) => e.kind === 'medicine_credit').reduce((s, e) => s + e.amount, 0);
  const label: Record<api.StaffEntryKind, string> = { advance_sale_cash: 'Advance from sale cash', advance_purchase_cash: 'Advance from purchase cash', medicine_credit: 'Medicine on credit', salary_deduction: 'Deducted from salary', cash_repayment: 'Repaid in cash' };
  return (
    <>
      <TopBar title={staff.name} sub={staff.role} back right={isOwner && <><Button onClick={() => setSheet('advance')}>Add advance / credit</Button><Button kind="primary" onClick={() => setSheet('settle')}>Settle</Button></>} />
      <div className="content">
        <div className="grid grid-3"><div className="card kpi warn"><div className="label">Owes</div><div className="value num">{num(Math.max(0, staff.owed))}</div></div><div className="card kpi"><div className="label">Advances (all time)</div><div className="value num">{num(advances)}</div></div><div className="card kpi"><div className="label">Medicine (all time)</div><div className="value num">{num(medicine)}</div></div></div>
        <Card>{entries.length === 0 ? <Empty>No entries</Empty> : entries.map((e) => <div className="row" key={e.id}><div className="datebox"><b>{fmtShort(e.day).split(' ')[0]}</b><span>{fmtShort(e.day).split(' ')[1].toUpperCase()}</span></div><div className="grow"><span className="t">{label[e.kind]}{e.bill_no ? ` · bill ${e.bill_no}` : ''}</span><span className="s">{e.note || 'approved by owner'}</span></div><ProofLink storagePath={photos.find((p) => p.id === e.photo_id)?.storage_path} /><span className={`amt num ${e.kind === 'salary_deduction' || e.kind === 'cash_repayment' ? 'ok' : 'warn'}`}>{e.kind === 'salary_deduction' || e.kind === 'cash_repayment' ? '− ' : '+ '}{num(e.amount)}</span></div>)}</Card>
        <div className="help">Advances and credit are added only by the owner. Staff can view their own account.</div>
      </div>
      {sheet && <StaffSheet kind={sheet} staffId={staff.id} owed={staff.owed} userId={profile.id} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); useStore.getState().bump(); }} />}
    </>
  );
}

function StaffSheet({ kind, staffId, owed, userId, onClose, onSaved }: { kind: 'advance' | 'settle'; staffId: string; owed: number; userId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useStore((s) => s.toast);
  const [k, setK] = useState<api.StaffEntryKind>(kind === 'advance' ? 'advance_sale_cash' : 'salary_deduction');
  const [amount, setAmount] = useState('');
  const [billNo, setBillNo] = useState('');
  const [note, setNote] = useState('');
  const [day, setDay] = useState(today());
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const amt = amountOf(amount);
  const canSave = amt > 0 && photo && !busy && (kind === 'advance' || amt <= owed);
  const save = async () => { if (!canSave || !photo) return; setBusy(true); try { await api.addStaffEntry({ staff_id: staffId, day, kind: k, amount: amt, bill_no: billNo || null, note: note || null, photo_id: photo.id }); toast('Saved', 'ok'); onSaved(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); } };
  return <Sheet title={kind === 'advance' ? 'Advance or credit' : 'Settle'} onClose={onClose}>
    <Chips options={kind === 'advance' ? [{ value: 'advance_sale_cash', label: 'Advance from sale cash' }, { value: 'advance_purchase_cash', label: 'Advance from purchase cash' }, { value: 'medicine_credit', label: 'Medicine on credit' }] : [{ value: 'salary_deduction', label: 'Deduct from salary' }, { value: 'cash_repayment', label: 'Repaid in cash' }]} value={k} onChange={setK} />
    <Field label="Amount" error={kind === 'settle' && amt > owed ? `More than owed (${num(owed)})` : undefined}><AmountInput big={false} value={amount} onChange={setAmount} /></Field>
    {k === 'medicine_credit' && <Field label="Bill no"><input className="input num" value={billNo} onChange={(e) => setBillNo(e.target.value)} /></Field>}
    <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    <Field label="Date"><input className="input" type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} /></Field>
    <PhotoPicker label={k === 'medicine_credit' ? 'Bill photo' : 'Slip photo'} value={photo} onChange={setPhoto} userId={userId} />
    <Button kind="primary" size="big" disabled={!canSave} onClick={save}>Save</Button>
  </Sheet>;
}

// ---- WAW F/S loans & owner money -------------------------------------------------
export function WawPage() {
  const profile = useStore((s) => s.profile)!;
  const accounts = useStore((s) => s.accounts);
  const isOwner = useIsOwner();
  const refreshKey = useStore((s) => s.refreshKey);
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const [loans, setLoans] = useState<api.WawLoan[]>([]);
  const [owed, setOwed] = useState(0);
  const [ownerPaid, setOwnerPaid] = useState<api.OwnerPaid[]>([]);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [photos, setPhotos] = useState<api.Photo[]>([]);
  const [sheet, setSheet] = useState<'borrow' | 'repay' | null>(null);
  const [settle, setSettle] = useState<api.OwnerPaid | null>(null);
  useEffect(() => { (async () => { const [l, o, op, p] = await Promise.all([api.listWaw(), api.wawOutstanding(), api.ownerPaid(), api.listProfiles()]); setLoans(l); setOwed(o); setOwnerPaid(op); setProfiles(p); setPhotos(await api.getPhotos([...l.map((x) => x.photo_id), ...op.map((x) => x.photo_id)])); })().catch((e) => toast((e as Error).message, 'danger')); }, [refreshKey, toast]);
  const owedOwner = ownerPaid.reduce((s, o) => s + o.unsettled, 0);
  const who = (id: string | null) => profiles.find((p) => p.id === id)?.name ?? '';
  const ph = (id: string) => photos.find((p) => p.id === id)?.storage_path;
  return (
    <>
      <TopBar title="WAW F/S & owner money" sub="Loans from the fuel station and invoices paid from the owner's account" right={<><Button onClick={() => setSheet('borrow')}>Borrow from WAW F/S</Button><Button kind="primary" onClick={() => setSheet('repay')} disabled={owed <= 0}>Repay WAW F/S</Button>{isOwner && <Button onClick={() => navigate('/noncash')}>Non-cash received</Button>}</>} />
      <div className="content">
        <div className="grid grid-2"><div className={`card kpi ${owed > 0 ? 'danger' : 'ok'}`}><div className="label">Owed to WAW F/S</div><div className="value num">{num(owed)}</div><div className="hint">{owed > 0 ? 'Owner is notified every morning until repaid in full' : 'Nothing owed'}</div></div><div className="card kpi accent"><div className="label">Owed to owner (personal account)</div><div className="value num">{num(owedOwner)}</div><div className="hint">{ownerPaid.filter((o) => o.unsettled > 0).length} invoices not yet settled</div></div></div>
        <Card title="Borrowed from WAW F/S">{loans.length === 0 ? <Empty>No loans</Empty> : loans.map((l) => <div className="row" key={l.id}><div className="datebox"><b>{fmtShort(l.day).split(' ')[0]}</b><span>{fmtShort(l.day).split(' ')[1].toUpperCase()}</span></div><div className="grow"><span className="t">{l.kind === 'borrow' ? 'Borrowed' : 'Repaid'} · {accounts.find((a) => a.id === l.account_id)?.kind === 'cash_drawer' ? 'cash' : accounts.find((a) => a.id === l.account_id)?.name}</span><span className="s">{l.handled_by ? `${l.handled_by} · ` : ''}{l.note ? `${l.note} · ` : ''}by {who(l.entered_by)}</span></div><ProofLink storagePath={ph(l.photo_id)} /><span className={`amt num ${l.kind === 'borrow' ? 'danger' : 'ok'}`}>{l.kind === 'borrow' ? '+ ' : '− '}{num(l.amount)}</span></div>)}</Card>
        <Card title="Invoices paid from the owner's personal account">{ownerPaid.length === 0 ? <Empty>None</Empty> : ownerPaid.map((o) => <div className="row" key={o.payment_id}><div className="datebox"><b>{fmtShort(o.day).split(' ')[0]}</b><span>{fmtShort(o.day).split(' ')[1].toUpperCase()}</span></div><div className="grow"><span className="t">{o.distributor_name} · Inv {o.invoice_no}</span><span className="s">Requested by {who(o.requested_by)} · {o.unsettled <= 0 ? <span className="ok">settled</span> : o.settled > 0 ? `${num(o.settled)} settled · ${num(o.unsettled)} left` : 'not settled'}</span></div><ProofLink storagePath={ph(o.photo_id)} />{isOwner && o.unsettled > 0 && <Button size="sm" kind="primary" onClick={() => setSettle(o)}>Settle</Button>}<span className="amt num">{num(o.amount)}</span></div>)}</Card>
      </div>
      {sheet && <WawSheet kind={sheet} owed={owed} userId={profile.id} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); useStore.getState().bump(); }} />}
      {settle && <SettleSheet item={settle} userId={profile.id} onClose={() => setSettle(null)} onSaved={() => { setSettle(null); useStore.getState().bump(); }} />}
    </>
  );
}

function WawSheet({ kind, owed, userId, onClose, onSaved }: { kind: 'borrow' | 'repay'; owed: number; userId: string; onClose: () => void; onSaved: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const toast = useStore((s) => s.toast);
  const [k, setK] = useState(kind);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState(accounts.find((a) => a.kind === 'cash_drawer')?.id ?? '');
  const [handled, setHandled] = useState('');
  const [note, setNote] = useState('');
  const [day, setDay] = useState(today());
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const amt = amountOf(amount);
  const over = k === 'repay' && amt > owed;
  const canSave = amt > 0 && !over && accountId && photo && !busy;
  const save = async () => { if (!canSave || !photo) return; setBusy(true); try { await api.addWaw({ day, kind: k, amount: amt, account_id: accountId, handled_by: handled || null, note: note || null, photo_id: photo.id }); toast('Saved', 'ok'); onSaved(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); } };
  return <Sheet title="WAW F/S" onClose={onClose}>
    <Chips options={[{ value: 'borrow', label: 'Borrow from WAW F/S' }, { value: 'repay', label: 'Repay WAW F/S' }]} value={k} onChange={setK} />
    <Field label="Amount" error={over ? `More than owed (${num(owed)})` : undefined}><AmountInput big={false} value={amount} onChange={setAmount} /></Field>
    {k === 'repay' && owed > 0 && <div className="chips"><button type="button" className="chip" onClick={() => setAmount(String(owed))}>Full {num(owed)}</button></div>}
    <Field label={k === 'borrow' ? 'Received as' : 'Paid from'}><Chips options={accounts.filter((a) => ['cash_drawer', 'bank', 'wallet'].includes(a.kind)).map((a) => ({ value: a.id, label: a.kind === 'cash_drawer' ? 'Cash drawer' : a.name }))} value={accountId} onChange={setAccountId} /></Field>
    <Field label={k === 'borrow' ? 'Taken by · reason' : 'Handed over by · received at WAW by'}><input className="input" value={handled} onChange={(e) => setHandled(e.target.value)} placeholder={k === 'borrow' ? 'Ahmed · for Getz payment' : 'Bilal → Rehman'} /></Field>
    <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    <Field label="Date"><input className="input" type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} /></Field>
    <PhotoPicker label="Slip / transfer screenshot" hint="WAW F/S receipt or bank app screenshot" value={photo} onChange={setPhoto} userId={userId} />
    {k === 'repay' && amt > 0 && !over && <Notice kind={owed - amt > 0 ? 'warn' : 'ok'}>{owed - amt > 0 ? `After this: ${num(owed - amt)} still owed · owner keeps getting the 9:00 am reminder` : 'This clears the loan · reminders stop'}</Notice>}
    <Button kind="primary" size="big" disabled={!canSave} onClick={save}>{busy ? 'Saving…' : k === 'borrow' ? 'Save loan' : 'Save repayment'}</Button>
  </Sheet>;
}

export function SettleSheet({ item, userId, onClose, onSaved }: { item: api.OwnerPaid; userId: string; onClose: () => void; onSaved: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const toast = useStore((s) => s.toast);
  const [kind, setKind] = useState<'minus_receipts' | 'cash_return'>('minus_receipts');
  const [accountId, setAccountId] = useState<string | 'overall'>('overall');
  const [amount, setAmount] = useState(String(item.unsettled));
  const [pool, setPool] = useState<{ rows: api.NonCashRow[]; overallMinus: number } | null>(null);
  const [day, setDay] = useState(today());
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const f = new Date(); f.setDate(1); api.nonCashPool(f.toISOString().slice(0, 10), today()).then(setPool).catch(() => undefined); }, []);
  const amt = amountOf(amount);
  const over = amt > item.unsettled;
  const canSave = amt > 0 && !over && photo && !busy;
  const save = async () => { if (!canSave || !photo) return; setBusy(true); try { await api.addSettlement({ payment_id: item.payment_id, day, kind, account_id: kind === 'cash_return' || accountId === 'overall' ? null : accountId, amount: amt, photo_id: photo.id }); toast('Settled', 'ok'); onSaved(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); } };
  const totalRemaining = pool ? pool.rows.reduce((s, r) => s + r.remaining, 0) - pool.overallMinus : 0;
  return <Sheet title={`Settle ${num(item.unsettled)} · ${item.distributor_name} · Inv ${item.invoice_no}`} onClose={onClose}>
    <Chips options={[{ value: 'minus_receipts', label: 'Minus from card / online receipts' }, { value: 'cash_return', label: 'Returned in cash from drawer' }]} value={kind} onChange={setKind} />
    {kind === 'minus_receipts' && <Field label="Where should this come from? (this month's receipts)"><div className="tiles">{pool?.rows.map((r) => <button type="button" key={r.account_id} className={`tile ${accountId === r.account_id ? 'on' : ''}`} onClick={() => setAccountId(r.account_id)}><b>{r.account_name}</b><span>{num(r.remaining)} left</span></button>)}<button type="button" className={`tile ${accountId === 'overall' ? 'on' : ''}`} style={{ borderStyle: 'dashed' }} onClick={() => setAccountId('overall')}><b>Overall total</b><span>no account · {num(totalRemaining)} left</span></button></div></Field>}
    <Field label="Amount" error={over ? `More than unsettled (${num(item.unsettled)})` : undefined}><AmountInput big={false} value={amount} onChange={setAmount} /></Field>
    <Field label="Date"><input className="input" type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} /></Field>
    <PhotoPicker label={kind === 'cash_return' ? 'Cash handover photo' : 'Account statement screenshot'} value={photo} onChange={setPhoto} userId={userId} />
    {kind === 'cash_return' && <Notice kind="warn">This is recorded as a cash payout in today's cash book, so the drawer check still balances.</Notice>}
    <Button kind="primary" size="big" disabled={!canSave} onClick={save}>{busy ? 'Saving…' : kind === 'cash_return' ? `Record ${num(amt)} returned in cash` : `Minus ${num(amt)} from ${accountId === 'overall' ? 'overall total' : accounts.find((a) => a.id === accountId)?.name ?? ''}`}</Button>
  </Sheet>;
}

export function fmtDayLabel(d: string) { return fmtDay(d); }
