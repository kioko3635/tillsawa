import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { SessionRecord } from '../../lib/api/types';

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [sessionToRevoke, setSessionToRevoke] = useState<SessionRecord | null>(null);

  async function load() {
    const result = await api.sessions();
    setSessions(result.sessions);
  }

  useEffect(() => {
    let cancelled = false;
    load().then(() => !cancelled && setLoading(false)).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof ApiError ? err.message : 'Unable to load sessions.');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function revoke() {
    if (!sessionToRevoke) return;
    try {
      await api.revokeSession(sessionToRevoke.id);
      await load();
      setMessage('Session revoked.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to revoke session.');
    } finally {
      setSessionToRevoke(null);
    }
  }

  if (loading) return <Spinner label="Loading sessions" />;

  return (
    <div className="page-stack">
      <PageHeader title="Sessions" description="Review and revoke active authentication sessions." />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card title="Authentication sessions" subtitle={`${sessions.length} visible session${sessions.length === 1 ? '' : 's'}`}>
        {sessions.length === 0 ? <EmptyState title="No sessions" description="No visible authentication sessions were found." /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Status</th><th>IP</th><th>Last seen</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td><strong>{session.display_name}</strong><small className="table-subtext">{session.user_email}</small></td>
                    <td><Badge tone={session.status === 'active' ? 'success' : 'warning'}>{session.status}</Badge></td>
                    <td>{session.ip_address ?? 'Unknown'}</td>
                    <td>{new Date(session.last_seen_at).toLocaleString()}</td>
                    <td>{new Date(session.expires_at).toLocaleString()}</td>
                    <td className="table-actions">
                      {session.status === 'active' ? <Button variant="danger" onClick={() => setSessionToRevoke(session)}>Revoke</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={Boolean(sessionToRevoke)}
        title="Revoke session"
        description="The selected session and its refresh tokens will be revoked immediately."
        confirmLabel="Revoke session"
        danger
        onCancel={() => setSessionToRevoke(null)}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}
