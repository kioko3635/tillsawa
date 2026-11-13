import { createHash } from 'node:crypto';
import {
  SYNC_CONTRACT_VERSION,
  offlineSaleTransactionPayloadSchema,
  type CompleteSaleInput,
  type OfflineSaleSnapshot,
  type RegisterDeviceInput,
  type ResolveSyncTransactionInput,
  type SyncBatchInput,
  type SyncCursorInput,
  type SyncTransactionItem,
  type SyncTransactionQuery,
  type UpdateDeviceInput
} from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import { withTransaction, type Queryable } from '../../database/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { listAccessibleBranchIds, membershipHasBranchAccess, type AuthContext } from '../../http/middleware/auth.js';
import { requestPayloadHash } from '../../http/middleware/idempotency.js';
import { minorUnitsToDecimal } from '../../shared/money.js';
import { recordAudit } from '../audit/audit.js';
import { generateOpaqueToken, hashOpaqueToken } from '../identity/security.js';
import { completeSaleInTransaction } from '../pos/service.js';
import { resolvePrice } from '../pricing/service.js';

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

export async function registerDevice(pool: pg.Pool, config: AppConfig, auth: AuthContext, input: RegisterDeviceInput, req: Request) {
  if (!(await membershipHasBranchAccess(pool, auth, input.branchId))) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
  }
  const deviceKey = generateOpaqueToken(32);
  return withTransaction(pool, async (tx) => {
    let deviceId: string;
    let createdAt: Date;
    try {
      const result = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO registered_devices
          (organization_id, branch_id, name, platform, device_key_hash, created_by_membership_id, contract_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, created_at`,
        [auth.organizationId, input.branchId, input.name, input.platform ?? null, hashOpaqueToken(deviceKey, config), auth.membershipId, SYNC_CONTRACT_VERSION]
      );
      deviceId = result.rows[0]!.id;
      createdAt = result.rows[0]!.created_at;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw conflict('DEVICE_NAME_TAKEN', 'A device with this name already exists');
      }
      throw error;
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: input.branchId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      deviceId,
      action: 'device.registered',
      entityType: 'registered_device',
      entityId: deviceId,
      metadata: { name: input.name, platform: input.platform ?? null },
      ...requestMeta(req)
    });
    return {
      device: {
        id: deviceId,
        name: input.name,
        branchId: input.branchId,
        status: 'active',
        contractVersion: SYNC_CONTRACT_VERSION,
        createdAt: createdAt.toISOString()
      },
      deviceKey
    };
  });
}

export async function listDevices(pool: pg.Pool, auth: AuthContext) {
  const branchIds = await listAccessibleBranchIds(pool, auth);
  if (branchIds.length === 0) return [];
  const result = await pool.query(
    `SELECT d.id, d.name, d.platform, d.branch_id AS "branchId", b.name AS "branchName", d.status,
            d.contract_version AS "contractVersion", d.last_sync_at AS "lastSyncAt", d.created_at AS "createdAt"
     FROM registered_devices d
     JOIN branches b ON b.id = d.branch_id AND b.organization_id = d.organization_id
     WHERE d.organization_id = $1 AND d.branch_id = ANY($2::uuid[])
     ORDER BY d.created_at DESC`,
    [auth.organizationId, branchIds]
  );
  return result.rows;
}

export async function updateDevice(pool: pg.Pool, auth: AuthContext, deviceId: string, input: UpdateDeviceInput, req: Request) {
  if (input.status && !auth.permissions.has('device.revoke')) throw forbidden();
  if ((input.name || input.branchId) && !auth.permissions.has('device.register')) throw forbidden();
  return withTransaction(pool, async (tx) => {
    const existing = await tx.query<{ branch_id: string }>(
      'SELECT branch_id FROM registered_devices WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [deviceId, auth.organizationId]
    );
    const device = existing.rows[0];
    if (!device) throw notFound('Device was not found');
    if (!(await membershipHasBranchAccess(pool, auth, device.branch_id))) {
      throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
    }
    if (input.branchId && !(await membershipHasBranchAccess(pool, auth, input.branchId))) {
      throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      values.push(input.name);
      updates.push(`name = $${values.length + 2}`);
    }
    if (input.branchId !== undefined) {
      values.push(input.branchId);
      updates.push(`branch_id = $${values.length + 2}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      updates.push(`status = $${values.length + 2}`);
    }
    try {
      await tx.query(`UPDATE registered_devices SET ${updates.join(', ')} WHERE id = $1 AND organization_id = $2`, [deviceId, auth.organizationId, ...values]);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw conflict('DEVICE_NAME_TAKEN', 'A device with this name already exists');
      }
      throw error;
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: input.branchId ?? device.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      deviceId,
      action: 'device.updated',
      entityType: 'registered_device',
      entityId: deviceId,
      metadata: input as Record<string, unknown>,
      ...requestMeta(req)
    });
    return { id: deviceId, ...input };
  });
}

interface AuthorizedDevice {
  id: string;
  branch_id: string;
  status: string;
  contract_version: string;
  device_key_hash: string;
}

