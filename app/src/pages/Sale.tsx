import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { TopBar } from '../components/Shell';
import { Card, AmountInput, amountOf, PhotoPicker, Button, Notice, Icon, Spinner, Money, ProofLink, Pill } from '../components/ui';
import { useStore, useIsOwner } from '../lib/store';
import * as api from '../lib/api';
import { today, fmtDay, num, fmtShort } from '../lib/format';
import type { ProofPhoto } from '../lib/photos';

// Record the daily sale: POS total + photo, one line per card machine / wallet with its slip or screenshot, credit bills total.
export function SaleNew() {
  const profile = useStore((s) => s.profile)!;
  const accounts = useStore((s) => s.accounts);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const day = params.get('day') || today();
  const toast = useStore((s) => s.toast);
  const nonCash = useMemo(() => accounts.filter((a) => ['card_machine', 'wallet', 'bank'].includes(a.kind)), [accounts]);
  const [posTotal, setPosTotal] = useState('');
  const [posPhoto, setPosPhoto] = useState<ProofPhoto | null>(null);
  const [lines, setLines] = useState<Record<string, { amount: string; photo: ProofPhoto | null }>>({});
  const [credit, setCredit] = useState('');
  const [existing, setExisting] = useState<api.DailySale | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getDailySale(day).then(setExisting); }, [day]);

  const pos = amountOf(posTotal);
  const nonCashTotal = nonCash.reduce((s, a) => s + amountOf(lines[a.id]?.amount ?? ''), 0);
  const cash = pos - nonCashTotal - amountOf(credit);
  const missingPhotos = nonCash.filter((a) => amountOf(lines[a.id]?.amount ?? '') > 0 && !lines[a.id]?.photo);
  const canSave = pos > 0 && posPhoto && cash >= 0 && missingPhotos.length === 0 && !busy;

  const save = async () => {
    if (!canSave || !posPhoto) return;
    setBusy(true);
    try {
      await api.saveDailySale({ day, pos_total: pos, credit_total: amountOf(credit), photo_id: posPhoto.id, lines: nonCash.filter((a) => amountOf(lines[a.id]?.amount ?? '') > 0).map((a) => ({ account_id: a.id, amount: amountOf(lines[a.id].amount), photo_id: lines[a.id].photo!.id })) });
      toast('Daily sale saved', 'ok');
      useStore.getState().bump();
      navigate(`/closing?day=${day}`);
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };

  if (existing === undefined) return <><TopBar title="Record daily sale" back /><Spinner /></>;
  if (existing) return <><TopBar title="Record daily sale" sub={fmtDay(day)} back /><div className="content"><Notice kind="ok">The sale for {fmtShort(day)} is already recorded ({num(existing.pos_total)}). The owner can correct it from the Sales page.</Notice><Link className="btn primary" to={`/closing?day=${day}`}>Go to closing</Link></div></>;
  return (
    <>
      <TopBar title="Record daily sale" sub={`${fmtDay(day)} · ${profile.role === 'owner' ? 'Owner' : 'Manager'}: ${profile.name}`} back />
      <div className="content">
        <div className="form">
          <Card>
            <div className="card-title"><span>POS total from system</span><span className="danger" style={{ fontSize: 11 }}>photo required</span></div>
            <AmountInput id="pos-total" value={posTotal} onChange={setPosTotal} autoFocus />
            <PhotoPicker label="POS screen photo" hint="Photo of the POS daily total" value={posPhoto} onChange={setPosPhoto} userId={profile.id} />
          </Card>
          <Card title="How was it paid?">
            <div className="line"><span className="k accent" style={{ fontWeight: 800 }}>Cash (worked out automatically)</span><span className={`v num ${cash < 0 ? 'danger' : 'accent'}`} data-testid="cash-part">{num(cash)}</span></div>
            {nonCash.map((a) => (
              <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0', borderTop: '1px solid var(--line-2)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'center' }}>
                  <label htmlFor={`line-${a.id}`} style={{ fontSize: 13, fontWeight: 700 }}>{a.name}</label>
                  <AmountInput id={`line-${a.id}`} big={false} value={lines[a.id]?.amount ?? ''} onChange={(v) => setLines((l) => ({ ...l, [a.id]: { amount: v, photo: l[a.id]?.photo ?? null } }))} />
                </div>
                {amountOf(lines[a.id]?.amount ?? '') > 0 && <PhotoPicker label={a.kind === 'card_machine' ? 'Merchant copy slip' : 'Transfer screenshot'} hint={a.kind === 'card_machine' ? 'End-of-day slip from the machine' : 'Screenshot from the app'} value={lines[a.id]?.photo ?? null} onChange={(p) => setLines((l) => ({ ...l, [a.id]: { amount: l[a.id]?.amount ?? '', photo: p } }))} userId={profile.id} />}
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--line-2)' }}>
              <label htmlFor="credit-total" className="warn" style={{ fontSize: 13, fontWeight: 700 }}>Credit bills</label>
              <AmountInput id="credit-total" big={false} value={credit} onChange={setCredit} />
            </div>
            <div className="help">Credit bills are the customers who will pay later. Add each bill with its photo under Customers → New credit bill so the app knows who owes what.</div>
          </Card>
          {pos > 0 && (cash < 0 ? <Notice kind="danger">Card, online and credit amounts exceed the POS total by {num(-cash)}</Notice> : <Notice kind="ok">{num(cash)} cash + {num(nonCashTotal)} card/online + {num(amountOf(credit))} credit = {num(pos)} · matches POS</Notice>)}
          {missingPhotos.length > 0 && <Notice kind="warn">Attach the slip or screenshot for: {missingPhotos.map((a) => a.name).join(', ')}</Notice>}
          <div className="form-footer"><Button kind="primary" size="big" disabled={!canSave} onClick={save} data-testid="save-sale">{busy ? 'Saving…' : 'Save & go to drawer count'}</Button></div>
        </div>
      </div>
    </>
  );
}

