import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CheckboxField, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { StockCount } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { InventoryNav } from './InventoryNav';

export function CountsPage() {
  const { bootstrap, hasPermission } = useAuth();
  const canCount = hasPermission('inventory.count');
  const canApprove = hasPermission('inventory.count-approve');
  const canOverride = hasPermission('inventory.negative-override');
  const branches = useMemo(() => bootstrap?.branches ?? [], [bootstrap?.branches]);
  const [branchId, setBranchId] = useState('');
  const [counts, setCounts] = useState<StockCount[]>([]);
  const [selected, setSelected] = useState<StockCount | null>(null);
  const [name, setName] = useState('');
  const [lineForm, setLineForm] = useState({ productId: '', countedQty: '' });
  const [decisionReason, setDecisionReason] = useState('');
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
      const effectiveBranch = nextBranch || branches[0]?.id || '';
      if (effectiveBranch) {
        setBranchId(effectiveBranch);
        const result = await api.stockCounts(effectiveBranch);
        setCounts(result.counts);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load stock counts.');
    } finally {
      setLoading(false);
    }
  }, [branchId, branches]);

  useEffect(() => {
    void load();
  }, [load]);

  async function selectCount(count: StockCount) {
    try {
      const result = await api.stockCount(count.id);
      setSelected(result.count);
      if (!lineForm.productId) setLineForm((current) => ({ ...current, productId: result.count.lines?.[0]?.productId ?? '' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load count.');
    }
  }

  async function createCount(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const result = await api.createStockCount({ branchId, name: name || undefined });
      setName('');
      setSelected(result.count);
      await load(branchId);
      setMessage('Stock count created from expected branch balances.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create stock count.');
    } finally {
      setSaving(false);
    }
  }

  async function recordLine(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.recordStockCountLines(selected.id, {
        lines: [{ productId: lineForm.productId, countedQty: lineForm.countedQty }]
      });
      setSelected(result.count);
      setLineForm({ productId: lineForm.productId, countedQty: '' });
      setMessage('Counted quantity recorded.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to record counted quantity.');
    } finally {
      setSaving(false);
    }
  }

  async function submitCount() {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.submitStockCount(selected.id);
      setSelected(result.count);
      await load(branchId);
      setMessage('Stock count submitted for variance approval.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to submit count.');
    } finally {
      setSaving(false);
    }
  }

  async function decide(decision: 'approved' | 'rejected') {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.decideStockCount(selected.id, {
        decision,
        reason: decisionReason || null,
        allowNegative,
        negativeReason: negativeReason || null
      });
      setSelected(result.count);
      setDecisionReason('');
      setAllowNegative(false);
      setNegativeReason('');
      await load(branchId);
      setMessage(`Stock count ${decision}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to decide count.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner label="Loading stock counts" />;

  return (
    <div className="page-stack">
      <PageHeader title="Stock counts" description="Capture counted quantities, submit variances and approve ledger corrections." />
      <InventoryNav />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!canCount ? <Alert tone="warning">You can view counts but cannot create or update count lines.</Alert> : null}

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Counts" subtitle="Expected quantities are snapshotted when the count is created.">
          <SelectField label="Branch" value={branchId} onChange={(event) => {
            setBranchId(event.target.value);
            setSelected(null);
            void load(event.target.value);
          }}>
            <option value="">Select branch</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </SelectField>
          {canCount ? (
            <form className="inline-form" onSubmit={(event) => void createCount(event)}>
              <TextField label="Count name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Cycle count" />
              <Button type="submit" loading={saving} disabled={!branchId}>Create count</Button>
            </form>
          ) : null}
          {counts.length ? (
            <div className="list-stack">
              {counts.map((count) => (
                <button className={`role-row ${selected?.id === count.id ? 'role-row-selected' : ''}`} key={count.id} onClick={() => void selectCount(count)}>
                  <span><strong>{count.name ?? 'Stock count'}</strong><small>{new Date(count.createdAt).toLocaleString()} · {count.lineCount ?? 0} lines</small></span>
                  <Badge tone={count.status === 'approved' ? 'success' : count.status === 'submitted' ? 'warning' : 'info'}>{count.status}</Badge>
                </button>
              ))}
            </div>
          ) : <EmptyState title="No counts" description="Create a branch stock count." />}
        </Card>

        <div className="page-stack">
          <Card title={selected?.name ?? 'Count details'} subtitle="Expected vs counted quantities and variance.">
            {selected?.lines?.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Product</th><th>Expected</th><th>Counted</th><th>Variance</th></tr></thead>
                  <tbody>
                    {selected.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.productName}<small className="table-subtext">{line.productSku}</small></td>
                        <td>{line.expectedQty}</td>
                        <td>{line.countedQty ?? '—'}</td>
                        <td><Badge tone={Number(line.varianceQty ?? 0) === 0 ? 'success' : 'warning'}>{line.varianceQty ?? '—'}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="No count selected" description="Select a stock count to inspect its lines." />}
          </Card>

          {selected?.status === 'draft' && canCount ? (
            <Card title="Record count" subtitle="Enter physical counted quantities, then submit for approval.">
              <form className="inline-form" onSubmit={(event) => void recordLine(event)}>
                <SelectField label="Product" value={lineForm.productId} onChange={(event) => setLineForm({ ...lineForm, productId: event.target.value })} required>
                  <option value="">Select product</option>
                  {selected.lines?.map((line) => <option key={line.productId} value={line.productId}>{line.productSku} — {line.productName}</option>)}
                </SelectField>
                <TextField label="Counted quantity" inputMode="decimal" value={lineForm.countedQty} onChange={(event) => setLineForm({ ...lineForm, countedQty: event.target.value })} required />
                <Button type="submit" loading={saving}>Record</Button>
              </form>
              <Button onClick={() => void submitCount()} disabled={saving}>Submit for approval</Button>
            </Card>
          ) : null}

          {selected?.status === 'submitted' ? (
            <Card title="Variance approval" subtitle="Approval posts compensating stock movements; rejection leaves balances unchanged.">
              {canApprove ? (
                <div className="form-stack">
                  <TextField label="Decision reason" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} />
                  {canOverride ? (
                    <>
                      <CheckboxField label="Allow negative stock from this variance" checked={allowNegative} onChange={setAllowNegative} />
                      {allowNegative ? <TextField label="Negative-stock reason" value={negativeReason} onChange={(event) => setNegativeReason(event.target.value)} required /> : null}
                    </>
                  ) : null}
                  <div className="table-actions">
                    <Button onClick={() => void decide('approved')} loading={saving}>Approve variance</Button>
                    <Button variant="secondary" onClick={() => void decide('rejected')} disabled={saving}>Reject</Button>
                  </div>
                </div>
              ) : <Alert tone="warning">This count is waiting for a user with the count approval permission.</Alert>}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