async function authorizedDevice(
  pool: pg.Pool,
  config: AppConfig,
  auth: AuthContext,
  deviceId: string,
  deviceKey?: string
): Promise<AuthorizedDevice> {
  const result = await pool.query<AuthorizedDevice>(
    `SELECT id, branch_id, status, contract_version, device_key_hash
     FROM registered_devices
     WHERE id = $1 AND organization_id = $2`,
    [deviceId, auth.organizationId]
  );
  const device = result.rows[0];
  if (!device || device.status !== 'active') throw forbidden('DEVICE_NOT_REGISTERED', 'Device is not registered or active');
  if (!(await membershipHasBranchAccess(pool, auth, device.branch_id))) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
  }
  if (deviceKey !== undefined) {
    const suppliedHash = deviceKey ? hashOpaqueToken(deviceKey, config) : '';
    const expected = Buffer.from(device.device_key_hash, 'utf8');
    const actual = Buffer.from(suppliedHash, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw forbidden('DEVICE_KEY_INVALID', 'The registered device key is invalid');
    }
  }
  if (device.contract_version !== SYNC_CONTRACT_VERSION) {
    throw conflict('SYNC_CONTRACT_UNSUPPORTED', 'The device synchronization contract is not supported by this server');
  }
  return device;
}

function timingSafeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (const [index, byte] of left.entries()) different |= byte ^ right[index]!;
  return different === 0;
}

export async function getSyncState(pool: pg.Pool, config: AppConfig, auth: AuthContext, deviceId: string, deviceKey?: string) {
  const device = await authorizedDevice(pool, config, auth, deviceId, deviceKey);
  const cursors = await pool.query(
    `SELECT entity_type AS "entityType", cursor_value::text AS cursor, updated_at AS "updatedAt"
     FROM sync_cursors
     WHERE organization_id = $1 AND device_id = $2`,
    [auth.organizationId, deviceId]
  );
  return {
    contractVersion: SYNC_CONTRACT_VERSION,
    device: { id: device.id, branchId: device.branch_id, status: device.status, contractVersion: device.contract_version },
    serverTime: new Date().toISOString(),
    cursors: cursors.rows
  };
}

export async function updateSyncCursor(pool: pg.Pool, config: AppConfig, auth: AuthContext, input: SyncCursorInput, deviceKey: string | undefined, req: Request) {
  const device = await authorizedDevice(pool, config, auth, input.deviceId, deviceKey);
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO sync_cursors (organization_id, device_id, entity_type, branch_id, cursor_value)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, device_id, entity_type)
       DO UPDATE SET cursor_value = GREATEST(sync_cursors.cursor_value, EXCLUDED.cursor_value), branch_id = EXCLUDED.branch_id`,
      [auth.organizationId, input.deviceId, input.entityType, device.branch_id, input.cursor]
    );
    await tx.query('UPDATE registered_devices SET last_sync_at = now() WHERE id = $1 AND organization_id = $2', [input.deviceId, auth.organizationId]);
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: device.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      deviceId: input.deviceId,
      action: 'sync.cursor-updated',
      entityType: 'registered_device',
      entityId: input.deviceId,
      metadata: { entityType: input.entityType, cursor: input.cursor },
      ...requestMeta(req)
    });
  });
  return getSyncState(pool, config, auth, input.deviceId, deviceKey);
}

interface SyncTransactionRow {
  id: string;
  organization_id: string;
  device_id: string;
  branch_id: string;
  client_transaction_id: string;
  entity_type: string;
  payload_hash: string;
  payload: unknown;
  client_occurred_at: Date;
  cashier_membership_id: string | null;
  submitted_by_membership_id: string | null;
  status: string;
  sale_id: string | null;
  server_entity_type: string | null;
  server_entity_id: string | null;
  receipt_number: string | null;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  attempt_count: number;
  first_attempt_at: Date | null;
  last_attempt_at: Date | null;
  processed_at: Date | null;
  resolution_action: string | null;
  resolution_reason: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapSyncTransaction(row: SyncTransactionRow) {
  return {
    syncTransactionId: row.id,
    clientTransactionId: row.client_transaction_id,
    entityType: row.entity_type,
    deviceId: row.device_id,
    branchId: row.branch_id,
    cashierMembershipId: row.cashier_membership_id,
    status: row.status,
    outcome: row.status,
    saleId: row.sale_id,
    serverEntityType: row.server_entity_type,
    serverEntityId: row.server_entity_id,
    receiptNumber: row.receipt_number,
    error: row.error_code
      ? { code: row.error_code, message: row.error_message ?? 'Synchronization failed', details: row.error_details }
      : null,
    attempts: row.attempt_count,
    clientOccurredAt: row.client_occurred_at.toISOString(),
    firstAttemptAt: row.first_attempt_at?.toISOString() ?? null,
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    processedAt: row.processed_at?.toISOString() ?? null,
    resolutionAction: row.resolution_action,
    resolutionReason: row.resolution_reason,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function errorDetails(error: unknown): { code: string; message: string; details?: unknown; statusCode: number } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details, statusCode: error.statusCode };
  }
  return { code: 'SYNC_INTERNAL_ERROR', message: 'The transaction could not be synchronized because of a server error', statusCode: 500 };
}

function classifySyncError(error: unknown): 'retryable' | 'rejected' | 'conflict' {
  const details = errorDetails(error);
  if (details.statusCode >= 500) return 'retryable';
  if (details.statusCode === 409) return 'conflict';
  if (['SALE_IDENTIFIER_CONFLICT', 'SYNC_ACTOR_MISMATCH', 'BRANCH_ACCESS_DENIED', 'DEVICE_NOT_REGISTERED'].includes(details.code)) return 'conflict';
  if (details.statusCode === 403) return 'conflict';
  return 'rejected';
}

async function findSyncTransaction(db: Pick<pg.Pool | pg.PoolClient, 'query'>, organizationId: string, clientTransactionId: string, lock = false) {
  const result = await db.query<SyncTransactionRow>(
    `SELECT * FROM sync_transactions
     WHERE organization_id = $1 AND client_transaction_id = $2
     ${lock ? 'FOR UPDATE' : ''}`,
    [organizationId, clientTransactionId]
  );
  return result.rows[0];
}

async function insertAttempt(
  tx: pg.PoolClient,
  syncTransaction: SyncTransactionRow,
  outcome: string,
  error: { code?: string; message?: string } | null,
  serverEntityId?: string | null
) {
  await tx.query(
    `INSERT INTO sync_attempts (
      organization_id, sync_transaction_id, device_id, client_transaction_id,
      attempt_number, outcome, error_code, error_message, server_entity_id, started_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      syncTransaction.organization_id,
      syncTransaction.id,
      syncTransaction.device_id,
      syncTransaction.client_transaction_id,
      syncTransaction.attempt_count,
      outcome,
      error?.code ?? null,
      error?.message ?? null,
      serverEntityId ?? null,
      syncTransaction.last_attempt_at ?? new Date().toISOString()
    ]
  );
}

