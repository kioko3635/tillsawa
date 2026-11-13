import { Router } from 'express';
import {
  SYNC_CONTRACT_VERSION,
  registerDeviceSchema,
  resolveSyncTransactionSchema,
  syncBatchSchema,
  syncCursorSchema,
  syncTransactionQuerySchema,
  updateDeviceSchema,
  uuidSchema
} from '@pos/contracts';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import { idempotency } from '../../http/middleware/idempotency.js';
import { requireModule, requirePermission } from '../../http/middleware/auth.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import {
  getSyncBootstrap,
  getSyncState,
  getSyncTransaction,
  listDevices,
  listSyncTransactions,
  registerDevice,
  resolveSyncTransaction,
  submitSyncBatch,
  updateDevice,
  updateSyncCursor
} from './service.js';

interface SyncRoutesDeps {
  pool: pg.Pool;
  config: AppConfig;
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

function deviceKey(req: Request): string {
  return req.header('x-device-key') ?? '';
}

export function createSyncRoutes({ pool, config, authenticate }: SyncRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);

  // Device management remains available so administrators can revoke devices
  // before or after disabling offline synchronization for the organization.
  router.use('/sync', requireModule('offline_sync'));

  router.get('/sync/contract', requirePermission('sync.read'), asyncHandler(async (_req, res) => {
    sendData(res, {
      contractVersion: SYNC_CONTRACT_VERSION,
      capabilities: [
        'registered-device',
        'device-key-authentication',
        'durable-outbox',
        'idempotent-sale-replay',
        'conflict-resolution',
        'reference-snapshot'
      ]
    });
  }));

  router.get('/sync/state', requirePermission('sync.read'), asyncHandler(async (req, res) => {
    const parsed = uuidSchema.safeParse(req.query.deviceId);
    if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'A valid deviceId query parameter is required');
    sendData(res, { sync: await getSyncState(pool, config, req.auth!, parsed.data, deviceKey(req)) });
  }));

  router.get('/sync/bootstrap', requirePermission('sync.read'), asyncHandler(async (req, res) => {
    const parsed = uuidSchema.safeParse(req.query.deviceId);
    if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'A valid deviceId query parameter is required');
    sendData(res, { bootstrap: await getSyncBootstrap(pool, config, req.auth!, parsed.data, deviceKey(req)) });
  }));

  router.get('/sync/transactions', requirePermission('sync.read'), asyncHandler(async (req, res) => {
    sendData(res, {
      transactions: await listSyncTransactions(pool, config, req.auth!, parseQuery(syncTransactionQuerySchema, req), deviceKey(req))
    });
  }));

  router.get('/sync/transactions/:clientTransactionId', requirePermission('sync.read'), asyncHandler(async (req, res) => {
    const parsedDevice = uuidSchema.safeParse(req.query.deviceId);
    if (!parsedDevice.success) throw badRequest('VALIDATION_ERROR', 'A valid deviceId query parameter is required');
    sendData(res, {
      transaction: await getSyncTransaction(pool, config, req.auth!, parsedDevice.data, uuidParam(req, 'clientTransactionId'), deviceKey(req))
    });
  }));

  router.post('/sync/transactions', requirePermission('sync.write'), validateBody(syncBatchSchema), idempotency(pool, 'sync.transactions'), asyncHandler(async (req, res) => {
    sendData(res, await submitSyncBatch(pool, config, req.auth!, req.body, deviceKey(req), req));
  }));

  router.post('/sync/transactions/:syncTransactionId/resolve', requirePermission('sync.resolve-conflict'), validateBody(resolveSyncTransactionSchema), idempotency(pool, 'sync.resolve'), asyncHandler(async (req, res) => {
    sendData(res, {
      transaction: await resolveSyncTransaction(pool, config, req.auth!, uuidParam(req, 'syncTransactionId'), req.body, deviceKey(req), req)
    });
  }));

  router.post('/sync/cursor', requirePermission('sync.write'), validateBody(syncCursorSchema), asyncHandler(async (req, res) => {
    sendData(res, { sync: await updateSyncCursor(pool, config, req.auth!, req.body, deviceKey(req), req) });
  }));

  router.get('/devices', requirePermission('device.read'), asyncHandler(async (req, res) => {
    sendData(res, { devices: await listDevices(pool, req.auth!) });
  }));

  router.post('/devices/register', requirePermission('device.register'), validateBody(registerDeviceSchema), idempotency(pool, 'devices.register'), asyncHandler(async (req, res) => {
    sendData(res, await registerDevice(pool, config, req.auth!, req.body, req), 201);
  }));

  router.patch('/devices/:deviceId', validateBody(updateDeviceSchema), asyncHandler(async (req, res) => {
    sendData(res, { device: await updateDevice(pool, req.auth!, req.params.deviceId!, req.body, req) });
  }));

  return router;
}
