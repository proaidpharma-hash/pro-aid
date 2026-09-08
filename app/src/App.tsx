import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useStore } from './lib/store';
import { Shell } from './components/Shell';
import { Spinner, Toasts } from './components/ui';
import Login from './pages/Login';
import Today from './pages/Today';
import { SaleNew, SalesPage } from './pages/Sale';
import Closing from './pages/Closing';
import { PurchasesPage, PurchaseNew, PayPage, ExpenseNew, ExpensesPage } from './pages/Purchases';
import { DistributorsPage, DistributorDetail, CustomersPage, StaffPage, StaffDetail, WawPage } from './pages/Ledgers';
import { NonCashPage, InsightsPage, ReportsPage, SettingsPage, NotificationsPage, LedgersHub, MoreHub } from './pages/Owner';

function Guard({ roles, children }: { roles?: string[]; children: React.ReactElement }) {
  const profile = useStore((s) => s.profile);
  const loading = useStore((s) => s.loading);
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!profile) return <Navigate to="/login" state={{ from: loc }} replace />;
  if (roles && !roles.includes(profile.role)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const init = useStore((s) => s.init);
  const loading = useStore((s) => s.loading);
  const profile = useStore((s) => s.profile);
  useEffect(() => { init(); }, [init]);
  if (loading) return <Spinner />;
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Routes>
        <Route path="/login" element={profile ? <Navigate to="/" replace /> : <><Login /><Toasts /></>} />
        <Route element={<Guard><Shell /></Guard>}>
          <Route path="/" element={<Today />} />
          <Route path="/sales" element={<Guard roles={['owner', 'manager']}><SalesPage /></Guard>} />
          <Route path="/sales/new" element={<Guard roles={['owner', 'manager']}><SaleNew /></Guard>} />
          <Route path="/closing" element={<Closing />} />
          <Route path="/purchases" element={<PurchasesPage />} />
          <Route path="/purchases/new" element={<PurchaseNew />} />
          <Route path="/pay" element={<PayPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/expenses/new" element={<ExpenseNew />} />
          <Route path="/distributors" element={<DistributorsPage />} />
          <Route path="/distributors/:id" element={<DistributorDetail />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/staff" element={<StaffPage />} />
          <Route path="/staff/:id" element={<StaffDetail />} />
          <Route path="/waw" element={<WawPage />} />
          <Route path="/noncash" element={<Guard roles={['owner']}><NonCashPage /></Guard>} />
          <Route path="/insights" element={<Guard roles={['owner']}><InsightsPage /></Guard>} />
          <Route path="/reports" element={<Guard roles={['owner', 'manager']}><ReportsPage /></Guard>} />
          <Route path="/settings" element={<Guard roles={['owner']}><SettingsPage /></Guard>} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/ledgers" element={<LedgersHub />} />
          <Route path="/more" element={<MoreHub />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
