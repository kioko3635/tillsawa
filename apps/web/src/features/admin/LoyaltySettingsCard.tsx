import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, CheckboxField, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { LoyaltySettings } from '../../lib/api/types';
export function LoyaltySettingsCard({ canEdit }: { canEdit: boolean }) {
  const [settings,setSettings]=useState<LoyaltySettings | null>(null);
  const [saving,setSaving]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  useEffect(()=>{ api.loyaltySettings().then(result=>setSettings(result.settings)).catch(()=>setError('Unable to load loyalty settings.')); },[]);
  async function save(event:FormEvent) {
    event.preventDefault(); if(!settings) return;
    setSaving(true);setError('');setMessage('');
    try { const result=await api.updateLoyaltySettings(settings);setSettings(result.settings);setMessage('Loyalty settings saved. Existing customer points are preserved.'); }
    catch(err) {setError(err instanceof ApiError?err.message:'Unable to save loyalty settings.');} finally {setSaving(false);}
  }
  return <Card title="Customer loyalty points" subtitle="Each shop chooses its own rates. Select a customer at checkout to earn points on paid purchases.">
    {error?<Alert tone="danger">{error}</Alert>:null}{message?<Alert tone="success">{message}</Alert>:null}
    {settings?<form className="form-stack" onSubmit={event=>void save(event)}><fieldset className="online-review-fields" disabled={!canEdit || saving}>
      <CheckboxField label="Enable loyalty points" checked={settings.enabled} onChange={enabled=>setSettings({...settings,enabled})}/>
      <div className="form-grid"><TextField label="Spend to earn one point (KSh)" value={settings.earnSpend} inputMode="decimal" required onChange={event=>setSettings({...settings,earnSpend:event.target.value})}/>
      <TextField label="Value of one redeemed point (KSh)" value={settings.redeemValue} inputMode="decimal" required onChange={event=>setSettings({...settings,redeemValue:event.target.value})}/>
      <TextField label="Minimum points to redeem" type="number" min="1" max="1000000000" step="1" value={settings.minimumRedeemPoints} required onChange={event=>setSettings({...settings,minimumRedeemPoints:Number(event.target.value)})}/></div>
      <p>One point is earned for each complete spend amount, after redeemed points. Credit purchases do not earn points. Redemption currently supports cash checkout; the balance is checked by your local POS database.</p>
      <p>Returns and voids reverse earned points and restore redeemed points proportionally. A balance can become negative if previously earned points were already spent. Changing rates changes the future redemption value of existing points; communicate changes to customers.</p>
      <Button type="submit" loading={saving}>Save loyalty settings</Button>
    </fieldset></form>:null}
  </Card>;
}
