import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import { supabase, deviceLabel } from './supabase';
import * as api from './api';
import type { Profile, Account, Notification } from './api';

type Toast = { id: number; text: string; kind?: 'ok' | 'danger' | 'info' };

type State = {
  session: Session | null; profile: Profile | null; loading: boolean;
  accounts: Account[]; notifications: Notification[]; online: boolean; toasts: Toast[]; refreshKey: number;
  init: () => Promise<void>;
  loadProfile: () => Promise<void>;
  loadNotifications: () => Promise<void>;
  toast: (text: string, kind?: Toast['kind']) => void;
  bump: () => void; reloadAccounts: () => Promise<void>;
};

let toastId = 0;
export const useStore = create<State>((set, get) => ({
  session: null, profile: null, loading: true, accounts: [], notifications: [], online: navigator.onLine, toasts: [], refreshKey: 0,
  async init() {
    const { data } = await supabase.auth.getSession();
    set({ session: data.session });
    supabase.auth.onAuthStateChange((_e, s) => { set({ session: s }); if (s) get().loadProfile(); else set({ profile: null }); });
    if (data.session) await get().loadProfile();
    set({ loading: false });
    window.addEventListener('online', () => set({ online: true }));
    window.addEventListener('offline', () => set({ online: false }));
  },
  async loadProfile() {
    try {
      const profile = await api.me();
      set({ profile });
      if (profile) {
        api.touchDevice(deviceLabel(), navigator.userAgent.slice(0, 80)).then(() => undefined, () => undefined);
        const [accounts] = await Promise.all([api.listAccounts(), get().loadNotifications()]);
        set({ accounts });
      }
    } catch (e) { get().toast((e as Error).message, 'danger'); }
  },
  async loadNotifications() {
    try { set({ notifications: await api.listNotifications() }); } catch { /* offline */ }
  },
  toast(text, kind = 'info') {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'danger' ? 6000 : 3500);
  },
  bump() { set((s) => ({ refreshKey: s.refreshKey + 1 })); },
  async reloadAccounts() { try { set({ accounts: await api.listAccounts() }); } catch { /* offline */ } },
}));

export const useProfile = () => useStore((s) => s.profile);
export const useIsOwner = () => useStore((s) => s.profile?.role === 'owner');
export const useIsViewer = () => useStore((s) => s.profile?.role === 'viewer');
export const useCanWrite = () => useStore((s) => s.profile?.role === 'owner' || s.profile?.role === 'manager' || s.profile?.role === 'cashier');
export const useCanSeeOwner = () => useStore((s) => s.profile?.role === 'owner' || s.profile?.role === 'viewer');
export const useIsManagerOrOwner = () => useStore((s) => s.profile?.role === 'owner' || s.profile?.role === 'manager');
