import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Organization } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';

export function OrganizationPage() {
  const { bootstrap, reload, hasPermission } = useAuth();
  const [organization, setOrganization] = useState<Organization | null>(bootstrap?.organization ?? null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const canEdit = hasPermission('organization.update');

  useEffect(() => {
    setOrganization(bootstrap?.organization ?? null);
  }, [bootstrap]);

  if (!organization) return <Spinner label="Loading organization" />;

  function update(field: keyof Organization, value: string) {
    setOrganization((current) => current ? { ...current, [field]: value } : current);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!organization) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await api.updateOrganization({
        legalName: organization.legalName,
        displayName: organization.displayName,
        currencyCode: organization.currencyCode,
        timezone: organization.timezone,
        taxPricingMode: organization.taxPricingMode
      });
      setOrganization(result.organization);
      await reload();
      setMessage('Organization settings saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to save organization settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="Organization" description="Business identity, currency, timezone and tax pricing defaults." />
      <Card title="Business type" subtitle={organization.businessProfile === 'wines_spirits' ? 'Wines & spirits / liquor store' : 'Choose the industry that matches your shop.'}>
        <div className="table-actions"><Link to="/settings/configuration">Choose or change business type</Link>{hasPermission('catalog.manage') ? <Link to="/catalogue">Choose products and services</Link> : null}</div>
      </Card>
      {message ? <Alert tone="success">{message}</Alert> : null}
      {hasPermission('settings.manage') ? <Card title="Receipt studio" subtitle="Design your receipt with your own logo, paper size, layout and contact details."><Link to="/settings/configuration#receipt-studio">Design my receipt</Link></Card> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card title="Business settings">
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <div className="form-grid">
            <TextField label="Legal name" value={organization.legalName} onChange={(event) => update('legalName', event.target.value)} disabled={!canEdit} required />
            <TextField label="Display name" value={organization.displayName} onChange={(event) => update('displayName', event.target.value)} disabled={!canEdit} required />
            <TextField label="Currency" value={organization.currencyCode} onChange={(event) => update('currencyCode', event.target.value.toUpperCase())} disabled={!canEdit} maxLength={3} required />
            <TextField label="Time zone" value={organization.timezone} onChange={(event) => update('timezone', event.target.value)} disabled={!canEdit} required />
            <SelectField label="Tax pricing" value={organization.taxPricingMode} onChange={(event) => update('taxPricingMode', event.target.value)} disabled={!canEdit}>
              <option value="inclusive">Tax-inclusive</option>
              <option value="exclusive">Tax-exclusive</option>
            </SelectField>
          </div>
          {canEdit ? <Button type="submit" loading={saving}>Save settings</Button> : <Alert tone="info">You have read-only access to organization settings.</Alert>}
        </form>
      </Card>
    </div>
  );
}
