import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api/client';
import type { SubscriptionStatus } from '../../lib/api/types';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '../../design-system/components';
import { useAuth } from '../../app/useAuth';
import { SubscriptionContext, useSubscription } from './subscription-context';

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const refresh = useCallback(async () => {
    try { setStatus(await api.subscriptionStatus()); setCheckedAt(Date.now()); } catch { /* Retain last checked status if the local server is temporarily unavailable. */ }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  return <SubscriptionContext.Provider value={{ status, refresh }}>
    {status && status.state !== 'disabled' && (status.state !== 'active' || (status.license?.expiresAt && Date.parse(status.license.expiresAt) - checkedAt < 7 * 86400000)) ? <Alert tone={status.canWrite ? 'warning' : 'danger'} title={status.canWrite ? 'Subscription renewal' : 'Activation required'}>{status.message} <Link to="/settings/subscription">Open subscription</Link></Alert> : null}
    {children}
  </SubscriptionContext.Provider>;
}
function date(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }) : '—';
}
export function SubscriptionPage() {
  const { hasPermission } = useAuth();
  const { status, refresh } = useSubscription();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const canManage = hasPermission('settings.manage');
  async function download() {
    setBusy(true); setError('');
    try {
      const request = await api.activationRequest();
      const url = URL.createObjectURL(new Blob([JSON.stringify(request, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'TillSawa-activation-request.json'; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setMessage('Send the downloaded activation request to your POS provider. It contains shop and installation identifiers, not your sales records or passwords.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to download activation request.'); }
    finally { setBusy(false); }
  }
  async function importFile(file?: File) {
    if (!file) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (file.size > 16000) throw new Error('Select the small licence file supplied by your POS provider.');
      await api.importLicense(JSON.parse(await file.text()));
      await refresh(); setMessage('Licence activated. You can continue using your shop without internet.');
    } catch (err) { setError(err instanceof SyntaxError ? 'This is not a valid licence file.' : err instanceof Error ? err.message : 'Unable to import licence.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return <div className="page-stack">
    <PageHeader title="Subscription" description="Activate this computer or renew your subscription using a licence file from your POS provider." />
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {message ? <Alert tone="success">{message}</Alert> : null}
    {!status ? <><Spinner label="Checking local licence" /><Button onClick={() => void refresh()}>Check again</Button></> : <>
      <Card title="Your subscription" actions={<Badge tone={status.canWrite ? 'success' : 'warning'}>{status.state.replaceAll('_', ' ')}</Badge>}>
        <p>{status.message}</p>
        <dl className="subscription-details"><div><dt>Plan</dt><dd>{status.license?.plan ?? 'Awaiting activation'}</dd></div><div><dt>Paid access ends</dt><dd>{status.license?.lifetime ? 'Lifetime — no expiry' : date(status.license?.expiresAt)}</dd></div><div><dt>Grace period ends</dt><dd>{date(status.graceEndsAt)}</dd></div><div><dt>Active user accounts (owner included)</dt><dd>{status.activeUsers ?? '—'} / {status.license ? status.license.maxUsers ?? 'Unlimited' : 'Not licensed'}</dd></div><div><dt>This computer’s installation code</dt><dd>{status.installationCode ?? 'Development instance'}</dd></div></dl>
      </Card>
      {status.state !== 'disabled' && canManage ? <Card title="Activate or renew" subtitle="You do not need to type an installation code. Exchange these two small files with your provider.">
        <ol className="subscription-steps"><li><strong>Download your activation request.</strong><p>Send this file to your POS provider and confirm your subscription payment with them.</p><Button disabled={busy} variant="secondary" onClick={() => void download()}>Download activation request</Button></li><li><strong>Import the licence they send back.</strong><p>Choose the licence file to activate this shop. The file also works when you have no internet.</p><input hidden ref={input} type="file" accept=".json,.poslicense" onChange={event => void importFile(event.target.files?.[0])} /><Button loading={busy} onClick={() => input.current?.click()}>Import licence file</Button></li></ol>
      </Card> : !canManage ? <Alert tone="info">Ask your shop owner or administrator to download an activation request or import a renewal.</Alert> : null}
      <Card title="Your records stay with you"><p>When a subscription expires, reports, existing receipts and backups stay accessible. New business changes and sales require an active licence or grace period. Correct date and time are required on this computer.</p></Card>
    </>}
  </div>;
}
