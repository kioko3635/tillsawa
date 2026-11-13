import { cloudManagement } from '../modules/licensing/cloud-management.js';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { SYNC_CONTRACT_VERSION } from '@pos/contracts';
import type { AppConfig } from '../config/env.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { errorHandler, notFoundHandler, requestContext } from './middleware/request-context.js';
import { sendData } from '../shared/http.js';
import { createAuthRoutes } from '../modules/identity/routes.js';
import { createCatalogRoutes } from '../modules/catalog/routes.js';
import { createCustomerRoutes } from '../modules/customers/routes.js';
import { createCreditRoutes } from '../modules/credit/routes.js';
import { createInventoryRoutes } from '../modules/inventory/routes.js';
import { createPosRoutes } from '../modules/pos/routes.js';
import { createPaymentRoutes } from '../modules/payments/routes.js';
import { createPricingRoutes } from '../modules/pricing/routes.js';
import { createProcurementRoutes } from '../modules/procurement/routes.js';
import { createExpenseRoutes } from '../modules/expenses/routes.js';
import { createReportsRoutes } from '../modules/reports/routes.js';
import { createSyncRoutes } from '../modules/sync/routes.js';
import { createTenancyRoutes } from '../modules/tenancy/routes.js';
import { getOrganization, listBranches } from '../modules/tenancy/service.js';
import { createLicenseService, licenseWriteExempt } from '../modules/licensing/service.js';
import { createLicenseRoutes } from '../modules/licensing/routes.js';
import { asyncHandler } from '../shared/http.js';
import { notFound,forbidden } from '../shared/errors.js';
import { createLoyaltyRoutes } from '../modules/loyalty/routes.js';
import { createNetworkRoutes } from '../modules/network/routes.js';

export interface AppDependencies {
  config: AppConfig;
  pool: pg.Pool;
  systemPool: pg.Pool;
}

