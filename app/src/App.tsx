import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useStore } from './lib/store';
import { Shell } from './components/Shell';
import { Spinner, Toasts } from './components/ui';
import Login from './pages/Login';
import Today from './pages/Today';
import { SaleNew, SalesPage, ReceiptNew, CreditBillNew } from './pages/Sale';
import Closing from './pages/Closing';
import { PurchasesPage, PurchaseNew, PayPage, ExpenseNew, ExpensesPage } from './pages/Purchases';
import { DistributorsPage, DistributorDetail, CustomersPage, StaffPage, StaffDetail, WawPage } from './pages/Ledgers';
import { NonCashPage, InsightsPage, ReportsPage, SettingsPage, NotificationsPage, LedgersHub, MoreHub, ChangePinPage } from './pages/Owner';

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
          <Route path="/sales" element={<Guard roles={['owner', 'manager', 'viewer']}><SalesPage /></Guard>} />
          <Route path="/sales/new" element={<Guard roles={['owner', 'manager']}><SaleNew /></Guard>} />
          <Route path="/receipts/new" element={<Guard roles={['owner', 'manager', 'cashier']}><ReceiptNew /></Guard>} />
          <Route path="/credit/new" element={<Guard roles={['owner', 'manager', 'cashier']}><CreditBillNew /></Guard>} />
          <Route path="/closing" element={<Closing />} />
          <Route path="/purchases" element={<PurchasesPage />} />
          <Route path="/purchases/new" element={<Guard roles={['owner', 'manager', 'cashier']}><PurchaseNew /></Guard>} />
          <Route path="/pay" element={<Guard roles={['owner', 'manager', 'cashier']}><PayPage /></Guard>} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/expenses/new" element={<Guard roles={['owner', 'manager', 'cashier']}><ExpenseNew /></Guard>} />
          <Route path="/distributors" element={<DistributorsPage />} />
          <Route path="/distributors/:id" element={<DistributorDetail />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/staff" element={<StaffPage />} />
          <Route path="/staff/:id" element={<StaffDetail />} />
          <Route path="/waw" element={<WawPage />} />
          <Route path="/noncash" element={<Guard roles={['owner', 'viewer']}><NonCashPage /></Guard>} />
          <Route path="/insights" element={<Guard roles={['owner', 'viewer']}><InsightsPage /></Guard>} />
          <Route path="/reports" element={<Guard roles={['owner', 'manager', 'viewer']}><ReportsPage /></Guard>} />
          <Route path="/settings" element={<Guard roles={['owner', 'viewer']}><SettingsPage /></Guard>} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/ledgers" element={<LedgersHub />} />
          <Route path="/more" element={<MoreHub />} />
          <Route path="/pin" element={<ChangePinPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