async function storeSyncOutcome(
  tx: pg.PoolClient,
  auth: AuthContext,
  item: SyncTransactionItem,
  outcome: 'accepted' | 'duplicate' | 'retryable' | 'rejected' | 'conflict' | 'resolved',
  req: Request,
  extras: {
    saleId?: string | null;
    receiptNumber?: string | null;
    error?: { code: string; message: string; details?: unknown } | null;
  } = {}
) {
  const payloadHash = requestPayloadHash(item);
  const inserted = await tx.query<SyncTransactionRow>(
    `INSERT INTO sync_transactions (
      organization_id, device_id, branch_id, client_transaction_id, entity_type, payload_hash, payload,
      client_occurred_at, cashier_membership_id, submitted_by_membership_id, status,
      sale_id, server_entity_type, server_entity_id, receipt_number,
      error_code, error_message, error_details,
      attempt_count, first_attempt_at, last_attempt_at, processed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,1,now(),now(),now())
    ON CONFLICT (organization_id, client_transaction_id) DO NOTHING
    RETURNING *`,
    [
      auth.organizationId,
      item.deviceId,
      item.branchId,
      item.clientTransactionId,
      item.entityType,
      payloadHash,
      JSON.stringify(item),
      item.occurredAt,
      item.cashierMembershipId,
      auth.membershipId,
      outcome,
      extras.saleId ?? null,
      extras.saleId ? 'sale' : null,
      extras.saleId ?? null,
      extras.receiptNumber ?? null,
      extras.error?.code ?? null,
      extras.error?.message ?? null,
      extras.error?.details === undefined ? null : JSON.stringify(extras.error.details)
    ]
  );
  let transaction = inserted.rows[0];
  if (!transaction) {
    transaction = await findSyncTransaction(tx, auth.organizationId, item.clientTransactionId, true);
    if (!transaction) throw new Error('Sync transaction was not persisted');
    if (transaction.payload_hash !== payloadHash) {
      outcome = 'conflict';
      extras = {
        error: {
          code: 'SYNC_PAYLOAD_CONFLICT',
          message: 'The client transaction identifier was reused with a different payload'
        }
      };
    }
    const updated = await tx.query<SyncTransactionRow>(
      `UPDATE sync_transactions
       SET status = $3,
           sale_id = COALESCE($4, sale_id),
           server_entity_type = COALESCE($5, server_entity_type),
           server_entity_id = COALESCE($6, server_entity_id),
           receipt_number = COALESCE($7, receipt_number),
           error_code = $8,
           error_message = $9,
           error_details = $10::jsonb,
           attempt_count = attempt_count + 1,
           first_attempt_at = COALESCE(first_attempt_at, now()),
           last_attempt_at = now(),
           processed_at = now(),
           updated_at = now()
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [
        transaction.id,
        auth.organizationId,
        outcome,
        extras.saleId ?? null,
        extras.saleId ? 'sale' : null,
        extras.saleId ?? null,
        extras.receiptNumber ?? null,
        extras.error?.code ?? null,
        extras.error?.message ?? null,
        extras.error?.details === undefined ? null : JSON.stringify(extras.error.details)
      ]
    );
    transaction = updated.rows[0]!;
  }
  await insertAttempt(tx, transaction, outcome, extras.error ?? null, extras.saleId ?? null);
  await tx.query('UPDATE registered_devices SET last_sync_at = now() WHERE id = $1 AND organization_id = $2', [item.deviceId, auth.organizationId]);
  await recordAudit(tx, {
    organizationId: auth.organizationId,
    branchId: item.branchId,
    actorMembershipId: auth.membershipId,
    actorUserId: auth.userId,
    deviceId: item.deviceId,
    action: `sync.transaction-${outcome}`,
    entityType: 'sync_transaction',
    entityId: transaction.id,
    metadata: {
      clientTransactionId: item.clientTransactionId,
      entityType: item.entityType,
      errorCode: extras.error?.code ?? null,
      saleId: extras.saleId ?? null,
      receiptNumber: extras.receiptNumber ?? null
    },
    ...requestMeta(req)
  });
  return transaction;
}

function validateSaleEnvelope(item: SyncTransactionItem) {
  const parsed = offlineSaleTransactionPayloadSchema.safeParse(item.payload);
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', 'Offline sale payload validation failed', parsed.error.flatten());
  }
  const { sale, snapshot } = parsed.data;
  if (sale.clientTransactionId !== item.clientTransactionId || sale.deviceId !== item.deviceId || sale.registerSessionId !== item.registerSessionId) {
    throw conflict('SYNC_CONTEXT_CONFLICT', 'The offline sale context does not match its synchronization envelope');
  }
  if (sale.payment.method !== 'cash' || sale.customerId || sale.priceListId) {
    throw badRequest('UNSUPPORTED_OFFLINE_TRANSACTION', 'Phase 6 supports offline cash sales without a customer or selected price list only');
  }
  if (sale.items.length !== snapshot.lines.length) {
    throw conflict('SALE_REFERENCE_CONFLICT', 'The offline sale snapshot does not match the submitted lines');
  }
  return parsed.data;
}

async function beginSyncProcessing(
  tx: pg.PoolClient,
  auth: AuthContext,
  item: SyncTransactionItem
): Promise<{ transaction: SyncTransactionRow; final: boolean }> {
  const payloadHash = requestPayloadHash(item);
  const inserted = await tx.query<SyncTransactionRow>(
    `INSERT INTO sync_transactions (
      organization_id, device_id, branch_id, client_transaction_id, entity_type, payload_hash, payload,
      client_occurred_at, cashier_membership_id, submitted_by_membership_id, status,
      attempt_count, first_attempt_at, last_attempt_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'processing',1,now(),now())
    ON CONFLICT (organization_id, client_transaction_id) DO NOTHING
    RETURNING *`,
    [
      auth.organizationId,
      item.deviceId,
      item.branchId,
      item.clientTransactionId,
      item.entityType,
      payloadHash,
      JSON.stringify(item),
      item.occurredAt,
      item.cashierMembershipId,
      auth.membershipId
    ]
  );
  let transaction = inserted.rows[0];
  if (!transaction) {
    transaction = await findSyncTransaction(tx, auth.organizationId, item.clientTransactionId, true);
    if (!transaction) throw new Error('Sync transaction was not persisted');
    if (transaction.payload_hash !== payloadHash) {
      const updated = await tx.query<SyncTransactionRow>(
        `UPDATE sync_transactions
         SET status = 'conflict', error_code = 'SYNC_PAYLOAD_CONFLICT',
             error_message = 'The client transaction identifier was reused with a different payload',
             error_details = NULL, attempt_count = attempt_count + 1, last_attempt_at = now(),
             processed_at = now(), updated_at = now()
         WHERE id = $1 AND organization_id = $2
         RETURNING *`,
        [transaction.id, auth.organizationId]
      );
      transaction = updated.rows[0]!;
      await insertAttempt(tx, transaction, 'conflict', {
        code: 'SYNC_PAYLOAD_CONFLICT',
        message: 'The client transaction identifier was reused with a different payload'
      });
      return { transaction, final: true };
    }
    if (['accepted', 'duplicate', 'rejected', 'conflict', 'resolved'].includes(transaction.status)) {
      return { transaction, final: true };
    }
    const updated = await tx.query<SyncTransactionRow>(
      `UPDATE sync_transactions
       SET status = 'processing', attempt_count = attempt_count + 1,
           first_attempt_at = COALESCE(first_attempt_at, now()), last_attempt_at = now(), updated_at = now()
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [transaction.id, auth.organizationId]
    );
    transaction = updated.rows[0]!;
  }
  return { transaction, final: false };
}

