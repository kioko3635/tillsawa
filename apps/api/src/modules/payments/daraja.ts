import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';

const host = 'https://sandbox.safaricom.co.ke';
export function darajaConfigured(config: AppConfig) {
  if (!config.paymentTestMode || !config.darajaConsumerKey || !config.darajaConsumerSecret || !config.darajaPasskey || !config.darajaShortcode || !config.darajaCallbackUrl) return false;
  const url = new URL(config.darajaCallbackUrl);
  return url.protocol === 'https:' && !url.username && !url.password && !['localhost','127.0.0.1','[::1]'].includes(url.hostname);
}
export function normalizeKenyanPhone(value: string) {
  const digits = value.replace(/[\s()+-]/g, '');
  const phone = digits.startsWith('0') ? `254${digits.slice(1)}` : digits;
  if (!/^254[17]\d{8}$/.test(phone)) throw new AppError(400, 'INVALID_PHONE', 'Enter a Kenyan mobile number such as 07… or 01…');
  return phone;
}
function credentials(config: AppConfig) {
  if (!darajaConfigured(config)) throw new AppError(503, 'DARAJA_NOT_CONFIGURED', 'Configure Daraja sandbox credentials and a public HTTPS callback URL on this computer first');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).formatToParts(new Date());
  const timestamp = ['year','month','day','hour','minute','second'].map(type => parts.find(part => part.type === type)!.value).join('');
  return { timestamp, password: Buffer.from(`${config.darajaShortcode}${config.darajaPasskey}${timestamp}`).toString('base64') };
}
async function token(config: AppConfig, transport: typeof fetch) {
  const response = await transport(`${host}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${Buffer.from(`${config.darajaConsumerKey}:${config.darajaConsumerSecret}`).toString('base64')}` }, signal: AbortSignal.timeout(15000), redirect:'error' });
  if (!response.ok) throw new AppError(502, 'DARAJA_AUTH_FAILED', 'Daraja sandbox authentication failed. Check the local configuration.');
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new AppError(502, 'DARAJA_AUTH_FAILED', 'Daraja did not provide a sandbox access token');
  return data.access_token;
}
async function post(config: AppConfig, path: string, body: Record<string, unknown>, transport: typeof fetch) {
  const accessToken = await token(config, transport);
  const response = await transport(host + path, { method:'POST', headers:{ Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' }, body:JSON.stringify(body), signal:AbortSignal.timeout(20000), redirect:'error' });
  if (!response.ok) throw new AppError(502, 'DARAJA_REQUEST_FAILED', 'Daraja sandbox did not accept the request. Check the provider portal before starting another attempt.');
  return response.json() as Promise<Record<string, unknown>>;
}
export async function initiateDaraja(config: AppConfig, amountMinor: bigint, phone: string, reference: string, transport: typeof fetch = fetch) {
  const { timestamp, password } = credentials(config);
  if (amountMinor % 100n !== 0n || amountMinor < 100n || amountMinor > 25000000n) throw new AppError(400, 'DARAJA_AMOUNT', 'Sandbox STK Push requires a whole-shilling amount between KSh 1 and KSh 250,000');
  const result = await post(config, '/mpesa/stkpush/v1/processrequest', { BusinessShortCode: config.darajaShortcode, Password:password, Timestamp:timestamp, TransactionType:'CustomerPayBillOnline', Amount:Number(amountMinor / 100n), PartyA:normalizeKenyanPhone(phone), PartyB:config.darajaShortcode, PhoneNumber:normalizeKenyanPhone(phone), CallBackURL:config.darajaCallbackUrl, AccountReference:reference.slice(0,12), TransactionDesc:'POS sandbox test' }, transport);
  if (String(result.ResponseCode) !== '0' || typeof result.CheckoutRequestID !== 'string') throw new AppError(502, 'DARAJA_REJECTED', 'Daraja rejected the sandbox initiation. Check the sandbox portal.');
  return result.CheckoutRequestID;
}
export async function queryDaraja(config: AppConfig, checkoutId: string, transport: typeof fetch = fetch) {
  const { timestamp, password } = credentials(config);
  const result = await post(config, '/mpesa/stkpushquery/v1/query', { BusinessShortCode:config.darajaShortcode, Password:password, Timestamp:timestamp, CheckoutRequestID:checkoutId }, transport);
  if (result.CheckoutRequestID !== undefined && result.CheckoutRequestID !== checkoutId) throw new AppError(502, 'DARAJA_RESULT_MISMATCH', 'Daraja returned a different checkout identifier');
  const code = typeof result.ResultCode === 'number' || typeof result.ResultCode === 'string' ? String(result.ResultCode) : '';
  if (code === '0') {
    if (result.CheckoutRequestID !== checkoutId) throw new AppError(502, 'DARAJA_RESULT_MISMATCH', 'Daraja did not identify the confirmed checkout');
    return { status: 'paid' as const, message: 'Confirmed by the Daraja sandbox status API' };
  }
  // A processing/unknown provider result must not unlock another charge.
  // The sandbox explicitly identifies a customer cancellation as 1032.
  if (code === '1032' && result.CheckoutRequestID === checkoutId) return { status: 'cancelled' as const, message: 'Customer cancelled the sandbox prompt' };
  return { status: 'pending' as const, message: 'Provider has not confirmed a final result. Check again or reconcile in Daraja before retrying.' };
}
