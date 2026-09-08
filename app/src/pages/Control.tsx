import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Field, AmountInput, amountOf, Button, Notice, PhotoPicker, Sheet, Pill, Empty, Spinner, DenominationCount, denominationsTotal, denominationsText, type Denominations, Icon } from '../components/ui';
import { useStore, useIsOwner } from '../lib/store';
import * as api from '../lib/api';
import { num, fmtShort, fmtDateTime, today } from '../lib/format';
import type { ProofPhoto } from '../lib/photos';

// ---- 3. surprise drawer count -----------------------------------------------------------
export function SpotCountSheet({ day, userId, onClose, onSaved }: { day: string; userId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useStore((s) => s.toast);
  const [pos, setPos] = useState('');
  const [posPhoto, setPosPhoto] = useState<ProofPhoto | null>(null);
  const [denoms, setDenoms] = useState<Denominations>({});
  const [drawerPhoto, setDrawerPhoto] = useState<ProofPhoto | null>(null);
  const [note, setNote] = useState('');
  const [expected, setExpected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const posN = amountOf(pos);
  const counted = denominationsTotal(denoms);
  useEffect(() => { if (pos === '') { setExpected(null); return; } api.expectedCashNow(day, posN).then(setExpected).catch(() => setExpected(null)); }, [day, posN, pos]);
  const diff = expected === null ? null : counted - expected;
  const canSave = pos !== '' && posPhoto && counted > 0 && drawerPhoto && expected !== null && !busy;
  const save = async () => {
    if (!canSave || !posPhoto || !drawerPhoto) return;
    setBusy(true);
    try {
      const r = await api.spotCount({ day, pos_so_far: posN, pos_photo_id: posPhoto.id, counted, denominations: denoms, drawer_photo_id: drawerPhoto.id, note: note.trim() || null });
      toast(r.difference < 0 ? `Surprise count saved — MINUS ${num(-r.difference)}, the owner is alerted` : `Surprise count saved · ${num(r.difference, true)}`, r.difference < 0 ? 'danger' : 'ok');
      onSaved();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return <Sheet title="Surprise drawer count" onClose={onClose}>
    <Notice kind="info">Any time of day, without warning. The app works out what the drawer should hold right now from the POS running total and today's entries.</Notice>
    <Field label="POS sale so far (running total on the screen)"><AmountInput big={false} value={pos} onChange={setPos} id="spot-pos" /></Field>
    <PhotoPicker label="POS screen photo" value={posPhoto} onChange={setPosPhoto} userId={userId} />
    {expected !== null && <div className="line total"><span className="k">Drawer should hold right now</span><span className="v num accent" data-testid="spot-expected">{num(expected)}</span></div>}
    <div className="card-title" style={{ marginTop: 6 }}>Count the notes</div>
    <DenominationCount value={denoms} onChange={setDenoms} />
    {diff !== null && counted > 0 && <div className={`notice ${diff < 0 ? 'danger' : 'ok'}`} data-testid="spot-diff">{diff < 0 ? <Icon.Alert size={16} /> : <Icon.Check size={16} />}<span>Difference {num(diff, diff >= 0)} · {diff < 0 ? 'MINUS — the owner will be alerted' : 'plus is normal'}</span></div>}
    <PhotoPicker label="Drawer photo" value={drawerPhoto} onChange={setDrawerPhoto} userId={userId} />
    <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 3:15 pm, Ahmed on the counter" /></Field>
    <Button kind="primary" size="big" disabled={!canSave} onClick={save} data-testid="spot-save">{busy ? 'Saving…' : 'Save surprise count'}</Button>
  </Sheet>;
}

export function SpotCountsCard({ from, to, title = 'Surprise counts' }: { from: string; to: string; title?: string }) {
  const refreshKey = useStore((s) => s.refreshKey);
  const [rows, setRows] = useState<api.SpotCount[] | null>(null);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  useEffect(() => { Promise.all([api.listSpotCounts(from, to), api.listProfiles()]).then(([r, p]) => { setRows(r); setProfiles(p); }).catch(() => setRows([])); }, [from, to, refreshKey]);
  if (!rows) return <Card><Spinner /></Card>;
  if (rows.length === 0) return null;
  const who = (id: string) => profiles.find((p) => p.id === id)?.name ?? '';
  return <Card title={`${title} · ${rows.length}`} right={<span className="help">POS so far · expected · counted</span>}>
    {rows.map((r) => <div className="row wrap" key={r.id} data-testid="spot-row"><div className="grow"><span className="t">{fmtShort(r.day)} · {fmtDateTime(r.created_at)} · {who(r.counted_by)}</span><span className="s">POS {num(r.pos_so_far)} · expected {num(r.expected_cash)} · counted {num(r.counted_cash)}{r.denominations ? ` · ${denominationsText(r.denominations)}` : ''}{r.note ? ` · ${r.note}` : ''}</span></div><Pill kind={r.difference < 0 ? 'danger' : 'ok'}>{num(r.difference, true)}</Pill></div>)}
  </Card>;
}

// ---- 2. card-machine reconciliation ------------------------------------------------------
export function ReconciliationCard({ from, to }: { from: string; to: string }) {
  const profile = useStore((s) => s.profile)!;
  const accounts = useStore((s) => s.accounts);
  const refreshKey = useStore((s) => s.refreshKey);
  const toast = useStore((s) => s.toast);
  const [rows, setRows] = useState<api.CardRecon[] | null>(null);
  const [add, setAdd] = useState<{ account_id: string; day: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<ProofPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = profile.role === 'owner' || profile.role === 'manager';
  useEffect(() => { api.cardReconciliation(from, to).then(setRows).catch(() => setRows([])); }, [from, to, refreshKey]);
  const machines = accounts.filter((a) => a.kind === 'card_machine');
  const save = async () => {
    if (!add || !photo || amount === '') return;
    setBusy(true);
    try { await api.addBankSettlement({ account_id: add.account_id, day: add.day, amount: amountOf(amount), note: note.trim() || null, photo_id: photo.id }); toast('Settlement recorded', 'ok'); setAdd(null); setAmount(''); setNote(''); setPhoto(null); useStore.getState().bump(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  if (!rows) return <Card><Spinner /></Card>;
  const pending = rows.filter((r) => r.settled === null);
  const short = rows.filter((r) => r.difference !== null && r.difference < 0);
  return <>
    <Card title="Card machines vs bank · reconciliation" right={canWrite && <Button size="sm" kind="primary" onClick={() => setAdd({ account_id: machines[0]?.id ?? '', day: today() })} data-testid="add-settlement">+ Record bank settlement</Button>}>
      <div className="help">For every day a machine took card payments, enter what the bank actually paid into the account (from the statement or bank app). The app shows any shortfall.</div>
      {rows.length === 0 ? <Empty>No card receipts in this period</Empty> : <div className="scroll-x"><table className="table"><thead><tr><th>Day</th><th>Machine</th><th className="r">Machine took</th><th className="r">Bank paid in</th><th className="r">Difference</th><th></th></tr></thead><tbody>
        {rows.map((r) => <tr key={`${r.day}-${r.account_id}`} className={r.difference !== null && r.difference < 0 ? 'hl' : ''} data-testid="recon-row"><td className="num">{fmtShort(r.day)}</td><td>{r.account_name}</td><td className="r num">{num(r.machine)}</td><td className="r num">{r.settled === null ? <span className="muted">not yet</span> : num(r.settled)}</td><td className={`r num ${r.difference === null ? 'muted' : r.difference < 0 ? 'danger' : 'ok'}`} style={{ fontWeight: 800 }}>{r.difference === null ? '—' : num(r.difference, true)}</td><td>{r.settled === null && canWrite && <Button size="sm" onClick={() => setAdd({ account_id: r.account_id, day: r.day })}>Enter</Button>}{r.note && <span className="muted"> {r.note}</span>}</td></tr>)}
      </tbody></table></div>}
      {(pending.length > 0 || short.length > 0) && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{pending.length > 0 && <Pill kind="warn">{pending.length} day-machine{pending.length === 1 ? '' : 's'} not yet settled</Pill>}{short.length > 0 && <Pill kind="danger">{short.length} short · {num(short.reduce((t, r) => t + (r.difference ?? 0), 0))}</Pill>}</div>}
    </Card>
    {add && <Sheet title="Bank settlement" onClose={() => setAdd(null)}>
      <Field label="Card machine"><select className="select" value={add.account_id} onChange={(e) => setAdd({ ...add, account_id: e.target.value })} data-testid="settle-account">{machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      <Field label="Receipts day being settled"><input className="input" type="date" value={add.day} max={today()} onChange={(e) => setAdd({ ...add, day: e.target.value })} data-testid="settle-day" /></Field>
      <Field label="Amount the bank paid in"><AmountInput big={false} value={amount} onChange={setAmount} id="settle-amount" /></Field>
      <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="statement date, charges deducted…" /></Field>
      <PhotoPicker label="Bank statement / app screenshot" value={photo} onChange={setPhoto} userId={profile.id} />
      <Button kind="primary" size="big" disabled={!photo || amount === '' || busy} onClick={save} data-testid="settle-save">{busy ? 'Saving…' : 'Save settlement'}</Button>
    </Sheet>}
  </>;
}

// ---- 8. expense budgets --------------------------------------------------------------------
export function BudgetsCard({ editable, month }: { editable: boolean; month?: string }) {
  const refreshKey = useStore((s) => s.refreshKey);
  const toast = useStore((s) => s.toast);
  const [rows, setRows] = useState<api.BudgetStatus[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  useEffect(() => { api.expenseBudgetStatus(month).then(setRows).catch(() => setRows([])); }, [month, refreshKey]);
  if (!rows) return <Card><Spinner /></Card>;
  const save = async (id: string) => { try { const v = edit[id]; await api.setExpenseBudget(id, v === '' ? null : amountOf(v)); toast('Budget saved', 'ok'); setEdit((e) => { const c = { ...e }; delete c[id]; return c; }); useStore.getState().bump(); } catch (e) { toast((e as Error).message, 'danger'); } };
  const over = rows.filter((r) => r.over);
  return <Card title={`Expense budgets · ${month ? fmtShort(month).split(' ')[1] : 'this month'}`} right={over.length > 0 ? <Pill kind="danger">{over.length} over budget</Pill> : <span className="help">monthly limits per category</span>}>
    <div className="scroll-x"><table className="table"><thead><tr><th>Category</th><th className="r">Budget</th><th className="r">Spent</th><th className="r">Left</th>{editable && <th></th>}</tr></thead><tbody>
      {rows.map((r) => <tr key={r.category_id} className={r.over ? 'hl' : ''} data-testid="budget-row"><td><b>{r.name}</b></td><td className="r num">{editable && edit[r.category_id] !== undefined ? <input className="input num" style={{ width: 110, textAlign: 'right' }} value={edit[r.category_id]} onChange={(e) => setEdit({ ...edit, [r.category_id]: e.target.value.replace(/[^\d]/g, '') })} data-testid={`budget-input-${r.name}`} /> : r.budget === null ? <span className="muted">no limit</span> : num(r.budget)}</td><td className="r num">{num(r.spent)}</td><td className={`r num ${r.over ? 'danger' : r.remaining !== null && r.remaining < (r.budget ?? 0) * 0.2 ? 'warn' : ''}`} style={{ fontWeight: 800 }}>{r.remaining === null ? '—' : num(r.remaining)}</td>{editable && <td>{edit[r.category_id] !== undefined ? <span style={{ display: 'flex', gap: 4 }}><Button size="sm" kind="primary" onClick={() => save(r.category_id)} data-testid={`budget-save-${r.name}`}>Save</Button><Button size="sm" onClick={() => setEdit((e) => { const c = { ...e }; delete c[r.category_id]; return c; })}>Cancel</Button></span> : <Button size="sm" onClick={() => setEdit({ ...edit, [r.category_id]: r.budget === null ? '' : String(Math.round(r.budget)) })} data-testid={`budget-edit-${r.name}`}>Set</Button>}</td>}</tr>)}
    </tbody></table></div>
    <div className="help">Crossing a budget alerts the owner once that month. Leave empty for no limit.</div>
  </Card>;
}

// ---- 11. staff scorecard --------------------------------------------------------------------
export function ScorecardCard({ from, to }: { from: string; to: string }) {
  const refreshKey = useStore((s) => s.refreshKey);
  const [rows, setRows] = useState<api.Scorecard[] | null>(null);
  useEffect(() => { api.staffScorecard(from, to).then(setRows).catch(() => setRows([])); }, [from, to, refreshKey]);
  if (!rows) return <Card><Spinner /></Card>;
  return <Card title="Staff scorecard" right={<span className="help">{fmtShort(from)} – {fmtShort(to)}</span>}>
    {rows.length === 0 ? <Empty>No staff logins</Empty> : <div className="scroll-x"><table className="table"><thead><tr><th>Person</th><th className="r">Days closed</th><th className="r">Avg plus</th><th className="r">Minus days</th><th className="r">Late closings</th><th className="r">Entries</th><th className="r">Owner corrections</th><th className="r">Blocked attempts</th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.user_id} data-testid="score-row"><td><Link to={`/staff/${r.user_id}`}><b>{r.name}</b></Link> <span className="muted">{r.role}</span></td><td className="r num">{r.days_closed}</td><td className={`r num ${r.avg_difference !== null && r.avg_difference < 0 ? 'danger' : ''}`}>{r.avg_difference === null ? '—' : num(r.avg_difference, true)}</td><td className={`r num ${r.minus_days > 0 ? 'danger' : ''}`}>{r.minus_days}</td><td className={`r num ${r.late_closings > 0 ? 'warn' : ''}`}>{r.late_closings}</td><td className="r num">{r.entries}</td><td className={`r num ${r.owner_corrections > 0 ? 'warn' : ''}`}>{r.owner_corrections}</td><td className={`r num ${r.blocked_attempts > 0 ? 'danger' : ''}`}>{r.blocked_attempts}</td></tr>)}
    </tbody></table></div>}
    <div className="help">Late closing = closed after 4 am the next morning. Owner corrections = entries of theirs the owner had to change. Blocked = duplicate payments the app refused.</div>
  </Card>;
}

// ---- 9. daily digest + Telegram settings ----------------------------------------------------
export function DigestCard() {
  const [text, setText] = useState<string | null>(null);
  const y = new Date(today()); y.setDate(y.getDate() - 1); const day = y.toISOString().slice(0, 10);
  useEffect(() => { api.dailyDigest(day).then(setText).catch(() => setText(null)); }, [day]);
  if (!text) return null;
  return <Card title="Yesterday in one look" right={<span className="help">sent every morning</span>}><pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, fontWeight: 600 }} data-testid="digest">{text}</pre></Card>;
}

export function AlertsSettings() {
  const isOwner = useIsOwner();
  const toast = useStore((s) => s.toast);
  const [s, setS] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<string | null>(null);
  useEffect(() => { api.getSettings().then(setS).catch(() => setS({})); }, []);
  if (!s) return <Card><Spinner /></Card>;
  const token = (s.telegram_bot_token ?? '').trim();
  const chat = (s.telegram_chat_id ?? '').trim();
  const tg = async (method: string, body?: Record<string, unknown>) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const j = await r.json().catch(() => ({ ok: false, description: 'no answer' }));
    if (!j.ok) throw new Error(j.description === 'Unauthorized' ? 'Token is wrong — copy it again from BotFather' : `Telegram: ${j.description ?? r.status}`);
    return j.result;
  };
  // step 2 done for the owner: read the bot's recent messages and pick the chat that wrote to it
  const findChat = async () => {
    if (!token) return toast('Paste the bot token first', 'danger');
    setBusy(true);
    try {
      const updates = await tg('getUpdates') as { message?: { chat: { id: number; first_name?: string; username?: string } } }[];
      const chats = updates.map((u) => u.message?.chat).filter((c): c is NonNullable<typeof c> => !!c);
      if (chats.length === 0) throw new Error('No message found yet — open your bot in Telegram, press Start, send it "hi", then try again');
      const c = chats[chats.length - 1];
      setS({ ...s, telegram_chat_id: String(c.id) }); setFound(`${c.first_name ?? ''} ${c.username ? '@' + c.username : ''}`.trim());
      toast(`Found your chat: ${c.first_name ?? c.id}. Now press Save.`, 'ok');
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  const save = async () => { setBusy(true); try { await api.setSetting('telegram_bot_token', token); await api.setSetting('telegram_chat_id', chat); toast('Alert settings saved', 'ok'); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); } };
  const test = async () => {
    if (!token || !chat) return toast('Token and chat id are both needed', 'danger');
    setBusy(true);
    try { await tg('sendMessage', { chat_id: chat, text: 'Pro Aid test message — alerts are working.' }); toast('Sent — check Telegram', 'ok'); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return <Card title="Owner alerts on Telegram" right={<span className="help">free · instant</span>}>
    <div className="help"><b>1.</b> In Telegram search <b>BotFather</b> → send <span className="num">/newbot</span> → give a name and a username ending in "bot" → copy the <b>token</b> it gives you and paste it below.<br /><b>2.</b> Open your new bot in Telegram, press <b>Start</b>, send it "hi".<br /><b>3.</b> Press <b>Find my chat</b> below, then <b>Save</b>, then <b>Send test message</b>.</div>
    <Field label="Bot token"><input className="input" value={s.telegram_bot_token ?? ''} onChange={(e) => setS({ ...s, telegram_bot_token: e.target.value })} disabled={!isOwner} placeholder="123456789:AA…" data-testid="tg-token" /></Field>
    <Field label="Chat id" help={found ? `found: ${found}` : undefined}><div style={{ display: 'flex', gap: 6 }}><input className="input num" value={s.telegram_chat_id ?? ''} onChange={(e) => setS({ ...s, telegram_chat_id: e.target.value })} disabled={!isOwner} placeholder="press Find my chat" data-testid="tg-chat" />{isOwner && <Button disabled={busy || !token} onClick={findChat} data-testid="tg-find">Find my chat</Button>}</div></Field>
    {isOwner && <div className="actions"><Button kind="primary" disabled={busy} onClick={save} data-testid="tg-save">Save</Button><Button disabled={busy || !token || !chat} onClick={test}>Send test message</Button></div>}
    <div className="help">Once saved: minus closings, surprise-count minus, duplicate attempts, WAW reminders, anomalies, budget alerts, new-device logins and the morning digest also arrive on Telegram.</div>
  </Card>;
}
