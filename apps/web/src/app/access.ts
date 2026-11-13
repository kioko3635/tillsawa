/**
 * Route access policy shared by the sidebar navigation and the route guards.
 *
 * Visibility here is a UX convenience only — every permission and module gate
 * is enforced again by the backend. Ordering of `LANDING_ORDER` defines the
 * post-login destination for each role: owners/managers (reports.view) land on
 * the dashboard, cashiers (sales.create without reports) land on the POS.
 */
export interface RoutePolicy {
  path: string;
  label: string;
  section: 'workspace' | 'administration';
  permission?: string;
  module?: string;
  /** NavLink `end` flag — exact match only. */
  end?: boolean;
}

export interface AccessSubject {
  centralHub?: boolean;
  hasPermission: (permission: string) => boolean;
  hasModule: (moduleCode: string) => boolean;
}

export const ROUTE_POLICIES: RoutePolicy[] = [
  { path: '/dashboard', label: 'Dashboard', section: 'workspace', permission: 'reports.view', module: 'reports' },
  { path: '/pos', label: 'POS', section: 'workspace', permission: 'sales.create' },
  { path: '/credit', label: 'Credit', section: 'workspace', permission: 'credit.view', module: 'credit' },
  { path: '/procurement', label: 'Procurement', section: 'workspace', permission: 'purchase.read', module: 'procurement' },
  { path: '/expenses', label: 'Expenses', section: 'workspace', permission: 'expense.view', module: 'expenses' },
  { path: '/inventory', label: 'Inventory', section: 'workspace', permission: 'inventory.read', module: 'inventory' },
  { path: '/catalogue', label: 'Catalogue', section: 'workspace', permission: 'catalog.read' },
  { path: '/reports', label: 'Reports', section: 'workspace', permission: 'reports.view', module: 'reports' },
  { path: '/stores', label: 'Linked stores', section: 'workspace', permission: 'stores.view' },
  { path: '/settings/organization', label: 'Organization', section: 'administration', permission: 'organization.read' },
  { path: '/settings/configuration', label: 'Configuration', section: 'administration', permission: 'settings.manage' },
  { path: '/settings/branches', label: 'Branches', section: 'administration', permission: 'branch.read' },
  { path: '/settings/users', label: 'Users', section: 'administration', permission: 'user.read' },
  { path: '/settings/roles', label: 'Roles', section: 'administration', permission: 'role.read' },
  { path: '/settings/devices', label: 'Devices', section: 'administration', permission: 'device.read' },
  { path: '/settings/security', label: 'Password & recovery', section: 'administration' },
  { path: '/settings/sessions', label: 'Sessions', section: 'administration' },
  { path: '/settings/subscription', label: 'Subscription', section: 'administration' },
  { path: '/settings/audit', label: 'Audit log', section: 'administration', permission: 'audit.view' }
];

export function routeAllowed(policy: RoutePolicy, subject: AccessSubject): boolean {
  if(subject.centralHub && policy.section==='workspace' && policy.path!=='/stores') return false;
  return (!policy.permission || subject.hasPermission(policy.permission))
    && (!policy.module || subject.hasModule(policy.module));
}

/**
 * The post-login landing route for the authenticated membership. The first
 * accessible policy wins; the sessions page is the universal fallback because
 * every authenticated membership may view its own authentication sessions.
 */
export function landingPath(subject: AccessSubject): string {
  for (const policy of ROUTE_POLICIES) {
    if (routeAllowed(policy, subject)) return policy.path;
  }
  return '/settings/sessions';
}
