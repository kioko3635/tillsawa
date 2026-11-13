import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { z } from 'zod';
import {
  createExpenseCategorySchema,
  createExpenseSchema,
  expenseDecisionSchema,
  expenseExportQuerySchema,
  expenseQuerySchema,
  expenseReasonSchema,
  payExpenseSchema,
  updateExpenseCategorySchema,
  updateExpenseSchema,
  uuidSchema
} from '@pos/contracts';
import { requireAnyPermission, requireModule, requirePermission } from '../../http/middleware/auth.js';
import { idempotency } from '../../http/middleware/idempotency.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import {
  createExpense,
  createExpenseCategory,
  decideExpense,
  exportExpensesCsv,
  getExpense,
  listExpenseCategories,
  listExpenses,
  payExpense,
  submitExpense,
  updateExpense,
  updateExpenseCategory
} from './service.js';

interface ExpenseRoutesDeps {
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

export function createExpenseRoutes({ pool, authenticate }: ExpenseRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);
  router.use(['/expenses', '/expense-categories'], requireModule('expenses'));

  router.get('/expense-categories', requirePermission('expense.view'), asyncHandler(async (_req, res) => {
    sendData(res, await listExpenseCategories(pool, _req.auth!));
  }));

  router.post('/expense-categories', requirePermission('expense-category.manage'), validateBody(createExpenseCategorySchema), idempotency(pool, 'expense-categories.create'), asyncHandler(async (req, res) => {
    sendData(res, { category: await createExpenseCategory(pool, req.auth!, req.body, req) }, 201);
  }));

  router.patch('/expense-categories/:categoryId', requirePermission('expense-category.manage'), validateBody(updateExpenseCategorySchema), asyncHandler(async (req, res) => {
    sendData(res, { category: await updateExpenseCategory(pool, req.auth!, uuidParam(req, 'categoryId'), req.body, req) });
  }));

  router.get('/expenses/export.csv', requirePermission('reports.export'), asyncHandler(async (req, res) => {
    const csv = await exportExpensesCsv(pool, req.auth!, parseQuery(expenseExportQuerySchema, req));
    res.type('text/csv; charset=utf-8').set('content-disposition', 'attachment; filename="expenses.csv"').send(csv);
  }));

  router.get('/expenses', requirePermission('expense.view'), asyncHandler(async (req, res) => {
    sendData(res, await listExpenses(pool, req.auth!, parseQuery(expenseQuerySchema, req)));
  }));

  router.post('/expenses', requirePermission('expense.create'), validateBody(createExpenseSchema), idempotency(pool, 'expenses.create'), asyncHandler(async (req, res) => {
    const result = await createExpense(pool, req.auth!, req.body, req);
    sendData(res, result, result.replayed ? 200 : 201);
  }));

  router.get('/expenses/:expenseId', requirePermission('expense.view'), asyncHandler(async (req, res) => {
    sendData(res, await getExpense(pool, req.auth!, uuidParam(req, 'expenseId')));
  }));

  router.patch('/expenses/:expenseId', requireAnyPermission(['expense.create', 'expense.adjust']), validateBody(updateExpenseSchema), asyncHandler(async (req, res) => {
    sendData(res, await updateExpense(pool, req.auth!, uuidParam(req, 'expenseId'), req.body, req));
  }));

  router.post('/expenses/:expenseId/submit', requirePermission('expense.submit'), idempotency(pool, 'expenses.submit'), asyncHandler(async (req, res) => {
    sendData(res, await submitExpense(pool, req.auth!, uuidParam(req, 'expenseId'), req));
  }));

  router.post('/expenses/:expenseId/approve', requirePermission('expense.approve'), validateBody(expenseDecisionSchema), idempotency(pool, 'expenses.approve'), asyncHandler(async (req, res) => {
    sendData(res, await decideExpense(pool, req.auth!, uuidParam(req, 'expenseId'), 'approve', req.body.reason, req));
  }));

  router.post('/expenses/:expenseId/reject', requirePermission('expense.reject'), validateBody(expenseReasonSchema), idempotency(pool, 'expenses.reject'), asyncHandler(async (req, res) => {
    sendData(res, await decideExpense(pool, req.auth!, uuidParam(req, 'expenseId'), 'reject', req.body.reason, req));
  }));

  router.post('/expenses/:expenseId/cancel', requirePermission('expense.cancel'), validateBody(expenseReasonSchema), idempotency(pool, 'expenses.cancel'), asyncHandler(async (req, res) => {
    sendData(res, await decideExpense(pool, req.auth!, uuidParam(req, 'expenseId'), 'cancel', req.body.reason, req));
  }));

  router.post('/expenses/:expenseId/pay', requirePermission('expense.pay'), validateBody(payExpenseSchema), idempotency(pool, 'expenses.pay'), asyncHandler(async (req, res) => {
    const result = await payExpense(pool, req.auth!, uuidParam(req, 'expenseId'), req.body, req);
    sendData(res, result, result.replayed ? 200 : 201);
  }));

  return router;
}
