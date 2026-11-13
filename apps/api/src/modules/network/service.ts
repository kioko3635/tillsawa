import { createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import { withTransaction } from '../../database/pool.js';
import { membershipHasBranchAccess,type AuthContext } from '../../http/middleware/auth.js';
import { badRequest,conflict,forbidden,notFound,unauthorized } from '../../shared/errors.js';
import { minorUnitsToDecimal } from '../../shared/money.js';
import { getOperationsReport } from '../reports/service.js';
import { hubOrigin,pairingCode,snapshotSchema,type StoreSnapshot } from './schema.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function protectToken(value:string,secret:string) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',createHash('sha256').update('store-link:'+secret).digest(),iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),encrypted].map(part=>part.toString('base64url')).join('.');
}
export function revealToken(value:string,secret:string) {
  const [iv,tag,data]=value.split('.').map(part=>Buffer.from(part,'base64url'));
  if(!iv || !tag || !data) throw new Error('Store connection credentials need to be paired again.');
  const decipher=createDecipheriv('aes-256-gcm',createHash('sha256').update('store-link:'+secret).digest(),iv);decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8');
}
function requireHub(config:AppConfig) {if(!config.multiStoreHub) throw forbidden('CENTRAL_SERVICE_REQUIRED','This operation belongs on the hosted central dashboard.');}
function requireStore(config:AppConfig) {if(config.multiStoreHub) throw forbidden('STORE_SERVICE_REQUIRED','Connect the local shop application, not the central dashboard.');}

export async function createNetworkStore(pool:pg.Pool,config:AppConfig,auth:AuthContext,input:{code:string;name:string}) {
  requireHub(config);const token=randomBytes(32).toString('base64url');
  try {
    const result=await pool.query(`INSERT INTO network_stores(organization_id,code,name,token_hash,pairing_expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours') RETURNING id,code,name`,[auth.organizationId,input.code.toUpperCase(),input.name,hash(token)]);
    return {store:result.rows[0],pairingCode:`POSLINK.${result.rows[0].id}.${token}`};
  } catch(error) {if((error as {code?:string}).code==='23505') throw conflict('STORE_CODE_EXISTS','A store with that code already exists.');throw error;}
}
export async function rotateNetworkStore(pool:pg.Pool,config:AppConfig,auth:AuthContext,id:string) {
  requireHub(config);const token=randomBytes(32).toString('base64url');
  const result=await pool.query(`UPDATE network_stores SET token_hash=$3,pairing_expires_at=now()+interval '24 hours',revoked_at=NULL,last_sequence=0,last_snapshot_id=NULL WHERE id=$1 AND organization_id=$2 RETURNING id,code,name`,[id,auth.organizationId,hash(token)]);
  if(!result.rows[0]) throw notFound();
  return {store:result.rows[0],pairingCode:`POSLINK.${id}.${token}`};
}
export async function revokeNetworkStore(pool:pg.Pool,config:AppConfig,auth:AuthContext,id:string) {
  requireHub(config);const result=await pool.query('UPDATE network_stores SET revoked_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id',[id,auth.organizationId]);
  if(!result.rows[0]) throw notFound();return {revoked:true};
}

