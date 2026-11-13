import { useState } from 'react';
import { Alert, Button, Card, TextField } from '../../design-system/components';
import { api } from '../../lib/api/client';

export function StaffPasswordReset({ membershipId, name }: { membershipId: string; name: string }) {
  const [currentPassword, setCurrentPassword] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function reset() {
    setError(''); setMessage('');
    if (!password || password !== confirm) { setError('Enter matching new staff passwords.'); return; }
    setBusy(true);
    try { await api.resetStaffPassword({ membershipId, currentPassword, password }); setMessage('Staff password reset. Their old sessions have been signed out. Share the new password privately.'); setCurrentPassword(''); setPassword(''); setConfirm(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not reset password.'); } finally { setBusy(false); }
  }
  return <Card title={`Reset password for ${name}`} subtitle="Owner authorization is required. This does not change the staff member's roles or stock/sales history.">
    {message ? <Alert tone="success">{message}</Alert> : null}{error ? <Alert tone="danger">{error}</Alert> : null}
    <div className="form-stack"><TextField label="Owner current password" type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /><TextField label="New staff password" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /><TextField label="Confirm staff password" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /><Button loading={busy} onClick={() => void reset()}>Reset staff password</Button></div>
  </Card>;
}
