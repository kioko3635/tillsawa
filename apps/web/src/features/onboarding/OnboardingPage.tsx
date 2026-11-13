import { BrandMark } from '../../design-system/Brand';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BUSINESS_PROFILE_DEFINITIONS, type BusinessProfileCode } from '@pos/contracts';
import { Alert, Button, Card, SelectField, TextField } from '../../design-system/components';
import { ApiError } from '../../lib/api/client';
import { useAuth } from '../../app/useAuth';
import { useDeploymentConnection } from '../../lib/offline/connection';

export function OnboardingPage() {
  const { mode: deploymentMode, registrationOpen } = useDeploymentConnection();
  const [setupKey, setSetupKey] = useState('');
  const { registerOrganization } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    legalName: '',
    displayName: '',
    currencyCode: 'KES',
    timezone: 'Africa/Nairobi',
    taxPricingMode: 'inclusive' as 'inclusive' | 'exclusive',
    businessProfile: 'general_retail' as BusinessProfileCode,
    branchCode: 'HQ',
    branchName: 'Head Office',
    ownerName: '',
    email: '',
    password: ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function update(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await registerOrganization({
        organization: {
          legalName: form.legalName,
          displayName: form.displayName,
          currencyCode: form.currencyCode,
          timezone: form.timezone,
          taxPricingMode: form.taxPricingMode,
          businessProfile: form.businessProfile
        },
        branch: {
          code: form.branchCode.toUpperCase(),
          name: form.branchName
        },
        owner: {
          displayName: form.ownerName,
          email: form.email,
          password: form.password
        }
      }, deploymentMode === 'cloud' ? setupKey.trim() : undefined);
      navigate('/catalogue', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to register the business.');
    } finally {
      setLoading(false);
    }
  }

  if (deploymentMode === 'cloud' && !registrationOpen) return <main className="auth-page"><Card title="Business setup is closed"><p>Contact your hosting administrator to set up a new business.</p><Link to="/login">Back to sign in</Link></Card></main>;
  if(deploymentMode==='terminal') return <main className="auth-page"><Card title="Connect to your existing shop"><p>Create the business once on the main server. Sign in here with the cashier or owner account from that shop.</p><Link to="/login">Sign in to shared shop</Link></Card></main>;
  return (
    <main className="auth-page auth-page-wide">
      <Card className="auth-card auth-card-wide">
        <div className="auth-brand">
          <BrandMark />
          <div>
            <h1>Set up your business</h1>
            <p>Create a secure organization, first branch and owner account.</p>
          </div>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <form onSubmit={(event) => void submit(event)} className="form-stack">
          {deploymentMode === 'cloud' ? <TextField label="Cloud setup key" type="password" value={setupKey} onChange={event => setSetupKey(event.target.value)} autoComplete="off" maxLength={64} required /> : null}
          <fieldset>
            <legend>Business</legend>
            <div className="form-grid">
              <TextField label="Display name" value={form.displayName} onChange={(event) => update('displayName', event.target.value)} required />
              <TextField label="Legal name" value={form.legalName} onChange={(event) => update('legalName', event.target.value)} required />
              <SelectField label="Tax pricing" value={form.taxPricingMode} onChange={(event) => update('taxPricingMode', event.target.value)}>
                <option value="inclusive">Tax-inclusive prices</option>
                <option value="exclusive">Tax-exclusive prices</option>
              </SelectField>
              <TextField label="Currency" value={form.currencyCode} onChange={(event) => update('currencyCode', event.target.value.toUpperCase())} maxLength={3} required />
              <TextField label="Time zone" value={form.timezone} onChange={(event) => update('timezone', event.target.value)} required />
              <SelectField label="Business type" hint="Selects recommended modules. Industry-specific workflows marked as planned are not included yet." value={form.businessProfile} onChange={(event) => update('businessProfile', event.target.value)}>
                {BUSINESS_PROFILE_DEFINITIONS.map((profile) => (
                  <option key={profile.code} value={profile.code}>{profile.label}</option>
                ))}
              </SelectField>
            </div>
            <p className="field-hint">{BUSINESS_PROFILE_DEFINITIONS.find((profile) => profile.code === form.businessProfile)?.summary}</p>
          </fieldset>
          <fieldset>
            <legend>First branch</legend>
            <div className="form-grid">
              <TextField label="Branch code" value={form.branchCode} onChange={(event) => update('branchCode', event.target.value.toUpperCase())} required />
              <TextField label="Branch name" value={form.branchName} onChange={(event) => update('branchName', event.target.value)} required />
            </div>
          </fieldset>
          <fieldset>
            <legend>Owner account</legend>
            <div className="form-grid">
              <TextField label="Full name" value={form.ownerName} onChange={(event) => update('ownerName', event.target.value)} required />
              <TextField label="Email" type="email" value={form.email} onChange={(event) => update('email', event.target.value)} required />
              <TextField label="Password" type="password" value={form.password} onChange={(event) => update('password', event.target.value)} autoComplete="new-password" required />
            </div>
          </fieldset>
          <Button type="submit" loading={loading}>Create business workspace</Button>
        </form>
        <div className="auth-links">
          <Link to="/login">Already have an account?</Link>
        </div>
      </Card>
    </main>
  );
}
