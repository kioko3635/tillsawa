import { z } from 'zod';
import { createProductSchema } from '@pos/contracts';
import { AppError, badRequest } from '../../shared/errors.js';

const origin = 'https://world.openfoodfacts.org';
const fields = 'code,product_name,product_name_en,brands,quantity,categories,image_front_url';
const codeSchema = z.string().regex(/^\d{8,14}$/, 'Enter a barcode with 8–14 digits');
export const onlineSearchSchema = z.object({ query: z.string().trim().min(2).max(100) });
export const onlineImportSchema = createProductSchema.pick({ name: true, brand: true, categoryId: true, baseUnitId: true, cost: true, basePrice: true })
  .extend({ code: codeSchema, name: z.string().trim().min(1).max(160), size: z.string().trim().max(100), barcode: z.string().trim().max(64).regex(/^[\w .\-/]*$/), includePhoto: z.boolean().default(true), confirmed: z.literal(true) });
export type OnlineImport = z.infer<typeof onlineImportSchema>;
export interface OnlineProduct { code: string; name: string; brand: string; size: string; category: string; imageUrl: string | null; sourceUrl: string }

function text(value: unknown, limit: number) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
export function safePhotoUrl(value: unknown): string | null {
  try { const url = new URL(String(value)); return url.protocol === 'https:' && url.hostname === 'images.openfoodfacts.org' && !url.port && !url.username && !url.password && /^\/images\/products\/[\d/]+\/[\w.-]+\.(jpg|jpeg|png)$/.test(url.pathname) ? url.href : null; } catch { return null; }
}
export function normalizeOnlineProduct(raw: unknown): OnlineProduct | null {
  if (!raw || typeof raw !== 'object') return null;
  const product = raw as Record<string, unknown>;
  const code = codeSchema.safeParse(product.code);
  const name = text(product.product_name_en, 160) || text(product.product_name, 160);
  if (!code.success || !name) return null;
  return { code: code.data, name, brand: text(product.brands, 120), size: text(product.quantity, 100), category: text(product.categories, 160), imageUrl: safePhotoUrl(product.image_front_url), sourceUrl: `${origin}/product/${code.data}` };
}

// Explicit searches only. Keep comfortably below the public provider's per-IP limits.
const cache = new Map<string, { until: number; data: unknown }>();
const calls: Record<string, number[]> = { search: [], product: [] };
async function jsonRequest(url: URL, kind: 'search' | 'product'): Promise<Record<string, unknown>> {
  const now = Date.now();
  const hit = cache.get(url.href); if (hit && hit.until > now) return hit.data as Record<string, unknown>;
  calls[kind] = calls[kind]!.filter(time => now - time < 60_000);
  if (calls[kind]!.length >= (kind === 'search' ? 8 : 12)) throw new AppError(429, 'ONLINE_SEARCH_LIMIT', 'Too many online lookups. Please wait one minute and try again.');
  calls[kind]!.push(now);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'KenyaPOS/0.1 (local shop catalogue lookup)', Accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Provider returned ${response.status}`);
    const bytes = await boundedBody(response, 1_000_000);
    const result: unknown = JSON.parse(bytes.toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid provider response');
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(url.href, { until: now + 10 * 60_000, data: result });
    return result as Record<string, unknown>;
  } catch { throw new AppError(503, 'ONLINE_CATALOG_UNAVAILABLE', 'Online product lookup is unavailable. Check your internet connection or try again later. Your local catalogue still works.'); }
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Response is too large'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) throw new Error('Response is too large'); chunks.push(next.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export async function getOnlineProduct(code: string): Promise<OnlineProduct> {
  codeSchema.parse(code);
  const url = new URL(`/api/v2/product/${code}.json`, origin); url.searchParams.set('fields', fields);
  const result = await jsonRequest(url, 'product');
  const product = normalizeOnlineProduct(result.product);
  if (result.status !== 1 || !product || product.code !== code) throw badRequest('ONLINE_PRODUCT_NOT_FOUND', 'This barcode was not found online. You can create the product manually.');
  return product;
}
export async function searchOnlineProducts(query: string) {
  if (/^\d{8,14}$/.test(query)) {
    try { return { products: [await getOnlineProduct(query)], source: 'Open Food Facts' }; }
    catch (error) { if (error instanceof AppError && error.code === 'ONLINE_PRODUCT_NOT_FOUND') return { products: [], source: 'Open Food Facts' }; throw error; }
  }
  const url = new URL('/cgi/search.pl', origin);
  for (const [key, value] of Object.entries({ search_terms: query, search_simple: '1', action: 'process', json: '1', page_size: '12', fields })) url.searchParams.set(key, value);
  const result = await jsonRequest(url, 'search');
  if (!Array.isArray(result.products)) throw new AppError(503, 'ONLINE_CATALOG_UNAVAILABLE', 'The product source returned an unexpected response. Please try again later.');
  const unique = new Map<string, OnlineProduct>();
  for (const raw of result.products.slice(0, 12)) { const product = normalizeOnlineProduct(raw); if (product) unique.set(product.code, product); }
  return { products: [...unique.values()], source: 'Open Food Facts' };
}
export async function downloadOnlinePhoto(product: OnlineProduct) {
  if (!product.imageUrl) return null;
  try {
    const response = await fetch(product.imageUrl, { signal: AbortSignal.timeout(12_000), redirect: 'error', headers: { 'User-Agent': 'KenyaPOS/0.1 (local shop catalogue lookup)' } });
    if (!response.ok) throw new Error('Image unavailable');
    const bytes = await boundedBody(response, 2_000_000);
    const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (!jpeg && !png) throw new Error('Unsupported image');
    return { bytes, mime: jpeg ? 'image/jpeg' : 'image/png', sourceUrl: product.imageUrl };
  } catch { throw new AppError(503, 'ONLINE_PHOTO_UNAVAILABLE', 'The product photo could not be saved. Try again, or untick “Save product photo” to add the reviewed details without a photo.'); }
}
