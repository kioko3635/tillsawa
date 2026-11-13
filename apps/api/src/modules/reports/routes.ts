import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { z } from 'zod';
import { operationsReportQuerySchema } from '@pos/contracts';
import { requireModule, requirePermission } from '../../http/middleware/auth.js';
import { AppError } from '../../shared/errors.js';
import { asyncHandler, sendData } from '../../shared/http.js';
import { exportOperationsReportCsv, getOperationsReport } from './service.js';

interface ReportsRoutesDeps {
  pool: pg.Pool;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
}

function parseQuery<S extends z.ZodTypeAny>(schema: S, req: Request): z.output<S> {
  const result = schema.safeParse(req.query);
  if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', 'Query validation failed', result.error.flatten());
  return result.data as z.output<S>;
}

export function createReportsRoutes({ pool, authenticate }: ReportsRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);
  router.use('/reports', requireModule('reports'));
  router.get('/reports/operations', requirePermission('reports.view'), asyncHandler(async (req, res) => {
    sendData(res, { report: await getOperationsReport(pool, req.auth!, parseQuery(operationsReportQuerySchema, req)) });
  }));
  router.get('/reports/operations/export.csv', requirePermission('reports.export'), asyncHandler(async (req, res) => {
    const csv = await exportOperationsReportCsv(pool, req.auth!, parseQuery(operationsReportQuerySchema, req));
    res.type('text/csv; charset=utf-8').set('content-disposition', 'attachment; filename="operations-report.csv"').send(csv);
  }));
  return router;
}
