import { supabase, IS_LOCAL } from './supabase';
import { useStore } from './store';

// Live updates: Supabase realtime when available; a gentle poll as the fallback (also covers the local stand-in).
let started = false;
export function startRealtime() {
  if (started) return; started = true;
  const bump = () => { useStore.getState().bump(); useStore.getState().loadNotifications(); };
  if (!IS_LOCAL) {
    const ch = supabase.channel('proaid-live');
    for (const t of ['notifications', 'business_days', 'closings', 'invoices', 'payments', 'expenses', 'daily_sales', 'daily_sale_lines', 'waw_loans', 'reminders', 'customer_credit_bills', 'customer_credit_collections', 'staff_entries', 'owner_settlements']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, bump);
    }
    ch.subscribe();
  }
  setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) bump(); }, IS_LOCAL ? 4000 : 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') bump(); });
}
