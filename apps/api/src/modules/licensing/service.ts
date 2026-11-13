import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Request } from 'express';
import type { AppConfig } from '../../config/env.js';
import { withTransaction } from '../../database/pool.js';
import { badRequest, forbidden } from '../../shared/errors.js';
import { recordAudit, auditFromRequest } from '../audit/audit.js';
import { evaluateLicense, stateMac, validMac, verifyLicense, type LicensePayload } from './verification.js';

export function licenseIdentity(config: AppConfig, organizationId: string) {
  const options = config.licensing!;
  if (!config.cloud) return { organizationId, installationId: options.installationId, machineId: options.machineId };
  const bytes = createHash('sha256').update(options.installationId + ':' + organizationId).digest();
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return { organizationId, machineId: options.machineId, installationId: [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-') };
}

export function createLicenseService(pool: pg.Pool, config: AppConfig) {
  const options = config.licensing;
  const publicKey = options ? readFileSync(options.publicKeyPath ?? fileURLToPath(new URL('../../../data/license-public-key.pem', import.meta.url)), 'utf8') : '';
  const identity = (organizationId: string) => licenseIdentity(config, organizationId);
  async function inspect(organizationId: string, imported?: unknown, req?: Request) {
    if (!options) return { state: 'disabled', canWrite: true, message: 'Licensing is not enabled in this development instance.', license: null, installationCode: null, graceEndsAt: null };
    return withTransaction(pool, async tx => {
      const id = identity(organizationId);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('license-users:' || $1, 0))", [organizationId]);
      const now = Date.now();
      await tx.query(`INSERT INTO installation_licenses (organization_id,high_water_ms,state_mac) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [organizationId, now, stateMac(config.accessTokenSecret, id, now, null)]);
      const result = await tx.query('SELECT envelope, high_water_ms::text, state_mac FROM installation_licenses WHERE organization_id=$1 FOR UPDATE', [organizationId]);
      const row = result.rows[0];
      let highWater = Number(row.high_water_ms);
      const intact = Number.isSafeInteger(highWater) && validMac(row.state_mac, stateMac(config.accessTokenSecret, id, highWater, row.envelope));
      let payload: LicensePayload | null = null;
      let envelope = row.envelope;
      if (imported !== undefined) {
        try { payload = verifyLicense(imported, publicKey, id); }
        catch { throw badRequest('INVALID_LICENSE', 'Invalid licence file, signature, shop or computer. Ask your provider for the correct file.'); }
        if (Date.parse(payload.issuedAt) > now + 300000 || Date.parse(payload.validFrom) > now + 300000) throw badRequest('LICENSE_NOT_STARTED', 'This licence is dated in the future. Check your computer date and time.');
        if (!payload.lifetime && Date.parse(payload.expiresAt!) <= now) throw badRequest('LICENSE_ALREADY_EXPIRED', 'This licence has already expired. Ask for a current renewal.');
        const currentUsers = await activeUserCount(tx, organizationId);
        if (payload.maxUsers !== null && payload.maxUsers < currentUsers) throw badRequest('LICENSE_USER_LIMIT', `This licence allows ${payload.maxUsers} active users, but this shop has ${currentUsers}. Suspend unused accounts or request more users.`);
        if ((!intact || now + 300000 < highWater) && !payload.resetClock) throw badRequest('LICENSE_CLOCK_RECOVERY_REQUIRED', 'Correct the computer clock or request a support recovery licence.');
        if (row.envelope) {
          try {
            const previous = verifyLicense(row.envelope, publicKey, id);
            if (previous.licenseId === payload.licenseId) throw badRequest('LICENSE_ALREADY_IMPORTED', 'This licence is already installed.');
            if (Date.parse(payload.issuedAt) < Date.parse(previous.issuedAt) || (previous.lifetime && !payload.lifetime) || (!payload.lifetime && previous.expiresAt && Date.parse(payload.expiresAt!) < Date.parse(previous.expiresAt))) throw badRequest('OLDER_LICENSE', 'This file would replace a newer or longer licence. Ask for the latest renewal.');
          } catch (error) { if (error instanceof Error && 'statusCode' in error) throw error; }
        }
        if (payload.resetClock) highWater = now;
        envelope = imported;
        await recordAudit(tx, { ...auditFromRequest(req!, req!.auth), organizationId, action: 'license.imported', entityType: 'license', entityId: payload.licenseId, metadata: { expiresAt: payload.expiresAt, plan: payload.plan, resetClock: payload.resetClock, source: req!.auth ? 'shop' : 'cloud-management' } });
      } else if (intact && envelope) {
        try { payload = verifyLicense(envelope, publicKey, id); } catch { /* Invalid state is read-only. */ }
      }
      if (imported === undefined && (!intact || (envelope && !payload))) return { state: 'invalid', canWrite: false, message: 'Licence state cannot be verified. Contact support; your records remain available.', license: null, installationCode: 'KP-' + id.installationId.toUpperCase(), graceEndsAt: null };
      const status = evaluateLicense(payload, now, highWater);
      highWater = Math.max(now, highWater);
      await tx.query('UPDATE installation_licenses SET envelope=$2::jsonb, high_water_ms=$3, state_mac=$4, updated_at=now() WHERE organization_id=$1', [organizationId, JSON.stringify(envelope), highWater, stateMac(config.accessTokenSecret, id, highWater, envelope)]);
      return { ...status, ...(config.cloud && status.state === 'active' && !payload?.lifetime ? { message: 'Your cloud subscription is active.' } : {}), license: payload, activeUsers: await activeUserCount(tx, organizationId), installationCode: 'KP-' + id.installationId.toUpperCase(), graceEndsAt: payload?.expiresAt ? new Date(Date.parse(payload.expiresAt) + payload.graceDays * 86400000).toISOString() : null };
    });
  }
  return {
    status: (organizationId: string) => inspect(organizationId),
    preview: (organizationId: string, row: { envelope?: unknown; high_water_ms?: string; state_mac?: string }, now: number) => {
      const high = Number(row.high_water_ms);
      try {
        if (!row.envelope) return { ...evaluateLicense(null, now, now), license: null };
        const id = identity(organizationId);
        if (!Number.isSafeInteger(high) || !validMac(row.state_mac ?? '', stateMac(config.accessTokenSecret, id, high, row.envelope))) throw new Error('Invalid state');
        const license = verifyLicense(row.envelope, publicKey, id);
        return { ...evaluateLicense(license, now, high), license };
      } catch { return { state: 'invalid', canWrite: false, license: null }; }
    },
    import: (organizationId: string, envelope: unknown, req: Request) => inspect(organizationId, envelope, req),
    request: (organizationId: string, shopName: string) => {
      if (!options) throw badRequest('LICENSING_DISABLED', 'Activation requests are available in the installed application.');
      return { version: 1, ...identity(organizationId), shopName };
    },
    enforce: async (organizationId: string) => {
      const status = await inspect(organizationId);
      if (!status.canWrite) throw forbidden('LICENSE_REQUIRED', status.message);
    }
  };
}

async function activeUserCount(tx: pg.PoolClient, organizationId: string): Promise<number> {
  const result = await tx.query("SELECT count(*)::int AS count FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.status='active' AND u.status='active'", [organizationId]);
  return result.rows[0].count;
}

export async function enforceLicenseUserLimit(tx: pg.PoolClient, config: AppConfig, organizationId: string) {
  if (!config.licensing) return;
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('license-users:' || $1, 0))", [organizationId]);
  const row = (await tx.query('SELECT envelope, high_water_ms::text, state_mac FROM installation_licenses WHERE organization_id=$1 FOR UPDATE', [organizationId])).rows[0];
  if (!row?.envelope) throw forbidden('LICENSE_REQUIRED', 'An active licence is required to add users.');
  const id = licenseIdentity(config, organizationId);
  const publicKey = readFileSync(config.licensing.publicKeyPath ?? fileURLToPath(new URL('../../../data/license-public-key.pem', import.meta.url)), 'utf8');
  let payload: LicensePayload;
  try { payload = verifyLicense(row.envelope, publicKey, id); } catch { throw forbidden('LICENSE_REQUIRED', 'The installed licence could not be verified.'); }
  if (!validMac(row.state_mac, stateMac(config.accessTokenSecret, id, Number(row.high_water_ms), row.envelope)) || !evaluateLicense(payload, Date.now(), Number(row.high_water_ms)).canWrite) throw forbidden('LICENSE_REQUIRED', 'An active licence is required to add users.');
  if (payload.maxUsers !== null && await activeUserCount(tx, organizationId) >= payload.maxUsers) throw forbidden('LICENSE_USER_LIMIT', `Your licence allows ${payload.maxUsers} active user accounts, including the owner. Suspend an unused account or upgrade your user allowance.`);
}

export function licenseWriteExempt(method: string, path: string, body?: unknown) {
  const suspension = body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && 'status' in body && body.status === 'suspended';
  return ['GET', 'HEAD', 'OPTIONS'].includes(method) || /^\/api\/v1\/(auth|licensing)(\/|$)/.test(path)
    || (method === 'PATCH' && /^\/api\/v1\/memberships\/[^/]+$/.test(path) && suspension)
    || (method === 'POST' && /^\/api\/v1\/pos\/(register-sessions\/[^/]+\/close|sales\/[^/]+\/receipt\/reprint)$/.test(path));
}
