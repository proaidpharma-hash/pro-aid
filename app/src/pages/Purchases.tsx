import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { TopBar } from '../components/Shell';
import { Card, Field, AmountInput, amountOf, PhotoPicker, Button, Notice, Spinner, Pill, ProofLink, Chips, Empty, Sheet } from '../components/ui';
import { useStore, useIsManagerOrOwner, useIsOwner, useCanWrite } from '../lib/store';
import * as api from '../lib/api';
import { PaymentLinesEditor, useSourceOptions, paymentLinesTotal, paymentLinesProblem, postPaymentLines, newLine, type PaymentLine } from '../components/PaymentLines';
import { PostedSheet } from '../components/Posting';
import { today, fmtDay, num, fmtShort, initials } from '../lib/format';
import type { ProofPhoto } from '../lib/photos';

type Tab = 'all' | 'unpaid' | 'installments' | 'unposted';

export function PurchasesPage() {
  const canWrite = useCanWrite();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'all';
  const refreshKey = useStore((s) => s.refreshKey);
  const canPost = useIsManagerOrOwner();
  const isOwner = useIsOwner();
  const toast = useStore((s) => s.toast);
  const [rows, setRows] = useState<api.InvoiceStatus[] | null>(null);
  const [photos, setPhotos] = useState<api.Photo[]>([]);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  useEffect(() => {
    (async () => {
      const [r, p] = await Promise.all([api.invoiceStatus(tab === 'all' ? undefined : { unpaid: tab === 'unpaid', installments: tab === 'installments', unposted: tab === 'unposted' }), api.listProfiles()]);
      setRows(r); setProfiles(p); setPhotos(await api.getPhotos(r.slice(0, 60).map((i) => i.photo_id)));
    })().catch((e) => toast((e as Error).message, 'danger'));
  }, [tab, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const unpostedCount = useMemo(() => rows?.filter((r) => !r.posted_in_pos).length ?? 0, [rows]);
  const [posting, setPosting] = useState<api.InvoiceStatus | null>(null);
  const who = (id: string | null) => profiles.find((p) => p.id === id)?.name ?? '';
  const days = (d: string) => Math.max(0, Math.round((new Date(today()).getTime() - new Date(d).getTime()) / 86400000));
  return (
    <>
      <TopBar title="Purchases" sub="Every invoice received, with payment and POS posting status" right={canWrite && (<Link to="/purchases/new" className="btn primary">+ Add purchase</Link>)} />
      <div className="content">
        <div className="chips">
          {(['all', 'unpaid', 'installments', 'unposted'] as Tab[]).map((t) => <button key={t} type="button" className={`chip ${tab === t ? (t === 'unposted' ? 'warn on' : 'on') : ''}`} onClick={() => setParams({ tab: t })}>{t === 'all' ? 'All' : t === 'unpaid' ? 'Unpaid' : t === 'installments' ? 'On installments' : `Not posted in POS${tab === 'all' && unpostedCount ? ` · ${unpostedCount}` : ''}`}</button>)}
        </div>
        {tab === 'unposted' && rows && rows.length > 0 && <Notice kind="warn">{rows.length} invoice{rows.length > 1 ? 's' : ''} worth {num(rows.reduce((s, r) => s + r.amount, 0))} received but not yet entered into the POS system. Until they are posted, POS stock and sale figures will not match.</Notice>}
        {!rows ? <Spinner /> : rows.length === 0 ? <Card><Empty>Nothing here</Empty></Card> : (
          <Card>
            <div className="scroll-x"><table className="table">
              <thead><tr><th>Received</th><th>Distributor</th><th>Invoice</th><th className="r">Amount</th><th className="r">Paid</th><th>Status</th><th>POS</th><th>Entered by</th><th></th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">{fmtShort(r.day)}</td>
                  <td><b>{r.distributor_name}</b></td>
                  <td className="num">{r.invoice_no}</td>
                  <td className="r num"><b>{num(r.amount)}</b></td>
                  <td className="r num">{num(r.paid)}</td>
                  <td>{r.remaining <= 0 ? <Pill kind="ok">Paid</Pill> : r.installments_planned ? <Pill kind="warn">Installments {r.payments_made}/{r.installments_planned}{r.next_due ? ` · next ${fmtShort(r.next_due)}` : ''}</Pill> : r.paid > 0 ? <Pill kind="warn">Part paid · {num(r.remaining)} left</Pill> : <Pill kind="warn">Pending</Pill>}</td>
                  <td>{r.posted_in_pos ? <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Pill kind="ok">Posted{r.posted_by ? ` · ${who(r.posted_by).split(' ')[0]}` : ''}</Pill>{r.post_diff > 0 && <Pill kind={r.diff_pending > 0 ? 'danger' : 'neutral'}>{r.diff_pending > 0 ? `${num(r.diff_pending)} short · ${r.post_diff_kind ? api.DIFF_KIND_LABEL[r.post_diff_kind] : ''}` : `${num(r.post_diff)} difference settled`}</Pill>}</span> : <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Pill kind="danger">Not posted · {days(r.day) === 0 ? 'today' : `${days(r.day)}d`}</Pill>{canPost && <Button size="sm" kind="primary" onClick={() => setPosting(r)}>Posted in POS…</Button>}</span>}</td>
                  <td>{who(r.entered_by)}{r.device ? <span className="muted"> · {r.device}</span> : ''}</td>
                  <td><span style={{ display: 'flex', gap: 4 }}><ProofLink storagePath={photos.find((p) => p.id === r.photo_id)?.storage_path} />{r.remaining > 0 && <Link className="btn sm" to={`/pay?invoice=${r.id}`}>Pay</Link>}{isOwner && <Link className="btn ghost sm" to={`?edit=invoices:${r.id}`}>Edit</Link>}</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
        )}
      </div>
      {posting && <PostedSheet invoice={posting} onClose={() => setPosting(null)} onSaved={() => { setPosting(null); useStore.getState().bump(); }} />}
    </>
  );
}

// New purchase (invoice received). Can be "pending" or "paid on the spot" — on-the-spot payment continues to the pay screen.
export function PurchaseNew() {
  const profile = useStore((s) => s.profile)!;
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [dists, setDists] = useState<api.Distributor[]>([]);
  const [distId, setDistId] = useState(params.get('distributor') || '');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState(today());
  const [invoiceDate, setInvoiceDate] = useState('');
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [posted, setPosted] = useState<'yes' | 'no' | null>(null);
  const [plan, setPlan] = useState<'full' | 'installments'>('full');
  const [nInst, setNInst] = useState('3');
  const [nextDue, setNextDue] = useState('');
  const [payNow, setPayNow] = useState<'pending' | 'now'>('pending');
  const [lines, setLines] = useState<PaymentLine[]>([newLine()]);
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [newDist, setNewDist] = useState(false);
  const [newDistName, setNewDistName] = useState('');
  useEffect(() => { api.listDistributors().then(setDists).catch((e) => toast(e.message, 'danger')); }, [toast]);
  const amt = amountOf(amount);
  const options = useSourceOptions(distId || null, null);
  const linesProblem = payNow === 'now' ? paymentLinesProblem(lines, options, amt) : null;
  const canSave = distId && invoiceNo.trim() && amt > 0 && photo && posted !== null && !busy && (plan === 'full' || Number(nInst) >= 2) && !linesProblem;
  const save = async () => {
    if (!canSave || !photo) return;
    setBusy(true);
    try {
      const inv = await api.addInvoice({ distributor_id: distId, invoice_no: invoiceNo.trim(), day, amount: amt, photo_id: photo.id, invoice_date: invoiceDate || null, installments_planned: plan === 'installments' ? Number(nInst) : null, next_due: plan === 'installments' && nextDue ? nextDue : null, note: note || null, posted_in_pos: posted === 'yes' });
      if (payNow !== 'now') { toast('Purchase saved', 'ok'); useStore.getState().bump(); navigate('/purchases'); return; }
      let saved = 0;
      try {
        saved = await postPaymentLines(inv.id, day, lines, options, profile.id);
        const left = amt - paymentLinesTotal(lines);
        if (left > 0 && dueDate) await api.setInvoiceDue(inv.id, dueDate);
        toast(left > 0 ? `Purchase saved · ${num(amt - left)} paid, ${num(left)} pending` : 'Purchase saved and paid', 'ok'); useStore.getState().bump(); navigate(`/distributors/${distId}`);
      } catch (e) {
        toast(`Purchase saved, but payment: ${(e as Error).message}${saved > 0 ? ` (${saved} of ${lines.length} lines saved)` : ''}`, 'danger');
        useStore.getState().bump(); navigate(`/pay?invoice=${inv.id}`);
      }
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  const addDist = async () => { if (!newDistName.trim()) return; try { const d = await api.addDistributor({ name: newDistName.trim() }); setDists((x) => [...x, d].sort((a, b) => a.name.localeCompare(b.name))); setDistId(d.id); setNewDist(false); setNewDistName(''); } catch (e) { toast((e as Error).message, 'danger'); } };
  return (
    <>
      <TopBar title="Add purchase" sub={`Stock received · ${profile.name}`} back />
      <div className="content"><div className="form">
        <Card>
          <Field label="Distributor"><div style={{ display: 'flex', gap: 6 }}><select className="select" value={distId} onChange={(e) => setDistId(e.target.value)} data-testid="distributor"><option value="">Choose…</option>{dists.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select><Button onClick={() => setNewDist(true)}>New</Button></div></Field>
          <div className="grid grid-2">
            <Field label="Invoice no"><input className="input num" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} data-testid="invoice-no" /></Field>
            <Field label="Invoice total"><AmountInput id="invoice-amount" big={false} value={amount} onChange={setAmount} /></Field>
            <Field label="Received on"><input className="input" type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} data-testid="received-on" /></Field>
            <Field label="Invoice date (optional)"><input className="input" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></Field>
          </div>
          <PhotoPicker label="Invoice photo" hint="The distributor's invoice — camera or gallery" value={photo} onChange={setPhoto} userId={profile.id} />
        </Card>
        <Card title="Posted into POS system?">
          <Chips options={[{ value: 'yes', label: 'Yes, posted' }, { value: 'no', label: 'Not yet' }]} value={posted} onChange={setPosted} warnValue="no" />
          <div className="help">Unposted invoices go on the owner's follow-up list until someone marks them posted.</div>
        </Card>
        <Card title="Payment">
          <Chips options={[{ value: 'pending', label: 'Leave pending' }, { value: 'now', label: 'Pay now (on the spot)' }]} value={payNow} onChange={setPayNow} />
          {payNow === 'pending' && <Chips options={[{ value: 'full', label: 'Single payment' }, { value: 'installments', label: 'In installments' }]} value={plan} onChange={setPlan} />}
          {plan === 'installments' && <div className="grid grid-2"><Field label="How many installments"><input className="input num" inputMode="numeric" value={nInst} onChange={(e) => setNInst(e.target.value.replace(/\D/g, ''))} /></Field><Field label="First due date"><input className="input" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} /></Field></div>}
          <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </Card>
        {payNow === 'now' && (amt > 0 ? <>
          <div className="help">Paying {num(amt)} now — from one source or several. Anything left stays pending on the invoice.</div>
          <PaymentLinesEditor lines={lines} onChange={setLines} options={options} remaining={amt} userId={profile.id} day={day} dueDate={dueDate} onDueDate={setDueDate} />
        </> : <Notice kind="info">Enter the invoice total first, then the payment sources appear here.</Notice>)}
        <div className="form-footer"><Button kind="primary" size="big" disabled={!canSave} onClick={save} data-testid="save-purchase">{busy ? 'Saving…' : payNow === 'now' ? 'Save & pay now' : 'Save purchase'}</Button></div>
      </div></div>
      {newDist && <Sheet title="New distributor" onClose={() => setNewDist(false)}><Field label="Name"><input className="input" autoFocus value={newDistName} onChange={(e) => setNewDistName(e.target.value)} /></Field><div className="actions"><Button onClick={() => setNewDist(false)}>Cancel</Button><Button kind="primary" onClick={addDist}>Add</Button></div></Sheet>}
    </>
  );
}

// Pay a distributor against an invoice — the cashier's main screen.
export function PayPage() {
  const profile = useStore((s) => s.profile)!;
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [dists, setDists] = useState<api.DistributorBalance[]>([]);
  const [distId, setDistId] = useState('');
  const [invoices, setInvoices] = useState<api.InvoiceStatus[]>([]);
  const [invoiceId, setInvoiceId] = useState(params.get('invoice') || '');
  const [lines, setLines] = useState<PaymentLine[]>([newLine()]);
  const [dueDate, setDueDate] = useState('');
  const [day, setDay] = useState(today());
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.distributorBalances().then(setDists); }, []);
  useEffect(() => { if (params.get('invoice')) api.getInvoice(params.get('invoice')!).then((i) => { setDistId(i.distributor_id); setInvoiceId(i.id); }).catch(() => undefined); }, [params]);
  useEffect(() => { if (distId) api.invoiceStatus({ distributor_id: distId, unpaid: true }).then(setInvoices); else setInvoices([]); }, [distId]);
  const inv = invoices.find((i) => i.id === invoiceId) || null;
  const options = useSourceOptions(inv?.distributor_id ?? null, inv?.id ?? null);
  const total = paymentLinesTotal(lines);
  useEffect(() => { if (inv && total > 0) api.paymentWarning(inv.id, total, day).then(setWarning).catch(() => setWarning(null)); else setWarning(null); }, [inv, total, day]);
  const problem = inv ? paymentLinesProblem(lines, options, inv.remaining) : 'Choose an invoice';
  const canSave = inv && !problem && !busy;
  const save = async () => {
    if (!canSave || !inv) return;
    setBusy(true);
    let saved = 0;
    try {
      saved = await postPaymentLines(inv.id, day, lines, options, profile.id);
      const left = inv.remaining - total;
      if (left > 0 && dueDate) await api.setInvoiceDue(inv.id, dueDate);
      toast(lines.length > 1 ? `${lines.length} payment lines saved` : 'Payment saved', 'ok'); useStore.getState().bump(); navigate(`/distributors/${inv.distributor_id}`);
    } catch (e) {
      toast(`${(e as Error).message}${saved > 0 ? ` — ${saved} of ${lines.length} lines were saved; the rest were not` : ''}`, 'danger');
      useStore.getState().bump();
    } finally { setBusy(false); }
  };
  return (
    <>
      <TopBar title="Pay distributor" sub={`${profile.role === 'cashier' ? 'Cashier' : profile.role === 'manager' ? 'Manager' : 'Owner'}: ${profile.name}`} back />
      <div className="content"><div className="form">
        <Card>
          <Field label="Distributor"><select className="select" value={distId} onChange={(e) => { setDistId(e.target.value); setInvoiceId(''); }} data-testid="pay-distributor"><option value="">Choose…</option>{dists.map((d) => <option key={d.id} value={d.id}>{d.name}{d.pending > 0 ? ` · pending ${num(d.pending)}` : ''}{d.diff_pending > 0 ? ` · they owe ${num(d.diff_pending)}` : ''}</option>)}</select></Field>
          {distId && (invoices.length === 0 ? <Notice kind="info">No unpaid invoices for this distributor. <Link to={`/purchases/new?distributor=${distId}`}>Add the invoice first</Link> — stock received today is entered as a purchase, then paid.</Notice> : <Field label="Invoice"><select className="select" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} data-testid="pay-invoice"><option value="">Choose…</option>{invoices.map((i) => <option key={i.id} value={i.id}>Inv {i.invoice_no} · {fmtShort(i.day)} · {num(i.amount)} · {num(i.remaining)} remaining</option>)}</select></Field>)}
          {inv && <Notice kind="ok">Invoice found · paid {num(inv.paid)}{inv.installments_planned ? ` (${inv.payments_made} of ${inv.installments_planned})` : inv.payments_made > 0 ? ` (${inv.payments_made} payment${inv.payments_made > 1 ? 's' : ''})` : ''} · {num(inv.remaining)} remaining{inv.next_due ? ` · next due ${fmtShort(inv.next_due)}` : ''}. A fully paid invoice number is blocked (duplicate guard).</Notice>}
        </Card>
        {inv && <>
          <Field label="Payment date"><input className="input" type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 220 }} data-testid="payment-date" /></Field>
          <PaymentLinesEditor lines={lines} onChange={setLines} options={options} remaining={inv.remaining} userId={profile.id} day={day} dueDate={dueDate} onDueDate={setDueDate} />
          {warning && <Notice kind="warn">{warning}. Check you are not paying twice.</Notice>}
          <div className="form-footer"><Button kind="primary" size="big" disabled={!canSave} onClick={save} data-testid="save-payment">{busy ? 'Saving…' : total > 0 && total < inv.remaining ? `Save · ${num(total)} now, ${num(inv.remaining - total)} pending` : 'Save payment'}</Button></div>
        </>}
      </div></div>
    </>
  );
}