async function recordDuplicateReplay(
  pool: pg.Pool,
  auth: AuthContext,
  item: SyncTransactionItem,
  req: Request
): Promise<SyncTransactionRow> {
  return withTransaction(pool, async (tx) => {
    const current = await findSyncTransaction(tx, auth.organizationId, item.clientTransactionId, true);
    if (!current) throw new Error('Sync transaction was not persisted');
    const updated = await tx.query<SyncTransactionRow>(
      `UPDATE sync_transactions
       SET attempt_count = attempt_count + 1,
           first_attempt_at = COALESCE(first_attempt_at, now()),
           last_attempt_at = now(), processed_at = COALESCE(processed_at, now()), updated_at = now()
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [current.id, auth.organizationId]
    );
    const transaction = { ...updated.rows[0]!, status: 'duplicate' };
    await insertAttempt(tx, transaction, 'duplicate', null, transaction.sale_id);
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: item.branchId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      deviceId: item.deviceId,
      action: 'sync.transaction-duplicate',
      entityType: 'sync_transaction',
      entityId: transaction.id,
      metadata: {
        clientTransactionId: item.clientTransactionId,
        saleId: transaction.sale_id,
        receiptNumber: transaction.receipt_number
      },
      ...requestMeta(req)
    });
    return transaction;
  });
}

async function recordPayloadConflictReplay(
  pool: pg.Pool,
  auth: AuthContext,
  item: SyncTransactionItem,
  req: Request
): Promise<SyncTransactionRow> {
  return withTransaction(pool, async (tx) => {
    const current = await findSyncTransaction(tx, auth.organizationId, item.clientTransactionId, true);
    if (!current) throw new Error('Sync transaction was not persisted');
    const updated = await tx.query<SyncTransactionRow>(
      `UPDATE sync_transactions
       SET attempt_count = attempt_count + 1,
           first_attempt_at = COALESCE(first_attempt_at, now()), last_attempt_at = now(), updated_at = now()
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [current.id, auth.organizationId]
    );
    const transaction = {
      ...updated.rows[0]!,
      status: 'conflict',
      error_code: 'SYNC_PAYLOAD_CONFLICT',
      error_message: 'The client transaction identifier was reused with a different payload',
      error_details: null
    };
    await insertAttempt(tx, transaction, 'conflict', {
      code: 'SYNC_PAYLOAD_CONFLICT',
      message: 'The client transaction identifier was reused with a different payload'
    });
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: item.branchId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      deviceId: item.deviceId,
      action: 'sync.transaction-conflict',
      entityType: 'sync_transaction',
      entityId: transaction.id,
      metadata: { clientTransactionId: item.clientTransactionId, errorCode: 'SYNC_PAYLOAD_CONFLICT' },
      ...requestMeta(req)
    });
    return transaction;
  });
}