// Sales page: the day's breakdown (desktop) and a list of days
export function SalesPage() {
  const accounts = useStore((s) => s.accounts);
  const refreshKey = useStore((s) => s.refreshKey);
  const isOwner = useIsOwner();
  const [params, setParams] = useSearchParams();
  const day = params.get('day') || today();
  const [data, setData] = useState<{ sale: api.DailySale | null; lines: api.DailySaleLine[]; bday: api.BusinessDay | null; closing: api.Closing | null; book: api.CashBook; bills: api.CreditBill[]; collections: api.CreditCollection[]; customers: api.Customer[]; photos: api.Photo[] } | null>(null);
  useEffect(() => {
    (async () => {
      const [sale, bday, closing, book, bills, collections, customers] = await Promise.all([api.getDailySale(day), api.getDay(day), api.getClosing(day), api.cashBook(day), api.listCreditBills(), api.listCreditCollections(), api.listCustomers()]);
      const lines = sale ? await api.getSaleLines(sale.id) : [];
      const photos = await api.getPhotos([...(sale ? [sale.photo_id] : []), ...lines.map((l) => l.photo_id)]);
      setData({ sale, lines, bday, closing, book, bills: bills.filter((b) => b.day === day), collections: collections.filter((c) => c.day === day), customers, photos });
    })().catch((e) => useStore.getState().toast((e as Error).message, 'danger'));
  }, [day, refreshKey]);
  const shift = (n: number) => { const d = new Date(day); d.setDate(d.getDate() + n); setParams({ day: d.toISOString().slice(0, 10) }); };
  if (!data) return <><TopBar title="Daily sale" /><Spinner /></>;
  const { sale, lines, closing, book } = data;
  const acc = (id: string) => accounts.find((a) => a.id === id);
  const photo = (id: string) => data.photos.find((p) => p.id === id)?.storage_path;
  const cust = (id: string) => data.customers.find((c) => c.id === id)?.name ?? '';
  const card = lines.filter((l) => acc(l.account_id)?.kind === 'card_machine');
  const online = lines.filter((l) => acc(l.account_id)?.kind !== 'card_machine');
  const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);
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
              <div className="kpi"><div className="label">POS system total</div><div className="value num"><Money v={sale.pos_total} /></div><div className="hint"><ProofLink storagePath={photo(sale.photo_id)} label="POS photo" /></div></div>
              <div className="kpi"><div className="label accent">Cash</div><div className="value num accent">{num(book.pos_cash_sale)}</div><div className="hint">goes to drawer</div></div>
              <div className="kpi"><div className="label">Card machines</div><div className="value num">{num(sum(card))}</div><div className="hint">{card.length} slips attached</div></div>
              <div className="kpi"><div className="label">Online received</div><div className="value num">{num(sum(online))}</div><div className="hint">{online.length} screenshots</div></div>
              <div className="kpi"><div className="label warn">Credit bills</div><div className="value num warn">{num(sale.credit_total)}</div><div className="hint">{data.bills.length} bills · pay later</div></div>
            </div>
          </Card>
          <div className="grid grid-3">
            <Card title="Card machines" right={<span className="num" style={{ fontWeight: 800 }}>{num(sum(card))}</span>}>
              {card.length === 0 ? <div className="muted">None</div> : card.map((l) => <div className="row" key={l.id}><div className="grow"><span className="t">{acc(l.account_id)?.name}</span><span className="s">End-of-day slip</span></div><ProofLink storagePath={photo(l.photo_id)} /><span className="amt num">{num(l.amount)}</span></div>)}
            </Card>
            <Card title="Online received" right={<span className="num" style={{ fontWeight: 800 }}>{num(sum(online))}</span>}>
              {online.length === 0 ? <div className="muted">None</div> : online.map((l) => <div className="row" key={l.id}><div className="grow"><span className="t">{acc(l.account_id)?.name}</span><span className="s">Screenshot</span></div><ProofLink storagePath={photo(l.photo_id)} /><span className="amt num">{num(l.amount)}</span></div>)}
            </Card>
            <Card title="Credit bills today" right={<span className="num warn" style={{ fontWeight: 800 }}>{num(sale.credit_total)}</span>}>
              {data.bills.map((b) => <div className="row" key={b.id}><div className="grow"><span className="t">{cust(b.customer_id)}</span><span className="s">Bill {b.bill_no}</span></div><span className="amt num">{num(b.amount)}</span></div>)}
              {data.collections.map((c) => <div className="row" key={c.id}><div className="grow"><span className="t">Collected · {cust(c.customer_id)}</span><span className="s">{acc(c.account_id)?.kind === 'cash_drawer' ? 'cash into drawer' : acc(c.account_id)?.name}</span></div><span className="amt num ok">+ {num(c.amount)}</span></div>)}
              {data.bills.length === 0 && data.collections.length === 0 && <div className="muted">None</div>}
              {sale.credit_total !== sum(data.bills) && <Notice kind="warn">Credit total {num(sale.credit_total)} but bills entered {num(sum(data.bills))} — add the missing bills under Customers</Notice>}
            </Card>
          </div>
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