export function ExpenseNew() {
  const profile = useStore((s) => s.profile)!;
  const accounts = useStore((s) => s.accounts);
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const [cats, setCats] = useState<api.ExpenseCategory[]>([]);
  const [catId, setCatId] = useState('');
  const [budgets, setBudgets] = useState<api.BudgetStatus[]>([]);
  useEffect(() => { api.expenseBudgetStatus().then(setBudgets).catch(() => undefined); }, []);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [accountId, setAccountId] = useState('');
  const [cashSource, setCashSource] = useState<'today' | 'yesterday'>('today');
  const [day, setDay] = useState(today());
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listCategories().then(setCats); }, []);
  useEffect(() => { const c = accounts.find((a) => a.kind === 'cash_drawer'); if (c && !accountId) setAccountId(c.id); }, [accounts, accountId]);
  const amt = amountOf(amount);
  const account = accounts.find((a) => a.id === accountId);
  const canSave = catId && amt > 0 && account && photo && !busy;
  const save = async () => {
    if (!canSave || !photo || !account) return;
    setBusy(true);
    try { await api.addExpense({ day, category_id: catId, amount: amt, note: note || null, account_id: account.id, cash_source: account.kind === 'cash_drawer' ? cashSource : 'not_cash', photo_id: photo.id }); toast('Expense saved', 'ok'); useStore.getState().bump(); navigate('/expenses'); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return (
    <>
      <TopBar title="Add expense" sub={`${profile.name} · ${fmtDay(day)}`} back />
      <div className="content"><div className="form">
        <Card>
          <Field label="Category"><Chips options={cats.map((c) => ({ value: c.id, label: c.name }))} value={catId || null} onChange={setCatId} /></Field>
          {catId && budgets.find((b) => b.category_id === catId)?.budget !== null && budgets.find((b) => b.category_id === catId) && (() => { const b = budgets.find((x) => x.category_id === catId)!; return <Notice kind={b.over || (b.remaining ?? 0) < amountOf(amount) ? 'danger' : 'info'}>{b.over ? `This category is already over its monthly budget (${num(b.spent)} of ${num(b.budget)}). The owner will be alerted.` : `Budget this month: ${num(b.budget)} · spent ${num(b.spent)} · ${num(b.remaining ?? 0)} left${amountOf(amount) > (b.remaining ?? 0) ? ' — this expense crosses it' : ''}`}</Notice>; })()}
          <Field label="Amount"><AmountInput id="expense-amount" value={amount} onChange={setAmount} /></Field>
          <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Petrol for delivery bike" data-testid="expense-note" /></Field>
          <Field label="Paid from"><Chips options={accounts.filter((a) => ['cash_drawer', 'wallet', 'bank'].includes(a.kind)).map((a) => ({ value: a.id, label: a.kind === 'cash_drawer' ? 'Cash drawer' : a.name }))} value={accountId || null} onChange={setAccountId} /></Field>
          {account?.kind === 'cash_drawer' && <Chips options={[{ value: 'today', label: "Today's cash" }, { value: 'yesterday', label: "Yesterday's cash" }]} value={cashSource} onChange={setCashSource} />}
          <Field label="Date"><input className="input" type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} /></Field>
          <PhotoPicker label="Receipt photo" hint="Petrol slip, shop receipt, or bill" value={photo} onChange={setPhoto} userId={profile.id} />
        </Card>
        <Notice kind="ok">Goes into the day's cash book · cannot be edited after saving</Notice>
        <div className="form-footer"><Button kind="primary" size="big" disabled={!canSave} onClick={save} data-testid="save-expense">{busy ? 'Saving…' : 'Save expense'}</Button></div>
      </div></div>
    </>
  );
}

