import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Device, SyncState } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { saveDeviceIdentity } from '../../lib/offline/db';

export function DevicesPage() {
  const { bootstrap, hasPermission } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [deviceKey, setDeviceKey] = useState('');
  const [form, setForm] = useState({ name: '', branchId: bootstrap?.branches[0]?.id ?? '', platform: 'web-pwa' });
  const canRegister = hasPermission('device.register');
  const canRevoke = hasPermission('device.revoke');

  async function load() {
    const result = await api.devices();
    setDevices(result.devices);
  }

  useEffect(() => {
    let cancelled = false;
    load().then(() => !cancelled && setLoading(false)).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof ApiError ? err.message : 'Unable to load devices.');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    setDeviceKey('');
    try {
      const result = await api.registerDevice(form);
      setDeviceKey(result.deviceKey);
      await saveDeviceIdentity({
        key: 'current',
        deviceId: result.device.id,
        organizationId: bootstrap?.organization.id ?? '',
        branchId: result.device.branchId,
        deviceKey: result.deviceKey,
        deviceName: result.device.name
      });
      await load();
      setMessage('Device registered. Store the shown device key securely; it will not be displayed again.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to register device.');
    }
  }

  async function inspectSync(device: Device) {
    try {
      const result = await api.syncState(device.id);
      setSyncStates((current) => ({ ...current, [device.id]: result.sync }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load sync state.');
    }
  }

  async function setStatus(device: Device, status: 'active' | 'suspended' | 'revoked') {
    try {
      await api.updateDevice(device.id, { status });
      await load();
      setMessage(`Device marked ${status}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update device.');
    }
  }

  if (loading) return <Spinner label="Loading devices" />;

  return (
    <div className="page-stack">
      <PageHeader title="Registered devices" description="Device registration and versioned synchronization foundation." />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {deviceKey ? <Alert tone="warning" title="Device key">{deviceKey}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {canRegister ? (
        <Card title="Register device" subtitle="Device keys are hashed on the server and shown once.">
          <form className="inline-form" onSubmit={(event) => void submit(event)}>
            <TextField label="Device name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Front Counter POS" required />
            <SelectField label="Branch" value={form.branchId} onChange={(event) => setForm({ ...form, branchId: event.target.value })} required>
              {bootstrap?.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </SelectField>
            <TextField label="Platform" value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value })} />
            <Button type="submit">Register</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Devices" subtitle={`${devices.length} registered device${devices.length === 1 ? '' : 's'}`}>
        {devices.length === 0 ? <EmptyState title="No devices" description="Register the first POS-capable device." /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Branch</th><th>Status</th><th>Contract</th><th>Last sync</th><th /></tr></thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td><strong>{device.name}</strong><small className="table-subtext">{device.platform ?? 'Unknown platform'}</small></td>
                    <td>{device.branchName}</td>
                    <td><Badge tone={device.status === 'active' ? 'success' : device.status === 'suspended' ? 'warning' : 'danger'}>{device.status}</Badge></td>
                    <td>v{device.contractVersion}</td>
                    <td>{device.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString() : 'Never'}</td>
                    <td className="table-actions">
                      <Button variant="secondary" onClick={() => void inspectSync(device)}>Sync state</Button>
                      {canRevoke && device.status === 'active' ? <Button variant="secondary" onClick={() => void setStatus(device, 'suspended')}>Suspend</Button> : null}
                      {canRevoke && device.status !== 'revoked' ? <Button variant="danger" onClick={() => void setStatus(device, 'revoked')}>Revoke</Button> : null}
                      {canRevoke && device.status !== 'active' ? <Button variant="secondary" onClick={() => void setStatus(device, 'active')}>Activate</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {Object.keys(syncStates).length > 0 ? (
          <div className="sync-panel">
            {Object.entries(syncStates).map(([deviceId, state]) => (
              <div key={deviceId}>
                <strong>{devices.find((device) => device.id === deviceId)?.name ?? deviceId}</strong>
                <span>Contract v{state.contractVersion}; server time {new Date(state.serverTime).toLocaleString()}; {state.cursors.length} cursor(s)</span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
