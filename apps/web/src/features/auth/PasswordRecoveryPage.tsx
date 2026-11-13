import { BrandMark } from '../../design-system/Brand';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, TextField } from '../../design-system/components';
import { api } from '../../lib/api/client';

export function PasswordRecoveryPage() {
  const [email,setEmail]=useState(''), [code,setCode]=useState(''), [password,setPassword]=useState(''), [confirm,setConfirm]=useState('');
  const [message,setMessage]=useState(''), [error,setError]=useState(''), [busy,setBusy]=useState(false);
  async function submit(event:FormEvent) {
    event.preventDefault();setError('');setMessage('');if(password!==confirm){setError('Passwords do not match.');return;}setBusy(true);
    try {await api.recoverAccount({email,code,password});setMessage('Password updated. Your old sessions have been signed out. Sign in with your new password.');setCode('');setPassword('');setConfirm('');}
    catch(error){setError(error instanceof Error?error.message:'Unable to recover this account.');}finally{setBusy(false);}
  }
  return <main className="auth-page"><Card className="auth-card"><div className="auth-brand"><BrandMark /><div><h1>Recover your account</h1><p>Use one of your saved private recovery codes. Internet is not needed when your shop server is reachable.</p></div></div>
    {message?<Alert tone="success">{message}</Alert>:null}{error?<Alert tone="danger">{error}</Alert>:null}
    <form className="form-stack" onSubmit={event=>void submit(event)}><TextField label="Account email" type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required /><TextField label="Private recovery code" autoComplete="off" value={code} onChange={e=>setCode(e.target.value)} required /><TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} required /><TextField label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} required /><Button type="submit" loading={busy}>Recover account</Button></form>
    <p>Staff without a saved code can ask their shop owner to reset their password in Users. Owners must prepare recovery codes in Password &amp; recovery before losing access. No email or SMS delivery is configured.</p><div className="auth-links"><Link to="/login">Back to sign in</Link><Link to="/reset-password">I have an issued reset token</Link></div></Card></main>;
}
