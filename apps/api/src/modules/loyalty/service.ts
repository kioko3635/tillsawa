import { z } from 'zod';
import type pg from 'pg';
import type { Request } from 'express';
import type { AuthContext } from '../../http/middleware/auth.js';
import type { Queryable } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { decimalToMinorUnits, minorUnitsToDecimal } from '../../shared/money.js';
import { recordAudit } from '../audit/audit.js';

const positiveMoney = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/).refine(value => decimalToMinorUnits(value)>0n, 'Enter a value greater than zero');
export const loyaltySettingsSchema = z.object({ enabled: z.boolean(), earnSpend: positiveMoney, redeemValue: positiveMoney, minimumRedeemPoints: z.number().int().min(1).max(1000000000) }).strict();
export async function loyaltySettings(db: Queryable, organizationId: string) {
  const result = await db.query('SELECT * FROM loyalty_settings WHERE organization_id=$1', [organizationId]);
  const row = result.rows[0];
  return { enabled: row?.enabled ?? false, earnSpend: minorUnitsToDecimal(String(row?.earn_spend_minor ?? 10000)), redeemValue: minorUnitsToDecimal(String(row?.redeem_value_minor ?? 100)), minimumRedeemPoints: Number(row?.minimum_redeem_points ?? 1) };
}
export async function updateLoyaltySettings(pool: pg.Pool, auth: AuthContext, input: z.infer<typeof loyaltySettingsSchema>, req: Request) {
  await withTransaction(pool, async tx => {
    await tx.query(`INSERT INTO loyalty_settings (organization_id,enabled,earn_spend_minor,redeem_value_minor,minimum_redeem_points) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id) DO UPDATE SET enabled=$2,earn_spend_minor=$3,redeem_value_minor=$4,minimum_redeem_points=$5,updated_at=now()`, [auth.organizationId,input.enabled,decimalToMinorUnits(input.earnSpend).toString(),decimalToMinorUnits(input.redeemValue).toString(),input.minimumRedeemPoints]);
    await recordAudit(tx,{organizationId:auth.organizationId,actorMembershipId:auth.membershipId,actorUserId:auth.userId,action:'loyalty.settings-updated',entityType:'organization',entityId:auth.organizationId,metadata:input,ipAddress:req.ip ?? null,userAgent:req.header('user-agent') ?? null});
  });
  return loyaltySettings(pool,auth.organizationId);
}
export async function loyaltyBalance(db: Queryable, organizationId: string, customerId: string) {
  const result = await db.query('SELECT COALESCE(SUM(points_delta),0)::text AS balance FROM loyalty_entries WHERE organization_id=$1 AND customer_id=$2',[organizationId,customerId]);
  return BigInt(result.rows[0]!.balance);
}
export async function customerLoyalty(db: Queryable, organizationId: string, customerId: string) {
  const customer = await db.query('SELECT id,name FROM customers WHERE organization_id=$1 AND id=$2',[organizationId,customerId]);
  if (!customer.rows[0]) throw notFound('Customer was not found');
  const entries = await db.query(`SELECT id,sale_id AS "saleId",points_delta::text AS points,kind,created_at AS "createdAt" FROM loyalty_entries WHERE organization_id=$1 AND customer_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50`,[organizationId,customerId]);
  return { customerName: customer.rows[0].name as string, balance:(await loyaltyBalance(db,organizationId,customerId)).toString(), entries: entries.rows };
}
export async function prepareLoyalty(db: Queryable, auth: AuthContext, customerId: string | null | undefined, points: number, method: string, total: bigint, provisional: boolean) {
  const settings = await loyaltySettings(db,auth.organizationId);
  if (points && (!customerId || !settings.enabled || method!=='cash' || provisional)) throw badRequest('LOYALTY_REDEMPTION_UNAVAILABLE','Select a customer and use cash checkout with an active loyalty scheme to redeem points. The local POS server must be available.');
  if (!customerId || !settings.enabled || method==='credit' || provisional) return null;
  const balance = await loyaltyBalance(db,auth.organizationId,customerId);
  if (points && (points<settings.minimumRedeemPoints || BigInt(points)>balance)) throw conflict('LOYALTY_BALANCE_EXCEEDED','The points requested are below the minimum or exceed this customer’s available balance.');
  const redeemedMinor = BigInt(points)*decimalToMinorUnits(settings.redeemValue);
  if (redeemedMinor>total) throw badRequest('LOYALTY_VALUE_EXCEEDS_SALE','Redeemed points cannot exceed the purchase total.');
  return { customerId, points:BigInt(points), redeemedMinor, earned:(total-redeemedMinor)/decimalToMinorUnits(settings.earnSpend) };
}
export async function postLoyalty(tx: pg.PoolClient,auth:AuthContext,saleId:string,loyalty:Awaited<ReturnType<typeof prepareLoyalty>>) {
  if (!loyalty) return;
  for (const [kind,delta] of [['earn',loyalty.earned],['redeem',-loyalty.points]] as const) {
    if (delta) await tx.query('INSERT INTO loyalty_entries (organization_id,customer_id,sale_id,points_delta,kind) VALUES ($1,$2,$3,$4,$5)',[auth.organizationId,loyalty.customerId,saleId,delta.toString(),kind]);
  }
  const balance = await loyaltyBalance(tx,auth.organizationId,loyalty.customerId);
  await tx.query('INSERT INTO loyalty_sale_summaries (sale_id,organization_id,customer_id,earned,redeemed,redeemed_minor,balance_after) VALUES ($1,$2,$3,$4,$5,$6,$7)',[saleId,auth.organizationId,loyalty.customerId,loyalty.earned.toString(),loyalty.points.toString(),loyalty.redeemedMinor.toString(),balance.toString()]);
}
export async function saleLoyalty(db:Queryable,organizationId:string,saleId:string) {
  const result=await db.query(`SELECT earned::text,redeemed::text,redeemed_minor::text,balance_after::text,reversed_earned::text,restored_redeemed::text FROM loyalty_sale_summaries WHERE organization_id=$1 AND sale_id=$2`,[organizationId,saleId]);
  const row=result.rows[0];
  return row?{earned:row.earned as string,redeemed:row.redeemed as string,redeemedValue:minorUnitsToDecimal(row.redeemed_minor as string),balanceAfter:row.balance_after as string,reversedEarned:row.reversed_earned as string,restoredRedeemed:row.restored_redeemed as string}:null;
}
// Allocate the actual cash paid across lines using cumulative integer allocation.
// Returning all quantities yields exactly the original cash payment, including rounding.
export async function loyaltyReturnCash(db:Queryable,organizationId:string,saleId:string,lineId:string,quantity:string) {
  const result=await db.query(`WITH amounts AS (
    SELECT i.id,i.quantity,i.returned_qty,i.total_minor,
      COALESCE(SUM(i.total_minor) OVER (ORDER BY i.created_at,i.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS before,
      s.total_minor AS sale_total,ls.redeemed_minor
    FROM sale_items i JOIN sales s ON s.id=i.sale_id AND s.organization_id=i.organization_id
    JOIN loyalty_sale_summaries ls ON ls.sale_id=s.id AND ls.organization_id=s.organization_id
    WHERE i.organization_id=$1 AND i.sale_id=$2 AND ls.redeemed_minor>0
  ), allocated AS (SELECT *,floor((before+total_minor)*(sale_total-redeemed_minor)/NULLIF(sale_total,0))-floor(before*(sale_total-redeemed_minor)/NULLIF(sale_total,0)) AS cash FROM amounts)
  SELECT (floor(cash*(returned_qty+$4::numeric)/quantity)-floor(cash*returned_qty/quantity))::bigint::text AS refundable FROM allocated WHERE id=$3`,[organizationId,saleId,lineId,quantity]);
  return result.rows[0]?BigInt(result.rows[0].refundable):null;
}
export async function reconcileLoyalty(tx:pg.PoolClient,organizationId:string,saleId:string,voided=false) {
  const result=await tx.query('SELECT ls.*,s.total_minor FROM loyalty_sale_summaries ls JOIN sales s ON s.id=ls.sale_id AND s.organization_id=ls.organization_id WHERE ls.organization_id=$1 AND ls.sale_id=$2 FOR UPDATE OF ls',[organizationId,saleId]);
  const row=result.rows[0]; if(!row) return;
  await tx.query('SELECT id FROM customers WHERE organization_id=$1 AND id=$2 FOR UPDATE',[organizationId,row.customer_id]);
  const ratios=await tx.query(`SELECT
    COALESCE((SELECT SUM(i.total_minor*i.returned_qty/NULLIF(i.quantity,0)) FROM sale_items i WHERE i.organization_id=$1 AND i.sale_id=$2)/NULLIF($3::numeric,0),0)::text AS returned_ratio,
    COALESCE((SELECT SUM(f.amount_minor) FROM sale_refunds f WHERE f.organization_id=$1 AND f.sale_id=$2)/NULLIF(($3::numeric-$4::numeric),0),0)::text AS refunded_ratio`,[organizationId,saleId,String(row.total_minor),String(row.redeemed_minor)]);
  // PostgreSQL numeric keeps fractional return quantities exact before flooring points.
  const target=await tx.query(`SELECT floor($1::numeric*LEAST(1,GREATEST($3::numeric,$4::numeric)))::bigint::text AS reverse, floor($2::numeric*LEAST(1,$3::numeric))::bigint::text AS restore`,[String(row.earned),String(row.redeemed),voided?'1':ratios.rows[0].returned_ratio,voided?'1':ratios.rows[0].refunded_ratio]);
  const reverse=BigInt(target.rows[0].reverse),restore=BigInt(target.rows[0].restore);
  for(const [kind,delta] of [['reverse_earn',-(reverse-BigInt(row.reversed_earned))],['restore_redeem',restore-BigInt(row.restored_redeemed)]] as const) {
    if(delta) await tx.query('INSERT INTO loyalty_entries (organization_id,customer_id,sale_id,points_delta,kind) VALUES ($1,$2,$3,$4,$5)',[organizationId,row.customer_id,saleId,delta.toString(),kind]);
  }
  await tx.query('UPDATE loyalty_sale_summaries SET reversed_earned=$3,restored_redeemed=$4 WHERE organization_id=$1 AND sale_id=$2',[organizationId,saleId,reverse.toString(),restore.toString()]);
}
