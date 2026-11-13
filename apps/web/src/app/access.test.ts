import { describe, expect, it } from 'vitest';
import { landingPath, routeAllowed, ROUTE_POLICIES, type AccessSubject } from './access';

function subject(permissions: string[], modules: string[] = ['inventory', 'credit', 'procurement', 'expenses', 'reports', 'offline_sync']): AccessSubject {
  return {
    hasPermission: (permission) => permissions.includes(permission),
    hasModule: (moduleCode) => modules.includes(moduleCode)
  };
}

// Mirrors the seeded role permission sets (auth-service.ts) at the decision points.
const OWNER = ['reports.view', 'sales.create', 'settings.manage', 'user.read', 'audit.view'];
const MANAGER = ['reports.view', 'sales.create', 'sales.view', 'expense.approve', 'purchase.approve', 'inventory.read', 'device.read'];
const CASHIER = ['organization.read', 'branch.read', 'device.read', 'sales.create', 'sales.view', 'credit.view', 'purchase.read', 'expense.view', 'inventory.read'];

describe('landingPath', () => {
  it('takes a central owner to linked stores and keeps local checkout out of the central workspace',()=>{
    const hub={...subject([...OWNER,'stores.view']),centralHub:true};
    expect(landingPath(hub)).toBe('/stores');
    expect(routeAllowed(ROUTE_POLICIES.find(policy=>policy.path==='/pos')!,hub)).toBe(false);
    expect(routeAllowed(ROUTE_POLICIES.find(policy=>policy.path==='/stores')!,subject(CASHIER))).toBe(false);
  });
  it('sends owners and managers to the dashboard', () => {
    expect(landingPath(subject(OWNER))).toBe('/dashboard');
    expect(landingPath(subject(MANAGER))).toBe('/dashboard');
  });

  it('sends cashiers straight to the POS checkout', () => {
    expect(landingPath(subject(CASHIER))).toBe('/pos');
  });

  it('skips the dashboard when the reports module is disabled', () => {
    expect(landingPath(subject(MANAGER, ['inventory']))).toBe('/pos');
  });

  it('falls back to the first permitted route and finally sessions', () => {
    expect(landingPath(subject(['inventory.read']))).toBe('/inventory');
    expect(landingPath(subject(['expense.view'], ['expenses']))).toBe('/expenses');
    expect(landingPath(subject([], []))).toBe('/settings/sessions');
  });
});

describe('routeAllowed', () => {
  it('allows catalogues for service businesses without the inventory module', () => {
    const catalogue = ROUTE_POLICIES.find((policy) => policy.path === '/catalogue')!;
    expect(routeAllowed(catalogue, subject(['catalog.read'], []))).toBe(true);
    expect(routeAllowed(catalogue, subject([], []))).toBe(false);
  });
  it('enforces permission and module gates together', () => {
    const reports = ROUTE_POLICIES.find((p) => p.path === '/dashboard')!;
    expect(routeAllowed(reports, subject(['reports.view']))).toBe(true);
    expect(routeAllowed(reports, subject(CASHIER))).toBe(false);
    expect(routeAllowed(reports, subject(['reports.view'], []))).toBe(false);
  });

  it('hides administration screens from cashiers', () => {
    const cashier = subject(CASHIER);
    for (const path of ['/settings/users', '/settings/roles', '/settings/configuration', '/settings/audit']) {
      expect(routeAllowed(ROUTE_POLICIES.find((p) => p.path === path)!, cashier)).toBe(false);
    }
    // Branch and device screens are permission-authorized for cashiers.
    expect(routeAllowed(ROUTE_POLICIES.find((p) => p.path === '/settings/branches')!, cashier)).toBe(true);
  });

  it('keeps own-sessions available to every authenticated membership', () => {
    expect(routeAllowed(ROUTE_POLICIES.find((p) => p.path === '/settings/sessions')!, subject([]))).toBe(true);
  });
});
