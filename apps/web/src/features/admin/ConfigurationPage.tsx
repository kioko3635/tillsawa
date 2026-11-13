import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { BusinessProfileCode, UpdateOrganizationConfigurationInput } from '@pos/contracts';
import { Alert, Badge, Button, Card, CheckboxField, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { ModuleCatalogEntry, OrganizationConfiguration } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { LoyaltySettingsCard } from './LoyaltySettingsCard';
import { EtimsReadinessCard } from './EtimsReadinessCard';
import { receiptDesign, type ReceiptDesign } from '@pos/contracts';
import { ReceiptDesigner } from './ReceiptDesigner';
import { PeripheralSettingsCard } from './PeripheralSettingsCard';

interface ConfigForm {
  businessProfile: string;
  applyProfilePreset: boolean;
  defaultBranchId: string;
  contactPhone: string;
  contactEmail: string;
  businessAddress: string;
  taxPin: string;
  receiptHeader: string;
  receiptFooter: string;
  receiptLogoUrl: string;
  receiptDesign: ReceiptDesign;
  cashDrawerPolicy: 'cash' | 'paid';
  modules: Record<string, boolean>;
  capabilities: Record<string, boolean>;
  changeReason: string;
}

function toForm(configuration: OrganizationConfiguration): ConfigForm {
  const organization = configuration.organization;
  return {
    businessProfile: organization.businessProfile ?? 'general_retail',
    applyProfilePreset: false,
    defaultBranchId: organization.defaultBranchId ?? '',
    contactPhone: organization.contactPhone ?? '',
    contactEmail: organization.contactEmail ?? '',
    businessAddress: organization.businessAddress ?? '',
    taxPin: organization.taxPin ?? '',
    receiptHeader: organization.receiptHeader ?? '',
    receiptFooter: organization.receiptFooter ?? '',
    receiptLogoUrl: organization.receiptLogoUrl ?? '',
    receiptDesign: receiptDesign(organization.receiptDesign),
    cashDrawerPolicy: organization.cashDrawerPolicy ?? 'cash',
    modules: Object.fromEntries(configuration.modules
      .filter((entry) => entry.kind === 'module' && entry.configurable)
      .map((entry) => [entry.code, entry.enabled])),
    capabilities: Object.fromEntries(configuration.modules
      .filter((entry) => entry.kind === 'capability' && entry.configurable)
      .map((entry) => [entry.code, entry.enabled])),
    changeReason: ''
  };
}

function applyPreset(form: ConfigForm, configuration: OrganizationConfiguration): ConfigForm {
  const profile = configuration.profiles.find((item) => item.code === form.businessProfile);
  if (!profile) return form;
  return {
    ...form,
    applyProfilePreset: true,
    modules: Object.fromEntries(Object.keys(form.modules).map((code) => [code, profile.recommendedModules.includes(code)])),
    capabilities: Object.fromEntries(Object.keys(form.capabilities).map((code) => [code, profile.recommendedCapabilities.includes(code)]))
  };
}

export function ConfigurationPage() {
  const { bootstrap, reload, hasPermission } = useAuth();
  const [configuration, setConfiguration] = useState<OrganizationConfiguration | null>(null);
  const [form, setForm] = useState<ConfigForm | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const canEdit = hasPermission('settings.manage');

  useEffect(() => {
    void api.organizationConfiguration().then((result) => {
      setConfiguration(result.configuration);
      setForm(toForm(result.configuration));
    }).catch((err) => setError(err instanceof ApiError ? err.message : 'Unable to load business configuration.'));
  }, []);

  const moduleEntries = useMemo(() => ({
    core: configuration?.modules.filter((entry) => entry.kind === 'module' && entry.core) ?? [],
    configurable: configuration?.modules.filter((entry) => entry.kind === 'module' && entry.configurable) ?? [],
    capabilities: configuration?.modules.filter((entry) => entry.kind === 'capability' && entry.configurable) ?? [],
    planned: configuration?.modules.filter((entry) => entry.availability === 'planned') ?? []
  }), [configuration]);

  const activeProfile = configuration?.profiles.find((profile) => profile.code === form?.businessProfile);
  if (!configuration || !form) return <Spinner label="Loading business configuration" />;

  const structuralChange = form.businessProfile !== (configuration.organization.businessProfile ?? 'general_retail')
    || Object.entries(form.modules).some(([code, enabled]) => moduleEntries.configurable.find((entry) => entry.code === code)?.enabled !== enabled)
    || Object.entries(form.capabilities).some(([code, enabled]) => moduleEntries.capabilities.find((entry) => entry.code === code)?.enabled !== enabled);

  function update(field: keyof ConfigForm, value: string | boolean) {
    setForm((current) => {
      if (!current) return current;
      const next = { ...current, [field]: value };
      return field === 'businessProfile' ? applyPreset(next, configuration!) : next;
    });
  }

  function toggleModule(code: string, enabled: boolean) {
    setForm((current) => current ? {
      ...current,
      applyProfilePreset: false,
      modules: { ...current.modules, [code]: enabled }
    } : current);
  }

  function toggleCapability(code: string, enabled: boolean) {
    setForm((current) => current ? {
      ...current,
      applyProfilePreset: false,
      capabilities: { ...current.capabilities, [code]: enabled }
    } : current);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const input: UpdateOrganizationConfigurationInput = {
        businessProfile: form.businessProfile as BusinessProfileCode,
        defaultBranchId: form.defaultBranchId || null,
        contactPhone: form.contactPhone || null,
        contactEmail: form.contactEmail || null,
        businessAddress: form.businessAddress || null,
        taxPin: form.taxPin || null,
        receiptHeader: form.receiptHeader || null,
        receiptFooter: form.receiptFooter || null,
        receiptLogoUrl: form.receiptLogoUrl || null,
        receiptDesign: form.receiptDesign,
        cashDrawerPolicy: form.cashDrawerPolicy,
        modules: form.modules,
        capabilities: form.capabilities,
        changeReason: form.changeReason || undefined
      };
      const result = await api.updateOrganizationConfiguration(input);
      setConfiguration(result.configuration);
      setForm(toForm(result.configuration));
      await reload();
      setMessage('Business configuration saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to save business configuration.');
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(file: File | undefined) {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5_000_000) { setError('Choose a PNG or JPEG logo smaller than 5 MB.'); return; }
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 320 / bitmap.width, 160 / bitmap.height);
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d'); if (!context) throw new Error('Image editor unavailable');
      context.fillStyle = '#fff'; context.fillRect(0,0,canvas.width,canvas.height); context.drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
      update('receiptLogoUrl', canvas.toDataURL('image/jpeg', 0.85)); setError('');
    } catch { setError('This logo could not be read. Choose another PNG or JPEG image.'); }
  }

  return (
    <div className="page-stack">
      <PageHeader title="Business configuration" description="Industry profile, contact and receipt details, enabled modules and supported capabilities." />
      <Card title="Prepare password recovery" subtitle="Save private recovery codes now so the owner can recover access without internet."><Link to="/settings/security">Set up my recovery codes</Link></Card>
      {message ? <Alert tone="success">{message}</Alert> : null}
      {hasPermission('catalog.manage') ? <Card title="Your business catalogue"><p>The installed library matches your saved business type. Choose products, sizes and service options, then set your own prices.</p><Link to="/catalogue">Choose items for my business</Link></Card> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form className="form-stack page-stack" onSubmit={(event) => void submit(event)}>
        <Card title="1. Business profile" subtitle="Selects recommended modules and capabilities. Planned industry workflows are listed but are not functional yet.">
          <div className="form-grid">
            <SelectField label="Industry profile" value={form.businessProfile} onChange={(event) => update('businessProfile', event.target.value)} disabled={!canEdit}>
              {configuration.profiles.map((profile) => (
                <option key={profile.code} value={profile.code}>{profile.label}</option>
              ))}
            </SelectField>
            <SelectField label="Default branch" hint="Used as the primary branch for configuration defaults." value={form.defaultBranchId} onChange={(event) => update('defaultBranchId', event.target.value)} disabled={!canEdit}>
              <option value="">No default branch</option>
              {bootstrap?.branches.filter((branch) => branch.status === 'active').map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>
              ))}
            </SelectField>
          </div>
          {activeProfile ? (
            <div className="profile-detail">
              <p>{activeProfile.summary}</p>
              <div className="profile-columns">
                <div>
                  <strong>Included today</strong>
                  <ul>{activeProfile.implementedHighlights.map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
                <div>
                  <strong>Planned — not yet available</strong>
                  <ul>{activeProfile.deferredCapabilities.map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
              </div>
            </div>
          ) : null}
        </Card>

        <span id="receipt-studio" />
        <Card title="2. Your receipt studio" subtitle="Add your shop branding, choose a layout and preview your receipt. A KRA PIN alone does not enable eTIMS invoicing.">
          <div className="form-grid">
            <TextField label="Business phone" value={form.contactPhone} onChange={(event) => update('contactPhone', event.target.value)} disabled={!canEdit} />
            <TextField label="Business email" type="email" value={form.contactEmail} onChange={(event) => update('contactEmail', event.target.value)} disabled={!canEdit} />
            <TextField label="Business address" value={form.businessAddress} onChange={(event) => update('businessAddress', event.target.value)} disabled={!canEdit} />
            <TextField label="Tax registration reference" hint="KRA PIN or other reference. This is not a fiscal integration." value={form.taxPin} onChange={(event) => update('taxPin', event.target.value.toUpperCase())} disabled={!canEdit} />
            <div className="field"><label className="field-label" htmlFor="receipt-header">Receipt header</label><textarea id="receipt-header" rows={2} maxLength={240} value={form.receiptHeader} onChange={(event) => update('receiptHeader', event.target.value)} disabled={!canEdit} /></div>
            <TextField label="Upload company logo" type="file" accept="image/png,image/jpeg" hint="Saved locally with your shop settings; works without internet. PNG or JPEG, up to 5 MB." onChange={event => void uploadLogo(event.target.files?.[0])} disabled={!canEdit} />
            <TextField label="Receipt logo URL" hint="Optional HTTPS image address. Upload a file above for reliable offline printing." value={form.receiptLogoUrl.startsWith('data:') ? '' : form.receiptLogoUrl} onChange={(event) => update('receiptLogoUrl', event.target.value)} disabled={!canEdit} />
          </div>
          {form.receiptLogoUrl ? <div><img className="receipt-logo" src={form.receiptLogoUrl} alt="Receipt logo preview" /><Button type="button" variant="secondary" disabled={!canEdit} onClick={() => update('receiptLogoUrl','')}>Remove logo</Button></div> : null}
          <div className="field"><label className="field-label" htmlFor="receipt-footer">Receipt footer</label><textarea id="receipt-footer" rows={3} maxLength={500} value={form.receiptFooter} onChange={(event) => update('receiptFooter', event.target.value)} disabled={!canEdit} /></div>
          <ReceiptDesigner design={form.receiptDesign} disabled={!canEdit} onChange={design => setForm(current => current ? { ...current, receiptDesign: design } : current)} receipt={{
            organization: { legalName: configuration.organization.legalName, displayName: configuration.organization.displayName, receiptPolicy: configuration.organization.receiptPolicy ?? '', branchName: bootstrap?.branches.find(b => b.id === form.defaultBranchId)?.name ?? 'Main branch', branchCode: 'MAIN', registerName: 'Till 01', registerCode: '01', ...form },
            sale: { receiptNumber: 'PREVIEW-001', soldAt: '2026-10-30T09:30:00+03:00', cashierName: 'Sample cashier', currency: configuration.organization.currencyCode, subtotal: '862.07', discountTotal: '0.00', taxTotal: '137.93', total: '1000.00', lines: [{ id: 'sample', productName: 'Sample product · 500 ml', quantity: '2', unitCode: 'EA', unitPrice: '500.00', total: '1000.00' }], payments: [{ id: 'sample', method: 'cash', amount: '1000.00', amountTendered: '1200.00', change: '200.00', status: 'completed', createdAt: '2026-10-30T09:30:00+03:00' }] },
            loyalty: { earned: '10', redeemed: '0', redeemedValue: '0.00', balanceAfter: '40', reversedEarned: '0', restoredRedeemed: '0' }, complianceNotice: 'This is a sales receipt, not a KRA eTIMS tax invoice. Fiscal integration remains pending.'
          }} />
          {canEdit ? <Button type="submit" loading={saving}>Save receipt design</Button> : null}
        </Card>

        <Card title="3. Enabled modules" subtitle="Modules can be disabled without deleting historical data. The backend enforces every change — permissions are unchanged by module state.">
          <div className="module-grid">
            {moduleEntries.core.map((entry) => (
              <div key={entry.code} className="module-card">
                <CheckboxField label={entry.name} checked disabled onChange={() => undefined} />
                <p>{entry.description}</p>
                <Badge tone="neutral">Core — always on</Badge>
              </div>
            ))}
            {moduleEntries.configurable.map((entry: ModuleCatalogEntry) => (
              <div key={entry.code} className="module-card">
                <CheckboxField label={entry.name} checked={form.modules[entry.code] ?? false} disabled={!canEdit} onChange={(checked) => toggleModule(entry.code, checked)} />
                <p>{entry.description}</p>
                {entry.dependsOn.length > 0 ? <span className="field-hint">Requires: {entry.dependsOn.join(', ')}</span> : null}
              </div>
            ))}
          </div>
        </Card>

        <Card title="4. Supported capabilities" subtitle="Implemented catalogue capabilities. Disabling a capability is blocked while active products depend on it.">
          <p>Barcode scanner and cash drawer are optional hardware capabilities and start disabled. Enable only what this shop uses.</p>
          <SelectField label="Automatic drawer payment policy" value={form.cashDrawerPolicy} disabled={!canEdit} onChange={e => update('cashDrawerPolicy', e.target.value)}><option value="cash">Completed cash sales only</option><option value="paid">Cash and manually confirmed M-Pesa/card sales</option></SelectField>
          <div className="module-grid">
            {moduleEntries.capabilities.map((entry) => (
              <div key={entry.code} className="module-card">
                <CheckboxField label={entry.name} checked={form.capabilities[entry.code] ?? false} disabled={!canEdit} onChange={(checked) => toggleCapability(entry.code, checked)} />
                <p>{entry.description}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="5. Planned modules" subtitle="Roadmap capabilities. These are intentionally not selectable and have no effect until implemented.">
          <div className="module-grid">
            {moduleEntries.planned.map((entry) => (
              <div key={entry.code} className="module-card module-card-planned">
                <CheckboxField label={entry.name} checked={false} disabled onChange={() => undefined} />
                <p>{entry.description}</p>
                <Badge tone="warning">Planned</Badge>
              </div>
            ))}
          </div>
        </Card>

        <Card title="6. Review and save" subtitle="A reason is recorded in the audit log whenever the profile, modules or capabilities change.">
          <TextField
            label="Change reason"
            hint={structuralChange ? 'Required because the profile, modules or capabilities changed.' : 'Required only for profile, module or capability changes.'}
            value={form.changeReason}
            onChange={(event) => update('changeReason', event.target.value)}
            disabled={!canEdit}
            required={structuralChange}
          />
          {canEdit ? (
            <Button type="submit" loading={saving}>Save configuration</Button>
          ) : (
            <Alert tone="info">You have read-only access. The settings.manage permission is required to change business configuration.</Alert>
          )}
        </Card>
      </form>
      {canEdit ? <PeripheralSettingsCard /> : null}
      <LoyaltySettingsCard canEdit={canEdit} />
      <EtimsReadinessCard taxPin={configuration.organization.taxPin} />
    </div>
  );
}
