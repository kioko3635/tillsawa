import { useEffect, useState } from 'react';
import { Alert, TextField } from '../../design-system/components';
import { api } from '../../lib/api/client';
import type { LoyaltySettings } from '../../lib/api/types';
export function LoyaltyCheckout({ customerId, available, cash, total, onChange }: { customerId:string; available:boolean; cash:boolean; total:bigint; onChange:(points:number,value:bigint,valid:boolean)=>void }) {
  const [settings,setSettings]=useState<LoyaltySettings | null>(null),[balance,setBalance]=useState('0'),[raw,setRaw]=useState(''),[error,setError]=useState('');
  const [entries,setEntries]=useState<{id:string;points:string;kind:string;createdAt:string}[]>([]);
  useEffect(()=>{
    let disposed=false; setRaw(''); setSettings(null); setError(''); onChange(0,0n,true);
    if(available && customerId) Promise.all([api.loyaltySettings(),api.customerLoyalty(customerId)]).then(([configuration,account])=>{
      if(!disposed) {setSettings(configuration.settings);setBalance(account.balance);setEntries(account.entries);}
    }).catch(()=>{if(!disposed)setError('Points balance could not be loaded. You can still complete a purchase without redeeming points.');});
    return()=>{disposed=true;};
  },[customerId,available,cash,onChange]);
  const rate=settings?BigInt(Math.round(Number(settings.redeemValue)*100)):0n;
  const points=/^\d+$/.test(raw)?Number(raw):0;
  const value=Number.isSafeInteger(points)?BigInt(points)*rate:0n;
  const valid=raw==='' || (Number.isSafeInteger(points) && /^\d+$/.test(raw) && points<=1000000000 && (points===0 || points>=(settings?.minimumRedeemPoints ?? 1)) && BigInt(points)<=BigInt(balance) && value<=total);
  useEffect(()=>{onChange(cash && valid?points:0,cash && valid?value:0n,valid);},[points,value,valid,cash,onChange]);
  if(!customerId || !available) return null;
  if(error) return <Alert tone="warning">{error}</Alert>;
  if(!settings?.enabled) return null;
  return <div className="loyalty-checkout"><strong>Loyalty balance: {balance} points</strong>
    {cash?<><TextField label="Points to redeem" inputMode="numeric" value={raw} onChange={event=>setRaw(event.target.value)} hint={`1 point = KSh ${settings.redeemValue}. Minimum ${settings.minimumRedeemPoints}.`} error={!valid?'Enter whole points within the available balance and purchase value.':''}/>{value>0n && valid?<p>Points payment: KSh {(Number(value)/100).toFixed(2)}</p>:null}</>:<p>Paid purchases earn points. To redeem points, choose cash checkout.</p>}
    {entries.length?<details><summary>Recent points history</summary><ul>{entries.slice(0,8).map(entry=><li key={entry.id}>{new Date(entry.createdAt).toLocaleDateString()} · {entry.kind.replaceAll('_',' ')} · {entry.points} points</li>)}</ul></details>:null}
  </div>;
}
