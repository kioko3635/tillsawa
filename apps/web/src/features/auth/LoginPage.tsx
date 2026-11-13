import { BrandMark } from '../../design-system/Brand';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, SelectField, TextField } from '../../design-system/components';
import { ApiError } from '../../lib/api/client';
import { useAuth } from '../../app/useAuth';
import { useDeploymentConnection } from '../../lib/offline/connection';

export function LoginPage() {
  const { login } = useAuth();
  const { mode: deploymentMode, registrationOpen } = useDeploymentConnection();
  const navigate = useNavigate();
  const [businesses, setBusinesses] = useState<Array<{ id: string; name: string }>>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login({ email, password, organizationId: organizationId || undefined });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BUSINESS_SELECTION_REQUIRED') {
        const choices = (err.details as { businesses?: unknown } | undefined)?.businesses;
        if (Array.isArray(choices)) setBusinesses(choices.filter((item): item is { id: string; name: string } => typeof item?.id === 'string' && typeof item?.name === 'string'));
      }
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Check your details and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page login-page">
      <section className="login-story" aria-label="TillSawa"><div className="login-wordmark"><BrandMark /> TillSawa</div><div><span className="workspace-eyebrow">BUILT FOR YOUR BUSINESS</span><h2>Your counter.<br />Your business.<br /><em>Under control.</em></h2><p>From the first sale to the final report, keep your shop moving with one connected workspace.</p><div className="login-feature-list"><span>Sales & checkout</span><span>Stock & purchases</span><span>Reports & team access</span></div></div><small>{deploymentMode === 'cloud' ? 'Your shop workspace, hosted online.' : deploymentMode === 'hub' ? 'Reports from your linked shops.' : deploymentMode === 'checking' ? 'Your TillSawa workspace.' : 'Your shop workspace, on your local network.'}</small></section>
      <Card className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <div>
            <h1>Welcome back</h1>
            <p>Sign in to your business workspace.</p>
            {deploymentMode==='terminal'?<p>Connected till — use the account created on your main server.</p>:null}
          </div>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <form onSubmit={(event) => void submit(event)} className="form-stack">
          <TextField label="Email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); setBusinesses([]); setOrganizationId(''); }} autoComplete="email" required />
          <TextField label="Password" type="password" value={password} onChange={(event) => { setPassword(event.target.value); setBusinesses([]); setOrganizationId(''); }} autoComplete="current-password" required />
          {businesses.length > 1 ? <SelectField label="Business" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} required>
            <option value="">Select your business</option>
            {businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}
          </SelectField> : null}
          <Button type="submit" loading={loading}>Sign in</Button>
        </form>
        <div className="auth-links">
          <Link to="/forgot-password">Forgot password?</Link>
          {deploymentMode==='standalone' || deploymentMode==='server' || deploymentMode==='hub' || (deploymentMode==='cloud' && registrationOpen)?<Link to="/onboarding">Register a business</Link>:null}
        </div>
      </Card>
    </main>
  );
}
