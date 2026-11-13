import { unitLabel } from '@pos/contracts';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CheckboxField, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Product, StockTransfer, UnitOfMeasure } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { InventoryNav } from './InventoryNav';

const initialForm = {
  sourceBranchId: '',
  destinationBranchId: '',
  notes: '',
  productId: '',
  unitId: '',
  quantity: ''
};

export function TransfersPage() {
  const { bootstrap, hasPermission } = useAuth();
  const canTransfer = hasPermission('inventory.transfer');
  const canOverride = hasPermission('inventory.negative-override');
  const branches = useMemo(() => bootstrap?.branches ?? [], [bootstrap?.branches]);
  const [branchId, setBranchId] = useState('');
  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [selected, setSelected] = useState<StockTransfer | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [form, setForm] = useState(initialForm);
  const [receiveQtys, setReceiveQtys] = useState<Record<string, string>>({});
  const [cancelReason, setCancelReason] = useState('');
  const [allowNegative, setAllowNegative] = useState(false);
  const [negativeReason, setNegativeReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async (nextBranch = branchId) => {
    setLoading(true);
    setError('');
    try {
      const [productResult, unitResult] = await Promise.all([api.products({ pageSize: 100, status: 'active', itemType: 'stocked' }), api.units()]);
      setProducts(productResult.items);
      setUnits(unitResult.units);
      const effectiveBranch = nextBranch || branches[0]?.id || '';
      if (effectiveBranch) {
        setBranchId(effectiveBranch);
        const result = await api.transfers(effectiveBranch);
        setTransfers(result.transfers);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load transfers.');
    } finally {
      setLoading(false);
    }
  }, [branchId, branches]);

  useEffect(() => {
    void load();
  }, [load]);

  async function selectTransfer(transfer: StockTransfer) {
    setError('');
    try {
      const result = await api.transfer(transfer.id);
      setSelected(result.transfer);
      setReceiveQtys(Object.fromEntries((result.transfer.lines ?? []).map((line) => [line.id, line.inTransitQty])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load transfer.');
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await api.createTransfer({
        sourceBranchId: form.sourceBranchId,
        destinationBranchId: form.destinationBranchId,
        notes: form.notes || null,
        lines: [{ productId: form.productId, unitId: form.unitId || undefined, quantity: form.quantity }]
      });
      setSelected(result.transfer);
      setForm({ ...initialForm, sourceBranchId: form.sourceBranchId });
      await load(form.sourceBranchId);
      setMessage('Transfer draft created.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create transfer.');
    } finally {
      setSaving(false);
    }
  }

  async function dispatch() {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.dispatchTransfer(selected.id, {
        allowNegative,
        negativeReason: negativeReason || null
      });
      setSelected(result.transfer);
      setAllowNegative(false);
      setNegativeReason('');
      await load(branchId);
      setMessage('Transfer dispatched; source stock moved to in-transit.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to dispatch transfer.');
    } finally {
      setSaving(false);
    }
  }

  async function receive(lineId?: string) {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const lines = lineId
        ? [{ transferLineId: lineId, quantity: receiveQtys[lineId] || '0' }]
        : undefined;
      const result = await api.receiveTransfer(selected.id, { lines });
      setSelected(result.transfer);
      await load(branchId);
      setMessage('Transfer receipt posted to destination stock.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to receive transfer.');
    } finally {
      setSaving(false);
    }
  }

  async function cancel(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.cancelTransfer(selected.id, { reason: cancelReason });
      setSelected(result.transfer);
      setCancelReason('');
      await load(branchId);
      setMessage('Transfer cancelled and remaining stock reconciled.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to cancel transfer.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner label="Loading transfers" />;

  return (
    <div className="page-stack">
      <PageHeader title="Branch transfers" description="Draft, dispatch and receive stock between branches without silently increasing destination stock." />
      <InventoryNav />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!canTransfer ? <Alert tone="warning">You can view transfers but cannot create, dispatch, receive or cancel them.</Alert> : null}

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Transfers" subtitle="Filtered by the selected source or destination branch.">
          <SelectField label="Branch" value={branchId} onChange={(event) => {
            setBranchId(event.target.value);
            setSelected(null);
            void load(event.target.value);
          }}>
            <option value="">Select branch</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </SelectField>
          {transfers.length ? (
            <div className="list-stack">
              {transfers.map((transfer) => (
                <button className={`role-row ${selected?.id === transfer.id ? 'role-row-selected' : ''}`} key={transfer.id} onClick={() => void selectTransfer(transfer)}>
                  <span><strong>{transfer.referenceCode}</strong><small>{transfer.sourceBranchName} → {transfer.destinationBranchName}</small></span>
                  <Badge tone={transfer.status === 'received' ? 'success' : transfer.status === 'cancelled' ? 'danger' : 'info'}>{transfer.status}</Badge>
                </button>
              ))}
            </div>
          ) : <EmptyState title="No transfers" description="Create a draft transfer." />}
        </Card>

        <div className="page-stack">
          {canTransfer ? (
            <Card title="Create transfer" subtitle="A draft does not change stock. Dispatch writes the outbound movement.">
              <form className="form-stack" onSubmit={(event) => void create(event)}>
                <div className="form-grid">
                  <SelectField label="Source branch" value={form.sourceBranchId} onChange={(event) => setForm({ ...form, sourceBranchId: event.target.value })} required>
                    <option value="">Select branch</option>
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </SelectField>
                  <SelectField label="Destination branch" value={form.destinationBranchId} onChange={(event) => setForm({ ...form, destinationBranchId: event.target.value })} required>
                    <option value="">Select branch</option>
                    {branches.filter((branch) => branch.id !== form.sourceBranchId).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </SelectField>
                  <SelectField label="Product" value={form.productId} onChange={(event) => {
                    const product = products.find((item) => item.id === event.target.value);
                    setForm({ ...form, productId: event.target.value, unitId: product?.baseUnitId ?? '' });
                  }} required>
                    <option value="">Select product</option>
                    {products.map((product) => <option key={product.id} value={product.id}>{product.sku} — {product.name}</option>)}
                  </SelectField>
                  <SelectField label="Unit" value={form.unitId} onChange={(event) => setForm({ ...form, unitId: event.target.value })} required>
                    <option value="">Select unit</option>
                    {units.filter((unit) => unit.status === 'active').map((unit) => <option key={unit.id} value={unit.id}>{unitLabel(unit.code, unit.name)}</option>)}
                  </SelectField>
                  <TextField label="Quantity" inputMode="decimal" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} required />
                </div>
                <TextField label="Notes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
                <Button type="submit" loading={saving}>Create draft</Button>
              </form>
            </Card>
          ) : null}

          <Card title={selected ? selected.referenceCode : 'Transfer details'} subtitle="Dispatch, receive and cancellation statuses are explicit.">
            {selected?.lines?.length ? (
              <>
                <div className="list-row">
                  <div><strong>{selected.sourceBranchName} → {selected.destinationBranchName}</strong><span>{selected.status} · {new Date(selected.createdAt).toLocaleString()}</span></div>
                  <Badge tone={selected.status === 'received' ? 'success' : selected.status === 'cancelled' ? 'danger' : 'info'}>{selected.status}</Badge>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Product</th><th>Requested</th><th>Dispatched</th><th>In transit</th><th>Received</th><th>Receive qty</th></tr></thead>
                    <tbody>
                      {selected.lines.map((line) => (
                        <tr key={line.id}>
                          <td>{line.productName}<small className="table-subtext">{line.productSku}</small></td>
                          <td>{line.quantity}</td>
                          <td>{line.qtyDispatched}</td>
                          <td>{line.inTransitQty}</td>
                          <td>{line.qtyReceived}</td>
                          <td>
                            {Number(line.inTransitQty) > 0 && canTransfer ? (
                              <div className="inline-form transfer-receive">
                                <TextField label="Qty" inputMode="decimal" value={receiveQtys[line.id] ?? line.inTransitQty} onChange={(event) => setReceiveQtys({ ...receiveQtys, [line.id]: event.target.value })} />
                                <Button variant="secondary" onClick={() => void receive(line.id)} disabled={saving}>Receive</Button>
                              </div>
                            ) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {canTransfer && selected.status === 'draft' ? (
                  <div className="form-stack">
                    {canOverride ? (
                      <>
                        <CheckboxField label="Allow dispatch below zero" checked={allowNegative} onChange={setAllowNegative} />
                        {allowNegative ? <TextField label="Negative-stock reason" value={negativeReason} onChange={(event) => setNegativeReason(event.target.value)} required /> : null}
                      </>
                    ) : null}
                    <Button onClick={() => void dispatch()} loading={saving}>Dispatch transfer</Button>
                  </div>
                ) : null}
                {canTransfer && ['dispatched', 'partially_received'].includes(selected.status) ? <Button onClick={() => void receive()} disabled={saving}>Receive all in-transit</Button> : null}
                {canTransfer && !['received', 'cancelled'].includes(selected.status) ? (
                  <form className="inline-form" onSubmit={(event) => void cancel(event)}>
                    <TextField label="Cancel reason" value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} required />
                    <Button type="submit" variant="secondary" disabled={saving}>Cancel transfer</Button>
                  </form>
                ) : null}
              </>
            ) : <EmptyState title="No transfer selected" description="Select a draft, dispatched or received transfer." />}
          </Card>
        </div>
      </div>
    </div>
  );
}
