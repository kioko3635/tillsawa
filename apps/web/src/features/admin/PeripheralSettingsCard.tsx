import { useEffect, useState } from 'react';
import { Alert, Button, Card, CheckboxField, SelectField } from '../../design-system/components';
import { desktopAvailable, desktopRequest, type TillHardware } from '../../lib/desktop-bridge';

export function PeripheralSettingsCard() {
  const [hardware, setHardware] = useState<TillHardware | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (desktopAvailable()) void desktopRequest<TillHardware>('status').then(setHardware).catch(e => setError(e.message)); }, []);
  async function action(type: 'configure' | 'test') {
    if (!hardware) return; setBusy(true); setError(''); setMessage('');
    try { const result = await desktopRequest<{ message: string; settings?: TillHardware['settings'] }>(type, hardware.settings); setMessage(result.message); if (result.settings) setHardware({ ...hardware, settings: result.settings }); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not configure this till.'); } finally { setBusy(false); }
  }
  return <Card title="Printer & cash drawer — this till" subtitle="First enable Cash drawer in Supported capabilities and save configuration. Then configure each physical till separately.">
    <p>Connect the drawer to the receipt printer's drawer port, install its Windows driver and select its physical ESC/POS print queue. A USB/Bluetooth keyboard-mode barcode reader needs no driver integration: enable Barcode scanner and scan into product search.</p>
    {!desktopAvailable() ? <Alert tone="info">Shop hardware modules can be enabled here. To select the printer or test the drawer, open Configuration in the installed TillSawa Windows app on that till.</Alert> : null}
    {error ? <Alert tone="danger">{error}</Alert> : null}{message ? <Alert tone="success">{message}</Alert> : null}
    {hardware ? <div className="form-stack"><CheckboxField label="Enable automatic drawer on this till" checked={hardware.settings.enabled} onChange={enabled => setHardware({ ...hardware, settings: { ...hardware.settings, enabled } })} disabled={busy} /><SelectField label="Receipt printer for this till" value={hardware.settings.printer} disabled={busy} onChange={e => setHardware({ ...hardware, settings: { ...hardware.settings, printer: e.target.value } })}><option value="">Choose a Windows receipt printer</option>{hardware.printers.map(printer => <option key={printer}>{printer}</option>)}</SelectField><SelectField label="Drawer connector" value={hardware.settings.pin} disabled={busy} onChange={e => setHardware({ ...hardware, settings: { ...hardware.settings, pin: Number(e.target.value) } })}><option value={0}>Pin 2 — common default</option><option value={1}>Pin 5 — if specified by your printer</option></SelectField><p className="field-hint">Use the printer manufacturer's supported connector. This sends ESC/POS pulses; it does not support every printer model. A successful Windows queue response does not prove the physical drawer opened.</p><div className="button-row"><Button type="button" loading={busy} onClick={() => void action('configure')}>Save this till's hardware</Button><Button type="button" variant="secondary" disabled={busy || !hardware.settings.enabled} onClick={() => void action('test')}>Test drawer — opens now</Button></div></div> : null}
  </Card>;
}
