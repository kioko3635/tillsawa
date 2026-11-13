import { BrandMark } from '../../design-system/Brand';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await api.resetPassword({ token, password });
      setMessage('Password updated. You can sign in with the new password.');
      window.setTimeout(() => navigate('/login'), 1200);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to reset password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <Card className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <div>
            <h1>Set a new password</h1>
            <p>Reset tokens expire and can only be used once.</p>
          </div>
        </div>
        {message ? <Alert tone="success">{message}</Alert> : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <form onSubmit={(event) => void submit(event)} className="form-stack">
          <TextField label="Reset token" value={token} onChange={(event) => setToken(event.target.value)} required />
          <TextField label="New password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
          <TextField label="Confirm password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required />
          <Button type="submit" loading={loading}>Update password</Button>
        </form>
        <div className="auth-links">
          <Link to="/login">Back to sign in</Link>
        </div>
      </Card>
    </main>
  );
}
