import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Branch } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';

export function BranchesPage() {
  const { bootstrap, membership, reload, hasPermission } = useAuth();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [branchToToggle, setBranchToToggle] = useState<Branch | null>(null);
  const canCreate = hasPermission('branch.create') && (membership?.allBranches ?? false);
  const canUpdate = hasPermission('branch.update');
  const branches = bootstrap?.branches ?? [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api.createBranch({ code: code.toUpperCase(), name });
      setCode('');
      setName('');
      await reload();
      setMessage('Branch created.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create branch.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleBranch() {
    if (!branchToToggle) return;
    const nextStatus = branchToToggle.status === 'active' ? 'inactive' : 'active';
    try {
      await api.updateBranch(branchToToggle.id, { status: nextStatus });
      await reload();
      setMessage(`Branch ${nextStatus === 'active' ? 'activated' : 'deactivated'}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update branch.');
    } finally {
      setBranchToToggle(null);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="Branches" description="Create and manage branch access points." />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {canCreate ? (
        <Card title="New branch" subtitle="Branch codes are unique within the organization.">
          <form className="inline-form" onSubmit={(event) => void submit(event)}>
            <TextField label="Code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="CBD" required />
            <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Nairobi CBD" required />
            <Button type="submit" loading={saving}>Create branch</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Accessible branches" subtitle={`${branches.length} branch${branches.length === 1 ? '' : 'es'}`}>
        {branches.length === 0 ? (
          <EmptyState title="No branches accessible" description="Ask an administrator to grant branch access." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Currency</th><th>Timezone</th><th /></tr></thead>
              <tbody>
                {branches.map((branch) => (
                  <tr key={branch.id}>
                    <td><strong>{branch.code}</strong></td>
                    <td>{branch.name}</td>
                    <td><Badge tone={branch.status === 'active' ? 'success' : 'warning'}>{branch.status}</Badge></td>
                    <td>{branch.currencyCode ?? bootstrap?.organization.currencyCode ?? 'KES'}</td>
                    <td>{branch.timezone ?? bootstrap?.organization.timezone ?? 'Africa/Nairobi'}</td>
                    <td className="table-actions">
                      {canUpdate ? <Button variant="secondary" onClick={() => setBranchToToggle(branch)}>{branch.status === 'active' ? 'Deactivate' : 'Activate'}</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={Boolean(branchToToggle)}
        title={`${branchToToggle?.status === 'active' ? 'Deactivate' : 'Activate'} branch`}
        description={`${branchToToggle?.name ?? 'This branch'} will ${branchToToggle?.status === 'active' ? 'stop accepting new operational work' : 'be available for authorized users'} until changed again.`}
        confirmLabel={branchToToggle?.status === 'active' ? 'Deactivate' : 'Activate'}
        danger={branchToToggle?.status === 'active'}
        onCancel={() => setBranchToToggle(null)}
        onConfirm={() => void toggleBranch()}
      />
    </div>
  );
}