// Machine endpoints use the system pool with a high-entropy per-store credential
// fixing the tenant/store. The snapshot job below also uses explicit org/branch
// scope. Owner management reads and writes remain on the ordinary tenant pool.
async function authenticatedStore(db:pg.Pool|pg.PoolClient,config:AppConfig,code:string,lock=false) {
  requireHub(config);let parsed;
  try {parsed=pairingCode(code);} catch {throw unauthorized('STORE_KEY_INVALID','Invalid store connection credential.');}
  const result=await db.query(`SELECT * FROM network_stores WHERE id=$1 AND token_hash=$2 AND revoked_at IS NULL AND (pairing_expires_at IS NULL OR pairing_expires_at>now()) ${lock?'FOR UPDATE':''}`,[parsed.storeId,hash(parsed.token)]);
  if(!result.rows[0]) throw unauthorized('STORE_KEY_INVALID','The store connection was revoked, expired or is invalid. Generate a fresh pairing code on the central dashboard.');
  return result.rows[0];
}
export async function identifyNetworkStore(systemPool:pg.Pool,config:AppConfig,code:string) {
  const store=await authenticatedStore(systemPool,config,code);return {storeId:store.id,name:store.name,version:1};
}
export async function receiveSnapshot(systemPool:pg.Pool,config:AppConfig,code:string,snapshot:StoreSnapshot) {
  if(Date.parse(snapshot.capturedAt)>Date.now()+300000) throw badRequest('STORE_CLOCK_AHEAD','Correct the store computer date and time before syncing.');
  return withTransaction(systemPool,async tx=>{
    const store=await authenticatedStore(tx,config,code,true);
    if(store.source_organization_id && (store.source_organization_id!==snapshot.sourceOrganizationId || store.source_branch_id!==snapshot.sourceBranchId)) throw conflict('STORE_IDENTITY_CHANGED','This code is already linked to another shop or branch. Create a separate store entry.');
    const sequence=Number(store.last_sequence);
    if(snapshot.sequence<sequence) return {accepted:true,sequence,replayed:true};
    if(snapshot.sequence===sequence) {
      if(store.last_snapshot_id!==snapshot.snapshotId) throw conflict('STORE_SEQUENCE_CONFLICT','This store has conflicting upload sequences. Stop copied store databases and pair this store again.');
      return {accepted:true,sequence,replayed:true};
    }
    try {
      await tx.query(`UPDATE network_stores SET source_organization_id=$2,source_branch_id=$3,last_sequence=$4,last_snapshot_id=$5,last_received_at=now(),snapshot=$6::jsonb,pairing_expires_at=NULL WHERE id=$1`,[store.id,snapshot.sourceOrganizationId,snapshot.sourceBranchId,snapshot.sequence,snapshot.snapshotId,JSON.stringify(snapshot)]);
    } catch(error) {if((error as {code?:string}).code==='23505') throw conflict('STORE_ALREADY_LINKED','This local branch is already linked to another active store in this company.');throw error;}
    return {accepted:true,sequence:snapshot.sequence,replayed:false};
  });
}
export async function listNetworkStores(pool:pg.Pool,config:AppConfig,auth:AuthContext) {
  requireHub(config);
  const result=await pool.query('SELECT id,code,name,revoked_at,last_received_at,snapshot,pairing_expires_at FROM network_stores WHERE organization_id=$1 ORDER BY name',[auth.organizationId]);
  return result.rows.map(row=>({id:row.id,code:row.code,name:row.name,revoked:!!row.revoked_at,lastReceivedAt:row.last_received_at,snapshot:row.snapshot,pairingExpiresAt:row.pairing_expires_at,stale:!!row.pairing_expires_at || !row.last_received_at || Date.now()-new Date(row.last_received_at).getTime()>180000 || !row.snapshot || Date.now()-Date.parse(row.snapshot.capturedAt)>180000}));
}
export async function listLinks(pool:pg.Pool,auth:AuthContext) {
  const result=await pool.query(`SELECT l.id,l.branch_id AS "branchId",b.name AS "branchName",l.hub_url AS "hubUrl",l.hub_store_id AS "storeId",l.enabled,l.last_success_at AS "lastSuccessAt",l.last_attempt_at AS "lastAttemptAt",l.last_error AS "lastError",l.pending_snapshot IS NOT NULL AS pending FROM network_links l JOIN branches b ON b.id=l.branch_id AND b.organization_id=l.organization_id WHERE l.organization_id=$1 ORDER BY b.name`,[auth.organizationId]);
  return result.rows;
}
async function hubRequest(url:string,code:string,path:string,body?:unknown) {
  let response:Response;
  try {response=await fetch(url+'/api/v1/network/machine/'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+code,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});} catch {throw new Error('Central service is unreachable. Check internet and the dashboard address. Local trading can continue.');}
  const text=await response.text();if(text.length>64000) throw new Error('Unexpected response from central service.');
  let data;try {data=JSON.parse(text);} catch {throw new Error('The central address did not return a POS response.');}
  if(!response.ok) throw new Error(String(data.error?.message || 'Central service rejected the upload.').slice(0,500));
  return data.data;
}
export async function connectStore(pool:pg.Pool,config:AppConfig,auth:AuthContext,input:{branchId:string;hubUrl:string;pairingCode:string}) {
  requireStore(config);
  if(!await membershipHasBranchAccess(pool,auth,input.branchId)) throw forbidden('BRANCH_ACCESS_DENIED','Branch access denied.');
  let origin:string,parsed;
  try {origin=hubOrigin(input.hubUrl);parsed=pairingCode(input.pairingCode);} catch(error) {throw badRequest('INVALID_STORE_CONNECTION',(error as Error).message);}
  const identity=await hubRequest(origin,input.pairingCode,'identify');
  if(identity?.storeId!==parsed.storeId || identity.version!==1) throw badRequest('INVALID_CENTRAL_SERVICE','The central service did not identify the expected store.');
  const result=await withTransaction(pool,async tx=>{
    const previous=await tx.query('SELECT id FROM network_links WHERE organization_id=$1 AND branch_id=$2',[auth.organizationId,input.branchId]);
    if(previous.rows[0]) {
      const lock=await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',['network-link:'+previous.rows[0].id]);
      if(!lock.rows[0].locked) throw conflict('STORE_SYNC_BUSY','An upload is running. Wait a moment before changing this connection.');
    }
    return tx.query(`INSERT INTO network_links(organization_id,branch_id,hub_url,hub_store_id,encrypted_token) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,branch_id) DO UPDATE SET hub_url=EXCLUDED.hub_url,hub_store_id=EXCLUDED.hub_store_id,encrypted_token=EXCLUDED.encrypted_token,enabled=true,pending_snapshot=NULL,last_error=NULL RETURNING id`,[auth.organizationId,input.branchId,origin,parsed.storeId,protectToken(input.pairingCode,config.accessTokenSecret)]);
  });
  return {id:result.rows[0].id,storeName:identity.name};
}
export async function setLinkEnabled(pool:pg.Pool,auth:AuthContext,id:string,enabled:boolean) {
  const result=await pool.query('UPDATE network_links SET enabled=$3 WHERE id=$1 AND organization_id=$2 RETURNING id',[id,auth.organizationId,enabled]);
  if(!result.rows[0]) throw notFound();return {enabled};
}

