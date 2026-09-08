import { NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { EditSheet } from './EditSheet';
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import { Icon, Toasts } from './ui';
import { signOut } from '../lib/auth';
import { startRealtime } from '../lib/realtime';
import { supabase } from '../lib/supabase';
import * as api from '../lib/api';

const NAV = [
  { to: '/', label: 'Today', icon: Icon.Today, roles: ['owner', 'manager', 'cashier'] },
  { to: '/closing', label: 'Closing', icon: Icon.Closing, roles: ['owner', 'manager'] },
  { to: '/sales', label: 'Sales', icon: Icon.Sales, roles: ['owner', 'manager'] },
  { to: '/purchases', label: 'Purchases', icon: Icon.Purchases, roles: ['owner', 'manager', 'cashier'] },
  { to: '/pay', label: 'Payments', icon: Icon.Payments, roles: ['owner', 'manager', 'cashier'] },
  { to: '/expenses', label: 'Expenses', icon: Icon.Expenses, roles: ['owner', 'manager', 'cashier'] },
  { to: '/distributors', label: 'Distributors', icon: Icon.Distributors, roles: ['owner', 'manager', 'cashier'] },
  { to: '/customers', label: 'Customers', icon: Icon.Customers, roles: ['owner', 'manager', 'cashier'] },
  { to: '/staff', label: 'Staff', icon: Icon.Staff, roles: ['owner', 'manager', 'cashier'] },
  { to: '/waw', label: 'WAW F/S & owner', icon: Icon.Waw, roles: ['owner', 'manager', 'cashier'] },
  { to: '/insights', label: 'Insights', icon: Icon.Insights, roles: ['owner'] },
  { to: '/reports', label: 'Reports', icon: Icon.Reports, roles: ['owner', 'manager'] },
];

export function Shell() {
  const profile = useStore((s) => s.profile);
  const online = useStore((s) => s.online);
  const notifications = useStore((s) => s.notifications);
  const unread = notifications.filter((n) => !n.read_at).length;
  const [unposted, setUnposted] = useState(0);
  const refreshKey = useStore((s) => s.refreshKey);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const edit = params.get('edit');
  useEffect(() => { startRealtime(); }, []);
  useEffect(() => { api.invoiceStatus({ unposted: true }).then((r) => setUnposted(r.length)).catch(() => undefined); }, [refreshKey]);
  useEffect(() => { supabase; }, []);
  // auto-lock: after 15 minutes without a touch the session is signed out (shared pharmacy phones)
  useEffect(() => {
    const LIMIT = 15 * 60 * 1000;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    const events = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const check = () => { if (Date.now() - last > LIMIT) { signOut().then(() => navigate('/login?locked=1')); } };
    const timer = setInterval(check, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { events.forEach((e) => window.removeEventListener(e, touch)); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [navigate]);
  if (!profile) return null;
  const items = NAV.filter((n) => n.roles.includes(profile.role));
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><div className="logo"><Icon.Plus size={20} /></div><div><div className="name">Pro Aid</div><div className="who">{profile.role === 'owner' ? 'Owner' : profile.role === 'manager' ? 'Manager' : 'Cashier'} · {profile.name.split(' ')[0]}</div></div></div>
        <nav className="nav">
          {items.map((n) => <NavLink key={n.to} to={n.to} end={n.to === '/'}><span className="lbl"><n.icon /> {n.label}</span>{n.to === '/purchases' && unposted > 0 && <span className="badge">{unposted}</span>}</NavLink>)}
        </nav>
        <nav className="nav" style={{ marginTop: 'auto' }}>
          <NavLink to="/notifications"><span className="lbl"><Icon.Bell /> Notifications</span>{unread > 0 && <span className="badge danger">{unread}</span>}</NavLink>
          {profile.role === 'owner' && <NavLink to="/settings"><span className="lbl"><Icon.Settings /> Settings</span></NavLink>}
          <NavLink to="/pin"><span className="lbl"><Icon.Lock /> Change my PIN</span></NavLink>
          <a href="#" onClick={(e) => { e.preventDefault(); signOut().then(() => navigate('/login')); }}><span className="lbl">Sign out</span></a>
        </nav>
      </aside>
      <div className="main">
        <Outlet />
      </div>
      <nav className="tabbar">
        <NavLink to="/" end><Icon.Today size={22} />Today</NavLink>
        {profile.role === 'cashier' ? <NavLink to="/pay"><Icon.Payments size={22} />Pay</NavLink> : <NavLink to="/closing"><Icon.Closing size={22} />Closing</NavLink>}
        <NavLink to="/expenses"><Icon.Expenses size={22} />Expense</NavLink>
        <NavLink to="/ledgers"><Icon.Ledgers size={22} />Ledgers</NavLink>
        <NavLink to="/more" style={{ position: 'relative' }}><Icon.More size={22} />More{unread > 0 && <span className="badge danger" style={{ position: 'absolute', top: -2, right: 8 }}>{unread}</span>}</NavLink>
      </nav>
      {edit && <EditSheet spec={edit} onClose={() => { params.delete('edit'); setParams(params); }} />}
      <Toasts />
      {!online && <div className="toasts"><div className="toast danger">You are offline — entries will fail until the connection returns</div></div>}
    </div>
  );
}

export function TopBar({ title, sub, right, back }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; back?: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        {back && <button type="button" className="btn ghost sm" aria-label="Back" onClick={() => navigate(-1)}><Icon.Back size={22} /></button>}
        <div style={{ minWidth: 0 }}><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
      </div>
      {right && <div className="actions" style={{ justifyContent: 'flex-end' }}>{right}</div>}
    </div>
  );
}

export function LiveBadge() {
  const online = useStore((s) => s.online);
  return <span className={`live ${online ? '' : 'off'}`}><i />{online ? 'Live' : 'Offline'}</span>;
}
