import { unitLabel } from '@pos/contracts';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Device, Membership, OperationsReport, RegisterSession, StockLevel } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { deploymentLabels, useDeploymentMode, useOnlineStatus } from '../../lib/offline/connection';

function money(value: string) {
  return `KES ${Number(value).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Today's date expressed in the organization's configured timezone (YYYY-MM-DD). */
function orgToday(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

export function DashboardPage() {
  const { bootstrap, membership, hasPermission } = useAuth();
  const online = useOnlineStatus();
  const mode = useDeploymentMode();
  const [users, setUsers] = useState<Membership[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [report, setReport] = useState<OperationsReport | null>(null);
  const [today, setToday] = useState<OperationsReport | null>(null);
  const [lowStock, setLowStock] = useState<{ items: StockLevel[]; total: number } | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<{ expenses: number; purchaseOrders: number } | null>(null);
  const [openSessions, setOpenSessions] = useState<RegisterSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const canReport = hasPermission('reports.view') && Boolean(bootstrap?.modules.includes('reports'));
  const canInventory = hasPermission('inventory.read') && Boolean(bootstrap?.modules.includes('inventory'));
  const canApproveExpenses = hasPermission('expense.approve') && Boolean(bootstrap?.modules.includes('expenses'));
  const canApprovePurchases = hasPermission('purchase.approve') && Boolean(bootstrap?.modules.includes('procurement'));
  const canViewSales = hasPermission('sales.view');

  useEffect(() => {
    let cancelled = false;
    const timezone = bootstrap?.organization.timezone ?? 'Africa/Nairobi';
    const todayDate = orgToday(timezone);
    const stockBranchId = bootstrap?.organization.defaultBranchId ?? bootstrap?.branches[0]?.id;
    Promise.all([
      hasPermission('user.read') ? api.users() : Promise.resolve({ users: [] }),
      hasPermission('device.read') ? api.devices() : Promise.resolve({ devices: [] }),
      canReport ? api.operationsReport({}) : Promise.resolve({ report: null }),
      canReport ? api.operationsReport({ from: todayDate, to: todayDate }) : Promise.resolve({ report: null }),
      canInventory && stockBranchId ? api.stockLevels({ branchId: stockBranchId, lowStock: true, pageSize: 5 }) : Promise.resolve(null),
      canApproveExpenses ? api.expenses({ status: 'submitted', pageSize: 1 }) : Promise.resolve(null),
      canApprovePurchases ? api.purchaseOrders({ status: 'submitted', pageSize: 1 }) : Promise.resolve(null),
      canViewSales ? api.registerSessions({ status: 'open', pageSize: 20 }) : Promise.resolve(null)
    ]).then(([userResult, deviceResult, reportResult, todayResult, stockResult, expenseResult, orderResult, sessionResult]) => {
      if (cancelled) return;
      setUsers(userResult.users);
      setDevices(deviceResult.devices);
      setReport(reportResult.report);
      setToday(todayResult.report);
      setLowStock(stockResult ? { items: stockResult.items, total: stockResult.total } : null);
      setPendingApprovals(expenseResult || orderResult
        ? { expenses: expenseResult?.total ?? 0, purchaseOrders: orderResult?.total ?? 0 }
        : null);
      setOpenSessions(sessionResult ? sessionResult.sessions : null);
      setLoading(false);
    }).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof ApiError ? err.message : 'Unable to load workspace data.');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap]);

  if (!bootstrap || loading) return <Spinner label="Loading workspace" />;

  const recentDays = report ? [...report.daily].slice(-7) : [];
  const peak = Math.max(1, ...recentDays.map(day => Number(day.sales)));

  return (
    <div className="page-stack owner-dashboard">
      <PageHeader
        title="Business overview"
        description={`Welcome, ${membership?.displayName ?? 'back'}. Here's how your business is doing today.`}
        actions={hasPermission('sales.create') ? <Link className="btn btn-primary" to="/pos">Open point of sale →</Link> : undefined}
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="dashboard-hero">
        <div><span className="dashboard-eyebrow">YOUR BUSINESS, AT A GLANCE</span><h2>{bootstrap.organization.displayName}</h2><p>Review sales, stock and daily operations.</p></div>
        <div className="dashboard-hero-status"><Badge tone={online ? 'success' : 'warning'}>{online ? deploymentLabels[mode] : 'Connection unavailable'}</Badge><span>{new Intl.DateTimeFormat('en-KE', { dateStyle: 'full', timeZone: bootstrap.organization.timezone }).format(new Date())}</span></div>
      </div>
      <div className="dashboard-shortcuts">
        {canInventory ? <Link to="/inventory">View products & stock <span>→</span></Link> : null}
        {canReport ? <Link to="/reports">Sales & cash reports <span>→</span></Link> : null}
        {hasPermission('purchase.read') && bootstrap.modules.includes('procurement') ? <Link to="/procurement">Suppliers & purchases <span>→</span></Link> : null}
        {hasPermission('user.read') ? <Link to="/settings/users">Manage your team <span>→</span></Link> : null}
      </div>
      <div className="metric-grid">
        {today ? (
          <Card>
            <span className="metric-label">Today's sales</span>
            <strong className="metric-value">{money(today.sales.grossSales)}</strong>
            <span className="metric-note">{today.sales.count} sale{today.sales.count === 1 ? '' : 's'} · gross profit {money(today.sales.grossProfit)}</span>
          </Card>
        ) : null}
        {pendingApprovals ? (
          <Card>
            <span className="metric-label">Pending approvals</span>
            <strong className="metric-value">{pendingApprovals.expenses + pendingApprovals.purchaseOrders}</strong>
            <span className="metric-note">
              {pendingApprovals.expenses} expense{pendingApprovals.expenses === 1 ? '' : 's'}
              {canApprovePurchases ? ` · ${pendingApprovals.purchaseOrders} purchase order${pendingApprovals.purchaseOrders === 1 ? '' : 's'}` : ''}
            </span>
          </Card>
        ) : null}
        {lowStock ? (
          <Card>
            <span className="metric-label">Low stock</span>
            <strong className="metric-value">{lowStock.total}</strong>
            <span className="metric-note">Products at or below minimum stock</span>
          </Card>
        ) : null}
        {openSessions ? (
          <Card>
            <span className="metric-label">Open tills</span>
            <strong className="metric-value">{openSessions.length}</strong>
            <span className="metric-note">Register sessions currently open</span>
          </Card>
        ) : null}
        <Card>
          <span className="metric-label">Branches</span>
          <strong className="metric-value">{bootstrap.branches.length}</strong>
          <span className="metric-note">Authorized for your membership</span>
        </Card>
        {hasPermission('user.read') ? <Card>
          <span className="metric-label">Team members</span>
          <strong className="metric-value">{users.length}</strong>
          <span className="metric-note">Organization memberships</span>
        </Card> : null}
        {hasPermission('device.read') ? <Card>
          <span className="metric-label">Registered devices</span>
          <strong className="metric-value">{devices.length}</strong>
          <span className="metric-note">Sync contract v{bootstrap.syncContractVersion}</span>
        </Card> : null}
        <Card>
          <span className="metric-label">Connection</span>
          <strong className="metric-value metric-status">{online ? 'Connected' : 'Unavailable'}</strong>
          <span className="metric-note">{mode === 'standalone' && bootstrap.featureFlags.offlineSales ? 'Offline cash checkout available on registered devices' : 'Checkout requires a server connection'}</span>
        </Card>
      </div>
      {report ? (
        <div className="metric-grid">
          <Card>
            <span className="metric-label">Gross sales</span>
            <strong className="metric-value">{money(report.sales.grossSales)}</strong>
            <span className="metric-note">{report.sales.count} sales · gross profit {money(report.sales.grossProfit)}</span>
          </Card>
          <Card>
            <span className="metric-label">Authorized expenses</span>
            <strong className="metric-value">{money(report.expenses.authorized)}</strong>
            <span className="metric-note">Paid {money(report.expenses.paid)} · pending {money(report.expenses.pendingPayment)}</span>
          </Card>
          <Card>
            <span className="metric-label">Receivables</span>
            <strong className="metric-value">{money(report.debt.receivablesOutstanding)}</strong>
            <span className="metric-note">Customer credit outstanding</span>
          </Card>
          <Card>
            <span className="metric-label">Payables</span>
            <strong className="metric-value">{money(report.debt.payablesOutstanding)}</strong>
            <span className="metric-note">Supplier invoices outstanding</span>
          </Card>
        </div>
      ) : null}
      {recentDays.length > 0 || (lowStock && lowStock.items.length > 0) ? (
        <div className="dashboard-grid">
          {recentDays.length > 0 ? (
            <Card title="Sales trend" subtitle="Most recent days with activity" actions={<Link className="btn btn-secondary" to="/reports">Reports</Link>}>
              <ul className="workspace-sales-trend" aria-label="Daily sales totals">
                {recentDays.map(day => (
                  <li key={day.date}>
                    <time dateTime={day.date}>{day.date.slice(5)}</time>
                    <div className="workspace-trend-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Number(day.sales)) / peak * 100}%` }} /></div>
                    <strong>{money(day.sales)}</strong>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {lowStock && lowStock.items.length > 0 ? (
            <Card title="Low stock" subtitle="Products at or below their minimum level" actions={<Link className="btn btn-secondary" to="/inventory">Inventory</Link>}>
              <div className="list-stack">
                {lowStock.items.map((item) => (
                  <div className="list-row" key={item.productId}>
                    <div><strong>{item.name}</strong><span>{item.sku}</span></div>
                    <Badge tone="warning">{item.onHandQty} {unitLabel(item.unitCode)}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}
      <div className="dashboard-grid">
        <Card title="Organization" subtitle="Current business defaults">
          <dl className="detail-list">
            <div><dt>Legal name</dt><dd>{bootstrap.organization.legalName}</dd></div>
            <div><dt>Currency</dt><dd>{bootstrap.organization.currencyCode}</dd></div>
            <div><dt>Time zone</dt><dd>{bootstrap.organization.timezone}</dd></div>
            <div><dt>Tax pricing</dt><dd>{bootstrap.organization.taxPricingMode}</dd></div>
          </dl>
        </Card>
        <Card title="Branches" subtitle="Your accessible operating locations" actions={<Link className="btn btn-secondary" to="/settings/branches">Manage</Link>}>
          {bootstrap.branches.length === 0 ? (
            <EmptyState title="No accessible branches" description="Ask an owner or administrator to grant branch access." />
          ) : (
            <div className="list-stack">
              {bootstrap.branches.map((branch) => (
                <div className="list-row" key={branch.id}>
                  <div><strong>{branch.name}</strong><span>{branch.code}</span></div>
                  <Badge tone={branch.status === 'active' ? 'success' : 'warning'}>{branch.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