export function createApp({ config, pool, systemPool }: AppDependencies): express.Express {
  const app = express();
  app.locals.config = config;
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: { directives: {
    'upgrade-insecure-requests': config.serveWeb ? null : [],
    'img-src': ["'self'", 'data:', 'https:']
  } } }));
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use('/api/v1/network/machine/snapshot',express.json({limit:'8mb'}));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestContext);

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.apiRateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.authRateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true
  });

  app.get('/api/v1/health/live', (_req, res) => {
    sendData(res, { status: 'ok' });
  });
  app.get('/api/v1/local/connection', (_req, res) => {
    res.set('Cache-Control','no-store');
    sendData(res, { mode: config.multiStoreHub ? 'hub' : config.cloud ? 'cloud' : config.sharedServer ? 'server' : 'standalone', offlineCheckout: !config.sharedServer && !config.cloud && !config.multiStoreHub, registrationOpen: !config.cloud || Boolean(config.cloudSetupKey) });
  });
  app.get('/api/v1/health/ready', async (_req, res, next) => {
    try {
      await pool.query('SELECT 1');
      sendData(res, { status: 'ready' });
    } catch (error) {
      next(error);
    }
  });

  // Public, immutable photos from a public product source, like bundled catalogue assets.
  // Shop records and prices are never exposed through this endpoint.
  app.get('/api/v1/catalog/online/images/:imageId', asyncHandler(async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.imageId ?? '')) throw notFound();
    const result = await pool.query('SELECT content,mime_type FROM online_catalog_photos WHERE id=$1', [req.params.imageId]);
    if (!result.rows[0]) throw notFound();
    res.set('Cache-Control', 'public, max-age=31536000, immutable').type(result.rows[0].mime_type as string).send(result.rows[0].content);
  }));
  app.use('/api/v1', apiLimiter);
  app.use('/api/v1/auth/login', authLimiter);
  app.use('/api/v1/auth/register-organization', authLimiter);
  app.use('/api/v1/auth/password-reset', authLimiter);
  app.use('/api/v1/auth/recovery', authLimiter);
  app.use('/api/v1/auth/refresh', authLimiter);

  const baseAuthenticate = createAuthMiddleware(pool, config);
  const licensing = createLicenseService(pool, config);
  if (config.cloud) app.use('/subscription-management', cloudManagement(systemPool, config), (_req, res) => { res.sendStatus(404); });
  const checkedRequests = new WeakSet<express.Request>();
  const authenticate: express.RequestHandler = (req, res, next) => {
    if (config.cloud && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && /^\/api\/v1\/sync\/transactions(?:[/?]|$)/.test(req.originalUrl)) {
      return next(forbidden('CLOUD_ONLINE_CHECKOUT_ONLY', 'Cloud checkout requires a connection. Offline sales are supported by local standalone installations.'));
    }

    if(config.multiStoreHub && !['GET','HEAD','OPTIONS'].includes(req.method) && /^\/api\/v1\/(pos|catalog|inventory|customers|credit|suppliers|purchase-orders|supplier-invoices|expenses)(\/|$)/.test(req.originalUrl)) return next(forbidden('CENTRAL_REPORTING_ONLY','Make sales and stock changes at the local store. This central service holds reporting copies.'));
    if (checkedRequests.has(req)) return next();
    baseAuthenticate(req, res, error => {
      if (error) return next(error);
      const proceed = () => { checkedRequests.add(req); next(); };
      if (licenseWriteExempt(req.method, req.originalUrl.split('?')[0] ?? req.path, req.body)) return proceed();
      void licensing.enforce(req.auth!.organizationId).then(proceed, next);
    });
  };
  app.use('/api/v1', createLicenseRoutes(pool, licensing, authenticate));
  app.get('/api/v1/meta/bootstrap', authenticate, async (req, res, next) => {
    try {
      const [organization, branches] = await Promise.all([
        getOrganization(pool, req.auth!),
        listBranches(pool, req.auth!)
      ]);
      sendData(res, {
        organization,
        branches,
        permissions: [...req.auth!.permissions],
        modules: [...req.auth!.enabledModules],
        capabilities: [...req.auth!.enabledCapabilities],
        syncContractVersion: SYNC_CONTRACT_VERSION,
        featureFlags: {
          multiStoreHub:!!config.multiStoreHub,
          offlineFoundation: true,
          offlineSales: !config.cloud && !config.multiStoreHub && req.auth!.enabledModules.has('offline_sync'),
          catalog: true,
          pricing: true,
          inventory: req.auth!.enabledModules.has('inventory'),
          checkout: true,
          payments: false,
          expenses: req.auth!.enabledModules.has('expenses'),
          reports: req.auth!.enabledModules.has('reports')
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api/v1/auth', createAuthRoutes({ pool, systemPool, config, authenticate }));
  app.use('/api/v1',createNetworkRoutes(pool,systemPool,config,authenticate));
  app.use('/api/v1', createTenancyRoutes({ pool, systemPool, config, authenticate }));
  app.use('/api/v1', createSyncRoutes({ pool, config, authenticate }));
  app.use('/api/v1', createCatalogRoutes({ pool, authenticate }));
  app.use('/api/v1', createLoyaltyRoutes(pool, authenticate));
  app.use('/api/v1', createCustomerRoutes({ pool, authenticate }));
  app.use('/api/v1', createCreditRoutes({ pool, authenticate }));
  app.use('/api/v1', createPricingRoutes({ pool, authenticate }));
  app.use('/api/v1', createInventoryRoutes({ pool, authenticate }));
  app.use('/api/v1', createPosRoutes({ pool, authenticate, config }));
  app.use('/api/v1', createPaymentRoutes({ pool, authenticate, config }));
  app.use('/api/v1', createProcurementRoutes({ pool, authenticate }));
  app.use('/api/v1', createExpenseRoutes({ pool, authenticate }));
  app.use('/api/v1', createReportsRoutes({ pool, authenticate }));

  if (config.serveWeb) {
    const webRoot = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
    app.use(express.static(webRoot, { setHeaders: (res, path) => {
      if (!path.includes('/assets/') && !path.includes('\\assets\\')) res.setHeader('Cache-Control', 'no-cache');
    } }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(req.path)) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: webRoot, cacheControl: false });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
