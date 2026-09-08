import { useEffect, useState } from 'react';
import { Sheet, Notice, Field, AmountInput, amountOf, Button, Spinner } from './ui';
import { useStore } from '../lib/store';
import * as api from '../lib/api';
import { num } from '../lib/format';

// Owner correction: original kept, corrected value, reason required
export function EditSheet({ spec, onClose }: { spec: string; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [table, id] = spec.split(':');
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  useEffect(() => { (async () => { const { supabase } = await import('../lib/supabase'); const { data } = await supabase.from(table).select('*').eq('id', id).maybeSingle(); setRow(data); setAmount(String(data?.amount ?? '')); setNote(String(data?.note ?? '')); })(); }, [table, id]);
  if (!row) return <Sheet title="Edit" onClose={onClose}><Spinner /></Sheet>;
  const hasAmount = 'amount' in row; const hasNote = 'note' in row;
  const save = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      if (del) await api.ownerDelete(table, id, reason.trim());
      else { const patch: Record<string, unknown> = {}; if (hasAmount && amountOf(amount) !== Number(row.amount)) patch.amount = amountOf(amount); if (hasNote && note !== (row.note ?? '')) patch.note = note; if (!Object.keys(patch).length) return toast('Nothing changed', 'danger'); await api.ownerEdit(table, id, patch, reason.trim()); }
      toast(del ? 'Entry deleted (kept in audit log)' : 'Correction saved (original kept in audit log)', 'ok'); useStore.getState().bump(); onClose();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return <Sheet title={`Owner ${del ? 'delete' : 'edit'} · ${table.replace(/_/g, ' ')}`} onClose={onClose}>
    <Notice kind="warn">Both versions stay in the audit log. Locked days cannot be edited without unlocking first.</Notice>
    {hasAmount && <div className="grid grid-2"><Field label="Original (kept)"><div className="input num" style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', textDecoration: 'line-through', color: 'var(--muted)' }}>{num(Number(row.amount))}</div></Field><Field label="Corrected"><AmountInput big={false} value={amount} onChange={setAmount} /></Field></div>}
    {hasNote && <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
    <Field label="Reason (required)"><textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. typed 2500 instead of 1500 — receipt photo shows 1,500" /></Field>
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 700 }}><input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} /> Delete this entry instead</label>
    <div className="actions"><Button onClick={onClose}>Cancel</Button><Button kind={del ? 'danger' : 'primary'} disabled={!reason.trim() || busy} onClick={save}>{del ? 'Delete entry' : 'Save correction'}</Button></div>
  </Sheet>;
}