async function validateOriginatingCashier(
  tx: Queryable,
  auth: AuthContext,
  item: SyncTransactionItem,
  hasDiscount: boolean
): Promise<{ code: string; message: string } | null> {
  const result = await tx.query<{
    status: string;
    all_branches: boolean;
    can_sell: boolean;
    can_discount: boolean;
    branch_allowed: boolean;
  }>(
    `SELECT m.status, m.all_branches,
            COALESCE(bool_or(rp.permission_code = 'sales.create'), false) AS can_sell,
            COALESCE(bool_or(rp.permission_code = 'sales.discount'), false) AS can_discount,
            EXISTS (
              SELECT 1 FROM membership_branches mb
              WHERE mb.membership_id = m.id AND mb.organization_id = m.organization_id AND mb.branch_id = $2
            ) AS branch_allowed
     FROM memberships m
     LEFT JOIN membership_roles mr ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
     LEFT JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.organization_id = m.organization_id
     WHERE m.id = $1 AND m.organization_id = $3
     GROUP BY m.id`,
    [item.cashierMembershipId, item.branchId, auth.organizationId]
  );
  const cashier = result.rows[0];
  if (!cashier || cashier.status !== 'active') {
    return { code: 'PERMISSION_REVOKED', message: 'The originating cashier membership is not active' };
  }
  if (!cashier.can_sell) {
    return { code: 'PERMISSION_REVOKED', message: 'The originating cashier no longer has permission to create sales' };
  }
  if (hasDiscount && !cashier.can_discount) {
    return { code: 'PERMISSION_REVOKED', message: 'The originating cashier does not have permission to apply sale discounts' };
  }
  if (!cashier.all_branches && !cashier.branch_allowed) {
    return { code: 'BRANCH_ACCESS_DENIED', message: 'The originating cashier no longer has access to the transaction branch' };
  }
  return null;
}

