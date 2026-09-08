import { useEffect, useMemo, useState } from 'react';
import { Card, Field, AmountInput, amountOf, Chips, Button, Notice, PhotoPicker } from './ui';
import { useStore } from '../lib/store';
import * as api from '../lib/api';
import { num, fmtShort, today } from '../lib/format';
import type { ProofPhoto } from '../lib/photos';

// One invoice, several sources. Each line: where the money came from, how much, its proof and a note.
// Sources: drawer cash (today's / yesterday's), card machine / wallet / bank, owner's personal account,
// a WAW F/S loan (booked automatically), or adjusting a difference this distributor already owes us.
export type PaymentLine = { key: string; source: string; amount: string; cashSource: 'today' | 'yesterday'; photo: ProofPhoto | null; note: string };
export type SourceOption = { value: string; label: string; sub: string; kind: api.AccountKind | 'adjustment'; accountId: string; adjustFrom?: string; maxAmount?: number; needsPhoto: boolean };

export const newLine = (): PaymentLine => ({ key: `${Date.now()}-${Math.random()}`, source: '', amount: '', cashSource: 'today', photo: null, note: '' });

export function useSourceOptions(distributorId: string | null, excludeInvoiceId?: string | null) {
  const accounts = useStore((s) => s.accounts);
  const [diffs, setDiffs] = useState<api.InvoiceStatus[]>([]);
  const refreshKey = useStore((s) => s.refreshKey);
  useEffect(() => {
    if (!distributorId) { setDiffs([]); return; }
    api.invoiceStatus({ distributor_id: distributorId }).then((rows) => setDiffs(rows.filter((i) => i.diff_pending > 0 && i.id !== excludeInvoiceId))).catch(() => setDiffs([]));
  }, [distributorId, excludeInvoiceId, refreshKey]);
  return useMemo<SourceOption[]>(() => {
    const out: SourceOption[] = [];
    for (const a of accounts) {
      if (a.kind === 'cash_drawer') out.push({ value: a.id, label: 'Cash drawer', sub: "today's or yesterday's cash", kind: a.kind, accountId: a.id, needsPhoto: true });
      else if (a.kind === 'owner_personal') out.push({ value: a.id, label: "Owner's personal account", sub: 'owner pays, settled later', kind: a.kind, accountId: a.id, needsPhoto: true });
      else if (a.kind === 'waw_fs') out.push({ value: a.id, label: 'WAW F/S loan', sub: 'borrowed and paid straight to the distributor', kind: a.kind, accountId: a.id, needsPhoto: true });
      else if (a.kind === 'adjustment') { /* added per source invoice below */ }
      else out.push({ value: a.id, label: a.name, sub: a.kind === 'card_machine' ? 'card machine' : a.kind === 'wallet' ? 'wallet' : 'bank account', kind: a.kind, accountId: a.id, needsPhoto: true });
    }
    const adj = accounts.find((a) => a.kind === 'adjustment');
    if (adj) for (const d of diffs) out.push({ value: `adjust:${d.id}`, label: `Adjust difference · Inv ${d.invoice_no}`, sub: `${num(d.diff_pending)} they owe us · no cash moves`, kind: 'adjustment', accountId: adj.id, adjustFrom: d.id, maxAmount: d.diff_pending, needsPhoto: false });
    return out;
  }, [accounts, diffs]);
}

export function paymentLinesTotal(lines: PaymentLine[]) { return lines.reduce((s, l) => s + amountOf(l.amount), 0); }

// what stops the lines from being saved (null when they are fine)
export function paymentLinesProblem(lines: PaymentLine[], options: SourceOption[], remaining: number): string | null {
  if (lines.length === 0) return 'Add at least one payment line';
  const seen = new Set<string>();
  for (const l of lines) {
    const o = options.find((x) => x.value === l.source);
    if (!o) return 'Choose the source for every line';
    const key = o.kind === 'cash_drawer' ? `${o.value}:${l.cashSource}` : o.value;
    if (seen.has(key)) return `${o.label}${o.kind === 'cash_drawer' ? ` (${l.cashSource === 'today' ? "today's" : "yesterday's"} cash)` : ''} is used twice — combine into one line`;
    seen.add(key);
    const a = amountOf(l.amount);
    if (a <= 0) return 'Every line needs an amount';
    if (o.maxAmount !== undefined && a > o.maxAmount) return `Only ${num(o.maxAmount)} can be adjusted from Inv ${o.label.split('Inv ')[1]}`;
    if (o.needsPhoto && !l.photo) return `Attach the proof photo for ${o.label}`;
  }
  if (paymentLinesTotal(lines) > remaining) return `Lines add up to ${num(paymentLinesTotal(lines))} — more than the ${num(remaining)} remaining`;
  return null;
}

// posts the lines one by one; returns how many were saved (stops at the first refusal and throws)
export async function postPaymentLines(invoiceId: string, day: string, lines: PaymentLine[], options: SourceOption[], requestedBy: string) {
  let saved = 0;
  for (const l of lines) {
    const o = options.find((x) => x.value === l.source)!;
    await api.recordPayment({ invoice_id: invoiceId, day, amount: amountOf(l.amount), account_id: o.accountId, cash_source: o.kind === 'cash_drawer' ? l.cashSource : 'not_cash', photo_id: l.photo?.id ?? null, requested_by: o.kind === 'owner_personal' ? requestedBy : null, note: l.note.trim() || null, adjust_from_invoice_id: o.adjustFrom ?? null });
    saved++;
  }
  return saved;
}

