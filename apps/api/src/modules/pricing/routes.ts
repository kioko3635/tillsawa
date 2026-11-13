import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { z } from 'zod';
import {
  createPriceListSchema,
  priceListQuerySchema,
  priceResolveSchema,
  updatePriceListSchema,
  upsertPriceLinesSchema,
  uuidSchema
} from '@pos/contracts';
import { idempotency } from '../../http/middleware/idempotency.js';
import { requirePermission } from '../../http/middleware/auth.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import {
  createPriceList,
  getPriceList,
  listPriceHistory,
  listPriceLists,
  resolvePrice,
  updatePriceList,
  upsertPriceLines
} from './service.js';

interface PricingRoutesDeps {
  pool: pg.Pool;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
}

function parseQuery<S extends z.ZodTypeAny>(schema: S, req: Request): z.output<S> {
  const result = schema.safeParse(req.query);
  if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', 'Query validation failed', result.error.flatten());
  return result.data as z.output<S>;
}

function uuidParam(req: Request, name: string): string {
  const result = uuidSchema.safeParse(req.params[name]);
  if (!result.success) throw badRequest('VALIDATION_ERROR', `A valid ${name} is required`);
  return result.data;
}

export function createPricingRoutes({ pool, authenticate }: PricingRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);

  router.get('/pricing/price-lists', requirePermission('price-list.read'), asyncHandler(async (req, res) => {
    sendData(res, await listPriceLists(pool, req.auth!, parseQuery(priceListQuerySchema, req)));
  }));

  router.post('/pricing/price-lists', requirePermission('price-list.manage'), validateBody(createPriceListSchema), idempotency(pool, 'pricing.price-lists.create'), asyncHandler(async (req, res) => {
    sendData(res, { priceList: await createPriceList(pool, req.auth!, req.body, req) }, 201);
  }));

  router.get('/pricing/price-lists/:priceListId', requirePermission('price-list.read'), asyncHandler(async (req, res) => {
    sendData(res, { priceList: await getPriceList(pool, req.auth!, uuidParam(req, 'priceListId')) });
  }));

  router.patch('/pricing/price-lists/:priceListId', requirePermission('price-list.manage'), validateBody(updatePriceListSchema), asyncHandler(async (req, res) => {
    sendData(res, { priceList: await updatePriceList(pool, req.auth!, uuidParam(req, 'priceListId'), req.body, req) });
  }));

  router.put('/pricing/price-lists/:priceListId/lines', requirePermission('price-list.manage'), validateBody(upsertPriceLinesSchema), idempotency(pool, 'pricing.price-lines.upsert'), asyncHandler(async (req, res) => {
    sendData(res, { priceList: await upsertPriceLines(pool, req.auth!, uuidParam(req, 'priceListId'), req.body, req) });
  }));

  router.get('/pricing/price-lists/:priceListId/history', requirePermission('price-list.read'), asyncHandler(async (req, res) => {
    sendData(res, { history: await listPriceHistory(pool, req.auth!, uuidParam(req, 'priceListId')) });
  }));

  router.post('/pricing/resolve', requirePermission('price-list.read'), validateBody(priceResolveSchema), asyncHandler(async (req, res) => {
    sendData(res, { price: await resolvePrice(pool, req.auth!, req.body) });
  }));

  return router;
}
