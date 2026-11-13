import { useEffect, useState } from 'react';
import type { CompleteSaleInput } from '@pos/contracts';
import { api } from '../../lib/api/client';
import { Alert, Button, CheckboxField, TextField } from '../../design-system/components';

export interface PaymentIntent {
  id: string; clientTransactionId: string; method: string; provider: string;
  status: string; amount: string; reference: string | null; message: string | null; saleId: string | null; merchantReference?: string | null;
}

export function paymentCartSignature(sale: CompleteSaleInput) {
  return JSON.stringify({ ...sale, payment: { method: sale.payment.method } });
}

const statuses: Record<string, string> = { pending: 'Awaiting confirmation', paid: 'Payment confirmed', failed: 'Payment failed', cancelled: 'Attempt cancelled', unknown: 'Status needs checking' };

export function ElectronicPayment({ sale, intent, bound, currency, ready, online, onBusy, onReady }: {
  sale: CompleteSaleInput; intent: PaymentIntent | null; bound: string; currency: string; ready: boolean; online: boolean;
  onBusy: (busy: boolean) => void; onReady: (intent: PaymentIntent | null, signature: string) => void;
}) {
  const [configuration, setConfiguration] = useState({ testMode: false, simulator: false, darajaSandbox: false, pesapalTerminal: false });
  const [provider, setProvider] = useState<'manual' | 'simulator' | 'daraja_sandbox' | 'pesapal_terminal'>('manual');
  const [phone, setPhone] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [checked, setChecked] = useState(false);
  const [noPayment, setNoPayment] = useState(false);
  const [autoFinished, setAutoFinished] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<PaymentIntent[]>([]);
  const signature = paymentCartSignature(sale);
  const mpesa = sale.payment.method === 'mpesa';
  const sandbox = configuration.darajaSandbox && mpesa;
  const changed = Boolean(intent && bound !== signature);
  useEffect(() => { void api.paymentConfiguration().then(result => setConfiguration({ ...result, pesapalTerminal: result.pesapalTerminal === true })).catch(() => undefined); }, []);

  const waitingForPrompt = intent?.provider === 'daraja_sandbox' && intent.status === 'pending';
  const attemptId = intent?.id;
  useEffect(() => {
    if (!waitingForPrompt || !online || !attemptId || autoFinished) return;
    let disposed = false;
    let attempts = 0;
    let timer: number;
    const check = async () => {
      attempts += 1;
      try {
        const result = await api.checkDarajaPayment(attemptId);
        if (disposed) return;
        onReady(result.intent, bound);
        if (result.intent.status !== 'pending') return;
      } catch { if (disposed) return; }
      if (attempts >= 5) setAutoFinished(true);
      else timer = window.setTimeout(() => void check(), 8000);
    };
    timer = window.setTimeout(() => void check(), 6000);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [attemptId, autoFinished, bound, onReady, online, waitingForPrompt]);

  async function run(action: () => Promise<{ intent: PaymentIntent }>) {
    if (busy || !online) return;
    setBusy(true); onBusy(true); setError('');
    try {
      const result = await action();
      onReady(result.intent, bound || signature);
    } catch (err) { setError(err instanceof Error ? err.message : 'Check the payment status before trying again.'); }
    finally { setBusy(false); onBusy(false); }
  }

  return <div className="pos-electronic-flow">
    {!intent ? <>
      <p>{provider === 'pesapal_terminal' ? 'Prepare the sale first so you have the merchant reference to enter on the Pesapal terminal.' : mpesa ? 'For manual confirmation, ask the customer to pay using your shop’s M-Pesa details and verify the payment in the merchant account.' : 'For manual confirmation, charge the amount on the bank terminal and keep the approval reference.'}</p>
      {configuration.pesapalTerminal ? <div className="button-row">
        {provider !== 'pesapal_terminal' ? <Button type="button" variant="secondary" onClick={() => setProvider('pesapal_terminal')}>Use Pesapal terminal</Button>
          : <Button type="button" variant="secondary" onClick={() => setProvider('manual')}>Use manual confirmation</Button>}
      </div> : null}
      {sandbox && provider === 'manual' ? <Button type="button" variant="secondary" onClick={() => setProvider('daraja_sandbox')}>Use M-Pesa test phone prompt</Button> : null}
      {configuration.testMode && (configuration.simulator || sandbox) ? <details className="pos-payment-details" open={provider === 'daraja_sandbox' || provider === 'simulator' || undefined}>
        <summary>Payment test tools</summary>
        <p>Sandbox and simulated payments move no money.</p>
        <label className="field-label">Confirmation method<select value={provider} onChange={event => setProvider(event.target.value as typeof provider)}>
          <option value="manual">Manually verify received payment</option>
          {configuration.simulator ? <option value="simulator">Simulator</option> : null}
          {provider === 'pesapal_terminal' ? <option value="pesapal_terminal">Pesapal terminal</option> : null}
          {sandbox ? <option value="daraja_sandbox">Daraja sandbox phone prompt</option> : null}
        </select></label>
        {provider === 'daraja_sandbox' ? <TextField label="Sandbox phone" value={phone} onChange={event => setPhone(event.target.value)} placeholder="07… or 2547…" inputMode="tel" /> : null}
      </details> : null}
      <Button type="button" variant="secondary" loading={busy} disabled={!ready || (provider === 'daraja_sandbox' && !phone.trim())} onClick={() => void run(() => api.createPaymentIntent({ sale, provider, phone: provider === 'daraja_sandbox' ? phone : undefined }))}>
        {provider === 'pesapal_terminal' ? 'Prepare Pesapal payment' : provider === 'daraja_sandbox' ? 'Send test prompt' : provider === 'simulator' ? 'Start simulation' : 'Prepare payment confirmation'}
      </Button>
    </> : <>
      <div className="pos-payment-result" data-status={intent.status} role="status">
        <div><strong>{statuses[intent.status] ?? 'Check payment status'}</strong><strong>{currency} {intent.amount}</strong></div>
        <small>{intent.provider === 'manual' ? (intent.status === 'paid' ? 'Verified by cashier in the merchant account or terminal.' : intent.message) : intent.provider === 'pesapal_terminal' ? intent.message : `Test payment · ${intent.message ?? 'No money moved.'}`}</small>
        {intent.reference ? <small>Reference: {intent.reference}</small> : null}
      </div>
      {changed ? <Alert tone="warning">The cart changed. Restore the original items and customer before completing this sale.</Alert> : null}
      {intent.status === 'pending' && intent.provider === 'manual' ? <>
        <TextField label="Payment reference" hint={mpesa ? 'Use the merchant’s M-Pesa transaction code.' : 'Use the terminal approval reference. Never enter a card number.'} value={reference} onChange={event => setReference(event.target.value)} maxLength={64} />
        <TextField label="Amount actually received" value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" />
        <CheckboxField label="I verified this amount in the merchant account or terminal." checked={checked} onChange={setChecked} />
        <Button type="button" variant="secondary" loading={busy} disabled={!online || !checked || changed || !reference.trim() || !amount.trim()} onClick={() => void run(() => api.confirmManualPayment(intent.id, { reference, amount, confirmed: true }))}>Confirm received payment</Button>
        <details className="pos-payment-details"><summary>Customer did not pay?</summary>
          <CheckboxField label="No payment was received for this attempt." checked={noPayment} onChange={setNoPayment} />
          <Button type="button" variant="secondary" disabled={!online || !noPayment || busy} onClick={() => void run(() => api.cancelUnpaidManualPayment(intent.id))}>Cancel unpaid attempt</Button>
        </details>
      </> : null}
      {intent.provider === 'pesapal_terminal' && intent.status === 'pending' ? <>
        <p>On the Pesapal terminal, enter <strong>{intent.merchantReference}</strong> as the merchant reference before taking payment. Select the same payment method and exact amount.</p>
        <TextField label="Pesapal confirmation code" hint="Use the code on the terminal receipt. Never enter a card number." value={reference} onChange={event => setReference(event.target.value)} maxLength={64} />
        <Button type="button" variant="secondary" loading={busy} disabled={!online || changed || !reference.trim()} onClick={() => void run(() => api.verifyPesapalPayment(intent.id, reference))}>Verify with Pesapal</Button>
        <details className="pos-payment-details"><summary>Customer did not pay?</summary>
          <CheckboxField label="No payment was received for this attempt." checked={noPayment} onChange={setNoPayment} />
          <Button type="button" variant="secondary" disabled={!online || !noPayment || busy} onClick={() => void run(() => api.cancelUnpaidManualPayment(intent.id))}>Cancel unpaid attempt</Button>
        </details>
      </> : null}
      {intent.provider === 'simulator' && intent.status === 'pending' ? <div className="button-row">{(['paid', 'failed', 'cancelled'] as const).map(outcome => <Button key={outcome} variant="secondary" type="button" disabled={!online || busy || changed} onClick={() => void run(() => api.simulatePayment(intent.id, outcome))}>Simulate {outcome}</Button>)}</div> : null}
      {waitingForPrompt && !autoFinished && online ? <small role="status">Waiting for the test prompt result. TillSawa is checking automatically.</small> : null}
      {intent.provider === 'daraja_sandbox' && (intent.status === 'unknown' || (waitingForPrompt && autoFinished)) ? <Button type="button" variant="secondary" disabled={!online || busy} onClick={() => void run(() => api.checkDarajaPayment(intent.id))}>Check test prompt status</Button> : null}
      {['failed', 'cancelled'].includes(intent.status) ? <Button type="button" variant="secondary" onClick={() => onReady(null, '')}>Return to payment choices</Button> : null}
    </>}
    {error ? <Alert tone="danger">{error}</Alert> : null}
    <details className="pos-payment-details" onToggle={event => {
      if (event.currentTarget.open && online) void api.paymentIntents().then(result => setHistory(result.intents)).catch(() => setError('Payment history could not be loaded.'));
    }}><summary>Recent payment attempts</summary>
      {history.map(row => <p key={row.id}>{row.method} · {row.provider} · {row.amount} · {statuses[row.status] ?? row.status} · {row.reference || row.id} · {row.saleId ? 'Attached to sale' : 'No sale attached'}</p>)}
    </details>
  </div>;
}
