import { z } from 'zod';

const amount=z.string().regex(/^-?\d{1,22}(\.\d{1,6})?$/);
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const snapshotSchema=z.object({
  version:z.literal(1), snapshotId:z.string().uuid(), sequence:z.number().int().positive().safe(),
  sourceOrganizationId:z.string().uuid(), sourceBranchId:z.string().uuid(),
  capturedAt:z.string().datetime(), currency:z.string().regex(/^[A-Z]{3}$/), timezone:z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Invalid store timezone'),
  branchName:z.string().max(160),
  sales:z.object({count,grossSales:amount,tax:amount,costOfGoodsSold:amount,cashSales:amount,mpesaSales:amount,cardSales:amount,creditSales:amount,testSales:amount,returned:amount,refunded:amount}),
  expenses:z.object({paid:amount,authorized:amount}),
  inventory:z.object({stockValue:amount,onHandQty:amount,lowStockCount:count}),
  debt:z.object({receivablesOutstanding:amount,payablesOutstanding:amount}),
  daily:z.array(z.object({date:z.string().date(),sales:amount,saleCount:count,authorizedExpenses:amount,paidExpenses:amount})).max(20000),
  cashiers:z.array(z.object({membershipId:z.string().uuid(),name:z.string().max(160),saleCount:count,sales:amount})).max(10000),
  stock:z.array(z.object({id:z.string().uuid(),sku:z.string().max(100),name:z.string().max(250),unit:z.string().max(40),quantity:amount,price:amount})).max(500),
  stockItemCount:count,
  recentSales:z.array(z.object({id:z.string().uuid(),receipt:z.string().max(100),status:z.string().max(40),soldAt:z.string().datetime(),amount:amount,cashier:z.string().max(160)})).max(100)
});
export type StoreSnapshot=z.infer<typeof snapshotSchema>;

export function hubOrigin(value:string) {
  let url:URL;
  try {url=new URL(value);} catch {throw new Error('Enter the central dashboard HTTPS address.');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:' && !(url.protocol==='http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname!=='/') throw new Error('Use an HTTPS address without a path, credentials or query. HTTP is allowed only on localhost for testing.');
  return url.origin;
}
export function pairingCode(value:string) {
  const match=/^POSLINK\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value.trim());
  if(!match || !z.string().uuid().safeParse(match[1]).success) throw new Error('Paste the complete store pairing code generated on the central dashboard.');
  return {storeId:match[1]!,token:match[2]!};
}