export async function captureSnapshot(tx:pg.PoolClient,organizationId:string,branchId:string,sequence:number):Promise<StoreSnapshot> {
  const branch=await tx.query('SELECT name FROM branches WHERE id=$1 AND organization_id=$2',[branchId,organizationId]);
  if(!branch.rows[0]) throw new Error('The linked branch no longer exists.');
  // System job only: explicit org/branch scope, consistent local read snapshot.
  const auth={organizationId,allBranches:true} as AuthContext;
  const report=await getOperationsReport(tx as unknown as pg.Pool,auth,{branchId});
  const stock=await tx.query(`SELECT p.id,p.sku,p.name,u.code AS unit,COALESCE(sl.on_hand_qty,0)::text AS quantity,p.base_price_minor::text AS price_minor,count(*) OVER()::int AS item_count FROM products p JOIN units_of_measure u ON u.id=p.base_unit_id AND u.organization_id=p.organization_id LEFT JOIN stock_levels sl ON sl.product_id=p.id AND sl.organization_id=p.organization_id AND sl.branch_id=$2 WHERE p.organization_id=$1 AND p.item_type='stocked' AND p.status='active' ORDER BY COALESCE(sl.on_hand_qty,0),p.sku LIMIT 500`,[organizationId,branchId]);
  const recent=await tx.query(`SELECT s.id,s.receipt_number,s.status,s.sold_at,s.total_minor::text,u.display_name FROM sales s JOIN memberships m ON m.id=s.cashier_membership_id AND m.organization_id=s.organization_id JOIN users u ON u.id=m.user_id WHERE s.organization_id=$1 AND s.branch_id=$2 ORDER BY s.sold_at DESC,s.id LIMIT 100`,[organizationId,branchId]);
  return snapshotSchema.parse({version:1,snapshotId:randomUUID(),sequence,sourceOrganizationId:organizationId,sourceBranchId:branchId,capturedAt:report.generatedAt,currency:report.currencyCode,timezone:report.timezone,branchName:branch.rows[0].name,sales:report.sales,expenses:report.expenses,inventory:report.inventory,debt:report.debt,daily:report.daily,cashiers:report.cashiers,stock:stock.rows.map(row=>({id:row.id,sku:row.sku,name:row.name,unit:row.unit,quantity:row.quantity,price:minorUnitsToDecimal(row.price_minor)})),stockItemCount:stock.rows[0]?.item_count ?? 0,recentSales:recent.rows.map(row=>({id:row.id,receipt:row.receipt_number,status:row.status,soldAt:row.sold_at.toISOString(),amount:minorUnitsToDecimal(row.total_minor),cashier:row.display_name}))});
}

