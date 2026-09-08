import { supabase, adminSignupClient } from './supabase';

// Pro Aid signs in with a phone number and a 6-digit PIN. Underneath, Supabase sees an email + password.
// The password is never the PIN itself: it is a SHA-256 of phone + PIN + app salt, so a PIN cannot be read
// back from the auth store and a stolen hash is useless anywhere else.
export const normalizePhone = (p: string) => p.replace(/\D/g, '');
export const emailForPhone = (phone: string) => `${normalizePhone(phone)}@proaid.app`;
export const isValidPin = (pin: string) => /^\d{6}$/.test(pin);
export const isValidPhone = (phone: string) => /^\d{10,13}$/.test(normalizePhone(phone));
const legacyPassword = (pin: string) => `proaid-${pin}`;

export async function pinToPassword(phone: string, pin: string): Promise<string> {
  const data = new TextEncoder().encode(`proaid:v2:${normalizePhone(phone)}:${pin}`);
  const h = await crypto.subtle.digest('SHA-256', data);
  return 'v2.' + Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// wrong-PIN throttle: after 5 misses the form waits 60 s (the server also rate-limits sign-in attempts)
const ATTEMPT_KEY = 'proaid.attempts';
function attempts(): { n: number; until: number } { try { return JSON.parse(localStorage.getItem(ATTEMPT_KEY) || '') || { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } }
function setAttempts(a: { n: number; until: number }) { try { localStorage.setItem(ATTEMPT_KEY, JSON.stringify(a)); } catch { /* ignore */ } }
export function lockedForSeconds(): number { const a = attempts(); return Math.max(0, Math.ceil((a.until - Date.now()) / 1000)); }

export async function signIn(phone: string, pin: string) {
  const wait = lockedForSeconds();
  if (wait > 0) throw new Error(`Too many wrong attempts — wait ${wait} s`);
  const email = emailForPhone(phone);
  const password = await pinToPassword(phone, pin);
  let { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error && /invalid/i.test(error.message)) {
    // logins created before the v2 scheme: accept the old password once and move them to the new one
    const legacy = await supabase.auth.signInWithPassword({ email, password: legacyPassword(pin) });
    if (!legacy.error) {
      await supabase.auth.updateUser({ password }).catch(() => undefined);
      data = legacy.data; error = null;
    }
  }
  if (error) {
    const a = attempts(); const n = a.n + 1;
    setAttempts({ n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    throw new Error(/invalid/i.test(error.message) ? `Phone number or PIN is wrong${n >= 5 ? ' — wait 60 s' : ''}` : error.message);
  }
  setAttempts({ n: 0, until: 0 });
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// owner creates a staff login: auth user first (via the session-less client), then the profile row
export async function createStaffLogin(input: { name: string; phone: string; pin: string; role: 'owner' | 'manager' | 'cashier' | 'viewer' }) {
  const { data, error } = await adminSignupClient.auth.signUp({ email: emailForPhone(input.phone), password: await pinToPassword(input.phone, input.pin) });
  if (error) throw new Error(/already registered/i.test(error.message) ? 'A login with this phone number already exists' : error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Could not create the login');
  const { data: profile, error: perr } = await supabase.rpc('upsert_profile', { p_id: id, p_name: input.name, p_role: input.role, p_phone: normalizePhone(input.phone), p_active: true });
  if (perr) throw new Error(perr.message);
  return profile;
}

// anyone changes their own PIN (the current PIN is checked first)
export async function changeOwnPin(phone: string, currentPin: string, newPin: string) {
  const email = emailForPhone(phone);
  const check = await adminSignupClient.auth.signInWithPassword({ email, password: await pinToPassword(phone, currentPin) });
  if (check.error) throw new Error('Current PIN is wrong');
  await adminSignupClient.auth.signOut().catch(() => undefined);
  const { error } = await supabase.auth.updateUser({ password: await pinToPassword(phone, newPin) });
  if (error) throw new Error(error.message);
}

// owner resets someone else's PIN (server stores it exactly like Supabase Auth does; audited)
export async function resetPin(userId: string, phone: string, newPin: string) {
  const { error } = await supabase.rpc('reset_login_pin', { p_user: userId, p_password: await pinToPassword(phone, newPin) });
  if (error) throw new Error(error.message);
}
