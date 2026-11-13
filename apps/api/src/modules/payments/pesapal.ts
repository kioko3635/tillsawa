import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { decimalToMinorUnits } from '../../shared/money.js';

export const pesapalMerchantReference = (transactionId: string) => 'TS' + transactionId.replaceAll('-', '').slice(0, 20).toUpperCase();

export function pesapalTerminalConfigured(config: AppConfig, organizationId: string) {
  return Boolean(config.pesapalTerminalKey && config.pesapalOrganizationId === organizationId);
}

export async function verifyPesapalTerminalPayment(
  config: AppConfig,
  expected: { reference: string; merchantReference: string; amount: bigint; method: 'card' | 'mpesa' },
  transport: typeof fetch = fetch
) {
  const result = await transport('https://ext.pesapal.com/api/transactions/verifytransaction', {
    method: 'POST', headers: { APIKey: config.pesapalTerminalKey ?? '', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ confirmation_code: expected.reference }), signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  if (!result.ok) throw new AppError(502, 'PESAPAL_UNAVAILABLE', 'Pesapal did not confirm the result. Check the terminal before retrying.');
  const data = await result.json() as Record<string, unknown>;
  if (String(data.status) !== '1' || String(data.posting_status) !== '0' || String(data.status_description).toLowerCase() !== 'completed') {
    throw new AppError(409, 'PESAPAL_NOT_CONFIRMED', 'Pesapal has not confirmed this payment. Do not charge the customer again until you check the terminal.');
  }
  const option = String(data.payment_option ?? '').toLowerCase().replace(/[\s-]/g, '');
  const method = option === 'mpesa' ? 'mpesa' : ['card', 'visa', 'mastercard', 'amex', 'americanexpress', 'unionpay'].includes(option) ? 'card' : null;
  const amount = String(data.amount ?? '');
  if (!/^\d{1,16}(?:\.\d{1,2})?$/.test(amount) || decimalToMinorUnits(amount) !== expected.amount ||
      data.currency !== 'KES' || method !== expected.method ||
      String(data.merchant_ref ?? '').toUpperCase() !== expected.merchantReference ||
      String(data.confirmation_code ?? '').toUpperCase() !== expected.reference) {
    throw new AppError(409, 'PESAPAL_PAYMENT_MISMATCH', 'The terminal payment does not match this sale. Check the reference, method and amount in Pesapal before retrying.');
  }
}
