import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { z } from 'zod';
import {
  cancelTransferSchema,
  createAdjustmentSchema,
  createStockCountSchema,
  createTransferSchema,
  decideStockCountSchema,
  dispatchTransferSchema,
  movementQuerySchema,
  receiveTransferSchema,
  recordCountLinesSchema,
  stockLevelQuerySchema,
  uuidSchema
} from '@pos/contracts';
import { idempotency } from '../../http/middleware/idempotency.js';
import { requireModule, requirePermission } from '../../http/middleware/auth.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import {
  cancelTransfer,
  createAdjustment,
  createStockCount,
  createTransfer,
  decideStockCount,
  dispatchTransfer,
  getAdjustment,
  getStockCount,
  getTransfer,
  inventoryValuation,
  listAdjustments,
  listInTransit,
  listMovements,
  listStockCounts,
  listStockLevels,
  listTransfers,
  receiveTransfer,
  reconcileInventory,
  recordStockCountLines,
  submitStockCount
} from './service.js';

interface InventoryRoutesDeps {
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

export function createInventoryRoutes({ pool, authenticate }: InventoryRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);
  router.use('/inventory', requireModule('inventory'));

  router.get('/inventory/stock-levels', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, await listStockLevels(pool, req.auth!, parseQuery(stockLevelQuerySchema, req)));
  }));

  router.get('/inventory/movements', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, await listMovements(pool, req.auth!, parseQuery(movementQuerySchema, req)));
  }));

  router.get('/inventory/valuation', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, { valuation: await inventoryValuation(pool, req.auth!, uuidParam(req, 'branchId')) });
  }));

  router.get('/inventory/reconciliation', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, { reconciliation: await reconcileInventory(pool, req.auth!, uuidParam(req, 'branchId')) });
  }));

  router.get('/inventory/in-transit', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, { inTransit: await listInTransit(pool, req.auth!, uuidParam(req, 'branchId')) });
  }));

  router.get('/inventory/adjustments', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, { adjustments: await listAdjustments(pool, req.auth!, uuidParam(req, 'branchId')) });
  }));

  router.post('/inventory/adjustments', requirePermission('inventory.adjust'), validateBody(createAdjustmentSchema), idempotency(pool, 'inventory.adjustments.create'), asyncHandler(async (req, res) => {
    sendData(res, { adjustment: await createAdjustment(pool, req.auth!, req.body, req) }, 201);
  }));

  router.get('/inventory/adjustments/:adjustmentId', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, { adjustment: await getAdjustment(pool, req.auth!, uuidParam(req, 'adjustmentId')) });
  }));

  router.get('/inventory/counts', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, { counts: await listStockCounts(pool, req.auth!, uuidParam(req, 'branchId')) });
  }));

  router.post('/inventory/counts', requirePermission('inventory.count'), validateBody(createStockCountSchema), idempotency(pool, 'inventory.counts.create'), asyncHandler(async (req, res) => {
    sendData(res, { count: await createStockCount(pool, req.auth!, req.body, req) }, 201);
  }));

  router.get('/inventory/counts/:countId', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, { count: await getStockCount(pool, req.auth!, uuidParam(req, 'countId')) });
  }));

  router.post('/inventory/counts/:countId/lines', requirePermission('inventory.count'), validateBody(recordCountLinesSchema), idempotency(pool, 'inventory.count-lines.record'), asyncHandler(async (req, res) => {
    sendData(res, { count: await recordStockCountLines(pool, req.auth!, uuidParam(req, 'countId'), req.body, req) });
  }));

  router.post('/inventory/counts/:countId/submit', requirePermission('inventory.count'), idempotency(pool, 'inventory.counts.submit'), asyncHandler(async (req, res) => {
    sendData(res, { count: await submitStockCount(pool, req.auth!, uuidParam(req, 'countId'), req) });
  }));

  router.post('/inventory/counts/:countId/decision', requirePermission('inventory.count-approve'), validateBody(decideStockCountSchema), idempotency(pool, 'inventory.counts.decide'), asyncHandler(async (req, res) => {
    sendData(res, { count: await decideStockCount(pool, req.auth!, uuidParam(req, 'countId'), req.body, req) });
  }));

  router.get('/inventory/transfers', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, { transfers: await listTransfers(pool, req.auth!, uuidParam(req, 'branchId')) });
  }));

  router.post('/inventory/transfers', requirePermission('inventory.transfer'), validateBody(createTransferSchema), idempotency(pool, 'inventory.transfers.create'), asyncHandler(async (req, res) => {
    sendData(res, { transfer: await createTransfer(pool, req.auth!, req.body, req) }, 201);
  }));

  router.get('/inventory/transfers/:transferId', requirePermission('inventory.read'), asyncHandler(async (req, res) => {
    sendData(res, { transfer: await getTransfer(pool, req.auth!, uuidParam(req, 'transferId')) });
  }));

  router.post('/inventory/transfers/:transferId/dispatch', requirePermission('inventory.transfer'), validateBody(dispatchTransferSchema), idempotency(pool, 'inventory.transfers.dispatch'), asyncHandler(async (req, res) => {
    sendData(res, { transfer: await dispatchTransfer(pool, req.auth!, uuidParam(req, 'transferId'), req.body, req) });
  }));

  router.post('/inventory/transfers/:transferId/receive', requirePermission('inventory.transfer'), validateBody(receiveTransferSchema), idempotency(pool, 'inventory.transfers.receive'), asyncHandler(async (req, res) => {
    sendData(res, { transfer: await receiveTransfer(pool, req.auth!, uuidParam(req, 'transferId'), req.body, req) });
  }));

  router.post('/inventory/transfers/:transferId/cancel', requirePermission('inventory.transfer'), validateBody(cancelTransferSchema), idempotency(pool, 'inventory.transfers.cancel'), asyncHandler(async (req, res) => {
    sendData(res, { transfer: await cancelTransfer(pool, req.auth!, uuidParam(req, 'transferId'), req.body, req) });
  }));

  return router;
}
