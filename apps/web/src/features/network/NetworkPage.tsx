import { unitLabel } from '@pos/contracts';
import { useCallback,useEffect,useMemo,useState } from 'react';
import { useAuth } from '../../app/useAuth';
import { api } from '../../lib/api/client';
import { Alert,Badge,Button,Card,EmptyState,PageHeader,SelectField,Spinner,TextField } from '../../design-system/components';
import type { NetworkLink,NetworkStore,StoreSnapshot } from './types';

const money=(amount:string,currency='KES')=>`${currency} ${Number(amount).toLocaleString('en-KE',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const time=(value:string|null)=>value?new Date(value).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'}):'Not received yet';
function minor(value:string) {const negative=value.startsWith('-');const [whole,fraction='']=value.replace(/^-/,'').split('.');return (negative?-1n:1n)*(BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0').slice(0,2)));}
function decimal(value:bigint) {const absolute=value<0n?-value:value;return `${value<0n?'-':''}${absolute/100n}.${(absolute%100n).toString().padStart(2,'0')}`;}
function dateInZone(value:Date,zone:string) {const parts=new Intl.DateTimeFormat('en',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);return ['year','month','day'].map(type=>parts.find(part=>part.type===type)?.value).join('-');}
function figures(snapshot:StoreSnapshot,period:string) {
  if(period==='all') return {sales:snapshot.sales.grossSales,count:snapshot.sales.count,expenses:snapshot.expenses.paid};
  const days=period==='today'?1:Number(period);
  const from=dateInZone(new Date(Date.now()-(days-1)*86400000),snapshot.timezone),to=dateInZone(new Date(),snapshot.timezone);
  const rows=snapshot.daily.filter(row=>row.date>=from && row.date<=to);
  return {sales:decimal(rows.reduce((sum,row)=>sum+minor(row.sales),0n)),count:rows.reduce((sum,row)=>sum+row.saleCount,0),expenses:decimal(rows.reduce((sum,row)=>sum+minor(row.paidExpenses),0n))};
}

export function NetworkPage() {
  const {bootstrap,hasPermission}=useAuth();const canManage=hasPermission('stores.manage');
  const [hub,setHub]=useState<boolean|null>(null),[stores,setStores]=useState<NetworkStore[]>([]),[links,setLinks]=useState<NetworkLink[]>([]);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[key,setKey]=useState('');
  const [name,setName]=useState(''),[code,setCode]=useState(''),[selected,setSelected]=useState(''),[period,setPeriod]=useState('today'),[stockSearch,setStockSearch]=useState('');
  const [branchId,setBranchId]=useState(''),[hubUrl,setHubUrl]=useState(''),[pairing,setPairing]=useState('');
  const load=useCallback(async()=>{
    const configuration=await api.networkConfiguration();setHub(configuration.hub);
    if(configuration.hub)setStores((await api.networkStores()).stores);
    else if(canManage)setLinks((await api.networkLinks()).links);
  },[canManage]);
  useEffect(()=>{let live=true;const refresh=()=>{if(live)void load().then(()=>{if(live)setError('');}).catch(err=>{if(live)setError(err instanceof Error?err.message:'Unable to load linked stores.');});};refresh();const timer=window.setInterval(refresh,30000);return()=>{live=false;window.clearInterval(timer);};},[load]);
  async function action(operation:()=>Promise<void>) {setBusy(true);setError('');setMessage('');try {await operation();await load();} catch(err){setError(err instanceof Error?err.message:'The operation failed.');} finally {setBusy(false);}}
  const visible=stores.filter(store=>!store.revoked && (!selected || store.id===selected));
  const totals=useMemo(()=>{
    const groups=new Map<string,{sales:bigint;expenses:bigint;stock:bigint;count:number}>();
    for(const store of stores.filter(item=>!item.revoked && (!selected || item.id===selected))) {
      if(!store.snapshot)continue;const snapshot=store.snapshot,figure=figures(snapshot,period);
      const group=groups.get(snapshot.currency) || {sales:0n,expenses:0n,stock:0n,count:0};
      group.sales+=minor(figure.sales);group.expenses+=minor(figure.expenses);group.stock+=minor(snapshot.inventory.stockValue);group.count+=figure.count;groups.set(snapshot.currency,group);
    }
    return [...groups.entries()];
  },[stores,selected,period]);
  const detail=selected?stores.find(store=>store.id===selected):null;
  if(hub===null && !error)return <Spinner label="Loading store connections"/>;
  return <div className="page-stack">
    <PageHeader title={hub?'All stores':'Remote owner dashboard'} description={hub?'Choose a store or compare your company. Figures are the last snapshots received from each local store.':'Link this local shop to your company’s hosted dashboard. Cashiers continue using the local database.'}/>
    {error?<Alert tone="danger">{error}</Alert>:null}{message?<Alert tone="success">{message}</Alert>:null}
    {hub?<>
      <Card title="Company overview" subtitle="Gross sales and paid expenses follow the selected period. Stock value is the latest uploaded balance; currencies are never added together.">
        <div className="form-grid">
          <SelectField label="Store" value={selected} onChange={event=>setSelected(event.target.value)}><option value="">All active stores</option>{stores.filter(store=>!store.revoked).map(store=><option key={store.id} value={store.id}>{store.name}</option>)}</SelectField>
          <SelectField label="Sales period" value={period} onChange={event=>setPeriod(event.target.value)}><option value="today">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="all">All recorded dates</option></SelectField>
        </div>
        {totals.map(([currency,total])=><dl className="detail-list" key={currency}><div><dt>Gross sales ({total.count} sales)</dt><dd>{money(decimal(total.sales),currency)}</dd></div><div><dt>Paid expenses</dt><dd>{money(decimal(total.expenses),currency)}</dd></div><div><dt>Current stock value</dt><dd>{money(decimal(total.stock),currency)}</dd></div></dl>)}
        <p>These are reporting copies, not a live connection to the tills. Gross sales are not net cash or net profit. Return/refund totals appear in store details.</p>
      </Card>
      {visible.some(store=>store.stale || !store.snapshot)?<Alert tone="warning">Some stores have not sent a current update. Their figures may exclude recent activity. Local stores can continue selling while offline.</Alert>:null}
      {visible.some(store=>Number(store.snapshot?.sales.testSales || 0)>0)?<Alert tone="warning">Uploaded records include simulated or sandbox sales. Those test payments moved no money.</Alert>:null}
      <Card title="Store status"><div className="table-wrap"><table><thead><tr><th>Store</th><th>Status</th><th>Gross sales</th><th>Stock value</th><th>Captured at store</th><th>Received centrally</th></tr></thead><tbody>{visible.map(store=>{const snapshot=store.snapshot;return <tr key={store.id}><td><button type="button" onClick={()=>setSelected(store.id)}>{store.name}</button><br/>{store.code}</td><td><Badge tone={store.stale?'warning':'success'}>{!snapshot?'Awaiting first upload':store.stale?'Update overdue':'Recently synced'}</Badge></td><td>{snapshot?money(figures(snapshot,period).sales,snapshot.currency):'—'}</td><td>{snapshot?money(snapshot.inventory.stockValue,snapshot.currency):'—'}</td><td>{time(snapshot?.capturedAt || null)}</td><td>{time(store.lastReceivedAt)}</td></tr>;})}</tbody></table></div>{!stores.length?<EmptyState title="No linked stores" description="Create a store below, then pair its local POS using the generated code."/>:null}</Card>
      {detail?.snapshot?<StoreDetails snapshot={detail.snapshot} search={stockSearch} onSearch={setStockSearch}/>:null}
      {canManage?<>
        <Card title="Add a store" subtitle="Create the company once here. Every local shop keeps its own database and is linked with its own private pairing code."><form className="form-stack" onSubmit={event=>{event.preventDefault();void action(async()=>{const result=await api.createNetworkStore({code,name});setKey(result.pairingCode);setName('');setCode('');});}}><TextField label="Store code" value={code} onChange={event=>setCode(event.target.value)} placeholder="THIKA" required/><TextField label="Store name" value={name} onChange={event=>setName(event.target.value)} placeholder="Thika shop" required/><Button type="submit" loading={busy}>Create store and pairing code</Button></form></Card>
        {key?<Card title="Private store pairing code" subtitle="Copy this into the local shop’s Remote owner dashboard screen. It expires after 24 hours if unused. Keep it private; it grants reporting upload access."><textarea aria-label="Store pairing code" readOnly value={key} rows={3}/><Button variant="secondary" onClick={()=>setKey('')}>Hide pairing code</Button></Card>:null}
        <Card title="Manage store access"><div className="detail-stack">{stores.map(store=><div className="button-row" key={store.id}><strong>{store.name}{store.revoked?' (revoked)':''}</strong><Button disabled={busy} variant="secondary" onClick={()=>{if(window.confirm('Generate a new code? The current store connection stops working until paired again.'))void action(async()=>setKey((await api.rotateNetworkStore(store.id)).pairingCode));}}>New pairing code</Button><Button disabled={busy || store.revoked} variant="secondary" onClick={()=>{if(window.confirm('Stop accepting uploads from this store? Existing reports will be retained.'))void action(async()=>{await api.revokeNetworkStore(store.id);});}}>Revoke connection</Button></div>)}</div></Card>
      </>:null}
    </>:canManage?<>
      <Card title="Connect this store" subtitle="First prepare the hosted central dashboard and create a store there. This connection uploads report figures; it does not merge databases or alter local stock."><form className="form-stack" onSubmit={event=>{event.preventDefault();void action(async()=>{const result=await api.connectNetworkStore({branchId:branchId || bootstrap?.branches[0]?.id || '',hubUrl,pairingCode:pairing.trim()});setPairing('');const synced=await api.syncNetworkLink(result.id);if(synced.error)setError(synced.error);setMessage(`Connected to ${result.storeName}. Automatic reporting runs about once a minute while this server is running.`);});}}><SelectField label="Local branch to upload" value={branchId || bootstrap?.branches[0]?.id || ''} onChange={event=>setBranchId(event.target.value)} required>{bootstrap?.branches.map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</SelectField><TextField label="Central dashboard address" value={hubUrl} onChange={event=>setHubUrl(event.target.value)} placeholder="https://dashboard.yourcompany.co.ke" required/><TextField label="Private store pairing code" type="password" value={pairing} onChange={event=>setPairing(event.target.value)} required/><p>Shares sales totals, daily sales and expenses, cashier totals, latest 100 sales and up to 500 stock items. Customer contact details and payment credentials are not uploaded.</p><Button type="submit" loading={busy}>Connect store</Button></form></Card>
      <Card title="Connection status"><div className="detail-stack">{links.map(link=><section key={link.id}><h3>{link.branchName}</h3><p>{link.hubUrl}</p><p>{link.enabled?'Automatic reporting enabled':'Uploads paused'} · Last successful upload: {time(link.lastSuccessAt)}{link.pending?' · Saved upload awaiting acknowledgement':''}</p>{link.lastError?<Alert tone="warning">{link.lastError}</Alert>:null}<div className="button-row"><Button disabled={busy || !link.enabled} onClick={()=>void action(async()=>{const result=await api.syncNetworkLink(link.id);if(result.error)throw new Error(result.error);setMessage(result.busy?'An upload is already running.':'Store report sent.');})}>Sync now</Button><Button disabled={busy} variant="secondary" onClick={()=>void action(async()=>{await api.enableNetworkLink(link.id,!link.enabled);})}>{link.enabled?'Pause uploads':'Resume uploads'}</Button></div></section>)}</div>{!links.length?<p>No central connection configured. Local trading continues normally.</p>:null}</Card>
    </>:<Alert tone="info">The owner manages local store connections.</Alert>}
  </div>;
}

function StoreDetails({snapshot,search,onSearch}:{snapshot:StoreSnapshot;search:string;onSearch:(value:string)=>void}) {
  const stock=snapshot.stock.filter(item=>(item.name+' '+item.sku).toLowerCase().includes(search.toLowerCase()));
  return <>
    <Card title={`${snapshot.branchName}: all-time financial detail`}><dl className="detail-list">{[['Cash sales',snapshot.sales.cashSales],['M-Pesa sales',snapshot.sales.mpesaSales],['Card sales',snapshot.sales.cardSales],['Credit sales',snapshot.sales.creditSales],['Returns',snapshot.sales.returned],['Refunds',snapshot.sales.refunded],['Customer receivables',snapshot.debt.receivablesOutstanding],['Supplier payables',snapshot.debt.payablesOutstanding]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{money(value!,snapshot.currency)}</dd></div>)}</dl></Card>
    <Card title="Cashier activity" subtitle="All recorded dates; each store keeps its own staff identities."><div className="table-wrap"><table><thead><tr><th>Cashier</th><th>Sales count</th><th>Gross sales</th></tr></thead><tbody>{snapshot.cashiers.map(cashier=><tr key={cashier.membershipId}><td>{cashier.name}</td><td>{cashier.saleCount}</td><td>{money(cashier.sales,snapshot.currency)}</td></tr>)}</tbody></table></div></Card>
    <Card title="Stock at last upload" subtitle={`Showing ${snapshot.stock.length} of ${snapshot.stockItemCount} active stocked items, lowest quantities first. These are reporting balances; use the local shop to change stock.`}><TextField label="Search uploaded stock" value={search} onChange={event=>onSearch(event.target.value)}/><div className="table-wrap"><table><thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Base selling price</th></tr></thead><tbody>{stock.map(item=><tr key={item.id}><td>{item.name}</td><td>{item.sku}</td><td>{item.quantity} {unitLabel(item.unit)}</td><td>{money(item.price,snapshot.currency)}</td></tr>)}</tbody></table></div></Card>
    <Card title="Latest 100 sales" subtitle="Receipt summaries from the store; returns and refunds are reported separately above."><div className="table-wrap"><table><thead><tr><th>Receipt</th><th>When</th><th>Cashier</th><th>Status</th><th>Original total</th></tr></thead><tbody>{snapshot.recentSales.map(sale=><tr key={sale.id}><td>{sale.receipt}</td><td>{time(sale.soldAt)}</td><td>{sale.cashier}</td><td>{sale.status}</td><td>{money(sale.amount,snapshot.currency)}</td></tr>)}</tbody></table></div></Card>
  </>;
}
