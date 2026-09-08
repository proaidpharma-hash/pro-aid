import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import { uploadProof, proofUrl, type ProofPhoto } from '../lib/photos';
import { rs, toNumber } from '../lib/format';

// ---- icons (stroke, 24 grid) ------------------------------------------------
const I = (d: string, extra?: ReactNode) => (props: { size?: number; color?: string }) => (
  <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" fill="none" stroke={props.color ?? 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.split('|').map((p, i) => <path key={i} d={p} />)}{extra}
  </svg>
);
export const Icon = {
  Today: I('M3 9h18|M8 2v4|M16 2v4', <rect x="3" y="4" width="18" height="17" rx="2" />),
  Closing: I('M9 12l2 2 4-4', <circle cx="12" cy="12" r="9" />),
  Sales: I('M3 17l6-6 4 4 8-8|M14 7h7v7'),
  Purchases: I('M6 2l1.5 4h9L18 2|M9 12h6', <rect x="3" y="6" width="18" height="16" rx="2" />),
  Payments: I('M2 10h20', <><rect x="2" y="6" width="20" height="13" rx="2" /><circle cx="12" cy="12.5" r="3" /></>),
  Expenses: I('M6 3h9l4 4v14H6z|M9 12h6|M9 16h6'),
  Distributors: I('M3 21h18|M5 21V8l7-5 7 5v13|M9 21v-6h6v6'),
  Staff: I('M2.5 20a6.5 6.5 0 0 1 13 0|M16 15a5 5 0 0 1 5.5 5', <><circle cx="9" cy="8" r="3.5" /><circle cx="17" cy="9" r="2.5" /></>),
  Waw: I('M3 10h18|M5 6h14l2 4v10H3V10z|M9 14h6'),
  Insights: I('M12 8v4l3 2', <circle cx="12" cy="12" r="9" />),
  Reports: I('M4 20V10|M10 20V4|M16 20v-7|M22 20H2'),
  Settings: I('M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z', <circle cx="12" cy="12" r="3" />),
  Bell: I('M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9|M13.7 21a2 2 0 0 1-3.4 0'),
  Camera: I('M4 7h3l2-3h6l2 3h3v13H4z', <circle cx="12" cy="13" r="3.5" />),
  Image: I('M21 15l-5-5L5 21', <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /></>),
  Check: I('M20 6L9 17l-5-5'),
  Plus: I('M12 5v14|M5 12h14'),
  Back: I('M19 12H5|M12 19l-7-7 7-7'),
  Alert: I('M12 9v4|M12 17h.01|M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'),
  Info: I('M12 8v4|M12 16h.01', <circle cx="12" cy="12" r="9" />),
  Lock: I('M7 11V7a5 5 0 0 1 10 0v4', <rect x="3" y="11" width="18" height="10" rx="2" />),
  Ledgers: I('M4 6h16|M4 12h16|M4 18h10'),
  More: I('', <><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>),
  Customers: I('M20 21a8 8 0 1 0-16 0', <circle cx="12" cy="8" r="4" />),
  Search: I('M20 20l-3.5-3.5', <circle cx="11" cy="11" r="7" />),
  Download: I('M12 3v12|M7 10l5 5 5-5|M4 20h16'),
  Phone: I('M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z'),
  X: I('M18 6L6 18|M6 6l12 12'),
};

