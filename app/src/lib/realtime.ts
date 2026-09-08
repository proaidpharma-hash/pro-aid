import { supabase, IS_LOCAL } from './supabase';
import { useStore } from './store';

// Live updates: Supabase realtime when available; a gentle poll as the fallback (also covers the local stand-in).
let started = false;
export function startRealtime() {
  if (started) return; started = true;
  const bump = () => { useStore.getState().bump(); useStore.getState().loadNotifications(); };
  if (!IS_LOCAL) {
    const ch = supabase.channel('proaid-live');
    for (const t of ['notifications', 'business_days', 'sale_receipts', 'invoice_diff_settlements', 'closings', 'invoices', 'payments', 'expenses', 'daily_sales', 'daily_sale_lines', 'waw_loans', 'reminders', 'customer_credit_bills', 'customer_credit_collections', 'staff_entries', 'owner_settlements']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, bump);
    }
    ch.subscribe();
  }
  setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) bump(); }, IS_LOCAL ? 4000 : 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') bump(); });
}

// Device alerts: when a new notification arrives for this user and the app is open (even in the background),
// show it as a system notification too. Permission is asked from the Notifications page.
let seen: Set<string> | null = null;
export const alertsEnabled = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';
export async function enableAlerts() {
  if (typeof Notification === 'undefined') throw new Error('This browser cannot show notifications');
  const r = await Notification.requestPermission();
  if (r !== 'granted') throw new Error('Notifications were not allowed');
}
useStore.subscribe((state, prev) => {
  if (state.notifications === prev.notifications) return;
  if (seen === null) { seen = new Set(state.notifications.map((n) => n.id)); return; }
  for (const n of state.notifications) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (!n.read_at && alertsEnabled() && document.visibilityState !== 'visible') {
      try { new Notification(n.title, { body: n.body ?? undefined, tag: n.id, icon: `${import.meta.env.BASE_URL}icons/icon-192.png` }); } catch { /* ignore */ }
    }
  }
});
