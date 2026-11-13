import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { z } from 'zod';
import {
  cancelPurchaseOrderSchema,
  createPurchaseOrderSchema,
  createSupplierInvoiceSchema,
  createSupplierSchema,
  purchaseOrderQuerySchema,
  receivePurchaseOrderSchema,
  recordSupplierPaymentSchema,
  supplierInvoiceQuerySchema,
  supplierQuerySchema,
  updateSupplierSchema,
  uuidSchema
} from '@pos/contracts';
import { requireModule, requirePermission } from '../../http/middleware/auth.js';
import { idempotency } from '../../http/middleware/idempotency.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  createSupplierInvoice,
  getPurchaseOrder,
  getSupplier,
  getSupplierInvoice,
  listPurchaseOrders,
  listSupplierInvoices,
  listSuppliers,
  receivePurchaseOrder,
  recordSupplierPayment,
  submitPurchaseOrder,
  updateSupplier
} from './service.js';

interface ProcurementRoutesDeps {
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

export function createProcurementRoutes({ pool, authenticate }: ProcurementRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);
  router.use(['/suppliers', '/purchase-orders', '/supplier-invoices'], requireModule('procurement'));

  router.get('/suppliers', requirePermission('supplier.read'), asyncHandler(async (req, res) => {
    sendData(res, await listSuppliers(pool, req.auth!, parseQuery(supplierQuerySchema, req)));
  }));

  router.post('/suppliers', requirePermission('supplier.manage'), validateBody(createSupplierSchema), idempotency(pool, 'suppliers.create'), asyncHandler(async (req, res) => {
    sendData(res, { supplier: await createSupplier(pool, req.auth!, req.body, req) }, 201);
  }));

  router.get('/suppliers/:supplierId', requirePermission('supplier.read'), asyncHandler(async (req, res) => {
    sendData(res, { supplier: await getSupplier(pool, req.auth!, uuidParam(req, 'supplierId')) });
  }));

  router.patch('/suppliers/:supplierId', requirePermission('supplier.manage'), validateBody(updateSupplierSchema), asyncHandler(async (req, res) => {
    sendData(res, { supplier: await updateSupplier(pool, req.auth!, uuidParam(req, 'supplierId'), req.body, req) });
  }));

  router.post('/suppliers/:supplierId/payments', requirePermission('supplier-payment.record'), validateBody(recordSupplierPaymentSchema), idempotency(pool, 'supplier-payments.record'), asyncHandler(async (req, res) => {
    const result = await recordSupplierPayment(pool, req.auth!, uuidParam(req, 'supplierId'), req.body, req);
    sendData(res, result, result.replayed ? 200 : 201);
  }));

  router.get('/purchase-orders', requirePermission('purchase.read'), asyncHandler(async (req, res) => {
    sendData(res, await listPurchaseOrders(pool, req.auth!, parseQuery(purchaseOrderQuerySchema, req)));
  }));

  router.post('/purchase-orders', requirePermission('purchase.create'), validateBody(createPurchaseOrderSchema), idempotency(pool, 'purchase-orders.create'), asyncHandler(async (req, res) => {
    const result = await createPurchaseOrder(pool, req.auth!, req.body, req);
    sendData(res, result, result.replayed ? 200 : 201);
  }));

  router.get('/purchase-orders/:purchaseOrderId', requirePermission('purchase.read'), asyncHandler(async (req, res) => {
    sendData(res, await getPurchaseOrder(pool, req.auth!, uuidParam(req, 'purchaseOrderId')));
  }));

  router.post('/purchase-orders/:purchaseOrderId/submit', requirePermission('purchase.create'), idempotency(pool, 'purchase-orders.submit'), asyncHandler(async (req, res) => {
    sendData(res, await submitPurchaseOrder(pool, req.auth!, uuidParam(req, 'purchaseOrderId'), req));
  }));

  router.post('/purchase-orders/:purchaseOrderId/approve', requirePermission('purchase.approve'), idempotency(pool, 'purchase-orders.approve'), asyncHandler(async (req, res) => {
    sendData(res, await approvePurchaseOrder(pool, req.auth!, uuidParam(req, 'purchaseOrderId'), req));
  }));

  router.post('/purchase-orders/:purchaseOrderId/cancel', requirePermission('purchase.cancel'), validateBody(cancelPurchaseOrderSchema), idempotency(pool, 'purchase-orders.cancel'), asyncHandler(async (req, res) => {
    sendData(res, await cancelPurchaseOrder(pool, req.auth!, uuidParam(req, 'purchaseOrderId'), req.body, req));
  }));

  router.post('/purchase-orders/:purchaseOrderId/receipts', requirePermission('purchase.receive'), validateBody(receivePurchaseOrderSchema), idempotency(pool, 'purchase-orders.receive'), asyncHandler(async (req, res) => {
    const result = await receivePurchaseOrder(pool, req.auth!, uuidParam(req, 'purchaseOrderId'), req.body, req);
    sendData(res, result, result.replayed ? 200 : 201);
  }));

  router.get('/supplier-invoices', requirePermission('supplier.read'), asyncHandler(async (req, res) => {
    sendData(res, await listSupplierInvoices(pool, req.auth!, parseQuery(supplierInvoiceQuerySchema, req)));
  }));

  router.post('/supplier-invoices', requirePermission('supplier-invoice.manage'), validateBody(createSupplierInvoiceSchema), idempotency(pool, 'supplier-invoices.create'), asyncHandler(async (req, res) => {
    const result = await createSupplierInvoice(pool, req.auth!, req.body, req);
    sendData(res, result, result.replayed ? 200 : 201);
  }));

  router.get('/supplier-invoices/:invoiceId', requirePermission('supplier.read'), asyncHandler(async (req, res) => {
    sendData(res, { invoice: await getSupplierInvoice(pool, req.auth!, uuidParam(req, 'invoiceId')) });
  }));

  return router;
}
