import { unitLabel } from '@pos/contracts';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CheckboxField, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Paged, StockLevel, StockMovement } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { InventoryNav } from './InventoryNav';

export function StockPage() {
  const { bootstrap } = useAuth();
  const branches = useMemo(() => bootstrap?.branches ?? [], [bootstrap?.branches]);
  const [branchId, setBranchId] = useState('');
  const [levels, setLevels] = useState<Paged<StockLevel> | null>(null);
  const [movements, setMovements] = useState<Paged<StockMovement> | null>(null);
  const [valuation, setValuation] = useState<{ total: string; currency: string } | null>(null);
  const [reconciliation, setReconciliation] = useState<Array<Record<string, unknown>>>([]);
  const [inTransit, setInTransit] = useState<Array<Record<string, unknown>>>([]);
  const [filters, setFilters] = useState({ search: '', lowStock: false, page: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (nextFilters = filters, nextBranch = branchId) => {
    if (!nextBranch) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [levelResult, movementResult, valuationResult, reconciliationResult, transitResult] = await Promise.all([
        api.stockLevels({ branchId: nextBranch, search: nextFilters.search || undefined, lowStock: nextFilters.lowStock || undefined, page: nextFilters.page, pageSize: 15 }),
        api.stockMovements({ branchId: nextBranch, page: 1, pageSize: 15 }),
        api.inventoryValuation(nextBranch),
        api.inventoryReconciliation(nextBranch),
        api.inTransit(nextBranch)
      ]);
      setLevels(levelResult);
      setMovements(movementResult);
      setValuation(valuationResult.valuation);
      setReconciliation(reconciliationResult.reconciliation);
      setInTransit(transitResult.inTransit);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load inventory.');
    } finally {
      setLoading(false);
    }
  }, [branchId, filters]);

  useEffect(() => {
    const initial = branchId || branches[0]?.id || '';
    if (initial && initial !== branchId) setBranchId(initial);
    if (initial) void load(filters, initial);
  }, [branchId, branches, filters, load]);

  function submitFilters(event: FormEvent) {
    event.preventDefault();
    const next = { ...filters, page: 1 };
    setFilters(next);
    void load(next);
  }

  const lowStockCount = levels?.items.filter((item) => Number(item.onHandQty) <= Number(item.minStockLevel)).length ?? 0;
  const unreconciled = reconciliation.filter((item) => item.reconciled !== true);

  return (
    <div className="page-stack">
      <PageHeader title="Inventory stock" description="Branch stock balances, low-stock alerts, valuation, movements and ledger reconciliation." />
      <InventoryNav />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card title="Stock filters" subtitle="Select an accessible branch and search by product, SKU or barcode.">
        <form className="inline-form" onSubmit={submitFilters}>
          <SelectField label="Branch" value={branchId} onChange={(event) => {
            setBranchId(event.target.value);
            void load({ ...filters, page: 1 }, event.target.value);
          }} required>
            <option value="">Select branch</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </SelectField>
          <TextField label="Search" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="Product, SKU or barcode" />
          <CheckboxField label="Low stock only" checked={filters.lowStock} onChange={(checked) => setFilters({ ...filters, lowStock: checked })} />
          <Button type="submit" variant="secondary">Apply</Button>
        </form>
      </Card>
      {loading ? <Spinner label="Loading stock" /> : (
        <>
          <div className="metric-grid">
            <Card><span className="metric-label">Stock valuation</span><span className="metric-value">{valuation?.total ?? '0'}</span><span className="metric-note">{valuation?.currency ?? 'KES'}</span></Card>
            <Card><span className="metric-label">Stocked products</span><span className="metric-value">{levels?.total ?? 0}</span><span className="metric-note">At selected branch</span></Card>
            <Card><span className="metric-label">Low stock alerts</span><span className="metric-value">{lowStockCount}</span><span className="metric-note">On current page</span></Card>
            <Card><span className="metric-label">In transit</span><span className="metric-value">{inTransit.length}</span><span className="metric-note">Transfer lines</span></Card>
          </div>

          {unreconciled.length ? <Alert tone="warning" title="Reconciliation variance">{unreconciled.length} products differ between balances and the movement ledger.</Alert> : <Alert tone="success">Stock balances reconcile to the append-only movement ledger.</Alert>}

          <Card title="Stock levels" subtitle="Average cost and valuation are maintained transactionally by the API.">
            {levels?.items.length ? (
              <>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Product</th><th>On hand</th><th>Min / reorder</th><th>Avg cost</th><th>Valuation</th><th>Status</th></tr></thead>
                    <tbody>
                      {levels.items.map((item) => {
                        const low = Number(item.onHandQty) <= Number(item.minStockLevel);
                        return (
                          <tr key={item.productId}>
                            <td><strong>{item.name}</strong><small className="table-subtext">{item.sku} · {unitLabel(item.unitCode)}</small></td>
                            <td>{item.onHandQty}</td>
                            <td>{item.minStockLevel} / {item.reorderQty ?? '—'}</td>
                            <td>{item.averageCost}</td>
                            <td>{item.valuation}</td>
                            <td><Badge tone={low ? 'warning' : 'success'}>{low ? 'Low stock' : 'OK'}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="pagination-bar">
                  <span>Page {levels.page} of {levels.totalPages}</span>
                  <Button variant="secondary" disabled={levels.page <= 1} onClick={() => {
                    const next = { ...filters, page: filters.page - 1 };
                    setFilters(next);
                    void load(next);
                  }}>Previous</Button>
                  <Button variant="secondary" disabled={levels.page >= levels.totalPages} onClick={() => {
                    const next = { ...filters, page: filters.page + 1 };
                    setFilters(next);
                    void load(next);
                  }}>Next</Button>
                </div>
              </>
            ) : <EmptyState title="No stock" description="Post opening stock or receive a transfer to populate balances." />}
          </Card>

          <div className="dashboard-grid">
            <Card title="In-transit transfers" subtitle="Stock that left the source branch but has not been received.">
              {inTransit.length ? (
                <div className="list-stack">
                  {inTransit.map((item) => <div className="list-row" key={String(item.transferId)}><div><strong>{String(item.productName)}</strong><span>{String(item.referenceCode)} · {String(item.sourceBranchName)} → {String(item.destinationBranchName)}</span></div><Badge tone="info">{String(item.inTransitQty)} {unitLabel(String(item.unitCode))}</Badge></div>)}
                </div>
              ) : <EmptyState title="Nothing in transit" description="Dispatched but unreceived transfer lines will appear here." />}
            </Card>
            <Card title="Movement ledger" subtitle="Append-only stock movements; corrections use compensating movements.">
              {movements?.items.length ? (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>#</th><th>Product</th><th>Type</th><th>Qty</th><th>Base qty</th><th>Actor</th></tr></thead>
                    <tbody>
                      {movements.items.map((movement) => (
                        <tr key={movement.id}>
                          <td>{movement.seq}</td>
                          <td>{movement.productName}<small className="table-subtext">{movement.productSku}</small></td>
                          <td><Badge tone={movement.negativeOverride ? 'danger' : 'info'}>{movement.movementType}</Badge></td>
                          <td>{movement.quantity} {unitLabel(movement.unitCode)}</td>
                          <td>{movement.baseQuantity}</td>
                          <td>{movement.actorName ?? 'System'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState title="No movements" description="Inventory movements will appear after stock operations." />}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
