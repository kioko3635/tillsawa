import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { createLicenseService } from './service.js';
import type pg from 'pg';
import { requirePermission } from '../../http/middleware/auth.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import { getOrganization } from '../tenancy/service.js';
import { envelopeSchema } from './verification.js';

export function createLicenseRoutes(pool: pg.Pool, service: ReturnType<typeof createLicenseService>, authenticate: (req: Request, res: Response, next: NextFunction) => void) {
  const router = Router();
  router.get('/licensing/status', authenticate, asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await service.status(req.auth!.organizationId));
  }));
  router.get('/licensing/request', authenticate, requirePermission('settings.manage'), asyncHandler(async (req, res) => {
    const organization = await getOrganization(pool, req.auth!);
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, service.request(req.auth!.organizationId, organization.displayName));
  }));
  router.post('/licensing/import', authenticate, requirePermission('settings.manage'), validateBody(envelopeSchema), asyncHandler(async (req, res) => {
    sendData(res, await service.import(req.auth!.organizationId, req.body, req));
  }));
  return router;
}
