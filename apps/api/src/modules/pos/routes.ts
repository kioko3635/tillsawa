import { Router } from 'express';
import { z as valueSchema } from 'zod';
import { claimSaleDrawer } from './drawer.js';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import type { z } from 'zod';
import {
  cashMovementSchema,
  closeRegisterSessionSchema,
  completeSaleSchema,
  createRegisterSchema,
  createSaleRefundSchema,
  createSaleReturnSchema,
  openRegisterSessionSchema,
  posProductSearchQuerySchema,
  registerQuerySchema,
  registerSessionQuerySchema,
  reprintReceiptSchema,
  saleListQuerySchema,
  updateRegisterSchema,
  uuidSchema,
  voidSaleSchema
} from '@pos/contracts';
import { requirePermission } from '../../http/middleware/auth.js';
import { idempotency } from '../../http/middleware/idempotency.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import {
  closeRegisterSession,
  completeSale,
  createRegister,
  createSaleRefund,
  createSaleReturn,
  getReceipt,
  getRegisterSession,
  getSale,
  listRegisterSessions,
  listRegisters,
  listSales,
  openRegisterSession,
  recordCashMovement,
  reprintReceipt,
  searchPosProducts,
  updateRegister,
  voidSale
} from './service.js';

interface PosRoutesDeps {
  config: AppConfig;
  pool: pg.Pool;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
}

function parseQuery<S extends z.ZodTypeAny>(schema: S, req: Request): z.output<S> {
  const result = schema.safeParse(req.query);
  if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', 'Query validation failed', result.error.flatten());
  return result.data as z.output<S>;
}

function uuidParam(req: Request, name: string): string {
  const source = req.params[name] ?? req.query[name];
  const result = uuidSchema.safeParse(source);
  if (!result.success) throw badRequest('VALIDATION_ERROR', `A valid ${name} is required`);
  return result.data;
}

export function createPosRoutes({ pool, authenticate, config }: PosRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);
  router.post('/pos/sales/:saleId/drawer-claim', requirePermission('sales.create'), validateBody(valueSchema.object({ terminalId: valueSchema.string().uuid() }).strict()), asyncHandler(async (req, res) => {
    sendData(res, await claimSaleDrawer(pool, req.auth!, uuidParam(req, 'saleId'), req.body.terminalId, req));
  }));

  router.get('/pos/products/search', requirePermission('sales.create'), asyncHandler(async (req, res) => {
    sendData(res, { products: await searchPosProducts(pool, req.auth!, parseQuery(posProductSearchQuerySchema, req)) });
  }));

  router.get('/pos/registers', requirePermission('sales.create'), asyncHandler(async (req, res) => {
    sendData(res, { registers: await listRegisters(pool, req.auth!, parseQuery(registerQuerySchema, req)) });
  }));

  router.post('/pos/registers', requirePermission('registers.manage'), validateBody(createRegisterSchema), idempotency(pool, 'pos.registers.create'), asyncHandler(async (req, res) => {
    sendData(res, { register: await createRegister(pool, req.auth!, req.body, req) }, 201);
  }));

  router.patch('/pos/registers/:registerId', requirePermission('registers.manage'), validateBody(updateRegisterSchema), asyncHandler(async (req, res) => {
    sendData(res, { register: await updateRegister(pool, req.auth!, uuidParam(req, 'registerId'), req.body, req) });
  }));

  router.get('/pos/register-sessions', requirePermission('sales.view'), asyncHandler(async (req, res) => {
    sendData(res, { sessions: await listRegisterSessions(pool, req.auth!, parseQuery(registerSessionQuerySchema, req)) });
  }));

  router.post('/pos/register-sessions/open', requirePermission('registers.open'), validateBody(openRegisterSessionSchema), idempotency(pool, 'pos.register-sessions.open'), asyncHandler(async (req, res) => {
    sendData(res, { session: await openRegisterSession(pool, req.auth!, req.body, req) }, 201);
  }));

  router.get('/pos/register-sessions/:sessionId', requirePermission('sales.view'), asyncHandler(async (req, res) => {
    sendData(res, { session: await getRegisterSession(pool, req.auth!, uuidParam(req, 'sessionId')) });
  }));

  router.post('/pos/register-sessions/:sessionId/cash-movements', requirePermission('registers.cash-movement'), validateBody(cashMovementSchema), idempotency(pool, 'pos.register-sessions.cash-movement'), asyncHandler(async (req, res) => {
    sendData(res, await recordCashMovement(pool, req.auth!, uuidParam(req, 'sessionId'), req.body, req), 201);
  }));

  router.post('/pos/register-sessions/:sessionId/close', requirePermission('registers.close'), validateBody(closeRegisterSessionSchema), idempotency(pool, 'pos.register-sessions.close'), asyncHandler(async (req, res) => {
    sendData(res, { session: await closeRegisterSession(pool, req.auth!, uuidParam(req, 'sessionId'), req.body, req) });
  }));

  router.get('/pos/sales', requirePermission('sales.view'), asyncHandler(async (req, res) => {
    sendData(res, await listSales(pool, req.auth!, parseQuery(saleListQuerySchema, req)));
  }));

  router.post('/pos/sales', requirePermission('sales.create'), validateBody(completeSaleSchema), idempotency(pool, 'pos.sales.complete'), asyncHandler(async (req, res) => {
    const result = await completeSale(pool, req.auth!, req.body, req, config.paymentTestMode);
    sendData(res, result, result.replayed ? 200 : 201);
  }));

  router.get('/pos/sales/:saleId', requirePermission('sales.view'), asyncHandler(async (req, res) => {
    sendData(res, { sale: await getSale(pool, req.auth!, uuidParam(req, 'saleId')) });
  }));

  router.get('/pos/sales/:saleId/receipt', requirePermission('sales.view'), asyncHandler(async (req, res) => {
    sendData(res, { receipt: await getReceipt(pool, req.auth!, uuidParam(req, 'saleId')) });
  }));

  router.post('/pos/sales/:saleId/receipt/reprint', requirePermission('receipts.reprint'), validateBody(reprintReceiptSchema), idempotency(pool, 'pos.receipts.reprint'), asyncHandler(async (req, res) => {
    sendData(res, { receipt: await reprintReceipt(pool, req.auth!, uuidParam(req, 'saleId'), req.body, req) });
  }));

  router.post('/pos/sales/:saleId/void', requirePermission('sales.void'), validateBody(voidSaleSchema), idempotency(pool, 'pos.sales.void'), asyncHandler(async (req, res) => {
    sendData(res, { sale: await voidSale(pool, req.auth!, uuidParam(req, 'saleId'), req.body, req) });
  }));

  router.post('/pos/sales/:saleId/returns', requirePermission('sales.return'), validateBody(createSaleReturnSchema), idempotency(pool, 'pos.sales.return'), asyncHandler(async (req, res) => {
    sendData(res, await createSaleReturn(pool, req.auth!, uuidParam(req, 'saleId'), req.body, req), 201);
  }));

  router.post('/pos/sales/:saleId/refunds', requirePermission('sales.refund'), validateBody(createSaleRefundSchema), idempotency(pool, 'pos.sales.refund'), asyncHandler(async (req, res) => {
    sendData(res, await createSaleRefund(pool, req.auth!, uuidParam(req, 'saleId'), req.body, req), 201);
  }));

  return router;
}
