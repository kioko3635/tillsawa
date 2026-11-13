import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, PageHeader, TextField } from '../../design-system/components';
import { api } from '../../lib/api/client';
import { useAuth } from '../../app/useAuth';

export function SecurityPage() {
  const { membership } = useAuth();
  const [remaining, setRemaining] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.recoveryStatus().then(r => setRemaining(r.remaining)).catch(e => setError(e.message)); }, []);
  async function generate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setCodes([]);
    try { const result = await api.generateRecoveryCodes(password); setCodes(result.codes); setRemaining(result.codes.length); setPassword(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not generate recovery codes.'); }
    finally { setBusy(false); }
  }
  function download() {
    const file = new Blob([`TillSawa personal recovery codes\nAccount: ${membership?.email}\n\n${codes.join('\n')}\n\nEach code works once. Keep this file private and away from the till. Generating another set cancels this set.\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(file); const link = document.createElement('a'); link.href = url; link.download = 'TillSawa-private-recovery-codes.txt'; link.click(); URL.revokeObjectURL(url);
  }
  return <div className="page-stack"><PageHeader title="Password & recovery" description="Prepare recovery before a forgotten password. Works on the standalone computer or through the shop server without internet." />
    {error ? <Alert tone="danger">{error}</Alert> : null}
    <Card title="Your private recovery codes" subtitle="These codes recover your own account. Keep them offline in a secure place away from the POS computer.">
      <p>{remaining === null ? 'Checking recovery setup…' : `${remaining} unused recovery codes available.`}</p>
      {remaining === 0 ? <Alert tone="warning">Recovery is not prepared. Generate and save your codes now, especially for the owner account.</Alert> : null}
      <form className="form-stack" onSubmit={event => void generate(event)}><TextField label="Your current password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /><p>Generating a new set immediately cancels every previous unused code. The new codes are shown only here, once.</p><Button type="submit" loading={busy}>Generate new recovery codes</Button></form>
      {codes.length ? <div className="page-stack"><Alert tone="warning">Anyone holding one of these codes can reset your password. Save them securely before leaving this page. Do not give them to cashiers or send them in chat.</Alert><pre className="recovery-codes">{codes.join('\n')}</pre><div className="button-row"><Button onClick={download}>Download private codes</Button><Button variant="secondary" onClick={() => setCodes([])}>Hide codes</Button></div></div> : null}
    </Card><Card title="If a staff member forgets their password"><p>The shop owner can open Users, select the staff member and reset their password after confirming the owner's current password. The staff member's old sessions are signed out. Owners use their own recovery codes.</p></Card>
  </div>;
}
