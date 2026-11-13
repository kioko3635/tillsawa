import { useEffect, useState } from 'react';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { AuditEvent } from '../../lib/api/types';

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.auditEvents().then((result) => {
      if (cancelled) return;
      setEvents(result.events);
      setLoading(false);
    }).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof ApiError ? err.message : 'Unable to load audit events.');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <Spinner label="Loading audit events" />;

  return (
    <div className="page-stack">
      <PageHeader title="Audit log" description="Security-sensitive operational actions recorded by the API." />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card title="Recent events" subtitle="Latest 200 organization events">
        {events.length === 0 ? <EmptyState title="No audit events" description="Security and administration events will appear here." /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Action</th><th>Entity</th><th>Actor</th><th>IP</th></tr></thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.createdAt).toLocaleString()}</td>
                    <td>
                      <strong>{event.action}</strong>
                      {typeof event.metadata.reason === 'string' ? <small className="table-subtext">{event.metadata.reason}</small> : null}
                    </td>
                    <td>{event.entityType}<small className="table-subtext">{event.entityId ?? '—'}</small></td>
                    <td><small className="table-subtext">{event.actorUserId ?? 'System'}</small></td>
                    <td>{event.ipAddress ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