async function applySyncTransaction(
  pool: pg.Pool,
  auth: AuthContext,
  device: AuthorizedDevice,
  item: SyncTransactionItem,
  req: Request
): Promise<SyncTransactionRow> {
  if (item.branchId !== device.branch_id) {
    throw conflict('SYNC_BRANCH_CONFLICT', 'The transaction branch does not match the registered device branch');
  }
  if (item.cashierMembershipId !== auth.membershipId && !auth.permissions.has('sync.resolve-conflict')) {
    throw conflict('SYNC_ACTOR_MISMATCH', 'Only the originating cashier or an authorized sync resolver can submit this offline transaction');
  }

  const existing = await findSyncTransaction(pool, auth.organizationId, item.clientTransactionId);
  if (existing) {
    const payloadHash = requestPayloadHash(item);
    if (existing.payload_hash !== payloadHash) {
      if (['accepted', 'duplicate', 'resolved'].includes(existing.status)) {
        return recordPayloadConflictReplay(pool, auth, item, req);
      }
      return withTransaction(pool, (tx) => storeSyncOutcome(tx, auth, item, 'conflict', req, {
        error: {
          code: 'SYNC_PAYLOAD_CONFLICT',
          message: 'The client transaction identifier was reused with a different payload'
        }
      }));
    }
    if (['accepted', 'duplicate'].includes(existing.status)) return recordDuplicateReplay(pool, auth, item, req);
    if (['rejected', 'conflict', 'resolved'].includes(existing.status)) return existing;
  }

  if (item.entityType !== 'pos.sale') {
    return withTransaction(pool, (tx) => storeSyncOutcome(tx, auth, item, 'rejected', req, {
      error: { code: 'UNSUPPORTED_ENTITY_TYPE', message: 'Only POS sales can be synchronized in Phase 6' }
    }));
  }

  try {
    return await withTransaction(pool, async (tx) => {
      const prepared = await beginSyncProcessing(tx, auth, item);
      const current = prepared.transaction;
      if (prepared.final) return current;
      const envelope = validateSaleEnvelope(item);
      let saleInput: CompleteSaleInput = {
        ...envelope.sale,
        allowNegative: false,
        negativeReason: null,
        allowCreditOverride: false,
        creditOverrideReason: null
      };
      const invalidContext =
        saleInput.clientTransactionId !== item.clientTransactionId ||
        saleInput.registerSessionId !== item.registerSessionId ||
        saleInput.deviceId !== item.deviceId;
      if (invalidContext) {
        return storeSyncOutcome(tx, auth, item, 'rejected', req, {
          error: { code: 'SYNC_CONTEXT_MISMATCH', message: 'The embedded sale does not match the sync transaction context' }
        });
      }
      if (saleInput.payment.method !== 'cash') {
        return storeSyncOutcome(tx, auth, item, 'rejected', req, {
          error: { code: 'UNSUPPORTED_OFFLINE_PAYMENT', message: 'Only cash sales can be synchronized in Phase 6' }
        });
      }
      const hasDiscount = saleInput.items.some((line) => line.discountPct !== undefined && Number(line.discountPct) > 0);
      const cashierIssue = await validateOriginatingCashier(tx, auth, item, hasDiscount);
      if (cashierIssue) {
        return storeSyncOutcome(tx, auth, item, 'conflict', req, {
          error: { code: cashierIssue.code, message: cashierIssue.message }
        });
      }
      let expectedSnapshot: OfflineSaleSnapshot | undefined = envelope.snapshot;
      if (current.resolution_action === 'accept-current-price') {
        expectedSnapshot = undefined;
      } else if (current.resolution_action === 'override-negative-stock') {
        saleInput = {
          ...saleInput,
          allowNegative: true,
          negativeReason: current.resolution_reason ?? 'Authorized offline stock override'
        };
      }
      const result = await completeSaleInTransaction(tx, auth, saleInput, req, {
        expectedSnapshot,
        clientOccurredAt: item.occurredAt,
        cashierMembershipId: item.cashierMembershipId
      });
      const outcome = result.replayed ? 'duplicate' : 'accepted';
      const updated = await tx.query<SyncTransactionRow>(
        `UPDATE sync_transactions
         SET status = $3, sale_id = $4, server_entity_type = 'sale', server_entity_id = $4,
             receipt_number = $5, error_code = NULL, error_message = NULL, error_details = NULL,
             processed_at = now(), updated_at = now()
         WHERE id = $1 AND organization_id = $2
         RETURNING *`,
        [current.id, auth.organizationId, outcome, result.saleId, result.receiptNumber]
      );
      const transaction = updated.rows[0]!;
      await insertAttempt(tx, transaction, outcome, null, result.saleId);
      await tx.query('UPDATE registered_devices SET last_sync_at = now() WHERE id = $1 AND organization_id = $2', [item.deviceId, auth.organizationId]);
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: item.branchId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        deviceId: item.deviceId,
        action: `sync.transaction-${outcome}`,
        entityType: 'sync_transaction',
        entityId: transaction.id,
        metadata: {
          clientTransactionId: item.clientTransactionId,
          saleId: result.saleId,
          receiptNumber: result.receiptNumber,
          replayed: result.replayed
        },
        ...requestMeta(req)
      });
      return transaction;
    });
  } catch (error) {
    const details = errorDetails(error);
    const outcome = classifySyncError(error);
    return withTransaction(pool, (tx) => storeSyncOutcome(tx, auth, item, outcome, req, { error: details }));
  }
}

export async function submitSyncBatch(
  pool: pg.Pool,
  config: AppConfig,
  auth: AuthContext,
  input: SyncBatchInput,
  deviceKey: string | undefined,
  req: Request
) {
  if (input.contractVersion !== SYNC_CONTRACT_VERSION) {
    throw conflict('SYNC_CONTRACT_UNSUPPORTED', 'The synchronization contract is not supported by this server');
  }
  const device = await authorizedDevice(pool, config, auth, input.deviceId, deviceKey);
  const results = [] as Array<ReturnType<typeof mapSyncTransaction>>;
  for (const item of input.transactions) {
    try {
      const transaction = await applySyncTransaction(pool, auth, device, item, req);
      results.push(mapSyncTransaction(transaction));
    } catch (error) {
      const details = errorDetails(error);
      const outcome = classifySyncError(error);
      const transaction = await withTransaction(pool, (tx) => storeSyncOutcome(tx, auth, item, outcome, req, { error: details }));
      results.push(mapSyncTransaction(transaction));
    }
  }
  return {
    batchId: input.batchId,
    deviceId: input.deviceId,
    contractVersion: SYNC_CONTRACT_VERSION,
    serverTime: new Date().toISOString(),
    results
  };
}

