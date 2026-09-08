import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { TopBar } from '../components/Shell';
import { Card, AmountInput, amountOf, PhotoPicker, Button, Notice, Icon, Spinner, Money, ProofLink, Pill, Tiles, Sheet, Field, Chips } from '../components/ui';
import { useStore, useIsOwner } from '../lib/store';
import * as api from '../lib/api';
import { today, fmtDay, num, fmtShort, fmtTime } from '../lib/format';
import type { ProofPhoto } from '../lib/photos';

// Record the daily sale. Two ways in:
//  · POS total: type the POS figure (photo required); cash is worked out after card / online / credit.
//  · Drawer count: count the cash in the drawer; the app works the cash sale out from opening ± today's cash movements,
//    then adds card / online / credit to give the day's sale.
// Credit is entered bill by bill against a named customer or staff member, each with its own photo.
type CreditLine = { key: string; who: 'customer' | 'staff'; id: string; name: string; bill_no: string; bill_total: number | null; amount: number; photo: ProofPhoto };

export function SaleNew() {
  const profile = useStore((s) => s.profile)!;
  const accounts = useStore((s) => s.accounts);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const day = params.get('day') || today();
  const toast = useStore((s) => s.toast);
  const nonCash = useMemo(() => accounts.filter((a) => ['card_machine', 'wallet', 'bank'].includes(a.kind)), [accounts]);
  const [mode, setMode] = useState<'pos' | 'count'>('pos');
  const [posTotal, setPosTotal] = useState('');
  const [counted, setCounted] = useState('');
  const [before, setBefore] = useState<number | null>(null);
  const [posPhoto, setPosPhoto] = useState<ProofPhoto | null>(null);
  const [lines, setLines] = useState<Record<string, { amount: string; photo: ProofPhoto | null }>>({});
  const [credits, setCredits] = useState<CreditLine[]>([]);
  const [creditSheet, setCreditSheet] = useState(false);
  const [existing, setExisting] = useState<api.DailySale | null | undefined>(undefined);
  const [receipts, setReceipts] = useState<Record<string, { amount: number; receipts: number }>>({});
  const [dayCredit, setDayCredit] = useState({ customer_credit: 0, staff_credit: 0, bills: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.getDailySale(day).then(setExisting);
    api.cashBeforeSale(day).then(setBefore).catch(() => setBefore(null));
    api.dayReceipts(day).then((rs) => setReceipts(Object.fromEntries(rs.map((r) => [r.account_id, { amount: r.amount, receipts: r.receipts }])))).catch(() => undefined);
    api.dayCredit(day).then(setDayCredit).catch(() => undefined);
  }, [day]);

  const receiptsTotal = Object.values(receipts).reduce((s, r) => s + r.amount, 0);
  const nonCashTotal = nonCash.reduce((s, a) => s + (receipts[a.id] ? 0 : amountOf(lines[a.id]?.amount ?? '')), 0) + receiptsTotal;
  const creditEarlier = dayCredit.customer_credit + dayCredit.staff_credit;
  const creditTotal = creditEarlier + credits.reduce((s, c) => s + c.amount, 0);
  const countedN = amountOf(counted);
  const cashSaleFromCount = before === null ? 0 : countedN - before;
  const pos = mode === 'pos' ? amountOf(posTotal) : (counted === '' ? 0 : cashSaleFromCount + nonCashTotal + creditTotal);
  const cash = mode === 'pos' ? pos - nonCashTotal - creditTotal : cashSaleFromCount;
  const missingPhotos = nonCash.filter((a) => !receipts[a.id] && amountOf(lines[a.id]?.amount ?? '') > 0 && !lines[a.id]?.photo);
  const ready = mode === 'pos' ? pos > 0 : counted !== '' && before !== null;
  const canSave = ready && posPhoto && cash >= 0 && missingPhotos.length === 0 && !busy;

  const save = async () => {
    if (!canSave || !posPhoto) return;
    setBusy(true);
    try {
      await api.saveDailySale({
        day, pos_total: pos, credit_total: creditTotal, photo_id: posPhoto.id, pos_source: mode, counted_cash: mode === 'count' ? countedN : null,
        lines: nonCash.filter((a) => !receipts[a.id] && amountOf(lines[a.id]?.amount ?? '') > 0).map((a) => ({ account_id: a.id, amount: amountOf(lines[a.id].amount), photo_id: lines[a.id].photo!.id })),
        credits: credits.map((c) => ({ who: c.who, id: c.id, bill_no: c.bill_no, amount: c.amount, bill_total: c.bill_total, photo_id: c.photo.id })),
      });
      toast('Daily sale saved', 'ok');
      useStore.getState().bump();
      navigate(`/closing?day=${day}${mode === 'count' ? `&counted=${countedN}` : ''}`);
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };

  if (existing === undefined) return <><TopBar title="Record daily sale" back /><Spinner /></>;
  if (existing) return <><TopBar title="Record daily sale" sub={fmtDay(day)} back /><div className="content"><Notice kind="ok">The sale for {fmtShort(day)} is already recorded ({num(existing.pos_total)}). The owner can correct it from the Sales page.</Notice><Link className="btn primary" to={`/closing?day=${day}`}>Go to closing</Link></div></>;
  return (
    <>
      <TopBar title="Record daily sale" sub={`${fmtDay(day)} · ${profile.role === 'owner' ? 'Owner' : 'Manager'}: ${profile.name}`} back />
      <div className="content">
        <div className="form">
          <Tiles options={[{ value: 'pos', label: 'I have the POS total', sub: 'type it, cash is worked out' }, { value: 'count', label: 'Count the drawer', sub: 'the app works the sale out' }]} value={mode} onChange={(m) => { setMode(m); setPosPhoto(null); }} />
          {mode === 'pos' ? <Card>
            <div className="card-title"><span>POS total from system</span><span className="danger" style={{ fontSize: 11 }}>photo required</span></div>
            <AmountInput id="pos-total" value={posTotal} onChange={setPosTotal} autoFocus />
            <PhotoPicker label="POS screen photo" hint="Photo of the POS daily total" value={posPhoto} onChange={setPosPhoto} userId={profile.id} />
          </Card> : <Card>
            <div className="card-title"><span>Cash counted in the drawer now</span><span className="danger" style={{ fontSize: 11 }}>photo required</span></div>
            <AmountInput id="counted-now" value={counted} onChange={setCounted} autoFocus />
            <PhotoPicker label="Drawer photo" hint="Photo of the counted cash" value={posPhoto} onChange={setPosPhoto} userId={profile.id} />
            {before === null ? <Spinner /> : <>
              <div className="line"><span className="k">Cash that should be there before today's sale</span><span className="v num">{num(before)}</span></div>
              <div className="help">= opening cash + credit collected + WAW borrowed − distributor payments − expenses − advances − WAW repaid − returned to owner (all cash, from today's entries)</div>
              {counted !== '' && <div className="line total"><span className="k accent">Cash sale today</span><span className={`v num ${cash < 0 ? 'danger' : 'accent'}`} data-testid="cash-from-count">{num(cash)}</span></div>}
            </>}
          </Card>}
          <Card title="Card, online and credit">
            {mode === 'pos' && <div className="line"><span className="k accent" style={{ fontWeight: 800 }}>Cash (worked out automatically)</span><span className={`v num ${cash < 0 ? 'danger' : 'accent'}`} data-testid="cash-part">{num(cash)}</span></div>}
            {receiptsTotal > 0 && <div className="help">Card / online entered through the day are picked up automatically — {num(receiptsTotal)} so far.</div>}
            {nonCash.map((a) => receipts[a.id] ? (
              <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--line-2)' }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{a.name}</span>
                <span className="num" style={{ fontWeight: 800 }} data-testid={`receipts-${a.id}`}>{num(receipts[a.id].amount)} <span className="muted" style={{ fontWeight: 500, fontSize: 12 }}>· {receipts[a.id].receipts} receipt{receipts[a.id].receipts === 1 ? '' : 's'} entered today</span></span>
              </div>
            ) : (
              <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0', borderTop: '1px solid var(--line-2)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'center' }}>
                  <label htmlFor={`line-${a.id}`} style={{ fontSize: 13, fontWeight: 700 }}>{a.name}</label>
                  <AmountInput id={`line-${a.id}`} big={false} value={lines[a.id]?.amount ?? ''} onChange={(v) => setLines((l) => ({ ...l, [a.id]: { amount: v, photo: l[a.id]?.photo ?? null } }))} />
                </div>
                {amountOf(lines[a.id]?.amount ?? '') > 0 && <PhotoPicker label={a.kind === 'card_machine' ? 'Merchant copy slip' : 'Transfer screenshot'} hint={a.kind === 'card_machine' ? 'End-of-day slip from the machine' : 'Screenshot from the app'} value={lines[a.id]?.photo ?? null} onChange={(p) => setLines((l) => ({ ...l, [a.id]: { amount: l[a.id]?.amount ?? '', photo: p } }))} userId={profile.id} />}
              </div>
            ))}
            <div style={{ padding: '8px 0', borderTop: '1px solid var(--line-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="warn" style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>Credit bills · {dayCredit.bills + credits.length}</span><span className="num warn" style={{ fontWeight: 800 }} data-testid="credit-total">{num(creditTotal)}</span><Button size="sm" onClick={() => setCreditSheet(true)} data-testid="add-credit">+ Add credit bill</Button></div>
              {dayCredit.bills > 0 && <div className="row"><div className="grow"><span className="t">Entered through the day</span><span className="s">{dayCredit.bills} bill{dayCredit.bills === 1 ? '' : 's'} · customers {num(dayCredit.customer_credit)} · staff {num(dayCredit.staff_credit)}</span></div><span className="amt num warn">{num(creditEarlier)}</span></div>}
              {credits.map((c) => <div className="row" key={c.key}><div className="grow"><span className="t">{c.name} <span className="muted" style={{ fontWeight: 500 }}>· {c.who === 'staff' ? 'staff' : 'customer'}</span></span><span className="s">Bill {c.bill_no}{c.bill_total !== null && c.bill_total > c.amount ? ` · ${num(c.bill_total)} bill, ${num(c.bill_total - c.amount)} paid now` : ' · full bill on credit'}</span></div><span className="amt num warn">{num(c.amount)}</span><Button kind="ghost" size="sm" aria-label="Remove" onClick={() => setCredits((l) => l.filter((x) => x.key !== c.key))}>✕</Button></div>)}
              <div className="help">Each credit bill goes straight into that customer's or staff member's account with its photo.</div>
            </div>
          </Card>
          {ready && (cash < 0 ? <Notice kind="danger">{mode === 'pos' ? `Card, online and credit amounts exceed the POS total by ${num(-cash)}` : `The drawer holds ${num(-cash)} LESS than it should before any sale — check the count and today's payments`}</Notice> : <Notice kind="ok">{num(cash)} cash + {num(nonCashTotal)} card/online + {num(creditTotal)} credit = {num(pos)} {mode === 'pos' ? '· matches POS' : "· today's sale worked out from the count"}</Notice>)}
          {missingPhotos.length > 0 && <Notice kind="warn">Attach the slip or screenshot for: {missingPhotos.map((a) => a.name).join(', ')}</Notice>}
          <div className="form-footer"><Button kind="primary" size="big" disabled={!canSave} onClick={save} data-testid="save-sale">{busy ? 'Saving…' : mode === 'pos' ? 'Save & go to drawer count' : 'Save sale & close the day'}</Button></div>
        </div>
      </div>
      {creditSheet && <CreditLineSheet userId={profile.id} onClose={() => setCreditSheet(false)} onAdd={(c) => { setCredits((l) => [...l, c]); setCreditSheet(false); }} />}
    </>
  );
}

function CreditLineSheet({ userId, onClose, onAdd }: { userId: string; onClose: () => void; onAdd: (c: CreditLine) => void }) {
  const [customers, setCustomers] = useState<api.Customer[]>([]);
  const [staff, setStaff] = useState<api.StaffBalance[]>([]);
  const [balances, setBalances] = useState<api.CustomerBalance[]>([]);
  const [who, setWho] = useState('');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [billNo, setBillNo] = useState('');
  const [billTotal, setBillTotal] = useState('');
  const [partial, setPartial] = useState<'full' | 'part'>('full');
  const [amount, setAmount] = useState('');
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  useEffect(() => { Promise.all([api.listCustomers(), api.staffBalances(), api.customerBalances()]).then(([c, s, b]) => { setCustomers(c); setStaff(s.filter((x) => x.active)); setBalances(b); }).catch((e) => toast((e as Error).message, 'danger')); }, [toast]);
  const total = amountOf(billTotal);
  const amt = partial === 'full' ? total : amountOf(amount);
  const isNew = who === 'new';
  const canAdd = (who && (!isNew || newName.trim())) && billNo.trim() && total > 0 && amt > 0 && amt <= total && photo && !busy;
  const add = async () => {
    if (!canAdd || !photo) return;
    setBusy(true);
    try {
      let id = who; let kind: 'customer' | 'staff' = who.startsWith('staff:') ? 'staff' : 'customer'; let name = '';
      if (isNew) { const c = await api.addCustomer({ name: newName.trim(), phone: newPhone || null }); id = c.id; name = c.name; kind = 'customer'; }
      else if (kind === 'staff') { id = who.slice(6); name = staff.find((s) => s.id === id)?.name ?? ''; }
      else name = customers.find((c) => c.id === id)?.name ?? '';
      onAdd({ key: `${Date.now()}`, who: kind, id, name, bill_no: billNo.trim(), bill_total: total, amount: amt, photo });
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return <Sheet title="Add credit bill" onClose={onClose}>
    <Field label="Who is taking it on credit?">
      <select className="select" value={who} onChange={(e) => setWho(e.target.value)} data-testid="credit-who">
        <option value="">Choose…</option>
        <optgroup label="Customers">{customers.map((c) => <option key={c.id} value={c.id}>{c.name}{(balances.find((b) => b.id === c.id)?.owed ?? 0) > 0 ? ` · owes ${num(balances.find((b) => b.id === c.id)!.owed)}` : ''}</option>)}<option value="new">+ New customer…</option></optgroup>
        <optgroup label="Staff">{staff.map((s) => <option key={s.id} value={`staff:${s.id}`}>{s.name}{s.owed > 0 ? ` · owes ${num(s.owed)}` : ''}</option>)}</optgroup>
      </select>
    </Field>
    {isNew && <div className="grid grid-2"><Field label="Name"><input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} /></Field><Field label="Phone"><input className="input" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} /></Field></div>}
    <div className="grid grid-2">
      <Field label="Bill no"><input className="input num" value={billNo} onChange={(e) => setBillNo(e.target.value)} data-testid="credit-bill-no" /></Field>
      <Field label="Bill total"><AmountInput big={false} value={billTotal} onChange={setBillTotal} id="credit-bill-total" /></Field>
    </div>
    <Field label="How much is on credit?"><Chips options={[{ value: 'full', label: 'Whole bill' }, { value: 'part', label: 'Part of it' }]} value={partial} onChange={setPartial} /></Field>
    {partial === 'part' && <Field label="Credit amount" error={amt > total ? 'More than the bill' : undefined} help={total > 0 && amt > 0 && amt <= total ? `${num(total - amt)} paid now, ${num(amt)} to pay later` : undefined}><AmountInput big={false} value={amount} onChange={setAmount} id="credit-amount" /></Field>}
    <PhotoPicker label="Bill photo" value={photo} onChange={setPhoto} userId={userId} />
    <Button kind="primary" size="big" disabled={!canAdd} onClick={add} data-testid="credit-add">{busy ? 'Adding…' : `Add ${amt > 0 ? num(amt) : ''} on credit`}</Button>
  </Sheet>;
}

// Sales page: the day's breakdown (desktop) and a list of days
export function SalesPage() {
  const accounts = useStore((s) => s.accounts);
  const refreshKey = useStore((s) => s.refreshKey);
  const isOwner = useIsOwner();
  const [params, setParams] = useSearchParams();
  const day = params.get('day') || today();
  const [data, setData] = useState<{ sale: api.DailySale | null; lines: api.DailySaleLine[]; receipts: api.SaleReceipt[]; bday: api.BusinessDay | null; closing: api.Closing | null; book: api.CashBook; bills: api.CreditBill[]; staffCredits: api.StaffEntry[]; staff: api.StaffBalance[]; collections: api.CreditCollection[]; customers: api.Customer[]; photos: api.Photo[] } | null>(null);
  useEffect(() => {
    (async () => {
      const [sale, bday, closing, book, bills, collections, customers, staff] = await Promise.all([api.getDailySale(day), api.getDay(day), api.getClosing(day), api.cashBook(day), api.listCreditBills(), api.listCreditCollections(), api.listCustomers(), api.staffBalances().catch(() => [] as api.StaffBalance[])]);
      const lines = sale ? await api.getSaleLines(sale.id) : [];
      const receipts = await api.listReceipts(day, day).catch(() => [] as api.SaleReceipt[]);
      const staffCredits = await api.listStaffCreditForDay(day).catch(() => [] as api.StaffEntry[]);
      const dayBills = bills.filter((b) => b.day === day);
      const photos = await api.getPhotos([...(sale ? [sale.photo_id] : []), ...lines.map((l) => l.photo_id), ...receipts.map((r) => r.photo_id), ...dayBills.map((b) => b.photo_id), ...staffCredits.map((e) => e.photo_id)]);
      setData({ sale, lines, receipts, bday, closing, book, bills: dayBills, staffCredits, staff, collections: collections.filter((c) => c.day === day), customers, photos });
    })().catch((e) => useStore.getState().toast((e as Error).message, 'danger'));
  }, [day, refreshKey]);
  const shift = (n: number) => { const d = new Date(day); d.setDate(d.getDate() + n); setParams({ day: d.toISOString().slice(0, 10) }); };
  if (!data) return <><TopBar title="Daily sale" /><Spinner /></>;
  const { sale, lines, closing, book } = data;
  const acc = (id: string) => accounts.find((a) => a.id === id);
  const photo = (id: string) => data.photos.find((p) => p.id === id)?.storage_path;
  const cust = (id: string) => data.customers.find((c) => c.id === id)?.name ?? '';
  const all = [...lines.map((l) => ({ id: l.id, account_id: l.account_id, amount: l.amount, photo_id: l.photo_id, sub: 'End-of-day total', at: '' })), ...data.receipts.map((r) => ({ id: r.id, account_id: r.account_id, amount: r.amount, photo_id: r.photo_id, sub: `${r.note || 'Receipt'} · ${fmtTime(r.created_at)}`, at: r.created_at }))];
  const card = all.filter((l) => acc(l.account_id)?.kind === 'card_machine');
  const online = all.filter((l) => acc(l.account_id)?.kind !== 'card_machine');
  const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);
  const staffName = (id: string) => data.staff.find((s) => s.id === id)?.name ?? 'Staff';
  const creditEntered = sum(data.bills) + sum(data.staffCredits);
  return (
    <>
      <TopBar title={`Daily sale · ${fmtDay(day, 'EEEE d MMMM')}`} sub={sale ? `Recorded · ${data.bday?.status === 'approved' ? 'approved & locked' : data.bday?.status === 'closed' ? 'closed, awaiting approval' : 'day open'}` : 'Not recorded yet'} right={<>
        <Button onClick={() => shift(-1)}>← {fmtShort(new Date(new Date(day).getTime() - 86400000))}</Button>
        {day < today() && <Button onClick={() => shift(1)}>{fmtShort(new Date(new Date(day).getTime() + 86400000))} →</Button>}
        {!sale && <Link className="btn primary" to={`/sales/new?day=${day}`}>Record sale</Link>}
        {sale && isOwner && data.bday?.status === 'closed' && <Link className="btn primary" to={`/closing?day=${day}`}>Approve & lock day</Link>}
      </>} />
      <div className="content">
        {!sale ? <Card><div className="muted">No sale recorded for this day.</div></Card> : <>
          <Card>
            <div className="grid grid-5">
              <div className="kpi"><div className="label">{sale.pos_source === 'count' ? 'Day\'s sale (from drawer count)' : 'POS system total'}</div><div className="value num"><Money v={sale.pos_total} /></div><div className="hint"><ProofLink storagePath={photo(sale.photo_id)} label={sale.pos_source === 'count' ? 'Drawer photo' : 'POS photo'} /></div></div>
              <div className="kpi"><div className="label accent">Cash</div><div className="value num accent">{num(book.pos_cash_sale)}</div><div className="hint">goes to drawer</div></div>
              <div className="kpi"><div className="label">Card machines</div><div className="value num">{num(sum(card))}</div><div className="hint">{card.length} slip{card.length === 1 ? '' : 's'} attached</div></div>
              <div className="kpi"><div className="label">Online received</div><div className="value num">{num(sum(online))}</div><div className="hint">{online.length} screenshots</div></div>
              <div className="kpi"><div className="label warn">Credit bills</div><div className="value num warn">{num(sale.credit_total)}</div><div className="hint">{data.bills.length + data.staffCredits.length} bills · pay later</div></div>
            </div>
          </Card>
          <div className="grid grid-3">
            <Card title="Card machines" right={<span className="num" style={{ fontWeight: 800 }}>{num(sum(card))}</span>}>
              {card.length === 0 ? <div className="muted">None</div> : card.map((l) => <div className="row" key={l.id}><div className="grow"><span className="t">{acc(l.account_id)?.name}</span><span className="s">{l.sub}</span></div><ProofLink storagePath={photo(l.photo_id)} /><span className="amt num">{num(l.amount)}</span></div>)}
            </Card>
            <Card title="Online received" right={<span className="num" style={{ fontWeight: 800 }}>{num(sum(online))}</span>}>
              {online.length === 0 ? <div className="muted">None</div> : online.map((l) => <div className="row" key={l.id}><div className="grow"><span className="t">{acc(l.account_id)?.name}</span><span className="s">{l.sub}</span></div><ProofLink storagePath={photo(l.photo_id)} /><span className="amt num">{num(l.amount)}</span></div>)}
            </Card>
            <Card title="Credit bills today" right={<span className="num warn" style={{ fontWeight: 800 }}>{num(sale.credit_total)}</span>}>
              {data.bills.map((b) => <div className="row" key={b.id}><div className="grow"><span className="t">{cust(b.customer_id)}</span><span className="s">Bill {b.bill_no}{b.bill_total !== null && b.bill_total > b.amount ? ` · of ${num(b.bill_total)}` : ''}</span></div><ProofLink storagePath={photo(b.photo_id)} /><span className="amt num">{num(b.amount)}</span></div>)}
              {data.staffCredits.map((e) => <div className="row" key={e.id}><div className="grow"><span className="t">{staffName(e.staff_id)} <span className="muted" style={{ fontWeight: 500 }}>· staff</span></span><span className="s">Bill {e.bill_no ?? '—'}{e.bill_total !== null && e.bill_total > e.amount ? ` · of ${num(e.bill_total)}` : ''}</span></div><ProofLink storagePath={photo(e.photo_id)} /><span className="amt num">{num(e.amount)}</span></div>)}
              {data.collections.map((c) => <div className="row" key={c.id}><div className="grow"><span className="t">Collected · {cust(c.customer_id)}</span><span className="s">{acc(c.account_id)?.kind === 'cash_drawer' ? 'cash into drawer' : acc(c.account_id)?.name}</span></div><span className="amt num ok">+ {num(c.amount)}</span></div>)}
              {data.bills.length === 0 && data.staffCredits.length === 0 && data.collections.length === 0 && <div className="muted">None</div>}
              {sale.credit_total !== creditEntered && <Notice kind="warn">Credit total {num(sale.credit_total)} but bills entered {num(creditEntered)} — add the missing bills under Customers</Notice>}
            </Card>
          </div>
          {sale.pos_source === 'count' && <Notice kind="warn">This day's sale was worked out from the drawer count ({num(sale.counted_cash)} counted), not typed from the POS. Compare it with the POS report before approving.</Notice>}
          <Card kind="outline">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', fontSize: 13, fontWeight: 700 }} className="num">
              <b className="accent">Drawer check (cash only)</b>
              <span>Opening {num(book.opening_cash)}</span><span className="muted">+</span><span>POS cash {num(book.pos_cash_sale)}</span><span className="muted">+</span><span>Credit collected {num(book.credit_collected_cash)}</span>{book.waw_borrowed_cash > 0 && <><span className="muted">+</span><span>WAW {num(book.waw_borrowed_cash)}</span></>}<span className="muted">−</span><span>Distributors {num(book.distributor_paid_cash)}</span><span className="muted">−</span><span>Expenses {num(book.expenses_cash)}</span><span className="muted">−</span><span>Staff/WAW/owner {num(book.staff_advances_cash + book.waw_repaid_cash + book.owner_cash_returns)}</span><span className="muted">=</span><b>{num(book.expected_cash)} expected</b>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>{closing ? <><span>Counted {num(closing.counted_cash)}</span><Pill kind={closing.difference < 0 ? 'danger' : 'ok'}>{num(closing.difference, true)}</Pill></> : <span className="muted">not closed yet</span>}</span>
            </div>
          </Card>
        </>}
        <div className="help"><Icon.Info size={12} /> Every figure above links to the photo behind it. Corrections are owner-only, need a reason, and are kept in the audit log.</div>
      </div>
    </>
  );
}

// Card sale / online transfer entered as it happens (cashier, through the day)
export function ReceiptNew() {
  const profile = useStore((s) => s.profile)!;
  const accounts = useStore((s) => s.accounts);
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const day = params.get('day') || today();
  const nonCash = useMemo(() => accounts.filter((a) => ['card_machine', 'wallet', 'bank'].includes(a.kind)), [accounts]);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [todayList, setTodayList] = useState<api.SaleReceipt[]>([]);
  const refreshKey = useStore((s) => s.refreshKey);
  useEffect(() => { api.listReceipts(day, day).then(setTodayList).catch(() => undefined); }, [day, refreshKey]);
  const acc = accounts.find((a) => a.id === accountId);
  const amt = amountOf(amount);
  const canSave = accountId && amt > 0 && photo && !busy;
  const save = async (again: boolean) => {
    if (!canSave || !photo) return;
    setBusy(true);
    try {
      await api.addReceipt({ day, account_id: accountId, amount: amt, note: note.trim() || null, photo_id: photo.id });
      toast(`${num(amt)} on ${acc?.name} saved`, 'ok');
      useStore.getState().bump();
      if (again) { setAmount(''); setNote(''); setPhoto(null); } else navigate('/');
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  const total = todayList.reduce((s, r) => s + r.amount, 0);
  return (
    <>
      <TopBar title="Card / online received" sub={`${fmtDay(day)} · ${profile.name}`} back />
      <div className="content">
        <div className="form">
          <Card title="Which machine or wallet?">
            <Tiles cols={2} options={nonCash.map((a) => ({ value: a.id, label: a.name, sub: a.kind === 'card_machine' ? 'card machine' : a.kind === 'wallet' ? 'wallet' : 'bank account' }))} value={accountId} onChange={setAccountId} />
          </Card>
          <Card>
            <div className="card-title"><span>Amount</span><span className="danger" style={{ fontSize: 11 }}>photo required</span></div>
            <AmountInput id="receipt-amount" value={amount} onChange={setAmount} />
            <Field label="Customer / note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Imran Butt · bill 4482" /></Field>
            <PhotoPicker label={acc?.kind === 'card_machine' ? 'Card slip (merchant copy)' : 'Transfer screenshot'} hint={acc?.kind === 'card_machine' ? 'Photo of the machine slip' : 'Screenshot showing the amount received'} value={photo} onChange={setPhoto} userId={profile.id} />
          </Card>
          <div className="form-footer" style={{ display: 'flex', gap: 8 }}>
            <Button size="big" disabled={!canSave} onClick={() => save(true)} data-testid="save-receipt-again">Save & add another</Button>
            <Button kind="primary" size="big" disabled={!canSave} onClick={() => save(false)} data-testid="save-receipt">{busy ? 'Saving…' : 'Save'}</Button>
          </div>
          {todayList.length > 0 && <Card title={`Entered today · ${todayList.length}`} right={<span className="num" style={{ fontWeight: 800 }}>{num(total)}</span>}>
            {todayList.map((r) => <div className="row" key={r.id}><div className="grow"><span className="t">{accounts.find((a) => a.id === r.account_id)?.name}</span><span className="s">{r.note || '—'} · {fmtTime(r.created_at)}</span></div><span className="amt num">{num(r.amount)}</span></div>)}
          </Card>}
          <div className="help">At night the daily sale picks these totals up by itself — only the POS total and the drawer count are left to enter.</div>
        </div>
      </div>
    </>
  );
}

// A credit bill entered on its own during the day (goes straight to the customer's or staff member's account)
export function CreditBillNew() {
  const profile = useStore((s) => s.profile)!;
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const day = params.get('day') || today();
  const [saving, setSaving] = useState(false);
  const save = async (c: CreditLine) => {
    setSaving(true);
    try {
      if (c.who === 'customer') await api.addCreditBill({ customer_id: c.id, day, bill_no: c.bill_no, amount: c.amount, bill_total: c.bill_total, photo_id: c.photo.id });
      else await api.addStaffEntry({ staff_id: c.id, day, kind: 'medicine_credit', amount: c.amount, bill_total: c.bill_total, bill_no: c.bill_no, photo_id: c.photo.id });
      toast(`${num(c.amount)} on credit for ${c.name} saved`, 'ok');
      useStore.getState().bump();
      navigate('/');
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setSaving(false); }
  };
  return (
    <>
      <TopBar title="Credit bill" sub={`${fmtDay(day)} · ${profile.name}`} back />
      <div className="content">{saving ? <Spinner /> : <CreditLineSheet userId={profile.id} onClose={() => navigate(-1)} onAdd={save} />}</div>
    </>
  );
}
