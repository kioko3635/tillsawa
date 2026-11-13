import { SecurityPage } from './features/admin/SecurityPage';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spinner } from './design-system/components';
import { landingPath, routeAllowed, ROUTE_POLICIES, type AccessSubject, type RoutePolicy } from './app/access';
import { NoAccessPage } from './app/NoAccessPage';
import { Shell } from './app/Shell';
import { useAuth } from './app/useAuth';
import { AuditPage } from './features/admin/AuditPage';
import { BranchesPage } from './features/admin/BranchesPage';
import { ConfigurationPage } from './features/admin/ConfigurationPage';
import { DevicesPage } from './features/admin/DevicesPage';
import { OrganizationPage } from './features/admin/OrganizationPage';
import { RolesPage } from './features/admin/RolesPage';
import { SessionsPage } from './features/admin/SessionsPage';
import { UsersPage } from './features/admin/UsersPage';
import { LoginPage } from './features/auth/LoginPage';
import { PasswordRecoveryPage } from './features/auth/PasswordRecoveryPage';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { CreditPage } from './features/credit/CreditPage';
import { ExpensesPage } from './features/expenses/ExpensesPage';
import { AdjustmentsPage } from './features/inventory/AdjustmentsPage';
import { CatalogPage } from './features/inventory/CatalogPage';
import { CountsPage } from './features/inventory/CountsPage';
import { PricingPage } from './features/inventory/PricingPage';
import { StockPage } from './features/inventory/StockPage';
import { TransfersPage } from './features/inventory/TransfersPage';
import { OnboardingPage } from './features/onboarding/OnboardingPage';
import { PosPage } from './features/pos/PosPage';
import { ProcurementPage } from './features/procurement/ProcurementPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { NetworkPage } from './features/network/NetworkPage';
import { SubscriptionPage } from './features/licensing/Subscription';

function useAccessSubject(): AccessSubject {
  const { membership, bootstrap } = useAuth();
  return {
    hasPermission: (permission) => Boolean(membership?.permissions.includes(permission)),
    centralHub:!!bootstrap?.featureFlags.multiStoreHub,
    hasModule: (moduleCode) => Boolean(bootstrap?.modules.includes(moduleCode))
  };
}

function RequireAuth() {
  const { status } = useAuth();
  if (status === 'loading') return <Spinner label="Restoring secure session" />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <Shell />;
}

function PublicOnly({ children, afterOnboarding = false }: { children: JSX.Element; afterOnboarding?: boolean }) {
  const { status, bootstrap, hasPermission } = useAuth();
  const subject = useAccessSubject();
  if (status === 'loading') return <Spinner label="Checking session" />;
  if (status === 'authenticated') {
    const openLibrary = afterOnboarding && !bootstrap?.featureFlags.multiStoreHub && bootstrap?.organization.businessProfile
      && hasPermission('catalog.manage') && hasPermission('catalog.read');
    return <Navigate to={openLibrary ? '/catalogue' : landingPath(subject)} replace />;
  }
  return children;
}

/** Sends the authenticated user to the landing page their permissions allow. */
function HomeRedirect() {
  const subject = useAccessSubject();
  return <Navigate to={landingPath(subject)} replace />;
}

/** Guards a route by the same policy the navigation uses; backend authorization remains authoritative. */
function RequireAccess({ policy, children }: { policy: RoutePolicy; children: JSX.Element }) {
  const subject = useAccessSubject();
  if (!routeAllowed(policy, subject)) return <NoAccessPage />;
  return children;
}

function policyFor(path: string): RoutePolicy {
  const policy = ROUTE_POLICIES.find((entry) => entry.path === path);
  if (!policy) throw new Error(`No route policy defined for ${path}`);
  return policy;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/forgot-password" element={<PublicOnly><PasswordRecoveryPage /></PublicOnly>} />
      <Route path="/reset-password" element={<PublicOnly><ResetPasswordPage /></PublicOnly>} />
      <Route path="/onboarding" element={<PublicOnly afterOnboarding><OnboardingPage /></PublicOnly>} />
      <Route element={<RequireAuth />}>
        <Route index element={<HomeRedirect />} />
        <Route path="dashboard" element={<RequireAccess policy={policyFor('/dashboard')}><DashboardPage /></RequireAccess>} />
        <Route path="pos" element={<RequireAccess policy={policyFor('/pos')}><PosPage /></RequireAccess>} />
        <Route path="credit" element={<RequireAccess policy={policyFor('/credit')}><CreditPage /></RequireAccess>} />
        <Route path="procurement" element={<RequireAccess policy={policyFor('/procurement')}><ProcurementPage /></RequireAccess>} />
        <Route path="expenses" element={<RequireAccess policy={policyFor('/expenses')}><ExpensesPage /></RequireAccess>} />
        <Route path="inventory" element={<RequireAccess policy={policyFor('/inventory')}><StockPage /></RequireAccess>} />
        <Route path="inventory/catalogue" element={<RequireAccess policy={policyFor('/inventory')}><CatalogPage /></RequireAccess>} />
        <Route path="catalogue" element={<RequireAccess policy={policyFor('/catalogue')}><CatalogPage /></RequireAccess>} />
        <Route path="inventory/pricing" element={<RequireAccess policy={policyFor('/inventory')}><PricingPage /></RequireAccess>} />
        <Route path="inventory/adjustments" element={<RequireAccess policy={policyFor('/inventory')}><AdjustmentsPage /></RequireAccess>} />
        <Route path="inventory/counts" element={<RequireAccess policy={policyFor('/inventory')}><CountsPage /></RequireAccess>} />
        <Route path="inventory/transfers" element={<RequireAccess policy={policyFor('/inventory')}><TransfersPage /></RequireAccess>} />
        <Route path="reports" element={<RequireAccess policy={policyFor('/reports')}><ReportsPage /></RequireAccess>} />
        <Route path="stores" element={<RequireAccess policy={policyFor('/stores')}><NetworkPage /></RequireAccess>} />
        <Route path="settings/organization" element={<RequireAccess policy={policyFor('/settings/organization')}><OrganizationPage /></RequireAccess>} />
        <Route path="settings/configuration" element={<RequireAccess policy={policyFor('/settings/configuration')}><ConfigurationPage /></RequireAccess>} />
        <Route path="settings/branches" element={<RequireAccess policy={policyFor('/settings/branches')}><BranchesPage /></RequireAccess>} />
        <Route path="settings/users" element={<RequireAccess policy={policyFor('/settings/users')}><UsersPage /></RequireAccess>} />
        <Route path="settings/roles" element={<RequireAccess policy={policyFor('/settings/roles')}><RolesPage /></RequireAccess>} />
        <Route path="settings/devices" element={<RequireAccess policy={policyFor('/settings/devices')}><DevicesPage /></RequireAccess>} />
        <Route path="settings/security" element={<SecurityPage />} />
        <Route path="settings/sessions" element={<RequireAccess policy={policyFor('/settings/sessions')}><SessionsPage /></RequireAccess>} />
        <Route path="settings/subscription" element={<SubscriptionPage />} />
        <Route path="settings/audit" element={<RequireAccess policy={policyFor('/settings/audit')}><AuditPage /></RequireAccess>} />
        <Route path="*" element={<HomeRedirect />} />
      </Route>
    </Routes>
  );
}
