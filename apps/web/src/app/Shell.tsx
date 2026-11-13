import { BrandMark } from '../design-system/Brand';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { Button } from '../design-system/components';
import { deploymentLabels, useDeploymentMode, useOnlineStatus } from '../lib/offline/connection';
import { landingPath, routeAllowed, ROUTE_POLICIES, type AccessSubject } from './access';
import { useAuth } from './useAuth';
import { SubscriptionProvider } from '../features/licensing/Subscription';
import { Icon } from '../design-system/Icon';
import { RecoverySetupReminder } from '../features/admin/RecoverySetupReminder';

export function Shell() {
  const { membership, bootstrap, logout, hasPermission } = useAuth();
  const online = useOnlineStatus();
  const deploymentMode=useDeploymentMode();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const currentPage = ROUTE_POLICIES.find(item => item.path === location.pathname)?.label ?? (location.pathname.startsWith('/inventory/') ? 'Inventory' : 'Workspace');
  const initials = (membership?.displayName ?? 'User').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  const subject: AccessSubject = {
    hasPermission,
    centralHub:!!bootstrap?.featureFlags.multiStoreHub,
    hasModule: (moduleCode) => Boolean(bootstrap?.modules.includes(moduleCode))
  };
  const navItems = ROUTE_POLICIES.filter((item) => item.section === 'workspace' && routeAllowed(item, subject));
  const groups = [
    { label: 'Overview', paths: ['/dashboard', '/reports', '/stores'] },
    { label: 'Sales', paths: ['/pos', '/credit'] },
    { label: 'Stock & operations', paths: ['/inventory', '/catalogue', '/procurement', '/expenses'] }
  ];
  const adminItems = ROUTE_POLICIES.filter((item) => item.section === 'administration' && routeAllowed(item, subject));
  const home = landingPath(subject);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={`sidebar ${navOpen ? 'sidebar-open' : ''}`} aria-label="Primary navigation">
        <div className="brand">
          <NavLink to={home} className="brand-link" onClick={() => setNavOpen(false)}>
            <BrandMark />
            <div>
              <strong>TillSawa</strong>
              <span>{bootstrap?.organization.displayName ?? 'Business platform'}</span>
            </div>
          </NavLink>
        </div>
        {groups.map(group => {
          const items = group.paths.flatMap(path => navItems.filter(item => item.path === path));
          return items.length ? <nav key={group.label} className="nav-section" aria-label={group.label}>
            <span className="nav-heading">{group.label}</span>
            {items.map(item => <NavLink key={item.path} to={item.path} end={item.end ?? false} onClick={() => setNavOpen(false)}>
              <Icon name={item.path.split('/').at(-1) ?? 'dashboard'} /><span>{item.label}</span>
            </NavLink>)}
          </nav> : null;
        })}
        {adminItems.length > 0 ? (
          <nav className="nav-section" aria-label="Administration">
            <span className="nav-heading">Administration</span>
            {adminItems.map((item) => (
              <NavLink key={item.path} to={item.path} onClick={() => setNavOpen(false)}>
                <Icon name={item.path.split('/').at(-1) ?? 'configuration'} /><span>{item.label}</span>
              </NavLink>
            ))}
          </nav>
        ) : null}
        <div className="sidebar-foot"><i className={`status-dot ${online ? '' : 'danger'}`} aria-hidden="true" /><div><strong>{deploymentLabels[deploymentMode]}</strong><span>{online ? 'Shop server connected' : 'Shop server unavailable'}</span></div></div>
      </aside>
      <div className="app-frame">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Toggle navigation" aria-expanded={navOpen} onClick={() => setNavOpen((open) => !open)}>
            <span /><span /><span />
          </button>
          <div className="topbar-title">
            <span className="workspace-breadcrumb">{bootstrap?.organization.displayName ?? 'TillSawa'} <span aria-hidden="true">/</span> <strong>{currentPage}</strong></span>
            <span>{bootstrap?.organization.timezone ?? 'Africa/Nairobi'} · {bootstrap?.organization.currencyCode ?? 'KES'}</span>
          </div>
          <div className="topbar-actions">
            <span className="topbar-status"><i className={`status-dot ${online ? '' : 'danger'}`} aria-hidden="true" />{online ? deploymentLabels[deploymentMode] : 'Disconnected'}</span>
            <span className="user-avatar" aria-hidden="true">{initials}</span><div className="user-menu">
              <span>{membership?.displayName}</span>
              <small>{membership?.email}</small>
            </div>
            <Button variant="secondary" onClick={() => void logout()}>Sign out</Button>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {hasPermission('settings.manage') ? <RecoverySetupReminder key={location.pathname} /> : null}
          <SubscriptionProvider key={bootstrap?.organization.id}><Outlet /></SubscriptionProvider>
        </main>
      </div>
      {navOpen ? <button className="sidebar-overlay" aria-label="Close navigation" onClick={() => setNavOpen(false)} /> : null}
    </div>
  );
}
