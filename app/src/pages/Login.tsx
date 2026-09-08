import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signIn, isValidPin, isValidPhone } from '../lib/auth';
import { useStore } from '../lib/store';
import { Icon, Field, Button } from '../components/ui';

export default function Login() {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const loadProfile = useStore((s) => s.loadProfile);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!isValidPhone(phone)) return setErr('Enter your phone number, e.g. 03001234567');
    if (!isValidPin(pin)) return setErr('PIN is 6 digits');
    setBusy(true);
    try { await signIn(phone, pin); await loadProfile(); navigate('/'); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 }}>
      <form onSubmit={submit} className="form" style={{ width: '100%', maxWidth: 380, gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 68, height: 68, borderRadius: 20, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><Icon.Plus size={36} /></div>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em' }}>Pro Aid</div>
          <div className="muted" style={{ fontWeight: 600 }}>Pharmacy cash control</div>
        </div>
        <Field label="Phone number"><input className="input" inputMode="tel" autoComplete="username" placeholder="03001234567" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus /></Field>
        <Field label="PIN (6 digits)"><input className="input num" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} placeholder="••••••" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} style={{ letterSpacing: 6, fontSize: 22 }} /></Field>
        {err && <div className="notice danger">{err}</div>}
        <Button kind="primary" size="big" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        <div className="help" style={{ textAlign: 'center' }}>Accounts are created by the owner. Forgot your PIN? Ask the owner to reset it.</div>
      </form>
    </div>
  );
}
