import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { TopBar } from '../components/Shell';
import { Card, PhotoPicker, Button, Notice, Spinner, Money, ProofLink, Pill, Sheet, Field, Icon, DenominationCount, denominationsTotal, denominationsText, type Denominations } from '../components/ui';
import { useStore, useIsOwner } from '../lib/store';
import * as api from '../lib/api';
import { today, fmtDay, num, fmtDateTime } from '../lib/format';
import type { ProofPhoto } from '../lib/photos';
import { PostingCheck } from '../components/Posting';

// Daily closing: the app adds up what the drawer should hold; the manager counts; the difference is the control figure.
export default function Closing() {
  const profile = useStore((s) => s.profile)!;
  const isOwner = useIsOwner();
  const toast = useStore((s) => s.toast);
  const refreshKey = useStore((s) => s.refreshKey);
  const [params] = useSearchParams();
  const day = params.get('day') || today();
  const [data, setData] = useState<{ sale: api.DailySale | null; lines: api.DailySaleLine[]; receipts: api.SaleReceipt[]; book: api.CashBook; closing: api.Closing | null; bday: api.BusinessDay | null; photos: api.Photo[]; recent: api.Closing[]; closedBy: string } | null>(null);
  const [denoms, setDenoms] = useState<Denominations>({});
  const [fromSale, setFromSale] = useState(false);
  const [blocked, setBlocked] = useState(0);
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const [reason, setReason] = useState('');

  const load = async () => {
    const [sale, book, closing, bday, profiles] = await Promise.all([api.getDailySale(day), api.cashBook(day), api.getClosing(day), api.getDay(day), api.listProfiles()]);
    const lines = sale ? await api.getSaleLines(sale.id) : [];
    const receipts = await api.listReceipts(day, day).catch(() => [] as api.SaleReceipt[]);
    const from = new Date(day); from.setDate(from.getDate() - 7);
    const recent = await api.listClosings(from.toISOString().slice(0, 10), day);
    const photos = await api.getPhotos([...(closing ? [closing.drawer_photo_id] : []), ...(sale ? [sale.photo_id] : [])]);
    setData({ sale, lines, receipts, book, closing, bday, photos, recent, closedBy: closing ? profiles.find((p) => p.id === closing.closed_by)?.name ?? '' : '' });
    if (sale?.pos_source === 'count' && sale.denominations && !closing) { setDenoms(sale.denominations); setFromSale(true); }
  };
  useEffect(() => { load().catch((e) => toast((e as Error).message, 'danger')); }, [day, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <><TopBar title="Daily closing" /><Spinner /></>;
  const { sale, book, closing, bday } = data;
  const countedN = denominationsTotal(denoms);
  const counted = countedN > 0 ? String(countedN) : '';
  const diff = countedN - book.expected_cash;
  const avg = data.recent.filter((c) => c.day !== day).length ? data.recent.filter((c) => c.day !== day).reduce((s, c) => s + c.difference, 0) / data.recent.filter((c) => c.day !== day).length : null;
  const photoPath = (id: string) => data.photos.find((p) => p.id === id)?.storage_path;
  const nonCash = data.lines.reduce((s, l) => s + l.amount, 0) + data.receipts.reduce((s, r) => s + r.amount, 0);

  const submit = async () => {
    if (!photo || countedN < 0) return;
    if (diff < 0 && !confirm(`The drawer is SHORT by ${num(-diff)}. Submit anyway? The owner will be alerted.`)) return;
    setBusy(true);
    try { await api.submitClosing(day, countedN, photo.id, note || undefined, denoms); toast(diff < 0 ? 'Closing submitted — minus reported to the owner' : 'Closing submitted', diff < 0 ? 'danger' : 'ok'); useStore.getState().bump(); await load(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  const approve = async () => { setBusy(true); try { await api.approveDay(day); toast('Day approved and locked', 'ok'); useStore.getState().bump(); await load(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); } };
  const doUnlock = async () => { if (!reason.trim()) return; setBusy(true); try { await api.unlockDay(day, reason.trim()); toast('Day unlocked — the manager must close it again', 'ok'); setUnlock(false); setReason(''); useStore.getState().bump(); await load(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); } };

  return (
    <>
      <TopBar title="Daily closing" sub={`${fmtDay(day)} · ${profile.role === 'cashier' ? 'view only' : profile.name}`} back right={<>
        {bday?.status === 'approved' && <Pill kind="ok"><Icon.Lock size={12} /> Approved & locked</Pill>}
        {isOwner && bday?.status === 'closed' && <Button kind="primary" onClick={approve} disabled={busy} data-testid="approve-day">Approve & lock day</Button>}
        {isOwner && (bday?.status === 'approved' || bday?.status === 'closed') && <Button onClick={() => setUnlock(true)}>Unlock day…</Button>}
      </>} />
      <div className="content">
        <div className="form" style={{ maxWidth: 720 }}>
          {!sale && <Card kind="warn"><b>Step 1 · Record the daily sale first</b><span className="help">The closing needs the POS total and its split.</span>{profile.role !== 'cashier' && <Link className="btn primary" to={`/sales/new?day=${day}`} style={{ alignSelf: 'flex-start' }}>Record daily sale</Link>}</Card>}
          {sale && <Card title={<span><span className="pill ok"><Icon.Check size={12} /></span> POS system total</span>} right={<ProofLink storagePath={photoPath(sale.photo_id)} label="POS photo" />}>
            <div className="grid grid-4">
              <div className="kpi"><div className="label">{sale.pos_source === 'count' ? 'Sale (from count)' : 'Total'}</div><div className="value num" style={{ fontSize: 20 }}>{num(sale.pos_total)}</div></div>
              <div className="kpi"><div className="label accent">Cash</div><div className="value num accent" style={{ fontSize: 20 }}>{num(book.pos_cash_sale)}</div></div>
              <div className="kpi"><div className="label">Card / online</div><div className="value num" style={{ fontSize: 20 }}>{num(nonCash)}</div></div>
              <div className="kpi"><div className="label warn">Credit</div><div className="value num warn" style={{ fontSize: 20 }}>{num(sale.credit_total)}</div></div>
            </div>
          </Card>}
          {sale?.pos_source === 'count' && <Notice kind="warn">The sale was worked out from the drawer count ({num(sale.counted_cash)}), so the difference below will be zero. The owner should compare {num(sale.pos_total)} with the POS report.</Notice>}
          <Card title={<span><span className="pill ok"><Icon.Check size={12} /></span> Cash in and out today</span>} right={<span className="help">from entries</span>}>
            <div className="line"><span className="k">Opening cash (yesterday)</span><span className="v num">{num(book.opening_cash)}</span></div>
            <div className="line"><span className="k">+ POS cash sale (cash only)</span><span className="v num ok">+ {num(book.pos_cash_sale)}</span></div>
            <div className="line"><span className="k">+ Credit bills collected in cash</span><span className="v num ok">+ {num(book.credit_collected_cash)}</span></div>
            {book.waw_borrowed_cash > 0 && <div className="line"><span className="k">+ Borrowed from WAW F/S (cash)</span><span className="v num ok">+ {num(book.waw_borrowed_cash)}</span></div>}
            <div className="line"><span className="k">− Distributor payments (cash)</span><span className="v num danger">− {num(book.distributor_paid_cash)}</span></div>
            <div className="line"><span className="k">− Expenses (cash)</span><span className="v num danger">− {num(book.expenses_cash)}</span></div>
            <div className="line"><span className="k">− Staff advances · WAW repaid · returned to owner</span><span className="v num">{num(book.staff_advances_cash + book.waw_repaid_cash + book.owner_cash_returns)}</span></div>
            <div className="line total"><span className="k">Drawer should hold</span><span className="v num accent" data-testid="expected-cash">{num(book.expected_cash)}</span></div>
          </Card>
          {closing ? <>
            <PostingCheck day={day} canPost={profile.role !== 'cashier' && bday?.status !== 'approved'} onChange={() => undefined} />
            <Card kind={closing.difference < 0 ? 'danger' : 'ok'}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div className="kpi"><div className="label">Difference · counted {num(closing.counted_cash)} vs expected {num(closing.expected_cash)}</div><div className="value num" data-testid="difference"><Money v={closing.difference} sign /></div><div className="hint">{closing.difference < 0 ? 'MINUS — drawer is short' : 'Plus · normal'}{avg !== null && ` · 7-day avg ${num(Math.round(avg), true)}`} · closed by {data.closedBy} at {fmtDateTime(closing.created_at)}{closing.device ? ` · ${closing.device}` : ''}</div></div>
                </div>
                <ProofLink storagePath={photoPath(closing.drawer_photo_id)} label="Drawer photo" />
              </div>
              {closing.denominations && <div className="help">Notes counted: {denominationsText(closing.denominations)}</div>}
              {closing.note && <div className="help">Note: {closing.note}</div>}
            </Card>
            <Notice kind={bday?.status === 'approved' ? 'ok' : 'info'}>{bday?.status === 'approved' ? 'This day is approved and locked. Nothing in it can change unless the owner unlocks it with a reason.' : 'Closing submitted and cannot be edited. Waiting for the owner to approve and lock the day.'}</Notice>
          </> : profile.role !== 'cashier' && sale ? <>
            <PostingCheck day={day} canPost onChange={setBlocked} />
            <Card kind="outline" title={<span><span className="pill accent">3</span> Count the drawer · note by note</span>} right={fromSale ? <span className="help">from the count done at the sale</span> : undefined}>
              <DenominationCount value={denoms} onChange={(d) => { setDenoms(d); setFromSale(false); }} />
              {counted !== '' && <div className={`notice ${diff < 0 ? 'danger' : 'ok'}`} data-testid="live-diff">{diff < 0 ? <Icon.Alert size={16} /> : <Icon.Check size={16} />}<span>Difference {num(diff, diff >= 0)} · {diff < 0 ? 'MINUS — the drawer is short. The owner will be alerted.' : 'plus is normal'}{avg !== null && ` · 7-day avg ${num(Math.round(avg), true)}`}</span></div>}
              <PhotoPicker label="Drawer photo" hint="Photo of the counted cash" value={photo} onChange={setPhoto} userId={profile.id} />
              <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 500 note torn, kept aside" /></Field>
            </Card>
            <div className="form-footer"><Button kind="primary" size="big" disabled={!photo || counted === '' || busy || blocked > 0} onClick={submit} data-testid="submit-closing">{busy ? 'Submitting…' : blocked > 0 ? `Answer ${blocked} unposted invoice${blocked === 1 ? '' : 's'} first` : 'Submit closing'}</Button></div>
            <div className="help">Once submitted the closing cannot be changed. A minus turns red and alerts the owner immediately.</div>
          </> : null}
          {data.recent.length > 0 && <Card title="Last 7 closings">
            {data.recent.map((c) => <div className="row" key={c.id}><div className="grow"><span className="t">{fmtDay(c.day)}</span><span className="s">expected {num(c.expected_cash)} · counted {num(c.counted_cash)}{c.denominations ? ` · ${denominationsText(c.denominations)}` : ''}</span></div><Pill kind={c.difference < 0 ? 'danger' : 'ok'}>{num(c.difference, true)}</Pill></div>)}
          </Card>}
        </div>
      </div>
      {unlock && <Sheet title="Unlock this day" onClose={() => setUnlock(false)}>
        <Notice kind="warn">Unlocking removes the closing (it stays in the audit log) so the manager can count again. Every entry becomes editable by you with a reason.</Notice>
        <Field label="Reason (required)"><textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. manager counted a bundle twice" /></Field>
        <div className="actions"><Button onClick={() => setUnlock(false)}>Cancel</Button><Button kind="danger" disabled={!reason.trim() || busy} onClick={doUnlock}>Unlock day</Button></div>
      </Sheet>}
    </>
  );
}
