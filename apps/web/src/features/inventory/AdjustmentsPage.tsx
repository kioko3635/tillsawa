import { unitLabel } from '@pos/contracts';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CheckboxField, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Product, StockAdjustment, UnitOfMeasure } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { InventoryNav } from './InventoryNav';

const initialForm = {
  branchId: '',
  type: 'opening',
  reason: '',
  productId: '',
  unitId: '',
  quantity: '',
  unitCost: '',
  allowNegative: false,
  negativeReason: ''
};

export function AdjustmentsPage() {
  const { bootstrap, hasPermission } = useAuth();
  const canAdjust = hasPermission('inventory.adjust');
  const canOverride = hasPermission('inventory.negative-override');
  const branches = useMemo(() => bootstrap?.branches ?? [], [bootstrap?.branches]);
  const [branchId, setBranchId] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [adjustments, setAdjustments] = useState<StockAdjustment[]>([]);
  const [selected, setSelected] = useState<StockAdjustment | null>(null);
  const [form, setForm] = useState(initialForm);
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
        const result = await api.adjustments(effectiveBranch);
        setAdjustments(result.adjustments);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load adjustments.');
    } finally {
      setLoading(false);
    }
  }, [branchId, branches]);

  useEffect(() => {
    void load();
  }, [load]);

  async function selectAdjustment(adjustment: StockAdjustment) {
    try {
      const result = await api.adjustment(adjustment.id);
      setSelected(result.adjustment);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load adjustment.');
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await api.createAdjustment({
        branchId: form.branchId,
        type: form.type as 'opening' | 'correction' | 'damage' | 'loss' | 'write_off',
        reason: form.reason,
        allowNegative: form.allowNegative,
        negativeReason: form.negativeReason || null,
        lines: [{
          productId: form.productId,
          unitId: form.unitId || undefined,
          quantity: form.quantity,
          unitCost: form.unitCost || undefined
        }]
      });
      setSelected(result.adjustment);
      setForm({ ...initialForm, branchId: form.branchId });
      await load(form.branchId);
      setMessage('Adjustment posted and ledger updated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to post adjustment.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner label="Loading adjustments" />;

  return (
    <div className="page-stack">
      <PageHeader title="Stock adjustments" description="Post opening stock, corrections, damage, loss and write-offs through the transactional ledger." />
      <InventoryNav />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!canAdjust ? <Alert tone="warning">You have read access but cannot post stock adjustments.</Alert> : null}

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Adjustment history" subtitle="Latest posted stock adjustments for the selected branch.">
          <SelectField label="Branch" value={branchId} onChange={(event) => {
            setBranchId(event.target.value);
            void load(event.target.value);
          }}>
            <option value="">Select branch</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </SelectField>
          {adjustments.length ? (
            <div className="list-stack">
              {adjustments.map((adjustment) => (
                <button className={`role-row ${selected?.id === adjustment.id ? 'role-row-selected' : ''}`} key={adjustment.id} onClick={() => void selectAdjustment(adjustment)}>
                  <span><strong>{adjustment.type}</strong><small>{adjustment.reason} · {new Date(adjustment.createdAt).toLocaleString()}</small></span>
                  <Badge tone={adjustment.negativeOverride ? 'danger' : 'success'}>{adjustment.negativeOverride ? 'Override' : 'Posted'}</Badge>
                </button>
              ))}
            </div>
          ) : <EmptyState title="No adjustments" description="Post the first opening stock or adjustment." />}
        </Card>

        <div className="page-stack">
          {canAdjust ? (
            <Card title="Post adjustment" subtitle="Negative stock is denied unless the signed-in user has the backend override permission.">
              <form className="form-stack" onSubmit={(event) => void submit(event)}>
                <div className="form-grid">
                  <SelectField label="Branch" value={form.branchId} onChange={(event) => setForm({ ...form, branchId: event.target.value })} required>
                    <option value="">Select branch</option>
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </SelectField>
                  <SelectField label="Type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} required>
                    <option value="opening">Opening stock</option>
                    <option value="correction">Correction</option>
                    <option value="damage">Damage</option>
                    <option value="loss">Loss</option>
                    <option value="write_off">Write-off</option>
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
                  <TextField label="Quantity" inputMode="decimal" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} hint="Use a negative quantity for damage, loss and write-off." required />
                  <TextField label="Unit cost" inputMode="decimal" value={form.unitCost} onChange={(event) => setForm({ ...form, unitCost: event.target.value })} hint="Optional; product cost is used for inbound stock." />
                </div>
                <TextField label="Reason" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} required />
                {canOverride ? (
                  <>
                    <CheckboxField label="Allow this operation to take stock below zero" checked={form.allowNegative} onChange={(checked) => setForm({ ...form, allowNegative: checked })} />
                    {form.allowNegative ? <TextField label="Negative-stock override reason" value={form.negativeReason} onChange={(event) => setForm({ ...form, negativeReason: event.target.value })} required /> : null}
                  </>
                ) : null}
                <Button type="submit" loading={saving}>Post adjustment</Button>
              </form>
            </Card>
          ) : null}

          <Card title="Selected adjustment" subtitle="Submitted unit and normalized base quantity are preserved for audit.">
            {selected?.lines?.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Product</th><th>Submitted qty</th><th>Base qty</th></tr></thead>
                  <tbody>{selected.lines.map((line) => <tr key={`${selected.id}-${line.productId}`}><td>{line.productName}<small className="table-subtext">{line.productSku}</small></td><td>{line.quantity}</td><td>{line.baseQuantity}</td></tr>)}</tbody>
                </table>
              </div>
            ) : <EmptyState title="No adjustment selected" description="Choose an adjustment to inspect its lines." />}
          </Card>
        </div>
      </div>
    </div>
  );
}
