import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import { tenantRequestStore, type Queryable } from '../../database/pool.js';
import type { PermissionCode } from '@pos/contracts';
import { forbidden, unauthorized } from '../../shared/errors.js';
import { asyncHandler } from '../../shared/http.js';

export interface AuthContext {
  sessionId: string;
  userId: string;
  membershipId: string;
  organizationId: string;
  email: string;
  displayName: string;
  allBranches: boolean;
  permissions: Set<string>;
  enabledModules: Set<string>;
  enabledCapabilities: Set<string>;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

interface AccessTokenPayload extends jwt.JwtPayload {
  sub: string;
  uid: string;
  org: string;
  sid: string;
}

interface MembershipAuthRow {
  membership_id: string;
  organization_id: string;
  user_id: string;
  email: string;
  display_name: string;
  all_branches: boolean;
  membership_status: string;
  user_status: string;
  organization_status: string;
  permissions: string[] | null;
}

export function signAccessToken(config: AppConfig, context: Pick<AuthContext, 'membershipId' | 'organizationId' | 'sessionId' | 'userId'>): string {
  return jwt.sign(
    {
      sub: context.membershipId,
      uid: context.userId,
      org: context.organizationId,
      sid: context.sessionId
    },
    config.accessTokenSecret,
    { expiresIn: config.accessTokenTtlSeconds, issuer: 'kenya-pos-api', audience: 'kenya-pos-web' }
  );
}

export function createAuthMiddleware(pool: pg.Pool, config: AppConfig) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw unauthorized();

    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, config.accessTokenSecret, {
        issuer: 'kenya-pos-api',
        audience: 'kenya-pos-web'
      }) as AccessTokenPayload;
    } catch {
      throw unauthorized('SESSION_EXPIRED', 'Access token is invalid or expired');
    }

    // Bind the RLS tenant context for the rest of this request before any
    // database access. The org claim comes from a verified JWT; the membership
    // query below still proves the claim against authoritative data.
    tenantRequestStore.enterWith({ organizationId: payload.org });

    const result = await pool.query<MembershipAuthRow>(
      `
      SELECT
        m.id AS membership_id,
        m.organization_id,
        m.user_id,
        u.email::text,
        u.display_name,
        m.all_branches,
        m.status AS membership_status,
        u.status AS user_status,
        o.status AS organization_status,
        array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL) AS permissions
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      JOIN organizations o ON o.id = m.organization_id
      LEFT JOIN membership_roles mr ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
      LEFT JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.organization_id = m.organization_id
      WHERE m.id = $1 AND m.organization_id = $2
      GROUP BY m.id, u.id, o.id
      `,
      [payload.sub, payload.org]
    );
    const membership = result.rows[0];
    if (!membership || membership.user_id !== payload.uid || membership.membership_status !== 'active' || membership.user_status !== 'active' || membership.organization_status !== 'active') {
      throw unauthorized('SESSION_EXPIRED', 'Membership or organization is not active');
    }

    const session = await pool.query<{ status: string; expires_at: Date }>(
      `SELECT status, expires_at
       FROM auth_sessions
       WHERE id = $1 AND organization_id = $2 AND membership_id = $3`,
      [payload.sid, payload.org, payload.sub]
    );
    const sessionRow = session.rows[0];
    if (!sessionRow || sessionRow.status !== 'active' || sessionRow.expires_at <= new Date()) {
      throw unauthorized('SESSION_EXPIRED', 'Session is expired or revoked');
    }
    await pool.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [payload.sid]);
    const moduleState = await pool.query<{ module_code: string; enabled: boolean; kind: string; availability: string }>(
      `SELECT state.module_code, state.enabled, catalog.kind, catalog.availability
       FROM organization_module_states state
       JOIN module_catalog catalog ON catalog.code = state.module_code
       WHERE state.organization_id = $1`,
      [payload.org]
    );

    req.auth = {
      sessionId: payload.sid,
      userId: payload.uid,
      membershipId: payload.sub,
      organizationId: payload.org,
      email: membership.email,
      displayName: membership.display_name,
      allBranches: membership.all_branches,
      permissions: new Set(membership.permissions ?? []),
      enabledModules: new Set(moduleState.rows
        .filter((row) => row.kind === 'module' && row.availability === 'implemented' && row.enabled)
        .map((row) => row.module_code)),
      enabledCapabilities: new Set(moduleState.rows
        .filter((row) => row.kind === 'capability' && row.availability === 'implemented' && row.enabled)
        .map((row) => row.module_code))
    };
    next();
  });
}

