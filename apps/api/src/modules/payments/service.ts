import type { CompleteSaleInput } from '@pos/contracts';
import type pg from 'pg';
import type { Request } from 'express';
import type { AppConfig } from '../../config/env.js';
import type { AuthContext } from '../../http/middleware/auth.js';
import { listAccessibleBranchIds } from '../../http/middleware/auth.js';
import { withTransaction } from '../../database/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { decimalToMinorUnits, minorUnitsToDecimal } from '../../shared/money.js';
import { recordAudit } from '../audit/audit.js';
import { quoteElectronicSale } from '../pos/service.js';
import { paymentCartHash } from './verification.js';
import { darajaConfigured, initiateDaraja, normalizeKenyanPhone, queryDaraja } from './daraja.js';

import { pesapalMerchantReference, pesapalTerminalConfigured, verifyPesapalTerminalPayment } from './pesapal.js';

type Provider = 'manual' | 'simulator' | 'daraja_sandbox' | 'pesapal_terminal';
function map(row: Record<string, unknown>) {
  return { id:row.id, clientTransactionId:row.client_transaction_id, method:row.method, provider:row.provider, status:row.status, amount:minorUnitsToDecimal(String(row.amount_minor)), reference:row.reference, message:row.result_message, saleId:row.sale_id, merchantReference: row.provider === 'pesapal_terminal' ? pesapalMerchantReference(String(row.client_transaction_id)) : null, createdAt:row.created_at };
}
async function owned(db: Pick<pg.Pool,'query'> | pg.PoolClient, auth: AuthContext, id: string, lock = false) {
  const result = await db.query(`SELECT * FROM payment_intents WHERE id=$1 AND organization_id=$2 AND membership_id=$3${lock ? ' FOR UPDATE' : ''}`, [id,auth.organizationId,auth.membershipId]);
  if (!result.rows[0]) throw notFound('Payment attempt was not found for this cashier');
  return result.rows[0];
}
async function audit(tx: pg.PoolClient, auth: AuthContext, id: string, action: string, metadata: Record<string,unknown>, req: Request) {
  await recordAudit(tx, { organizationId:auth.organizationId,actorMembershipId:auth.membershipId,actorUserId:auth.userId,entityType:'payment_intent',entityId:id,action,metadata,ipAddress:req.ip ?? null,userAgent:req.header('user-agent') ?? null });
}
export function paymentCapabilities(config: AppConfig, organizationId: string) {
  return { testMode:config.paymentTestMode, manual:true, simulator:config.paymentTestMode, darajaSandbox:darajaConfigured(config), pesapalTerminal: pesapalTerminalConfigured(config, organizationId), liveProcessing: pesapalTerminalConfigured(config, organizationId) };
}
export async function createPaymentIntent(pool: pg.Pool, config: AppConfig, auth: AuthContext, input: { sale:CompleteSaleInput; provider:Provider; phone?:string }, req: Request) {
  const sale = input.sale;
  if (!['mpesa','card'].includes(sale.payment.method)) throw badRequest('INVALID_PAYMENT_METHOD', 'Choose M-Pesa or card for electronic payment');
  if (input.provider === 'pesapal_terminal' && !pesapalTerminalConfigured(config, auth.organizationId)) throw forbidden('PESAPAL_NOT_CONFIGURED', 'Pesapal terminal verification is not configured for this shop');
  if (['simulator', 'daraja_sandbox'].includes(input.provider) && !config.paymentTestMode) throw forbidden('TEST_PAYMENTS_DISABLED','Payment testing is disabled');
  if (input.provider === 'daraja_sandbox' && (sale.payment.method !== 'mpesa' || !darajaConfigured(config))) throw badRequest('DARAJA_NOT_CONFIGURED','Daraja sandbox requires M-Pesa and configured local sandbox credentials');
  if (input.provider === 'daraja_sandbox') normalizeKenyanPhone(input.phone ?? '');
  const hash = paymentCartHash(sale);
  const previous = await pool.query('SELECT * FROM payment_intents WHERE organization_id=$1 AND client_transaction_id=$2', [auth.organizationId,sale.clientTransactionId]);
  if (previous.rows[0]) {
    const row = previous.rows[0];
    if (row.membership_id !== auth.membershipId || row.cart_hash !== hash || row.provider !== input.provider || row.method !== sale.payment.method) throw conflict('PAYMENT_IDENTIFIER_CONFLICT','This checkout identifier already belongs to another payment attempt');
    return map(row);
  }
  const quote = await quoteElectronicSale(pool, auth, sale);
  if (input.provider === 'pesapal_terminal' && quote.currency !== 'KES') throw badRequest('PESAPAL_CURRENCY', 'Pesapal terminal verification currently supports KES only');
  if (quote.amountMinor <= 0n) throw badRequest('INVALID_PAYMENT_AMOUNT','Electronic payment requires a positive total');
  if (input.provider === 'daraja_sandbox' && (quote.currency !== 'KES' || quote.amountMinor % 100n !== 0n || quote.amountMinor > 25000000n)) throw badRequest('DARAJA_AMOUNT','Sandbox M-Pesa requires whole Kenyan shillings from KSh 1 to KSh 250,000');
  const created = await withTransaction(pool, async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`payment:${auth.organizationId}:${sale.clientTransactionId}`]);
    const existing = await tx.query('SELECT * FROM payment_intents WHERE organization_id=$1 AND client_transaction_id=$2',[auth.organizationId,sale.clientTransactionId]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.membership_id !== auth.membershipId || row.cart_hash !== hash || row.provider !== input.provider || row.method !== sale.payment.method) throw conflict('PAYMENT_IDENTIFIER_CONFLICT','This checkout identifier already belongs to another payment attempt');
      return { row, fresh:false };
    }
    const result = await tx.query(`INSERT INTO payment_intents(organization_id,branch_id,membership_id,register_session_id,client_transaction_id,cart_hash,method,provider,amount_minor,result_message)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Waiting for payment confirmation') RETURNING *`, [auth.organizationId,quote.branchId,auth.membershipId,sale.registerSessionId,sale.clientTransactionId,hash,sale.payment.method,input.provider,quote.amountMinor.toString()]);
    await audit(tx,auth,result.rows[0].id,'payment.started',{method:sale.payment.method,provider:input.provider,amount:minorUnitsToDecimal(quote.amountMinor)},req);
    return { row:result.rows[0],fresh:true };
  });
  if (created.fresh && input.provider === 'daraja_sandbox') {
    try {
      const checkout = await initiateDaraja(config,quote.amountMinor,input.phone!,`POS${created.row.id.replace(/-/g,'').slice(0,9)}`);
      await pool.query(`UPDATE payment_intents SET external_request_id=$3,result_message='Sandbox prompt requested. Check its status before checkout.' WHERE id=$1 AND organization_id=$2`,[created.row.id,auth.organizationId,checkout]);
    } catch {
      await pool.query(`UPDATE payment_intents SET status='unknown',result_message='Initiation result is uncertain. Check the Daraja sandbox portal before starting another attempt; no automatic retry was sent.' WHERE id=$1 AND organization_id=$2`,[created.row.id,auth.organizationId]);
    }
  }
  return map(await owned(pool,auth,created.row.id));
}
export async function getPaymentIntent(pool: pg.Pool, auth: AuthContext, id: string) { return map(await owned(pool,auth,id)); }
export async function listPaymentIntents(pool: pg.Pool, auth: AuthContext) {
  const branches = await listAccessibleBranchIds(pool,auth);
  const result = await pool.query(`SELECT * FROM payment_intents WHERE organization_id=$1 AND branch_id=ANY($2::uuid[]) AND ($3::boolean OR membership_id=$4) ORDER BY created_at DESC LIMIT 50`,[auth.organizationId,branches,auth.permissions.has('sales.view_all'),auth.membershipId]);
  return result.rows.map(map);
}
export async function confirmManualPayment(pool: pg.Pool, auth: AuthContext, id: string, input: {reference:string;amount:string}, req:Request) {
  return withTransaction(pool,async tx => {
    const row = await owned(tx,auth,id,true);
    if (row.provider !== 'manual') throw badRequest('WRONG_PAYMENT_PROVIDER','This is not a manual confirmation');
    const reference = input.reference.trim().toUpperCase();
    if (row.method === 'mpesa' && !/^[A-Z0-9]{10,20}$/.test(reference)) throw badRequest('INVALID_REFERENCE','Enter the M-Pesa transaction code from the merchant account');
    if (row.status === 'paid') {
      if (row.reference !== reference) throw conflict('PAYMENT_ALREADY_CONFIRMED','This payment already has a different confirmed reference');
      return map(row);
    }
    if (row.status !== 'pending' || BigInt(row.amount_minor) !== decimalToMinorUnits(input.amount)) throw conflict('PAYMENT_AMOUNT_MISMATCH','Confirm the exact displayed amount on the merchant statement or terminal');
    try {
      const result = await tx.query(`UPDATE payment_intents SET status='paid',reference=$3,result_message='Manually checked by cashier; not provider-verified' WHERE id=$1 AND organization_id=$2 RETURNING *`,[id,auth.organizationId,reference]);
      await audit(tx,auth,id,'payment.manually-confirmed',{reference,amount:input.amount},req);
      return map(result.rows[0]);
    } catch (error) {
      if ((error as {code?:string}).code === '23505') throw conflict('PAYMENT_REFERENCE_USED','This transaction reference was already used in this business');
      throw error;
    }
  });
}
export async function verifyPesapalPayment(pool: pg.Pool, config: AppConfig, auth: AuthContext, id: string, reference: string, req: Request) {
  if (!pesapalTerminalConfigured(config, auth.organizationId)) throw forbidden('PESAPAL_NOT_CONFIGURED', 'Pesapal terminal verification is not configured for this shop');
  const row = await owned(pool, auth, id);
  if (row.provider !== 'pesapal_terminal') throw badRequest('WRONG_PAYMENT_PROVIDER', 'Choose a Pesapal terminal attempt');
  if (row.status === 'paid' && row.reference === reference) return map(row);
  if (row.status !== 'pending') throw conflict('PAYMENT_NOT_PENDING', 'This attempt cannot accept a different payment');
  await verifyPesapalTerminalPayment(config, { reference, merchantReference: pesapalMerchantReference(row.client_transaction_id), amount: BigInt(row.amount_minor), method: row.method });
  return withTransaction(pool, async tx => {
    const current = await owned(tx, auth, id, true);
    if (current.status === 'paid' && current.reference === reference) return map(current);
    if (current.status !== 'pending') throw conflict('PAYMENT_NOT_PENDING', 'This attempt cannot accept a different payment');
    try {
      const result = await tx.query(`UPDATE payment_intents SET status='paid',reference=$3,result_message='Verified by Pesapal terminal API' WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, auth.organizationId, reference]);
      await audit(tx, auth, id, 'payment.pesapal-verified', { reference }, req);
      return map(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('PAYMENT_REFERENCE_USED', 'This payment reference was already recorded');
      throw error;
    }
  });
}

export async function cancelUnpaidManualPayment(pool: pg.Pool, auth: AuthContext, id: string, req: Request) {
  return withTransaction(pool, async tx => {
    const row = await owned(tx, auth, id, true);
    if (!['manual', 'pesapal_terminal'].includes(row.provider) || !['pending', 'cancelled'].includes(row.status)) {
      throw conflict('PAYMENT_CANNOT_CANCEL', 'Only an unpaid terminal or manual attempt can be cancelled here.');
    }
    if (row.status === 'cancelled') return map(row);
    const result = await tx.query(`UPDATE payment_intents SET status='cancelled', result_message='Cashier confirmed no payment was received' WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, auth.organizationId]);
    await audit(tx, auth, id, 'payment.unpaid-cancelled', { provider: row.provider }, req);
    return map(result.rows[0]);
  });
}

