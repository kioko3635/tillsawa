import { Router } from 'express';
import {
  PERMISSION_CODES,
  createBranchSchema,
  createUserSchema,
  roleSchema,
  updateBranchSchema,
  updateMembershipSchema,
  updateOrganizationConfigurationSchema,
  updateOrganizationSchema,
  updateRoleSchema
} from '@pos/contracts';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import { idempotency } from '../../http/middleware/idempotency.js';
import { requirePermission } from '../../http/middleware/auth.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import {
  createBranch,
  createMembership,
  createRole,
  getOrganization,
  listAuditEvents,
  listBranches,
  listMemberships,
  listRoles,
  getOrganizationConfiguration,
  updateBranch,
  updateMembership,
  updateOrganization,
  updateOrganizationConfiguration,
  updateRole
} from './service.js';

interface TenancyRoutesDeps {
  pool: pg.Pool;
  systemPool: pg.Pool;
  config: AppConfig;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
}

export function createTenancyRoutes({ pool, systemPool, config, authenticate }: TenancyRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);

  router.get('/organizations/current', requirePermission('organization.read'), asyncHandler(async (req, res) => {
    sendData(res, { organization: await getOrganization(pool, req.auth!) });
  }));

  router.patch('/organizations/current', requirePermission('organization.update'), validateBody(updateOrganizationSchema), asyncHandler(async (req, res) => {
    sendData(res, { organization: await updateOrganization(pool, req.auth!, req.body, req) });
  }));

  router.get('/organizations/current/configuration', requirePermission('organization.read'), asyncHandler(async (req, res) => {
    sendData(res, { configuration: await getOrganizationConfiguration(pool, req.auth!) });
  }));

  router.patch('/organizations/current/configuration', requirePermission('settings.manage'), validateBody(updateOrganizationConfigurationSchema), asyncHandler(async (req, res) => {
    sendData(res, { configuration: await updateOrganizationConfiguration(pool, req.auth!, req.body, req) });
  }));

  router.get('/branches', requirePermission('branch.read'), asyncHandler(async (req, res) => {
    sendData(res, { branches: await listBranches(pool, req.auth!) });
  }));

  router.post('/branches', requirePermission('branch.create'), validateBody(createBranchSchema), idempotency(pool, 'branches.create'), asyncHandler(async (req, res) => {
    sendData(res, { branch: await createBranch(pool, req.auth!, req.body, req) }, 201);
  }));

  router.patch('/branches/:branchId', requirePermission('branch.update'), validateBody(updateBranchSchema), asyncHandler(async (req, res) => {
    sendData(res, { branch: await updateBranch(pool, req.auth!, req.params.branchId!, req.body, req) });
  }));

  router.get('/users', requirePermission('user.read'), asyncHandler(async (req, res) => {
    sendData(res, { users: await listMemberships(pool, req.auth!) });
  }));

  router.post('/users', requirePermission('user.invite'), validateBody(createUserSchema), idempotency(pool, 'users.create'), asyncHandler(async (req, res) => {
    sendData(res, { membership: await createMembership(pool, systemPool, config, req.auth!, req.body, req) }, 201);
  }));

  router.patch('/memberships/:membershipId', requirePermission('user.update'), validateBody(updateMembershipSchema), asyncHandler(async (req, res) => {
    sendData(res, { membership: await updateMembership(pool, req.auth!, req.params.membershipId!, req.body, req, config) });
  }));

  router.get('/roles', requirePermission('role.read'), asyncHandler(async (req, res) => {
    sendData(res, { roles: await listRoles(pool, req.auth!) });
  }));

  router.post('/roles', requirePermission('role.manage'), validateBody(roleSchema), idempotency(pool, 'roles.create'), asyncHandler(async (req, res) => {
    sendData(res, { role: await createRole(pool, req.auth!, req.body, req) }, 201);
  }));

  router.patch('/roles/:roleId', requirePermission('role.manage'), validateBody(updateRoleSchema), asyncHandler(async (req, res) => {
    sendData(res, { role: await updateRole(pool, req.auth!, req.params.roleId!, req.body, req) });
  }));

  router.get('/permissions', requirePermission('role.read'), asyncHandler(async (_req, res) => {
    sendData(res, { permissions: PERMISSION_CODES });
  }));

  router.get('/audit-events', requirePermission('audit.view'), asyncHandler(async (req, res) => {
    sendData(res, { events: await listAuditEvents(pool, req.auth!) });
  }));

  return router;
}
