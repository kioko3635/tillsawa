import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CheckboxField, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Membership, Role } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { StaffPasswordReset } from './StaffPasswordReset';

function selectedValues(event: ChangeEvent<HTMLSelectElement>): string[] {
  return [...event.target.selectedOptions].map((option) => option.value);
}

export function UsersPage() {
  const { bootstrap, membership: currentMembership, hasPermission } = useAuth();
  const [users, setUsers] = useState<Membership[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [createForm, setCreateForm] = useState({
    email: '',
    displayName: '',
    temporaryPassword: '',
    title: '',
    allBranches: false,
    roleIds: [] as string[],
    branchIds: [] as string[]
  });
  const [selectedId, setSelectedId] = useState('');
  const selectedUser = useMemo(() => users.find((user) => user.id === selectedId) ?? null, [users, selectedId]);
  const [accessForm, setAccessForm] = useState({ allBranches: false, roleIds: [] as string[], branchIds: [] as string[] });
  const canInvite = hasPermission('user.invite');
  const canUpdate = hasPermission('user.update');
  const canDeactivate = hasPermission('user.deactivate');
  const canAssignAllBranches = currentMembership?.allBranches ?? false;
  const branches = bootstrap?.branches ?? [];

  async function load() {
    const [userResult, roleResult] = await Promise.all([api.users(), api.roles()]);
    setUsers(userResult.users);
    setRoles(roleResult.roles);
  }

  useEffect(() => {
    let cancelled = false;
    load().then(() => !cancelled && setLoading(false)).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof ApiError ? err.message : 'Unable to load users.');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedUser) return;
    setAccessForm({
      allBranches: selectedUser.allBranches,
      roleIds: selectedUser.roles.map((role) => role.id),
      branchIds: selectedUser.branchIds
    });
  }, [selectedUser]);

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api.createUser({
        email: createForm.email,
        displayName: createForm.displayName,
        temporaryPassword: createForm.temporaryPassword || undefined,
        title: createForm.title || undefined,
        allBranches: createForm.allBranches,
        roleIds: createForm.roleIds,
        branchIds: createForm.allBranches ? [] : createForm.branchIds
      });
      setCreateForm({ email: '', displayName: '', temporaryPassword: '', title: '', allBranches: false, roleIds: [], branchIds: [] });
      await load();
      setMessage('Team member added.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to add team member.');
    } finally {
      setSaving(false);
    }
  }

  async function saveAccess() {
    if (!selectedUser) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api.updateMembership(selectedUser.id, accessForm);
      await load();
      setMessage('Access updated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update access.');
    } finally {
      setSaving(false);
    }
  }

  async function setUserStatus(user: Membership, status: 'active' | 'suspended') {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api.updateMembership(user.id, { status });
      await load();
      setMessage(`User ${status === 'active' ? 'reactivated' : 'suspended'}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update user status.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner label="Loading team" />;

  return (
    <div className="page-stack">
      <PageHeader title="Users" description="Create memberships and assign roles and branch access." />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {canInvite ? (
        <Card title="Add team member" subtitle="Create a staff membership with a temporary password and explicit access assignment.">
          <form className="form-stack" onSubmit={(event) => void submitCreate(event)}>
            <div className="form-grid">
              <TextField label="Full name" value={createForm.displayName} onChange={(event) => setCreateForm({ ...createForm, displayName: event.target.value })} required />
              <TextField label="Email" type="email" value={createForm.email} onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })} required />
              <TextField label="Temporary password" type="password" value={createForm.temporaryPassword} onChange={(event) => setCreateForm({ ...createForm, temporaryPassword: event.target.value })} hint="Required only for a new user" />
              <TextField label="Job title" value={createForm.title} onChange={(event) => setCreateForm({ ...createForm, title: event.target.value })} />
              <SelectField label="Roles" multiple value={createForm.roleIds} onChange={(event) => setCreateForm({ ...createForm, roleIds: selectedValues(event) })} required>
                {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
              </SelectField>
              <SelectField label="Branches" multiple value={createForm.branchIds} onChange={(event) => setCreateForm({ ...createForm, branchIds: selectedValues(event) })} disabled={createForm.allBranches} required={!createForm.allBranches}>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </SelectField>
            </div>
            <CheckboxField label="Allow access to all branches" checked={createForm.allBranches} disabled={!canAssignAllBranches} onChange={(checked) => setCreateForm({ ...createForm, allBranches: checked })} />
            <Button type="submit" loading={saving}>Add member</Button>
          </form>
        </Card>
      ) : null}
      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Team members" subtitle={`${users.length} membership${users.length === 1 ? '' : 's'}`}>
          {users.length === 0 ? <EmptyState title="No team members" description="Create the first staff membership." /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Branches</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className={selectedId === user.id ? 'row-selected' : ''}>
                      <td><strong>{user.displayName}</strong><small className="table-subtext">{user.title ?? 'Staff'}</small></td>
                      <td>{user.email}</td>
                      <td>{user.roles.map((role) => role.name).join(', ')}</td>
                      <td>{user.allBranches ? 'All branches' : `${user.branchIds.length} selected`}</td>
                      <td><Badge tone={user.status === 'active' ? 'success' : 'warning'}>{user.status}</Badge></td>
                      <td className="table-actions">
                        <Button variant="secondary" onClick={() => setSelectedId(user.id)}>Access</Button>
                        {canDeactivate && user.id !== currentMembership?.id ? (
                          <Button variant={user.status === 'active' ? 'danger' : 'secondary'} onClick={() => void setUserStatus(user, user.status === 'active' ? 'suspended' : 'active')}>
                            {user.status === 'active' ? 'Suspend' : 'Activate'}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Access editor" subtitle={selectedUser ? selectedUser.displayName : 'Select a team member'}>
          {!selectedUser ? <EmptyState title="No member selected" description="Choose Access on a member to change roles and branch restrictions." /> : (
            <div className="form-stack">
              <SelectField label="Roles" multiple value={accessForm.roleIds} onChange={(event) => setAccessForm({ ...accessForm, roleIds: selectedValues(event) })} disabled={!canUpdate || selectedUser.id === currentMembership?.id}>
                {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
              </SelectField>
              <SelectField label="Branches" multiple value={accessForm.branchIds} onChange={(event) => setAccessForm({ ...accessForm, branchIds: selectedValues(event) })} disabled={!canUpdate || accessForm.allBranches || selectedUser.id === currentMembership?.id}>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </SelectField>
              <CheckboxField label="Allow access to all branches" checked={accessForm.allBranches} disabled={!canUpdate || !canAssignAllBranches || selectedUser.id === currentMembership?.id} onChange={(checked) => setAccessForm({ ...accessForm, allBranches: checked })} />
              {selectedUser.id === currentMembership?.id ? <Alert tone="info">You cannot change your own access from this screen.</Alert> : null}
              <Button onClick={() => void saveAccess()} loading={saving} disabled={!canUpdate || selectedUser.id === currentMembership?.id}>Save access</Button>
              {users.find(user => user.id === currentMembership?.id)?.roles.some(role => role.code === 'owner') && selectedUser.id !== currentMembership?.id && !selectedUser.roles.some(role => role.code === 'owner') ? <StaffPasswordReset key={selectedUser.id} membershipId={selectedUser.id} name={selectedUser.displayName} /> : null}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
