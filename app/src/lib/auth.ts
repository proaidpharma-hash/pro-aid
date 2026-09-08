import { supabase, adminSignupClient } from './supabase';

// Pro Aid signs in with a phone number and a 6-digit PIN. Underneath, Supabase sees an email + password.
export const normalizePhone = (p: string) => p.replace(/\D/g, '');
export const emailForPhone = (phone: string) => `${normalizePhone(phone)}@proaid.app`;
export const pinToPassword = (pin: string) => `proaid-${pin}`;
export const isValidPin = (pin: string) => /^\d{6}$/.test(pin);
export const isValidPhone = (phone: string) => /^\d{10,13}$/.test(normalizePhone(phone));

export async function signIn(phone: string, pin: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: emailForPhone(phone), password: pinToPassword(pin) });
  if (error) throw new Error(/invalid/i.test(error.message) ? 'Phone number or PIN is wrong' : error.message);
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// owner creates a staff login: auth user first (via the session-less client), then the profile row
export async function createStaffLogin(input: { name: string; phone: string; pin: string; role: 'owner' | 'manager' | 'cashier' }) {
  const { data, error } = await adminSignupClient.auth.signUp({ email: emailForPhone(input.phone), password: pinToPassword(input.pin) });
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Could not create the login');
  const { data: profile, error: perr } = await supabase.rpc('upsert_profile', { p_id: id, p_name: input.name, p_role: input.role, p_phone: normalizePhone(input.phone), p_active: true });
  if (perr) throw new Error(perr.message);
  return profile;
}

export async function changeOwnPin(newPin: string) {
  const { error } = await supabase.auth.updateUser({ password: pinToPassword(newPin) });
  if (error) throw new Error(error.message);
}
