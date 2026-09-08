import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
export const IS_LOCAL = /localhost|127\.0\.0\.1/.test(SUPABASE_URL);

export function deviceLabel(): string {
  try {
    const saved = localStorage.getItem('proaid.device');
    if (saved) return saved;
  } catch { /* ignore */ }
  const ua = navigator.userAgent;
  const platform = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'Mac' : 'Device';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches ? '' : ' (browser)';
  return `${platform}${standalone}`;
}

export function setDeviceLabel(label: string) {
  try { localStorage.setItem('proaid.device', label); } catch { /* ignore */ }
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  global: { headers: { 'x-device': deviceLabel() } },
});

// a second client that never keeps a session: used by the owner to create staff logins
export const adminSignupClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