export function ExpensesPage() {
  const canWrite = useCanWrite();
  const accounts = useStore((s) => s.accounts);
  const refreshKey = useStore((s) => s.refreshKey);
  const isOwner = useIsOwner();
  const [range, setRange] = useState<'today' | 'week' | 'month'>('week');
  const [rows, setRows] = useState<api.Expense[] | null>(null);
  const [cats, setCats] = useState<api.ExpenseCategory[]>([]);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [photos, setPhotos] = useState<api.Photo[]>([]);
  useEffect(() => {
    const to = today(); const f = new Date(to); if (range === 'week') f.setDate(f.getDate() - 6); if (range === 'month') f.setDate(1);
    const from = range === 'today' ? to : f.toISOString().slice(0, 10);
    Promise.all([api.listExpenses(from, to), api.listCategories(), api.listProfiles()]).then(async ([r, c, p]) => { setRows(r); setCats(c); setProfiles(p); setPhotos(await api.getPhotos(r.slice(0, 80).map((e) => e.photo_id))); }).catch(() => undefined);
  }, [range, refreshKey]);
  const total = rows?.reduce((s, r) => s + r.amount, 0) ?? 0;
  const byCat = cats.map((c) => ({ c, amt: rows?.filter((r) => r.category_id === c.id).reduce((s, r) => s + r.amount, 0) ?? 0 })).filter((x) => x.amt > 0).sort((a, b) => b.amt - a.amt);
  return (
    <>
      <TopBar title="Expenses" sub={`Total ${num(total)}`} right={canWrite && (<Link to="/expenses/new" className="btn primary">+ Add expense</Link>)} />
      <div className="content">
        <Chips options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'Last 7 days' }, { value: 'month', label: 'This month' }]} value={range} onChange={setRange} />
        {byCat.length > 0 && <Card title="By category">{byCat.map(({ c, amt }) => <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}><span style={{ width: 120, fontWeight: 600 }}>{c.name}</span><div className="bar" style={{ flex: 1 }}><div style={{ width: `${(amt / byCat[0].amt) * 100}%` }} /></div><span className="num" style={{ width: 70, textAlign: 'right', fontWeight: 700 }}>{num(amt)}</span></div>)}</Card>}
        <Card>{!rows ? <Spinner /> : rows.length === 0 ? <Empty>No expenses</Empty> : rows.map((e) => <div className="row" key={e.id}><div className="avatar danger">{initials(cats.find((c) => c.id === e.category_id)?.name ?? 'E')}</div><div className="grow"><span className="t">{cats.find((c) => c.id === e.category_id)?.name}{e.note ? ` · ${e.note}` : ''}</span><span className="s">{fmtShort(e.day)} · {accounts.find((a) => a.id === e.account_id)?.kind === 'cash_drawer' ? 'Cash' : accounts.find((a) => a.id === e.account_id)?.name} · {profiles.find((p) => p.id === e.entered_by)?.name}{e.device ? ` · ${e.device}` : ''}</span></div><ProofLink storagePath={photos.find((p) => p.id === e.photo_id)?.storage_path} />{isOwner && <Link className="btn ghost sm" to={`?edit=expenses:${e.id}`}>Edit</Link>}<span className="amt num">− {num(e.amount)}</span></div>)}</Card>
      </div>
    </>
  );
}
