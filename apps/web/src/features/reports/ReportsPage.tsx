import { unitLabel } from '@pos/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Alert, Button, Card, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { useAuth } from '../../app/useAuth';
import { api, ApiError } from '../../lib/api/client';
import type { OperationsReport } from '../../lib/api/types';
import { reportDates, type ReportPeriod } from '../../lib/report-dates';

function money(value: string, currency = 'KES') {
  return `${currency} ${Number(value).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateOnly(value?: string | null) {
  return value ? new Date(value).toLocaleDateString('en-KE', { dateStyle: 'medium' }) : 'All dates';
}

export function ReportsPage() {
  const { bootstrap, hasPermission } = useAuth();
  const canExport = hasPermission('reports.export');
  const branches = useMemo(() => bootstrap?.branches ?? [], [bootstrap?.branches]);
  const [filters, setFilters] = useState({ branchId: '', from: '', to: '' });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const requestVersion = useRef(0);
  const [report, setReport] = useState<OperationsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const dailyChartData = useMemo(() => (report?.daily ?? []).map((row) => ({
    date: row.date.slice(5),
    Sales: Number(row.sales),
    'Authorized expenses': Number(row.authorizedExpenses),
    'Paid expenses': Number(row.paidExpenses)
  })), [report]);

  async function load(next = filters) {
    if (next.from && next.to && next.from > next.to) {
      setError('The start date must be on or before the end date.');
      return;
    }
    const version = ++requestVersion.current;
    setLoading(true);
    setReport(null);
    setError('');
    try {
      const result = await api.operationsReport({
        branchId: next.branchId || undefined,
        from: next.from || undefined,
        to: next.to || undefined
      });
      if (version !== requestVersion.current) return;
      setReport(result.report);
      setAppliedFilters(next);
    } catch (err) {
      if (version === requestVersion.current) setError(err instanceof ApiError ? err.message : 'Unable to load operational reporting.');
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  async function exportCsv() {
    setError('');
    try {
      const csv = await api.exportOperationsReport({
        branchId: appliedFilters.branchId || undefined,
        from: appliedFilters.from || undefined,
        to: appliedFilters.to || undefined
      });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `operations-report-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to export the operational report.');
    }
  }

  useEffect(() => {
    let cancelled = false;
    const version = ++requestVersion.current;
    api.operationsReport({}).then((result) => {
      if (!cancelled && version === requestVersion.current) setReport(result.report);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof ApiError ? err.message : 'Unable to load operational reporting.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!bootstrap || loading) return <Spinner label="Loading operational reports" />;

  return (
    <div className="page-stack report-page">
      <PageHeader
        title="Business reports"
        description="Review sales, stock, expenses and cash reconciliation for your shop."
        actions={(
          <div className="button-row">
            <Button variant="secondary" onClick={() => window.print()} disabled={!report}>Print report</Button>
            <Button variant="secondary" onClick={() => void exportCsv()} disabled={!report || !canExport}>Export CSV</Button>
          </div>
        )}
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card className="report-scope" title="Report scope" subtitle="Date ranges use the organization time zone; branch totals only include authorized locations.">
        <div className="report-presets" role="group" aria-label="Report period">
          {([['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month'], ['all', 'All time']] as const).map(([period, label]) => (
            <Button key={period} variant="secondary" onClick={() => {
              const next = { ...filters, ...reportDates(period as ReportPeriod, bootstrap.organization.timezone) };
              setFilters(next);
              void load(next);
            }}>{label}</Button>
          ))}
        </div>
        <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void load(filters); }}>
          <SelectField label="Branch" value={filters.branchId} onChange={(event) => setFilters({ ...filters, branchId: event.target.value })}>
            <option value="">All accessible branches</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </SelectField>
          <TextField label="From" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          <TextField label="To" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          <Button type="submit">Run report</Button>
          <Button type="button" variant="secondary" onClick={() => { const empty = { branchId: '', from: '', to: '' }; setFilters(empty); void load(empty); }}>Reset</Button>
        </form>
      </Card>

      {!report ? (
        <EmptyState title="No report data" description="Run a report after sales, expenses or stock activity has been recorded." />
      ) : (
        <>
          <div className="report-context">
            <strong>{report.organizationName}</strong>
            <span>{report.range.from || report.range.to ? `${dateOnly(report.range.from)} to ${dateOnly(report.range.to)}` : 'All time'} · Generated {new Date(report.generatedAt).toLocaleString('en-KE')} · {report.timezone}</span>
          </div>
          {JSON.stringify(filters) !== JSON.stringify(appliedFilters) ? <Alert tone="info">Filters changed. Run report to update the results. Print and export use the displayed report's applied dates and branch.</Alert> : null}

          <div className="metric-grid">
            <Card><span className="metric-label">Gross sales</span><strong className="metric-value">{money(report.sales.grossSales, report.currencyCode)}</strong><span className="metric-note">{report.sales.count} non-voided sales</span></Card>
            <Card><span className="metric-label">Gross profit</span><strong className="metric-value">{money(report.sales.grossProfit, report.currencyCode)}</strong><span className="metric-note">Excludes tax; before returns and expenses</span></Card>
            <Card><span className="metric-label">Paid expenses</span><strong className="metric-value">{money(report.expenses.paid, report.currencyCode)}</strong><span className="metric-note">{money(report.expenses.authorized, report.currencyCode)} approved or paid</span></Card>
            <Card><span className="metric-label">Stock value</span><strong className="metric-value">{money(report.inventory.stockValue, report.currencyCode)}</strong><span className="metric-note">{report.inventory.lowStockCount} low-stock lines</span></Card>
          </div>

          <div className="dashboard-grid">
            <Card title="Sales and cash" subtitle="POS totals are authoritative sale ledger totals.">
              <dl className="detail-list">
                <div><dt>Cash sales</dt><dd>{money(report.sales.cashSales, report.currencyCode)}</dd></div>
                <div><dt>Credit sales</dt><dd>{money(report.sales.creditSales, report.currencyCode)}</dd></div>
                <div><dt>M-Pesa sales</dt><dd>{money(report.sales.mpesaSales, report.currencyCode)}</dd></div>
                <div><dt>Card sales</dt><dd>{money(report.sales.cardSales, report.currencyCode)}</dd></div>
                <div><dt>Included test payments — no money moved</dt><dd>{money(report.sales.testSales, report.currencyCode)}</dd></div>
                <div><dt>Discounts</dt><dd>{money(report.sales.discounts, report.currencyCode)}</dd></div>
                <div><dt>Tax included/collected</dt><dd>{money(report.sales.tax, report.currencyCode)}</dd></div>
                <div><dt>Returned value</dt><dd>{money(report.sales.returned, report.currencyCode)}</dd></div>
                <div><dt>Cash refunded</dt><dd>{money(report.sales.refunded, report.currencyCode)}</dd></div>
              </dl>
            </Card>
            <Card title="Drawer reconciliation" subtitle="Cash movements include customer collections, supplier payments, expense payments and adjustments.">
              <dl className="detail-list">
                <div><dt>Cash sale receipts</dt><dd>{money(report.drawer.cashSales, report.currencyCode)}</dd></div>
                <div><dt>Customer collections</dt><dd>{money(report.drawer.customerCollections, report.currencyCode)}</dd></div>
                <div><dt>Supplier payments</dt><dd>{money(report.drawer.supplierPayments, report.currencyCode)}</dd></div>
                <div><dt>Expense payments</dt><dd>{money(report.drawer.expensePayments, report.currencyCode)}</dd></div>
                <div><dt>Manual cash in/out</dt><dd>{money(report.drawer.cashIn, report.currencyCode)} / {money(report.drawer.cashOut, report.currencyCode)}</dd></div>
                <div><dt>Net movement</dt><dd>{money(report.drawer.netCashMovement, report.currencyCode)}</dd></div>
              </dl>
            </Card>
          </div>

          <div className="dashboard-grid">
            <Card title="Top selling products" subtitle="Top 20 by gross sales. Figures are before returns; profit excludes tax and expenses.">
              {!report.topProducts.length ? <EmptyState title="No product sales" description="Complete a sale to see your best sellers here." /> : (
                <div className="table-wrap"><table><thead><tr><th>Product</th><th>Qty / unit</th><th>Sales</th><th>Gross profit</th></tr></thead><tbody>
                  {report.topProducts.map((row) => <tr key={`${row.productId}-${row.sku}-${row.name}-${unitLabel(row.unitCode)}`}><td>{row.name}<small className="table-subtext">{row.sku}</small></td><td>{Number(row.quantity).toLocaleString('en-KE')} {unitLabel(row.unitCode)}</td><td>{money(row.sales, report.currencyCode)}</td><td>{money(row.grossProfit, report.currencyCode)}</td></tr>)}
                </tbody></table></div>
              )}
            </Card>
            <Card title="Sales by cashier" subtitle="Non-voided transactions in this period, before returns. Access is controlled by report permissions.">
              {!report.cashiers.length ? <EmptyState title="No cashier sales" description="Staff sales appear after checkout." /> : (
                <div className="table-wrap"><table><thead><tr><th>Cashier</th><th>Transactions</th><th>Sales</th></tr></thead><tbody>
                  {report.cashiers.map((row) => <tr key={row.membershipId}><td>{row.name}</td><td>{row.saleCount}</td><td>{money(row.sales, report.currencyCode)}</td></tr>)}
                </tbody></table></div>
              )}
            </Card>
          </div>
          <div className="dashboard-grid">
            <Card title="Expense categories" subtitle="Submitted, approved and paid totals are separated so unpaid work is not counted as cash spent.">
              {!report.expenses.categories.length ? <EmptyState title="No expenses" description="No expense records match this scope." /> : (
                <div className="table-wrap"><table><thead><tr><th>Category</th><th>Count</th><th>Submitted</th><th>Approved</th><th>Paid</th><th>Authorized</th></tr></thead><tbody>
                  {report.expenses.categories.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.count}</td><td>{money(row.submitted, report.currencyCode)}</td><td>{money(row.approved, report.currencyCode)}</td><td>{money(row.paid, report.currencyCode)}</td><td><strong>{money(row.total, report.currencyCode)}</strong></td></tr>)}
                </tbody></table></div>
              )}
            </Card>
            <Card title="Branch comparison" subtitle="Only branches visible to your membership are included.">
              {!report.branches.length ? <EmptyState title="No branch totals" description="No accessible branches have activity in this scope." /> : (
                <div className="table-wrap"><table><thead><tr><th>Branch</th><th>Sales</th><th>Authorized expenses</th><th>Paid expenses</th><th>Stock value</th></tr></thead><tbody>
                  {report.branches.map((row) => <tr key={row.branchId}><td>{row.name}</td><td>{money(row.sales, report.currencyCode)}</td><td>{money(row.authorizedExpenses, report.currencyCode)}</td><td>{money(row.paidExpenses, report.currencyCode)}</td><td>{money(row.stockValue, report.currencyCode)}</td></tr>)}
                </tbody></table></div>
              )}
            </Card>
          </div>

          <div className="dashboard-grid">
            <Card title="Daily trend" subtitle="Operational totals for each day in the selected range.">
              {!report.daily.length ? <EmptyState title="No daily activity" description="There are no sales or expense records in this period." /> : (
                <div className="detail-stack">
                  <div className="report-chart" aria-label="Daily sales and expense totals chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dailyChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="date" />
                        <YAxis tickFormatter={(value: number) => Math.abs(value) >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value))} />
                        <Tooltip formatter={(value) => money(String(value), report.currencyCode)} />
                        <Legend />
                        <Bar dataKey="Sales" fill="#2563eb" radius={[5, 5, 0, 0]} />
                        <Bar dataKey="Paid expenses" fill="#0f766e" radius={[5, 5, 0, 0]} />
                        <Bar dataKey="Authorized expenses" fill="#d97706" radius={[5, 5, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="table-wrap"><table><thead><tr><th>Date</th><th>Sales</th><th>Transactions</th><th>Authorized expenses</th><th>Paid expenses</th></tr></thead><tbody>
                    {report.daily.map((row) => <tr key={row.date}><td>{dateOnly(row.date)}</td><td>{money(row.sales, report.currencyCode)}</td><td>{row.saleCount}</td><td>{money(row.authorizedExpenses, report.currencyCode)}</td><td>{money(row.paidExpenses, report.currencyCode)}</td></tr>)}
                  </tbody></table></div>
                </div>
              )}
            </Card>
            <Card title="Debt position" subtitle="Receivables and payables are derived from ledgers and allocations.">
              <dl className="detail-list">
                <div><dt>Customer receivables</dt><dd>{money(report.debt.receivablesOutstanding, report.currencyCode)}</dd></div>
                <div><dt>Supplier payables</dt><dd>{money(report.debt.payablesOutstanding, report.currencyCode)}</dd></div>
                <div><dt>Pending expense payments</dt><dd>{money(report.expenses.pendingPayment, report.currencyCode)}</dd></div>
                <div><dt>Draft expenses</dt><dd>{money(report.expenses.draft, report.currencyCode)}</dd></div>
                <div><dt>Submitted expenses</dt><dd>{money(report.expenses.submitted, report.currencyCode)}</dd></div>
              </dl>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