export async function syncLink(systemPool:pg.Pool,config:AppConfig,id:string) {
  requireStore(config);const client=await systemPool.connect();let locked=false;
  try {
    locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',['network-link:'+id])).rows[0].locked;
    if(!locked) return {busy:true};
    const result=await client.query(`SELECT l.* FROM network_links l JOIN organizations o ON o.id=l.organization_id JOIN branches b ON b.id=l.branch_id AND b.organization_id=l.organization_id WHERE l.id=$1 AND l.enabled AND o.status='active' AND b.status='active'`,[id]);
    const link=result.rows[0];if(!link) return {disabled:true};
    await client.query('UPDATE network_links SET last_attempt_at=now() WHERE id=$1',[id]);
    let snapshot:StoreSnapshot=link.pending_snapshot;
    if(!snapshot) {
      snapshot=await withTransaction(client,async tx=>{
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const next=await tx.query('UPDATE network_links SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence',[id]);
        const captured=await captureSnapshot(tx,link.organization_id,link.branch_id,Number(next.rows[0].next_sequence));
        await tx.query('UPDATE network_links SET pending_snapshot=$2::jsonb WHERE id=$1',[id,JSON.stringify(captured)]);
        return captured;
      });
    }
    const code=revealToken(link.encrypted_token,config.accessTokenSecret);
    const ack=await hubRequest(hubOrigin(link.hub_url),code,'snapshot',snapshot);
    if(!ack?.accepted || !Number.isSafeInteger(ack.sequence) || ack.sequence<snapshot.sequence) throw new Error('The central service did not acknowledge this snapshot.');
    await client.query(`UPDATE network_links SET pending_snapshot=NULL,last_success_at=now(),last_error=NULL WHERE id=$1 AND pending_snapshot->>'snapshotId'=$2`,[id,snapshot.snapshotId]);
    return {synced:true,sequence:snapshot.sequence};
  } catch(error) {
    const message=(error as Error).message.slice(0,500);
    if(locked) await client.query('UPDATE network_links SET last_error=$2 WHERE id=$1',[id,message]).catch(()=>undefined);
    return {synced:false,error:message};
  } finally {
    if(locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['network-link:'+id]).catch(()=>undefined);
    client.release();
  }
}

export function startNetworkSync(systemPool:pg.Pool,config:AppConfig) {
  if(config.multiStoreHub) return ()=>{};
  let running=false,stopped=false;
  const tick=async()=>{
    if(running || stopped) return;running=true;
    try {const result=await systemPool.query('SELECT id FROM network_links WHERE enabled ORDER BY last_attempt_at NULLS FIRST LIMIT 50');for(const row of result.rows) {if(stopped) break;await syncLink(systemPool,config,row.id);}}
    catch { /* Checkout and startup must never depend on the internet worker. */ }
    finally {running=false;}
  };
  const timer=setInterval(()=>void tick(),60000);timer.unref();
  const initial=setTimeout(()=>void tick(),5000);initial.unref();
  return ()=>{stopped=true;clearInterval(timer);clearTimeout(initial);};
}