export function requirePermission(permission: PermissionCode) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth?.permissions.has(permission)) {
      next(forbidden());
      return;
    }
    next();
  };
}

export function requireAnyPermission(permissions: PermissionCode[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth || !permissions.some((permission) => req.auth!.permissions.has(permission))) {
      next(forbidden());
      return;
    }
    next();
  };
}

export function requireModule(moduleCode: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth?.enabledModules.has(moduleCode)) {
      next(forbidden('MODULE_DISABLED', 'This module is disabled for the organization'));
      return;
    }
    next();
  };
}

export function requireCapability(capabilityCode: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth?.enabledCapabilities.has(capabilityCode)) {
      next(forbidden('CAPABILITY_DISABLED', 'This capability is disabled for the organization'));
      return;
    }
    next();
  };
}

export async function membershipHasBranchAccess(db: Queryable, auth: AuthContext, branchId: string): Promise<boolean> {
  if (auth.allBranches) {
    const branch = await db.query('SELECT 1 FROM branches WHERE id = $1 AND organization_id = $2', [branchId, auth.organizationId]);
    return branch.rowCount === 1;
  }
  const result = await db.query(
    'SELECT 1 FROM membership_branches WHERE membership_id = $1 AND organization_id = $2 AND branch_id = $3',
    [auth.membershipId, auth.organizationId, branchId]
  );
  return result.rowCount === 1;
}

export function requireBranchAccess(pool: pg.Pool, branchIdFrom: (req: Request) => string | undefined) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    const branchId = branchIdFrom(req);
    if (!auth) throw unauthorized();
    if (!branchId) throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access is required');
    const branch = await pool.query('SELECT status FROM branches WHERE id = $1 AND organization_id = $2', [branchId, auth.organizationId]);
    if (!branch.rows[0]) throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
    if (!(await membershipHasBranchAccess(pool, auth, branchId))) {
      throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
    }
    resLocalsBranch(req, branchId);
    next();
  });
}

function resLocalsBranch(req: Request, branchId: string): void {
  req.res!.locals.branchId = branchId;
}

export async function listAccessibleBranchIds(db: Queryable, auth: AuthContext): Promise<string[]> {
  if (auth.allBranches) {
    const result = await db.query<{ id: string }>('SELECT id FROM branches WHERE organization_id = $1', [auth.organizationId]);
    return result.rows.map((row) => row.id);
  }
  const result = await db.query<{ branch_id: string }>(
    'SELECT branch_id FROM membership_branches WHERE membership_id = $1 AND organization_id = $2',
    [auth.membershipId, auth.organizationId]
  );
  return result.rows.map((row) => row.branch_id);
}

export async function membershipWithinBranchScope(db: Queryable, auth: AuthContext, membershipId: string): Promise<boolean> {
  const result = await db.query<{ all_branches: boolean; branch_ids: string[] | null }>(
    `SELECT m.all_branches,
            COALESCE(array_agg(mb.branch_id) FILTER (WHERE mb.branch_id IS NOT NULL), '{}'::uuid[]) AS branch_ids
     FROM memberships m
     LEFT JOIN membership_branches mb ON mb.membership_id = m.id AND mb.organization_id = m.organization_id
     WHERE m.id = $1 AND m.organization_id = $2
     GROUP BY m.id`,
    [membershipId, auth.organizationId]
  );
  const membership = result.rows[0];
  if (!membership) return false;
  if (auth.allBranches) return true;
  if (membership.all_branches || !membership.branch_ids?.length) return false;
  const accessible = new Set(await listAccessibleBranchIds(db, auth));
  return membership.branch_ids.every((branchId) => accessible.has(branchId));
}