// ---- primitives -------------------------------------------------------------
export function Card({ children, kind, className = '', title, right, ...rest }: { children: ReactNode; kind?: 'accent' | 'ok' | 'warn' | 'danger' | 'outline'; className?: string; title?: ReactNode; right?: ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return <div className={`card ${kind ?? ''} ${className}`} {...rest}>{title && <div className="card-title"><span>{title}</span>{right}</div>}{children}</div>;
}
export function KPI({ label, value, hint, kind, className = '' }: { label: string; value: ReactNode; hint?: ReactNode; kind?: 'accent' | 'ok' | 'warn' | 'danger'; className?: string }) {
  return <div className={`card kpi ${kind ?? ''} ${className}`}><div className="label">{label}</div><div className="value num">{value}</div>{hint && <div className="hint">{hint}</div>}</div>;
}
export function Pill({ kind = 'neutral', children }: { kind?: 'ok' | 'warn' | 'danger' | 'accent' | 'neutral'; children: ReactNode }) { return <span className={`pill ${kind}`}>{children}</span>; }
export function Button({ kind, size, children, ...rest }: { kind?: 'primary' | 'danger' | 'ghost'; size?: 'sm' | 'big' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`btn ${kind ?? ''} ${size ?? ''}`} {...rest}>{children}</button>;
}
export function Field({ label, children, help, error }: { label: string; children: ReactNode; help?: ReactNode; error?: string }) {
  return <div className="field"><label>{label}</label>{children}{error ? <div className="error-text">{error}</div> : help ? <div className="help">{help}</div> : null}</div>;
}
export function Notice({ kind = 'info', children }: { kind?: 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode }) {
  const Ic = kind === 'ok' ? Icon.Check : kind === 'info' ? Icon.Info : Icon.Alert;
  return <div className={`notice ${kind}`}><Ic size={16} /><span>{children}</span></div>;
}
export function Chips<T extends string>({ options, value, onChange, warnValue }: { options: { value: T; label: string }[]; value: T | null; onChange: (v: T) => void; warnValue?: T }) {
  return <div className="chips" role="radiogroup">{options.map((o) => <button type="button" key={o.value} role="radio" aria-checked={value === o.value} className={`chip ${value === o.value ? 'on' : ''} ${o.value === warnValue ? 'warn' : ''}`} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}
export function Tiles<T extends string>({ options, value, onChange, cols = 2 }: { options: { value: T; label: string; sub?: string }[]; value: T | null; onChange: (v: T) => void; cols?: number }) {
  return <div className="tiles" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} role="radiogroup">{options.map((o) => <button type="button" key={o.value} role="radio" aria-checked={value === o.value} className={`tile ${value === o.value ? 'on' : ''}`} onClick={() => onChange(o.value)}><b>{o.label}</b>{o.sub && <span>{o.sub}</span>}</button>)}</div>;
}
export function AmountInput({ value, onChange, autoFocus, placeholder = '0', id, big = true, error }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; placeholder?: string; id?: string; big?: boolean; error?: boolean }) {
  return <div className="amount-wrap"><span className="cur">Rs</span><input id={id} inputMode="numeric" pattern="[0-9]*" className={`input ${big ? 'amount' : ''} num ${error ? 'error' : ''}`} value={value} placeholder={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))} /></div>;
}
export const amountOf = (s: string) => toNumber(s);
export function Spinner() { return <div className="center"><div className="spinner" /></div>; }
export function Empty({ children }: { children: ReactNode }) { return <div className="muted" style={{ padding: '18px 0', textAlign: 'center', fontWeight: 600 }}>{children}</div>; }

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind ?? ''}`}>{t.text}</div>)}</div>;
}

export function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="handle" />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2>{title}</h2><button type="button" className="btn ghost sm" aria-label="Close" onClick={onClose}><Icon.X /></button></div>
        {children}
      </div>
    </div>
  );
}

// ---- the photo picker: camera or gallery, upload immediately, block the form until done ----
export function PhotoPicker({ label, hint, value, onChange, userId, required = true }: { label: string; hint?: string; value: ProofPhoto | null; onChange: (p: ProofPhoto | null) => void; userId: string; required?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  const handle = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr(null);
    try { onChange(await uploadProof(f, userId)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={`photo-box ${value ? 'done' : ''}`} data-testid="photo-picker">
      {value ? <img src={value.previewUrl} alt="proof" /> : <div className="ph">{busy ? <div className="spinner" /> : <Icon.Camera size={22} />}</div>}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>{label} {required && !value && <span className="danger">· required</span>}{value && <span className="ok"> · attached</span>}</span>
        <span className="help">{err ? <span className="danger">{err}</span> : hint ?? 'Camera or gallery'}</span>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" className="btn sm" disabled={busy} onClick={() => camRef.current?.click()} aria-label={`${label}: camera`}>Camera</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => galRef.current?.click()} aria-label={`${label}: gallery`}>Gallery</button>
      </div>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => handle(e.target.files?.[0])} data-testid="photo-camera" />
      <input ref={galRef} type="file" accept="image/*" hidden onChange={(e) => handle(e.target.files?.[0])} data-testid="photo-gallery" />
    </div>
  );
}

export function ProofLink({ storagePath, label = 'Photo' }: { storagePath: string | null | undefined; label?: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  if (!storagePath) return null;
  const show = async () => { try { setUrl(await proofUrl(storagePath)); setOpen(true); } catch (e) { useStore.getState().toast((e as Error).message, 'danger'); } };
  return <>
    <button type="button" className="btn ghost sm" onClick={show}><Icon.Image size={14} /> {label}</button>
    {open && url && <Sheet title="Photo" onClose={() => setOpen(false)}><img src={url} alt="proof" style={{ width: '100%', borderRadius: 12 }} /></Sheet>}
  </>;
}

export function Money({ v, sign, className = '' }: { v: number | null | undefined; sign?: boolean; className?: string }) { return <span className={`num ${className}`}>{rs(v, { sign })}</span>; }
