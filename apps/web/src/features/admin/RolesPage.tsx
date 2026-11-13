import { useEffect, useState, type FormEvent } from 'react';
import type { PermissionCode } from '@pos/contracts';
import { Alert, Badge, Button, Card, CheckboxField, EmptyState, PageHeader, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Role } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';

function togglePermission(current: PermissionCode[], code: PermissionCode, checked: boolean): PermissionCode[] {
  return checked ? [...new Set([...current, code])] : current.filter((item) => item !== code);
}

export function RolesPage() {
  const { hasPermission } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<PermissionCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', description: '', permissionCodes: [] as PermissionCode[] });
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [editedPermissions, setEditedPermissions] = useState<PermissionCode[]>([]);
  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? null;
  const canManage = hasPermission('role.manage');

  async function load() {
    const [roleResult, permissionResult] = await Promise.all([api.roles(), api.permissions()]);
    setRoles(roleResult.roles);
    setPermissions(permissionResult.permissions as PermissionCode[]);
  }

  useEffect(() => {
    let cancelled = false;
    load().then(() => !cancelled && setLoading(false)).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof ApiError ? err.message : 'Unable to load roles.');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setEditedPermissions((selectedRole?.permissionCodes ?? []) as PermissionCode[]);
  }, [selectedRole]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api.createRole({
        code: form.code,
        name: form.name,
        description: form.description || undefined,
        permissionCodes: form.permissionCodes
      });
      setForm({ code: '', name: '', description: '', permissionCodes: [] });
      await load();
      setMessage('Role created.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create role.');
    } finally {
      setSaving(false);
    }
  }

  async function savePermissions() {
    if (!selectedRole) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api.updateRole(selectedRole.id, { permissionCodes: editedPermissions });
      await load();
      setMessage('Role permissions saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to save role permissions.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner label="Loading roles" />;

  return (
    <div className="page-stack">
      <PageHeader title="Roles and permissions" description="Control granular access. Backend authorization still enforces every permission." />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Roles" subtitle={`${roles.length} roles`}>
          {roles.length === 0 ? <EmptyState title="No roles" description="Create the first organization role." /> : (
            <div className="list-stack">
              {roles.map((role) => (
                <button key={role.id} type="button" className={`role-row ${selectedRoleId === role.id ? 'role-row-selected' : ''}`} onClick={() => setSelectedRoleId(role.id)}>
                  <span><strong>{role.name}</strong><small>{role.code}</small></span>
                  <Badge tone={role.isSystem ? 'info' : 'neutral'}>{role.isSystem ? 'Default' : 'Custom'}</Badge>
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card title="Role permissions" subtitle={selectedRole ? selectedRole.name : 'Select a role'}>
          {!selectedRole ? <EmptyState title="No role selected" description="Select a role to inspect or update its permission set." /> : (
            <div className="permission-grid">
              {permissions.map((permission) => (
                <CheckboxField
                  key={permission}
                  label={permission}
                  checked={editedPermissions.includes(permission)}
                  disabled={!canManage || selectedRole.code === 'owner'}
                  onChange={(checked) => setEditedPermissions((current) => togglePermission(current, permission, checked))}
                />
              ))}
              {selectedRole.code === 'owner' ? <Alert tone="info">Owner permissions are locked to prevent accidental lockout.</Alert> : null}
              {canManage && selectedRole.code !== 'owner' ? <Button onClick={() => void savePermissions()} loading={saving}>Save permissions</Button> : null}
            </div>
          )}
        </Card>
      </div>
      {canManage ? (
        <Card title="Create role" subtitle="Custom roles can combine any available permission codes.">
          <form className="form-stack" onSubmit={(event) => void submit(event)}>
            <div className="form-grid">
              <TextField label="Role code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toLowerCase() })} required />
              <TextField label="Role name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
              <TextField label="Description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </div>
            <div className="permission-grid">
              {permissions.map((permission) => (
                <CheckboxField key={permission} label={permission} checked={form.permissionCodes.includes(permission)} onChange={(checked) => setForm({ ...form, permissionCodes: togglePermission(form.permissionCodes, permission, checked) })} />
              ))}
            </div>
            <Button type="submit" loading={saving}>Create role</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
