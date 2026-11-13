import type { CompleteSaleInput } from '@pos/contracts';
import type pg from 'pg';
import type { AuthContext } from '../../http/middleware/auth.js';
import { requestPayloadHash } from '../../http/middleware/idempotency.js';
import { conflict } from '../../shared/errors.js';

// Older clients omit redemption when preparing an electronic payment and send
// zero when completing it. Both mean no redemption; keep positive values bound.
export const paymentCartHash = (sale: CompleteSaleInput) => requestPayloadHash({ ...sale, loyaltyPointsToRedeem: sale.loyaltyPointsToRedeem || undefined, payment: undefined });

export async function verifyIntentForSale(tx: pg.PoolClient, auth: AuthContext, input: CompleteSaleInput, total: bigint, testMode: boolean) {
  const result = await tx.query(`SELECT * FROM payment_intents WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [input.payment.intentId, auth.organizationId]);
  const row = result.rows[0];
  // Accept pre-fix intents that explicitly hashed zero as well as omitted zero.
  const legacyZeroHash = !input.loyaltyPointsToRedeem ? requestPayloadHash({ ...input, loyaltyPointsToRedeem: 0, payment: undefined }) : null;
  if (!row || row.membership_id !== auth.membershipId || row.register_session_id !== input.registerSessionId || row.client_transaction_id !== input.clientTransactionId || row.method !== input.payment.method || (row.cart_hash !== paymentCartHash(input) && row.cart_hash !== legacyZeroHash)) {
    throw conflict('PAYMENT_CART_MISMATCH', 'This payment does not belong to this cashier and exact checkout. Restore the original cart or reconcile the payment in payment history.');
  }
  if (row.status !== 'paid' || row.sale_id) throw conflict('PAYMENT_NOT_AVAILABLE', 'Payment must be confirmed and unused before completing this sale');
  if (BigInt(row.amount_minor) !== total) throw conflict('PAYMENT_AMOUNT_CHANGED', 'The payable amount changed after payment. Reconcile the received payment before changing this cart.');
  if (['simulator', 'daraja_sandbox'].includes(row.provider) && !testMode) throw conflict('TEST_PAYMENT_DISABLED', 'Test payments cannot complete sales outside payment test mode');
  return { id: row.id as string, reference: row.reference as string, verification: row.provider === 'simulator' ? 'simulated' : row.provider === 'daraja_sandbox' ? 'sandbox' : row.provider === 'pesapal_terminal' ? 'pesapal_verified' : 'manual' };
}