export function PaymentLinesEditor({ lines, onChange, options, remaining, userId, day, dueDate, onDueDate }: { lines: PaymentLine[]; onChange: (l: PaymentLine[]) => void; options: SourceOption[]; remaining: number; userId: string; day: string; dueDate: string; onDueDate: (d: string) => void }) {
  const total = paymentLinesTotal(lines);
  const left = remaining - total;
  const problem = paymentLinesProblem(lines, options, remaining);
  const upd = (key: string, patch: Partial<PaymentLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const used = new Set(lines.map((l) => l.source));
  return <>
    {lines.map((l, idx) => {
      const o = options.find((x) => x.value === l.source);
      return <Card key={l.key} kind="outline" title={<span><span className="pill accent">{idx + 1}</span> {o ? o.label : 'Payment source'}</span>} right={lines.length > 1 && <Button kind="ghost" size="sm" onClick={() => onChange(lines.filter((x) => x.key !== l.key))} aria-label="Remove line">✕</Button>}>
        <Field label="Paid from">
          <select className="select" value={l.source} onChange={(e) => upd(l.key, { source: e.target.value, photo: null })} data-testid={`line-source-${idx}`}>
            <option value="">Choose…</option>
            {options.map((x) => <option key={x.value} value={x.value} disabled={used.has(x.value) && x.value !== l.source && x.kind !== 'cash_drawer'}>{x.label} — {x.sub}</option>)}
          </select>
        </Field>
        {o?.kind === 'cash_drawer' && <Chips options={[{ value: 'today', label: "Today's cash" }, { value: 'yesterday', label: "Yesterday's cash" }]} value={l.cashSource} onChange={(v) => upd(l.key, { cashSource: v })} />}
        <div className="grid grid-2">
          <Field label="Amount"><AmountInput big={false} id={`line-amount-${idx}`} value={l.amount} onChange={(v) => upd(l.key, { amount: v })} error={o?.maxAmount !== undefined && amountOf(l.amount) > o.maxAmount} /></Field>
          <Field label="Note (optional)"><input className="input" value={l.note} onChange={(e) => upd(l.key, { note: e.target.value })} placeholder="cheque no · rep name · TID" data-testid={`line-note-${idx}`} /></Field>
        </div>
        {o?.kind === 'adjustment' && <div className="chips"><button type="button" className="chip" onClick={() => upd(l.key, { amount: String(Math.round(Math.min(o.maxAmount ?? 0, remaining))) })}>Whole difference {num(o.maxAmount ?? 0)}</button></div>}
        {o && o.kind !== 'adjustment' && idx === lines.length - 1 && left + amountOf(l.amount) > 0 && <div className="chips"><button type="button" className="chip" onClick={() => upd(l.key, { amount: String(Math.round(left + amountOf(l.amount))) })}>Rest {num(left + amountOf(l.amount))}</button></div>}
        {o?.needsPhoto && <PhotoPicker label={o.kind === 'cash_drawer' ? 'Invoice / receipt photo' : o.kind === 'waw_fs' ? 'WAW F/S transfer proof' : 'Transfer screenshot'} hint={o.kind === 'cash_drawer' ? 'Signed invoice or the distributor receipt' : 'Screenshot showing the transfer'} value={l.photo} onChange={(p) => upd(l.key, { photo: p })} userId={userId} />}
        {o?.kind === 'owner_personal' && <div className="help">The owner is notified; this stays in the "paid from owner's account" list until settled.</div>}
        {o?.kind === 'waw_fs' && <div className="help">A WAW F/S loan of this amount is booked automatically and shows as owed until repaid.</div>}
        {o?.kind === 'adjustment' && <div className="help">No money moves — the distributor's pending difference goes down by this amount.</div>}
      </Card>;
    })}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button size="sm" onClick={() => onChange([...lines, newLine()])} data-testid="add-line">+ Add another source</Button>
      <span className="num" style={{ fontWeight: 800, marginLeft: 'auto' }} data-testid="lines-total">Paying {num(total)}</span>
      <span className={`num ${left < 0 ? 'danger' : left === 0 ? 'ok' : 'warn'}`} style={{ fontWeight: 800 }} data-testid="lines-left">{left < 0 ? `${num(-left)} too much` : left === 0 ? 'Fully paid' : `${num(left)} stays pending`}</span>
    </div>
    {problem && total > 0 && <Notice kind={left < 0 ? 'danger' : 'warn'}>{problem}</Notice>}
    {left > 0 && total > 0 && !problem && <Card kind="warn">
      <Field label={`Due date for the pending ${num(left)}`} help="Everyone gets a daily reminder from that date until it is paid"><input className="input" type="date" value={dueDate} min={day || today()} onChange={(e) => onDueDate(e.target.value)} data-testid="due-date" /></Field>
      {!dueDate && <div className="help">No date? The remainder simply stays pending on the invoice.</div>}
      {dueDate && <div className="help">Reminder on {fmtShort(dueDate)}, every day until paid.</div>}
    </Card>}
  </>;
}