export async function listSyncTransactions(pool: pg.Pool, config: AppConfig, auth: AuthContext, query: SyncTransactionQuery, deviceKey?: string) {
  const device = await authorizedDevice(pool, config, auth, query.deviceId, deviceKey);
  const values: unknown[] = [auth.organizationId, device.id];
  const where = ['st.organization_id = $1', 'st.device_id = $2'];
  if (!auth.permissions.has('sales.view_all') && !auth.permissions.has('sync.resolve-conflict')) {
    values.push(auth.membershipId);
    where.push(`st.cashier_membership_id = $${values.length}`);
  }
  if (query.status) {
    values.push(query.status);
    where.push(`st.status = $${values.length}`);
  }
  if (query.clientTransactionId) {
    values.push(query.clientTransactionId);
    where.push(`st.client_transaction_id = $${values.length}`);
  }
  const result = await pool.query<SyncTransactionRow>(
    `SELECT st.* FROM sync_transactions st
     WHERE ${where.join(' AND ')}
     ORDER BY st.client_occurred_at, st.created_at
     LIMIT 200`,
    values
  );
  return result.rows.map(mapSyncTransaction);
}

export async function getSyncTransaction(pool: pg.Pool, config: AppConfig, auth: AuthContext, deviceId: string, clientTransactionId: string, deviceKey?: string) {
  const transactions = await listSyncTransactions(pool, config, auth, { deviceId, clientTransactionId }, deviceKey);
  const transaction = transactions[0];
  if (!transaction) throw notFound('Sync transaction was not found');
  return transaction;
}

