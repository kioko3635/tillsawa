import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import { badRequest, conflict, unauthorized } from '../../shared/errors.js';
import { asyncHandler } from '../../shared/http.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

const SENSITIVE_RESPONSE_FIELDS = new Set([
  'deviceKey',
  'refreshToken',
  'resetToken',
  'temporaryPassword',
  'password',
  'passwordHash',
  'token',
  'csrfToken'
]);

function sanitizeResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResponse);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_RESPONSE_FIELDS.has(key))
        .map(([key, item]) => [key, sanitizeResponse(item)])
    );
  }
  return value;
}

export function requestPayloadHash(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(body ?? null)))
    .digest('hex');
}

function requestHash(req: Request): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ method: req.method, path: req.originalUrl, body: req.body ?? null })))
    .digest('hex');
}

export function idempotency(pool: pg.Pool, scope: string) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) throw unauthorized();
    const key = req.header('idempotency-key');
    if (!key || key.length > 128) throw badRequest('VALIDATION_ERROR', 'A valid Idempotency-Key header is required');
    const hash = requestHash(req);

    const existing = await pool.query<{
      request_hash: string;
      response_status: number | null;
      response_body: unknown;
      locked_until: Date | null;
    }>(
      `SELECT request_hash, response_status, response_body, locked_until
       FROM idempotency_records
       WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3`,
      [auth.organizationId, scope, key]
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      if (existingRow.request_hash !== hash) {
        throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request');
      }
      if (existingRow.response_status === null) {
        if (existingRow.locked_until && existingRow.locked_until > new Date()) {
          throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this idempotency key is still being processed');
        }
        await pool.query(
          `DELETE FROM idempotency_records
           WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
             AND response_status IS NULL`,
          [auth.organizationId, scope, key]
        );
      } else {
        res.status(existingRow.response_status).json(existingRow.response_body);
        return;
      }
    }

    const inserted = await pool.query(
      `INSERT INTO idempotency_records
        (organization_id, actor_membership_id, scope, idempotency_key, request_hash, locked_until)
       VALUES ($1, $2, $3, $4, $5, now() + interval '2 minutes')
       ON CONFLICT (organization_id, scope, idempotency_key) DO NOTHING`,
      [auth.organizationId, auth.membershipId, scope, key, hash]
    );
    if (inserted.rowCount !== 1) {
      throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this idempotency key is already being processed');
    }

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode < 500) {
        void pool.query(
          `UPDATE idempotency_records
           SET response_status = $1, response_body = $2::jsonb, completed_at = now(), locked_until = NULL
           WHERE organization_id = $3 AND scope = $4 AND idempotency_key = $5`,
          [res.statusCode, JSON.stringify(sanitizeResponse(body)), auth.organizationId, scope, key]
        ).catch((error: unknown) => console.error('Failed to complete idempotency record', error));
      } else {
        void pool.query(
          `DELETE FROM idempotency_records
           WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
             AND response_status IS NULL`,
          [auth.organizationId, scope, key]
        ).catch((error: unknown) => console.error('Failed to clear failed idempotency record', error));
      }
      return originalJson(body);
    }) as Response['json'];
    next();
  });
}
