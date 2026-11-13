import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, urlencoded } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import { asyncHandler } from '../../shared/http.js';
import { createLicenseService } from './service.js';
import { envelopeSchema } from './verification.js';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]!);
const hash = (value: string) => createHash('sha256').update(value).digest();
const prefix = '/subscription-management';

export function cloudManagement(pool: pg.Pool, config: AppConfig) {
  const router = Router();
  const password = config.managementPassword;
  if (!config.cloud || !config.licensing || !password) return router;
  const service = createLicenseService(pool, config);
  const credential = hash('operator:' + password);
  router.use(rateLimit({ windowMs: 15 * 60_000, limit: 15, skipSuccessfulRequests: true }));
  router.use((req,res,next) => {
    res.set('Cache-Control','no-store');
    if (config.nodeEnv === 'production' && !req.secure) { res.sendStatus(403); return; }
    const supplied = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? '';
    if (!timingSafeEqual(credential, hash(Buffer.from(supplied,'base64').toString('utf8')))) {
      res.set('WWW-Authenticate','Basic realm="TillSawa subscription management", charset="UTF-8"').sendStatus(401); return;
    }
    next();
  });
  router.get('/', asyncHandler(async (_req,res) => {
    const result = await pool.query(`SELECT o.id,o.display_name,o.status AS shop_status,l.envelope,l.high_water_ms::text,l.state_mac,activity.last_seen
      FROM organizations o LEFT JOIN installation_licenses l ON l.organization_id=o.id
      LEFT JOIN LATERAL (SELECT max(last_seen_at) AS last_seen FROM auth_sessions
        WHERE organization_id=o.id AND status='active' AND expires_at>now()) activity ON true
      ORDER BY o.display_name,o.id`);
    const now = Date.now();
    const shops = result.rows.map(row => ({...row, licence: service.preview(row.id,row,now), recent: row.shop_status === 'active' && row.last_seen && now - new Date(row.last_seen).getTime() <= 900000 }));
    const total = (state: string) => shops.filter(shop=>shop.licence.state===state).length;
    const rows = shops.map(shop => `<tr><th scope="row">${escape(shop.display_name)}<small>${escape(shop.shop_status)}</small></th><td>${escape(shop.licence.state)}</td><td>${escape(shop.licence.license?.plan ?? '—')}</td><td>${escape(shop.licence.license?.lifetime ? 'Lifetime' : shop.licence.license?.expiresAt?.slice(0,10) ?? '—')}</td><td>${shop.recent ? 'Recently active' : '—'}</td><td><a href="${prefix}/${escape(shop.id)}/request">Download request</a> · <a href="${prefix}/${escape(shop.id)}/install">Install licence</a></td></tr>`).join('');
    res.type('html').send(page('Cloud subscriptions',`<p>Cloud shops: <strong>${shops.length}</strong> · Active licences: <strong>${total('active')}</strong> · In grace: <strong>${total('grace')}</strong> · Expired: <strong>${total('expired')}</strong> · Recently active licensed shops: <strong>${shops.filter(s=>s.recent && s.licence.canWrite).length}</strong></p>
      <p>Recent activity means an authenticated cloud session was seen in the last 15 minutes. Offline Windows licences are managed separately.</p>
      <div class="table"><table><thead><tr><th>Shop</th><th>Licence</th><th>Plan</th><th>Expires</th><th>Activity</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`));
  }));
  async function find(id: unknown) {
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return undefined;
    return (await pool.query('SELECT id, display_name FROM organizations WHERE id=$1',[parsed.data])).rows[0];
  }
  router.get('/:id/request', asyncHandler(async (req,res) => {
    const shop = await find(req.params.id);
    if (!shop) { res.sendStatus(404); return; }
    res.attachment('tillsawa-cloud-activation-' + shop.id + '.json').json(service.request(shop.id,shop.display_name));
  }));
  router.get('/:id/install', asyncHandler(async (req,res) => {
    const shop = await find(req.params.id);
    if (!shop) { res.sendStatus(404); return; }
    res.type('html').send(page('Install licence for ' + shop.display_name,`<form method="post"><label for="envelope">Paste the signed .poslicense file contents</label><textarea id="envelope" name="envelope" rows="12" required></textarea><button>Install licence</button></form><p><a href="${prefix}/">Back to subscriptions</a></p>`));
  }));
  router.post('/:id/install',urlencoded({ extended:false,limit:'32kb' }),asyncHandler(async (req,res) => {
    if (!config.corsOrigins.includes(req.get('origin') ?? '')) { res.sendStatus(403); return; }
    const shop = await find(req.params.id);
    if (!shop) { res.sendStatus(404); return; }
    let input: unknown;
    try { input=JSON.parse(String(req.body?.envelope ?? '')); } catch { res.status(400).type('html').send(page('Invalid licence file','<p>Go back and paste the signed licence JSON.</p>')); return; }
    const envelope=envelopeSchema.safeParse(input);
    if (!envelope.success) { res.sendStatus(400); return; }
    await service.import(shop.id,envelope.data,req);
    res.redirect(303,prefix+'/');
  }));
  return router;
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | TillSawa</title>
  <style>body{max-width:76rem;margin:2rem auto;padding:0 1rem;font:1rem/1.55 system-ui;color:#123350;background:#f7fafc}a{color:#124d80}small{display:block;color:#536578}.table{overflow:auto}table{border-collapse:collapse;width:100%;background:white}td,th{padding:.65rem;border-bottom:1px solid #d8e2ec;text-align:left}textarea{display:block;width:min(100%,48rem);box-sizing:border-box;margin:.6rem 0}button{padding:.55rem 1rem}</style><main><p>TillSawa · Provider only</p><h1>${escape(title)}</h1>${body}</main></html>`;
}