export async function simulatePayment(pool: pg.Pool, config: AppConfig, auth: AuthContext, id:string, outcome:'paid'|'failed'|'cancelled', req:Request) {
  if (!config.paymentTestMode) throw forbidden('TEST_PAYMENTS_DISABLED','Payment simulation is disabled');
  return withTransaction(pool,async tx => {
    const row = await owned(tx,auth,id,true);
    if (row.provider !== 'simulator') throw badRequest('WRONG_PAYMENT_PROVIDER','Only a simulator attempt can be simulated');
    if (row.status !== 'pending') return map(row);
    const result = await tx.query(`UPDATE payment_intents SET status=$3,reference=$4,result_message='SIMULATED TEST PAYMENT — no money moved' WHERE id=$1 AND organization_id=$2 RETURNING *`,[id,auth.organizationId,outcome,outcome === 'paid' ? `SIM-${id}` : null]);
    await audit(tx,auth,id,'payment.simulated',{outcome},req);
    return map(result.rows[0]);
  });
}
export async function checkDarajaPayment(pool: pg.Pool, config:AppConfig, auth:AuthContext, id:string, req:Request) {
  const row = await owned(pool,auth,id);
  if (row.provider !== 'daraja_sandbox') throw badRequest('WRONG_PAYMENT_PROVIDER','Choose a Daraja sandbox attempt');
  if (row.status === 'paid' || row.status === 'failed' || row.status === 'cancelled') return map(row);
  if (!row.external_request_id) throw conflict('PAYMENT_STATUS_UNKNOWN','No provider request ID was received. Check the sandbox portal; do not send another prompt blindly.');
  const result = await queryDaraja(config,row.external_request_id);
  return withTransaction(pool,async tx => {
    const current = await owned(tx,auth,id,true);
    if (!['pending','unknown'].includes(current.status)) return map(current);
    const updated = await tx.query(`UPDATE payment_intents SET status=$3,result_message=$4,reference=$5 WHERE id=$1 AND organization_id=$2 RETURNING *`,[id,auth.organizationId,result.status,result.message,result.status === 'paid' ? `SANDBOX-${row.external_request_id}` : null]);
    await audit(tx,auth,id,'payment.sandbox-status',{status:result.status},req);
    return map(updated.rows[0]);
  });
}
