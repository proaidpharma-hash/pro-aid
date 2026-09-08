import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sheet, Field, AmountInput, amountOf, Chips, Button, Notice, Card, Pill, PhotoPicker, Spinner } from './ui';
import { useStore } from '../lib/store';
import * as api from '../lib/api';
import { num, fmtShort, today } from '../lib/format';
import type { ProofPhoto } from '../lib/photos';

// "Posted in POS" — asks how much was actually posted; a lower figure needs a reason and becomes a difference the distributor owes
export function PostedSheet({ invoice, onClose, onSaved }: { invoice: { id: string; invoice_no: string; distributor_name: string; amount: number }; onClose: () => void; onSaved: () => void }) {
  const toast = useStore((s) => s.toast);
  const [amount, setAmount] = useState(String(Math.round(invoice.amount)));
  const [kind, setKind] = useState<api.DiffKind | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const posted = amountOf(amount);
  const diff = invoice.amount - posted;
  const canSave = amount !== '' && posted >= 0 && (diff === 0 || kind) && !busy;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try { await api.markPosted(invoice.id, posted, diff !== 0 ? kind : null, diff !== 0 ? note.trim() || null : null); toast(diff > 0 ? `Posted · ${num(diff)} difference recorded` : 'Marked as posted in POS', diff > 0 ? 'danger' : 'ok'); onSaved(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return <Sheet title={`Posted in POS · ${invoice.distributor_name} · Inv ${invoice.invoice_no}`} onClose={onClose}>
    <Field label={`Amount posted in the POS system (invoice ${num(invoice.amount)})`}><AmountInput big={false} value={amount} onChange={setAmount} id="posted-amount" /></Field>
    {amount !== '' && diff > 0 && <>
      <Notice kind="warn">Posted {num(diff)} less than the invoice — the distributor owes this until it is settled (goods delivered later, credit note, refund or adjusted in the next invoice).</Notice>
      <Field label="Why the difference?"><Chips options={(Object.keys(api.DIFF_KIND_LABEL) as api.DiffKind[]).map((k) => ({ value: k, label: api.DIFF_KIND_LABEL[k] }))} value={kind} onChange={setKind} /></Field>
      <Field label="Detail (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 2 packs missing, rep will send tomorrow" data-testid="diff-note" /></Field>
    </>}
    {amount !== '' && diff < 0 && <>
      <Notice kind="warn">Posted {num(-diff)} MORE than the invoice — check the figure. If it is right, say why.</Notice>
      <Field label="Why the difference?"><Chips options={(Object.keys(api.DIFF_KIND_LABEL) as api.DiffKind[]).map((k) => ({ value: k, label: api.DIFF_KIND_LABEL[k] }))} value={kind} onChange={setKind} /></Field>
      <Field label="Detail (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </>}
    <Button kind="primary" size="big" disabled={!canSave} onClick={save} data-testid="posted-save">{busy ? 'Saving…' : diff === 0 ? 'Posted at the full amount' : `Posted with ${num(Math.abs(diff))} difference`}</Button>
  </Sheet>;
}

// "Not posted — why?" asked at closing for every invoice still not in the POS
export function UnpostedReasonSheet({ invoice, day, onClose, onSaved }: { invoice: api.ClosingBlocker; day: string; onClose: () => void; onSaved: () => void }) {
  const toast = useStore((s) => s.toast);
  const [reason, setReason] = useState(invoice.unposted_reason ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try { await api.giveUnpostedReason(invoice.id, day, reason.trim()); toast('Reason saved — the owner will see it with the closing', 'ok'); onSaved(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return <Sheet title={`Not posted · ${invoice.distributor_name} · Inv ${invoice.invoice_no}`} onClose={onClose}>
    <Notice kind="info">Received {fmtShort(invoice.day)} · {num(invoice.amount)}. Why is it not yet posted in the POS?</Notice>
    <Field label="Reason (required)"><textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. stock check pending · rate difference with rep · items short, waiting for the rest" data-testid="unposted-reason" /></Field>
    <Button kind="primary" size="big" disabled={!reason.trim() || busy} onClick={save} data-testid="unposted-reason-save">{busy ? 'Saving…' : 'Save reason'}</Button>
  </Sheet>;
}

// The posting check shown on the Closing page before the drawer count
export function PostingCheck({ day, canPost, onChange }: { day: string; canPost: boolean; onChange: (blocked: number) => void }) {
  const refreshKey = useStore((s) => s.refreshKey);
  const [blockers, setBlockers] = useState<api.ClosingBlocker[] | null>(null);
  const [unposted, setUnposted] = useState<api.InvoiceStatus[]>([]);
  const [diffs, setDiffs] = useState<api.InvoiceStatus[]>([]);
  const [posting, setPosting] = useState<api.ClosingBlocker | null>(null);
  const [reasoning, setReasoning] = useState<api.ClosingBlocker | null>(null);
  const load = async () => {
    const [b, u, all] = await Promise.all([api.closingBlockers(day), api.invoiceStatus({ unposted: true }), api.invoiceStatus()]);
    setBlockers(b); setUnposted(u.filter((i) => i.day <= day));
    setDiffs(all.filter((i) => i.posted_in_pos && i.posted_at && i.posted_at.slice(0, 10) === day && i.post_diff > 0));
    onChange(b.length);
  };
  useEffect(() => { load().catch(() => undefined); }, [day, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!blockers) return <Card><Spinner /></Card>;
  if (unposted.length === 0 && diffs.length === 0) return <Card kind="ok"><b>All invoices are posted in the POS</b><span className="help">Nothing received up to {fmtShort(day)} is waiting to be entered into the system.</span></Card>;
  const done = (b: api.ClosingBlocker) => !blockers.some((x) => x.id === b.id);
  return <>
    <Card kind={blockers.length ? 'warn' : 'outline'} title={<span><span className={`pill ${blockers.length ? 'warn' : 'ok'}`}>{blockers.length ? '!' : '✓'}</span> Invoices not posted in POS · {unposted.length}</span>} right={<span className="help">{blockers.length ? `${blockers.length} need an answer before closing` : 'reasons given for today'}</span>}>
      {unposted.map((i) => {
        const b: api.ClosingBlocker = { id: i.id, invoice_no: i.invoice_no, distributor_name: i.distributor_name, amount: i.amount, day: i.day, unposted_reason: i.unposted_reason, unposted_reason_day: i.unposted_reason_day };
        const ok = done(b);
        return <div className="row wrap" key={i.id} data-testid="posting-row">
          <div className="grow"><span className="t">{i.distributor_name} · Inv {i.invoice_no}</span><span className="s">received {fmtShort(i.day)} · {num(i.amount)} · {i.remaining <= 0 ? 'paid' : `${num(i.remaining)} unpaid`}{ok && i.unposted_reason ? <> · <b className="warn">not posted: {i.unposted_reason}</b>{i.unposted_reason_by_name ? ` (${i.unposted_reason_by_name})` : ''}</> : i.unposted_reason ? <span className="muted"> · earlier: {i.unposted_reason}</span> : ''}</span></div>
          {ok ? <Pill kind="warn">Reason given</Pill> : <Pill kind="danger">Needs answer</Pill>}
          <span className="acts">
            {canPost && <Button size="sm" kind="primary" onClick={() => setPosting(b)} data-testid="posting-posted">Posted in POS…</Button>}
            <Button size="sm" onClick={() => setReasoning(b)} data-testid="posting-reason">{ok ? 'Change reason' : 'Not posted — reason'}</Button>
          </span>
        </div>;
      })}
      {!canPost && <div className="help">Only a manager or the owner can mark an invoice as posted; you can give the reason.</div>}
    </Card>
    {diffs.length > 0 && <Card kind="warn" title={`Posted today with a difference · ${diffs.length}`}>
      {diffs.map((i) => <div className="row wrap" key={i.id}><div className="grow"><span className="t">{i.distributor_name} · Inv {i.invoice_no}</span><span className="s">invoice {num(i.amount)} · posted {num(i.posted_amount)} · <b className="danger">{num(i.post_diff)} short</b> · {i.post_diff_kind ? api.DIFF_KIND_LABEL[i.post_diff_kind] : ''}{i.post_diff_note ? ` · ${i.post_diff_note}` : ''}</span></div><Link className="btn sm" to={`/distributors/${i.distributor_id}`}>Distributor</Link></div>)}
    </Card>}
    {posting && <PostedSheet invoice={posting} onClose={() => setPosting(null)} onSaved={() => { setPosting(null); useStore.getState().bump(); }} />}
    {reasoning && <UnpostedReasonSheet invoice={reasoning} day={day} onClose={() => setReasoning(null)} onSaved={() => { setReasoning(null); useStore.getState().bump(); }} />}
  </>;
}

// Settle a posting difference (owner or manager, photo required)
export function DiffSettleSheet({ invoice, userId, onClose, onSaved }: { invoice: api.InvoiceStatus; userId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useStore((s) => s.toast);
  const [kind, setKind] = useState<api.DiffSettlement['kind']>('goods_received');
  const [amount, setAmount] = useState(String(Math.round(invoice.diff_pending)));
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const amt = amountOf(amount);
  const canSave = amt > 0 && amt <= invoice.diff_pending && photo && !busy;
  const save = async () => {
    if (!canSave || !photo) return;
    setBusy(true);
    try { await api.addDiffSettlement({ invoice_id: invoice.id, day: today(), kind, amount: amt, note: note.trim() || null, photo_id: photo.id }); toast('Difference settled', 'ok'); onSaved(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return <Sheet title={`Settle difference · Inv ${invoice.invoice_no}`} onClose={onClose}>
    <Notice kind="info">Invoice {num(invoice.amount)}, posted {num(invoice.posted_amount)} · {num(invoice.diff_pending)} still owed by {invoice.distributor_name}{invoice.post_diff_kind ? ` · ${api.DIFF_KIND_LABEL[invoice.post_diff_kind]}` : ''}{invoice.post_diff_note ? ` · ${invoice.post_diff_note}` : ''}</Notice>
    <Field label="How was it settled?"><Chips options={[{ value: 'goods_received', label: 'Goods delivered later' }, { value: 'credit_note', label: 'Credit note' }, { value: 'refund', label: 'Cash refund' }, { value: 'adjusted', label: 'Adjusted in next invoice' }]} value={kind} onChange={setKind} /></Field>
    <Field label="Amount" error={amt > invoice.diff_pending ? `More than pending (${num(invoice.diff_pending)})` : undefined}><AmountInput big={false} value={amount} onChange={setAmount} /></Field>
    <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    <PhotoPicker label="Proof photo" hint="Delivery note, credit note or the adjusted invoice" value={photo} onChange={setPhoto} userId={userId} />
    <Button kind="primary" size="big" disabled={!canSave} onClick={save}>{busy ? 'Saving…' : 'Settle'}</Button>
  </Sheet>;
}