export async function resolveSyncTransaction(
  pool: pg.Pool,
  config: AppConfig,
  auth: AuthContext,
  syncTransactionId: string,
  input: ResolveSyncTransactionInput,
  deviceKey: string | undefined,
  req: Request
) {
  const transaction = await withTransaction(pool, async (tx) => {
    const result = await tx.query<SyncTransactionRow>(
      `SELECT st.* FROM sync_transactions st
       JOIN registered_devices d ON d.id = st.device_id AND d.organization_id = st.organization_id
       WHERE st.id = $1 AND st.organization_id = $2
       FOR UPDATE OF st`,
      [syncTransactionId, auth.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw notFound('Sync transaction was not found');
    await authorizedDevice(pool, config, auth, row.device_id, deviceKey);
    if (['accepted', 'duplicate', 'resolved'].includes(row.status)) {
      throw conflict('SYNC_TRANSACTION_FINAL', 'A final synchronized transaction cannot be changed');
    }
    if (input.action === 'override-negative-stock' && !auth.permissions.has('inventory.negative-override')) {
      throw forbidden('NEGATIVE_OVERRIDE_DENIED', 'You do not have permission to authorize negative stock');
    }
    if (input.action === 'accept-current-price' && !auth.permissions.has('sales.create')) {
      throw forbidden('SALE_RESOLUTION_DENIED', 'You do not have permission to accept changed sale terms');
    }
    const finalStatus = input.action === 'cancel-local' ? 'resolved' : 'pending';
    const updated = await tx.query<SyncTransactionRow>(
      `UPDATE sync_transactions
       SET status = $3, resolution_action = $4, resolution_reason = $5,
           resolved_by_membership_id = $6, resolved_at = now(), updated_at = now()
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [syncTransactionId, auth.organizationId, finalStatus, input.action, input.reason, auth.membershipId]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: row.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      deviceId: row.device_id,
      action: 'sync.transaction-resolved',
      entityType: 'sync_transaction',
      entityId: syncTransactionId,
      metadata: {
        action: input.action,
        reason: input.reason,
        clientTransactionId: row.client_transaction_id
      },
      ...requestMeta(req)
    });
    return updated.rows[0]!;
  });
  return mapSyncTransaction(transaction);
}

export async function getSyncBootstrap(pool: pg.Pool, config: AppConfig, auth: AuthContext, deviceId: string, deviceKey?: string) {
  const device = await authorizedDevice(pool, config, auth, deviceId, deviceKey);
  if (!auth.permissions.has('sales.create') || !auth.permissions.has('catalog.read')) {
    throw forbidden('OFFLINE_REFERENCE_DENIED', 'This membership cannot download offline POS reference data');
  }
  const branch = await pool.query<{ id: string; code: string; name: string; currency_code: string; timezone: string }>(
    'SELECT id, code, name, currency_code, timezone FROM branches WHERE id = $1 AND organization_id = $2',
    [device.branch_id, auth.organizationId]
  );
  const organization = await pool.query<{ id: string; display_name: string; currency_code: string; timezone: string; tax_pricing_mode: string; default_tax_rate_bps: string }>(
    'SELECT id, display_name, currency_code, timezone, tax_pricing_mode, default_tax_rate_bps::text FROM organizations WHERE id = $1',
    [auth.organizationId]
  );
  const registers = await pool.query(
    `SELECT r.id, r.branch_id AS "branchId", r.code, r.name, r.status, r.receipt_prefix AS "receiptPrefix", r.receipt_footer AS "receiptFooter"
     FROM pos_registers r
     WHERE r.organization_id = $1 AND r.branch_id = $2
     ORDER BY r.code`,
    [auth.organizationId, device.branch_id]
  );
  const session = await pool.query(
    `SELECT s.id, s.branch_id AS "branchId", s.register_id AS "registerId", r.code AS "registerCode", r.name AS "registerName",
            s.status, s.opening_float_minor::text, s.opened_by_membership_id AS "openedByMembershipId", s.opened_at AS "openedAt"
     FROM register_sessions s
     JOIN pos_registers r ON r.id = s.register_id AND r.organization_id = s.organization_id
     WHERE s.organization_id = $1 AND s.branch_id = $2 AND s.opened_by_membership_id = $3 AND s.status = 'open'
     ORDER BY s.opened_at DESC
     LIMIT 1`,
    [auth.organizationId, device.branch_id, auth.membershipId]
  );
  const products = await pool.query(
    `SELECT p.id, p.sku, p.name, p.brand, p.image_url AS "imageUrl", p.item_type AS "itemType",
            p.base_unit_id AS "baseUnitId", u.code AS "unitCode", p.cost_minor::text,
            p.base_price_minor::text, p.tax_rate_bps::text,
            COALESCE(s.on_hand_qty, 0)::text AS "onHandQty", COALESCE(s.avg_cost_minor, 0)::text AS avg_cost_minor,
            (SELECT pb.barcode FROM product_barcodes pb
             WHERE pb.organization_id = p.organization_id AND pb.product_id = p.id
             ORDER BY pb.created_at LIMIT 1) AS barcode
     FROM products p
     JOIN units_of_measure u ON u.id = p.base_unit_id AND u.organization_id = p.organization_id
     LEFT JOIN stock_levels s ON s.product_id = p.id AND s.organization_id = p.organization_id AND s.branch_id = $2
     WHERE p.organization_id = $1 AND p.status = 'active'
     ORDER BY p.name
     LIMIT 500`,
    [auth.organizationId, device.branch_id]
  );
  const capturedAt = new Date();
  const snapshotProducts = [] as Array<Record<string, unknown>>;
  for (const row of products.rows) {
    const price = await resolvePrice(pool, auth, {
      productId: row.id,
      branchId: device.branch_id,
      quantity: '1',
      customerId: null,
      priceListId: null
    });
    snapshotProducts.push({
      id: row.id,
      sku: row.sku,
      name: row.name,
      brand: row.brand,
      imageUrl: row.imageUrl,
      itemType: row.itemType,
      baseUnitId: row.baseUnitId,
      unitCode: row.unitCode,
      barcode: row.barcode,
      cost: minorUnitsToDecimal(String(row.cost_minor)),
      basePrice: minorUnitsToDecimal(String(row.base_price_minor)),
      taxRatePct: row.tax_rate_bps === null ? null : (Number(row.tax_rate_bps) / 100).toString(),
      onHandQty: row.onHandQty,
      averageCost: minorUnitsToDecimal(String(row.avg_cost_minor)),
      price
    });
  }
  const core = {
    device: { id: device.id, branchId: device.branch_id },
    branch: branch.rows[0],
    organization: organization.rows[0],
    registers: registers.rows,
    currentSession: session.rows[0] ?? null,
    products: snapshotProducts
  };
  const revision = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO sync_cursors (organization_id, device_id, entity_type, branch_id, cursor_value)
       VALUES ($1,$2,'pos_reference',$3,$4)
       ON CONFLICT (organization_id, device_id, entity_type)
       DO UPDATE SET cursor_value = GREATEST(sync_cursors.cursor_value, EXCLUDED.cursor_value), branch_id = EXCLUDED.branch_id`,
      [auth.organizationId, device.id, device.branch_id, capturedAt.getTime()]
    );
    await tx.query('UPDATE registered_devices SET last_sync_at = now() WHERE id = $1 AND organization_id = $2', [device.id, auth.organizationId]);
  });
  return {
    contractVersion: SYNC_CONTRACT_VERSION,
    serverTime: capturedAt.toISOString(),
    device: { id: device.id, branchId: device.branch_id, status: device.status, contractVersion: device.contract_version },
    policy: {
      cashSales: true,
      creditSales: false,
      returnsAndRefunds: false,
      expenses: false,
      stockIsSnapshot: true,
      maxReferenceAgeSeconds: 86_400,
      staleAfterSeconds: 1_800
    },
    snapshot: {
      schemaVersion: 1,
      revision,
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + 86_400_000).toISOString(),
      staleAfter: new Date(capturedAt.getTime() + 1_800_000).toISOString(),
      ...core,
      cashierMembershipId: auth.membershipId,
      cashierName: auth.displayName,
      permissions: [...auth.permissions]
    }
  };
}
