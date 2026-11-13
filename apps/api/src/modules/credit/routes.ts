import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import { createCustomerCreditAdjustmentSchema, recordCustomerPaymentSchema, updateCustomerCreditSchema, uuidSchema } from '@pos/contracts';
import { requireModule, requirePermission } from '../../http/middleware/auth.js';
import { idempotency } from '../../http/middleware/idempotency.js';
import { badRequest } from '../../shared/errors.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import { createCreditAdjustment, getCreditAccount, recordCustomerPayment, updateCreditAccount } from './service.js';

interface CreditRoutesDeps {
  pool: pg.Pool;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
}

function customerId(req: Request): string {
  const result = uuidSchema.safeParse(req.params.customerId);
  if (!result.success) throw badRequest('VALIDATION_ERROR', 'A valid customerId is required');
  return result.data;
}

export function createCreditRoutes({ pool, authenticate }: CreditRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);
  const creditModule = requireModule('credit');

  router.get('/customers/:customerId/credit-account', creditModule, requirePermission('credit.view'), asyncHandler(async (req, res) => {
    sendData(res, await getCreditAccount(pool, req.auth!, customerId(req)));
  }));

  router.patch('/customers/:customerId/credit-account', creditModule, requirePermission('credit.manage'), validateBody(updateCustomerCreditSchema), asyncHandler(async (req, res) => {
    sendData(res, { account: await updateCreditAccount(pool, req.auth!, customerId(req), req.body, req) });
  }));

  router.post('/customers/:customerId/payments', creditModule, requirePermission('credit.collect'), validateBody(recordCustomerPaymentSchema), idempotency(pool, 'credit.payments.record'), asyncHandler(async (req, res) => {
    const result = await recordCustomerPayment(pool, req.auth!, customerId(req), req.body, req);
    sendData(res, result, result.replayed ? 200 : 201);
  }));

  router.post('/customers/:customerId/adjustments', creditModule, requirePermission('credit.adjust'), validateBody(createCustomerCreditAdjustmentSchema), idempotency(pool, 'credit.adjustments.create'), asyncHandler(async (req, res) => {
    const result = await createCreditAdjustment(pool, req.auth!, customerId(req), req.body, req);
    sendData(res, result, result.replayed ? 200 : 201);
  }));

  return router;
}
