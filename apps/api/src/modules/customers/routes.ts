import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import { createCustomerSchema, updateCustomerSchema, uuidSchema } from '@pos/contracts';
import { idempotency } from '../../http/middleware/idempotency.js';
import { requirePermission } from '../../http/middleware/auth.js';
import { badRequest } from '../../shared/errors.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import { createCustomer, listCustomers, updateCustomer } from './service.js';

interface CustomerRoutesDeps {
  pool: pg.Pool;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
}

export function createCustomerRoutes({ pool, authenticate }: CustomerRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);

  router.get('/customers', requirePermission('customer.read'), asyncHandler(async (req, res) => {
    sendData(res, {
      customers: await listCustomers(pool, req.auth!, {
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        creditStatus: typeof req.query.creditStatus === 'string' ? req.query.creditStatus : undefined
      })
    });
  }));

  router.post('/customers', requirePermission('customer.manage'), validateBody(createCustomerSchema), idempotency(pool, 'customers.create'), asyncHandler(async (req, res) => {
    sendData(res, { customer: await createCustomer(pool, req.auth!, req.body, req) }, 201);
  }));

  router.patch('/customers/:customerId', requirePermission('customer.manage'), validateBody(updateCustomerSchema), asyncHandler(async (req, res) => {
    const parsed = uuidSchema.safeParse(req.params.customerId);
    if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'A valid customerId is required');
    sendData(res, { customer: await updateCustomer(pool, req.auth!, parsed.data, req.body, req) });
  }));

  return router;
}
