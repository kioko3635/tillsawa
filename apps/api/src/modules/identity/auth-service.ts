import type {
  LoginInput,
  RegisterOrganizationInput,
  RequestPasswordResetInput,
  ResetPasswordInput
} from '@pos/contracts';
import { randomUUID } from 'node:crypto';
import { BUSINESS_PROFILE_DEFINITIONS, PERMISSION_CODES } from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import { withTransaction, type Queryable } from '../../database/pool.js';
import { conflict, forbidden, unauthorized } from '../../shared/errors.js';
import { recordAudit } from '../audit/audit.js';
import { PROCUREMENT_PERMISSIONS, WAITER_PERMISSIONS } from './staff-roles.js';
import { revokeUserSessions } from './recovery.js';
import { generateOpaqueToken, hashOpaqueToken, hashPassword, verifyPassword } from './security.js';
import { listAccessibleBranchIds, membershipWithinBranchScope, signAccessToken, type AuthContext } from '../../http/middleware/auth.js';

interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuthBundle {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  session: {
    id: string;
    expiresAt: string;
  };
  membership: {
    id: string;
    organizationId: string;
    userId: string;
    displayName: string;
    email: string;
    allBranches: boolean;
    permissions: string[];
  };
}

interface MembershipSessionRow {
  membership_id: string;
  organization_id: string;
  user_id: string;
  email: string;
  display_name: string;
  all_branches: boolean;
  permissions: string[] | null;
}

const OWNER_PERMISSIONS = [...PERMISSION_CODES];
const MANAGER_PERMISSIONS = [
  'organization.read',
  'branch.read',
  'branch.create',
  'branch.update',
  'user.read',
  'user.invite',
  'user.update',
  'role.read',
  'device.read',
  'device.register',
  'session.manage',
  'audit.view',
  'sync.read',
  'sync.write',
  'sync.resolve-conflict',
  'catalog.read',
  'price-list.read',
  'pos.sell',
  'sale.read',
  'inventory.read',
  'reports.view',
  'reports.export',
  'catalog.manage',
  'customer.read',
  'customer.manage',
  'price-list.manage',
  'inventory.adjust',
  'inventory.count',
  'inventory.count-approve',
  'inventory.transfer',
  'sales.create',
  'sales.view',
  'sales.view_all',
  'sales.discount',
  'sales.void',
  'sales.return',
  'sales.refund',
  'sales.credit',
  'credit.view',
  'credit.manage',
  'credit.collect',
  'credit.adjust',
  'supplier.read',
  'supplier.manage',
  'purchase.read',
  'purchase.create',
  'purchase.approve',
  'purchase.receive',
  'purchase.cancel',
  'supplier-invoice.manage',
  'supplier-payment.record',
  'expense.view',
  'expense.create',
  'expense.submit',
  'expense.approve',
  'expense.reject',
  'expense.pay',
  'expense.cancel',
  'expense.adjust',
  'expense-category.manage',
  'registers.manage',
  'registers.open',
  'registers.close',
  'registers.cash-movement',
  'receipts.reprint'
];
const CASHIER_PERMISSIONS = [
  'organization.read',
  'branch.read',
  'device.read',
  'sync.read',
  'sync.write',
  'catalog.read',
  'price-list.read',
  'pos.sell',
  'sale.read',
  'inventory.read',
  'customer.read',
  'sales.create',
  'sales.view',
  'credit.view',
  'credit.collect',
  'supplier.read',
  'purchase.read',
  'expense.view',
  'expense.create',
  'expense.submit',
  'registers.open',
  'registers.close',
  'registers.cash-movement',
  'receipts.reprint'
];

function requestMeta(req: Request): RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null
  };
}

async function insertRole(db: Queryable, organizationId: string, code: string, name: string, permissions: string[]): Promise<string> {
  const role = await db.query<{ id: string }>(
    `INSERT INTO roles (organization_id, code, name, description, is_system)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id`,
    [organizationId, code, name, `${name} role`]
  );
  const roleId = role.rows[0]!.id;
  await db.query(
    `INSERT INTO role_permissions (role_id, organization_id, permission_code)
     SELECT $1::uuid, $2::uuid, permission_code
     FROM unnest($3::text[]) AS permission_code`,
    [roleId, organizationId, permissions]
  );
  return roleId;
}

export async function createDefaultRoles(db: Queryable, organizationId: string): Promise<{ ownerRoleId: string }> {
  const ownerRoleId = await insertRole(db, organizationId, 'owner', 'Owner', OWNER_PERMISSIONS);
  await insertRole(db, organizationId, 'manager', 'Branch Manager', MANAGER_PERMISSIONS);
  await insertRole(db, organizationId, 'cashier', 'Cashier', CASHIER_PERMISSIONS);
  await insertRole(db, organizationId, 'procurement', 'Procurement', PROCUREMENT_PERMISSIONS);
  await insertRole(db, organizationId, 'waiter', 'Waiter', WAITER_PERMISSIONS);
  return { ownerRoleId };
}

export async function createDefaultUnits(db: Queryable, organizationId: string): Promise<void> {
  await db.query(
    `INSERT INTO units_of_measure (organization_id, code, name)
     SELECT $1::uuid, unit.code, unit.name
     FROM (VALUES
       ('EA', 'Each'),
       ('KG', 'Kilogram'),
       ('L', 'Litre'),
       ('PACK', 'Pack'),
       ('CASE', 'Case')
     ) AS unit(code, name)
     ON CONFLICT (organization_id, code) DO NOTHING`,
    [organizationId]
  );
}

export async function createDefaultExpenseCategories(db: Queryable, organizationId: string): Promise<void> {
  await db.query(
    `INSERT INTO expense_categories (organization_id, code, name, description)
     SELECT $1::uuid, category.code, category.name, category.description
     FROM (VALUES
       ('OPERATIONS', 'Operations', 'General operating and administrative costs'),
       ('RENT', 'Rent and premises', 'Rent, service charge and premises costs'),
       ('UTILITIES', 'Utilities', 'Electricity, water, internet and communication costs'),
       ('TRANSPORT', 'Transport', 'Delivery, logistics and travel costs'),
       ('SUPPLIES', 'Supplies', 'Packaging, cleaning and office supplies'),
       ('SALARIES', 'Salaries and wages', 'Approved staff salary and wage payments')
     ) AS category(code, name, description)
     ON CONFLICT (organization_id, code) DO NOTHING`,
    [organizationId]
  );
}

async function createSession(db: Queryable, config: AppConfig, input: {
  organizationId: string;
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  allBranches: boolean;
  permissions: string[];
}, meta: RequestMeta): Promise<AuthBundle> {
  const sessionExpiry = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  const session = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO auth_sessions (organization_id, membership_id, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3::inet, $4, $5)
     RETURNING id, expires_at`,
    [input.organizationId, input.membershipId, meta.ipAddress ?? null, meta.userAgent ?? null, sessionExpiry]
  );
  const sessionId = session.rows[0]!.id;
  const refreshToken = generateOpaqueToken();
  await db.query(
    `INSERT INTO refresh_tokens (organization_id, session_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [input.organizationId, sessionId, hashOpaqueToken(refreshToken, config), sessionExpiry]
  );

  return {
    accessToken: signAccessToken(config, {
      membershipId: input.membershipId,
      organizationId: input.organizationId,
      sessionId,
      userId: input.userId
    }),
    accessTokenExpiresIn: config.accessTokenTtlSeconds,
    refreshToken,
    session: {
      id: sessionId,
      expiresAt: session.rows[0]!.expires_at.toISOString()
    },
    membership: {
      id: input.membershipId,
      organizationId: input.organizationId,
      userId: input.userId,
      displayName: input.displayName,
      email: input.email,
      allBranches: input.allBranches,
      permissions: input.permissions
    }
  };
}

async function membershipSession(db: Queryable, membershipId: string, organizationId: string): Promise<MembershipSessionRow> {
  const result = await db.query<MembershipSessionRow>(
    `SELECT
       m.id AS membership_id,
       m.organization_id,
       m.user_id,
       u.email::text,
       u.display_name,
       m.all_branches,
       array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL) AS permissions
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN membership_roles mr ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
     LEFT JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.organization_id = m.organization_id
     WHERE m.id = $1 AND m.organization_id = $2
     GROUP BY m.id, u.id`,
    [membershipId, organizationId]
  );
  const row = result.rows[0];
  if (!row) throw unauthorized('SESSION_EXPIRED', 'Membership is no longer valid');
  return row;
}

export async function registerOrganization(pool: pg.Pool, config: AppConfig, input: RegisterOrganizationInput, req: Request): Promise<AuthBundle> {
  const slug = input.organization.slug ?? `business-${randomUUID()}`;
  return withTransaction(pool, async (tx) => {
    const existingUser = await tx.query('SELECT id FROM users WHERE email = $1', [input.owner.email]);
    if (existingUser.rows[0]) throw conflict('EMAIL_ALREADY_REGISTERED', 'A user with this email already exists');
    const existingOrg = await tx.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
    if (existingOrg.rows[0]) throw conflict('ORGANIZATION_SLUG_TAKEN', 'Organization slug is already in use');

    const organization = await tx.query<{ id: string }>(
      `INSERT INTO organizations (slug, legal_name, display_name, currency_code, timezone, tax_pricing_mode)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        slug,
        input.organization.legalName,
        input.organization.displayName,
        input.organization.currencyCode,
        input.organization.timezone,
        input.organization.taxPricingMode
      ]
    );
    const organizationId = organization.rows[0]!.id;
    await createDefaultUnits(tx, organizationId);
    await createDefaultExpenseCategories(tx, organizationId);

    const branch = await tx.query<{ id: string }>(
      `INSERT INTO branches (organization_id, code, name)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [organizationId, input.branch.code, input.branch.name]
    );
    const branchId = branch.rows[0]!.id;

    const user = await tx.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.owner.email, await hashPassword(input.owner.password, config), input.owner.displayName]
    );
    const userId = user.rows[0]!.id;

    const membership = await tx.query<{ id: string }>(
      `INSERT INTO memberships (organization_id, user_id, title, all_branches)
       VALUES ($1, $2, 'Owner', true)
       RETURNING id`,
      [organizationId, userId]
    );
    const membershipId = membership.rows[0]!.id;
    await tx.query(
      'INSERT INTO membership_branches (membership_id, organization_id, branch_id) VALUES ($1, $2, $3)',
      [membershipId, organizationId, branchId]
    );

    const { ownerRoleId } = await createDefaultRoles(tx, organizationId);
    await tx.query(
      'INSERT INTO membership_roles (membership_id, organization_id, role_id) VALUES ($1, $2, $3)',
      [membershipId, organizationId, ownerRoleId]
    );

    const businessProfile = input.organization.businessProfile;
    const profileDefinition = BUSINESS_PROFILE_DEFINITIONS.find((definition) => definition.code === businessProfile)
      ?? BUSINESS_PROFILE_DEFINITIONS[0]!;
    await tx.query(
      `INSERT INTO organization_profiles (organization_id, business_profile, default_branch_id, configured_by_membership_id)
       VALUES ($1, $2, $3, $4)`,
      [organizationId, profileDefinition.code, branchId, membershipId]
    );
    await tx.query(
      `INSERT INTO organization_module_states (organization_id, module_code, enabled, configured_by_membership_id)
       SELECT $1, catalog.code,
              CASE
                WHEN catalog.availability <> 'implemented' THEN false
                WHEN catalog.kind = 'module' THEN catalog.core OR catalog.code = ANY($2::text[])
                ELSE catalog.code = ANY($3::text[])
              END,
              $4
       FROM module_catalog catalog`,
      [organizationId, profileDefinition.recommendedModules, profileDefinition.recommendedCapabilities, membershipId]
    );

    const bundle = await createSession(tx, config, {
      organizationId,
      membershipId,
      userId,
      displayName: input.owner.displayName,
      email: input.owner.email,
      allBranches: true,
      permissions: OWNER_PERMISSIONS
    }, requestMeta(req));

    await recordAudit(tx, {
      organizationId,
      branchId,
      actorMembershipId: membershipId,
      actorUserId: userId,
      action: 'organization.registered',
      entityType: 'organization',
      entityId: organizationId,
      metadata: { slug, businessProfile: profileDefinition.code },
      ...requestMeta(req)
    });
    return bundle;
  });
}

export async function login(pool: pg.Pool, config: AppConfig, input: LoginInput, req: Request): Promise<AuthBundle> {
  const result = await pool.query<MembershipSessionRow & { password_hash: string; organization_name: string }>(
    `SELECT
       m.id AS membership_id,
       m.organization_id,
       o.display_name AS organization_name,
       m.user_id,
       u.email::text,
       u.display_name,
       u.password_hash,
       m.all_branches,
       array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL) AS permissions
     FROM organizations o
     JOIN memberships m ON m.organization_id = o.id
     JOIN users u ON u.id = m.user_id
     LEFT JOIN membership_roles mr ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
     LEFT JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.organization_id = m.organization_id
     WHERE ($1::text IS NULL OR o.slug = $1) AND u.email = $2
       AND ($3::uuid IS NULL OR o.id = $3)
       AND o.status = 'active' AND m.status = 'active' AND u.status = 'active'
     GROUP BY m.id, u.id, o.display_name
     ORDER BY m.organization_id`,
    [input.organizationSlug ?? null, input.email, input.organizationId ?? null]
  );
  const row = result.rows[0];
  const passwordValid = row ? await verifyPassword(input.password, row.password_hash) : await verifyPassword(input.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
  if (!row || !passwordValid) throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
  if (result.rows.length > 1) {
    throw conflict('BUSINESS_SELECTION_REQUIRED', 'Choose the business you want to open.', {
      businesses: result.rows.map((item) => ({ id: item.organization_id, name: item.organization_name }))
    });
  }

  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.user_id]);
  const bundle = await withTransaction(pool, async (tx) => {
    const authBundle = await createSession(tx, config, {
      organizationId: row.organization_id,
      membershipId: row.membership_id,
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      allBranches: row.all_branches,
      permissions: row.permissions ?? []
    }, requestMeta(req));
    await recordAudit(tx, {
      organizationId: row.organization_id,
      actorMembershipId: row.membership_id,
      actorUserId: row.user_id,
      action: 'auth.login',
      entityType: 'auth_session',
      entityId: authBundle.session.id,
      ...requestMeta(req)
    });
    return authBundle;
  });
  return bundle;
}

export async function refreshSession(pool: pg.Pool, config: AppConfig, refreshToken: string, req: Request): Promise<AuthBundle> {
  const tokenHash = hashOpaqueToken(refreshToken, config);
  return withTransaction(pool, async (tx) => {
    const result = await tx.query<{
      refresh_token_id: string;
      session_id: string;
      membership_id: string;
      organization_id: string;
      user_id: string;
      token_expires_at: Date;
      token_rotated_at: Date | null;
      token_revoked_at: Date | null;
      session_status: string;
      session_expires_at: Date;
      membership_status: string;
      user_status: string;
      organization_status: string;
    }>(
      `SELECT
         rt.id AS refresh_token_id,
         rt.session_id,
         rt.expires_at AS token_expires_at,
         rt.rotated_at AS token_rotated_at,
         rt.revoked_at AS token_revoked_at,
         s.status AS session_status,
         s.expires_at AS session_expires_at,
         m.id AS membership_id,
         m.organization_id,
         m.user_id,
         m.status AS membership_status,
         u.status AS user_status,
         o.status AS organization_status
       FROM refresh_tokens rt
       JOIN auth_sessions s ON s.id = rt.session_id AND s.organization_id = rt.organization_id
       JOIN memberships m ON m.id = s.membership_id AND m.organization_id = s.organization_id
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
       WHERE rt.token_hash = $1
       FOR UPDATE OF rt`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) throw unauthorized('SESSION_EXPIRED', 'Refresh token is invalid');

    const compromised = Boolean(row.token_rotated_at || row.token_revoked_at || row.session_status !== 'active');
    if (compromised) {
      await tx.query(
        `UPDATE auth_sessions SET status = 'revoked', revoked_at = now(), revoked_reason = 'refresh_token_reuse'
         WHERE id = $1 AND organization_id = $2`,
        [row.session_id, row.organization_id]
      );
      await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1', [row.session_id]);
      throw unauthorized('SESSION_EXPIRED', 'Refresh token has been revoked or reused');
    }
    if (row.token_expires_at <= new Date() || row.session_expires_at <= new Date() || row.membership_status !== 'active' || row.user_status !== 'active' || row.organization_status !== 'active') {
      throw unauthorized('SESSION_EXPIRED', 'Refresh token is expired or account is inactive');
    }

    const membership = await membershipSession(tx, row.membership_id, row.organization_id);
    const newSessionExpiry = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
    const newRefreshToken = generateOpaqueToken();
    const newToken = await tx.query<{ id: string }>(
      `INSERT INTO refresh_tokens (organization_id, session_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [row.organization_id, row.session_id, hashOpaqueToken(newRefreshToken, config), newSessionExpiry]
    );
    await tx.query(
      `UPDATE refresh_tokens
       SET rotated_at = now(), last_used_at = now(), replaced_by_token_id = $1
       WHERE id = $2`,
      [newToken.rows[0]!.id, row.refresh_token_id]
    );
    await tx.query(
      `UPDATE auth_sessions
       SET last_seen_at = now(), expires_at = $1, ip_address = $2::inet, user_agent = $3
       WHERE id = $4 AND organization_id = $5`,
      [newSessionExpiry, requestMeta(req).ipAddress ?? null, requestMeta(req).userAgent ?? null, row.session_id, row.organization_id]
    );

    return {
      accessToken: signAccessToken(config, {
        membershipId: row.membership_id,
        organizationId: row.organization_id,
        sessionId: row.session_id,
        userId: row.user_id
      }),
      accessTokenExpiresIn: config.accessTokenTtlSeconds,
      refreshToken: newRefreshToken,
      session: {
        id: row.session_id,
        expiresAt: newSessionExpiry.toISOString()
      },
      membership: {
        id: membership.membership_id,
        organizationId: membership.organization_id,
        userId: membership.user_id,
        displayName: membership.display_name,
        email: membership.email,
        allBranches: membership.all_branches,
        permissions: membership.permissions ?? []
      }
    } satisfies AuthBundle;
  });
}

export async function logout(pool: pg.Pool, config: AppConfig, refreshToken: string | undefined, req: Request): Promise<void> {
  if (!refreshToken) return;
  const tokenHash = hashOpaqueToken(refreshToken, config);
  await withTransaction(pool, async (tx) => {
    const result = await tx.query<{ session_id: string; organization_id: string }>(
      'SELECT session_id, organization_id FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) return;
    await tx.query(
      `UPDATE auth_sessions SET status = 'revoked', revoked_at = now(), revoked_reason = 'logout'
       WHERE id = $1 AND organization_id = $2`,
      [row.session_id, row.organization_id]
    );
    await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1', [row.session_id]);
    await recordAudit(tx, {
      organizationId: row.organization_id,
      action: 'auth.logout',
      entityType: 'auth_session',
      entityId: row.session_id,
      ...requestMeta(req)
    });
  });
}

export async function requestPasswordReset(pool: pg.Pool, config: AppConfig, input: RequestPasswordResetInput, req: Request): Promise<{ resetToken?: string }> {
  const result = await pool.query<{ membership_id: string; organization_id: string; user_id: string }>(
    `SELECT m.id AS membership_id, m.organization_id, m.user_id
     FROM organizations o
     JOIN memberships m ON m.organization_id = o.id
     JOIN users u ON u.id = m.user_id
     WHERE ($1::text IS NULL OR o.slug = $1) AND u.email = $2 AND o.status = 'active' AND m.status = 'active' AND u.status = 'active'
     ORDER BY m.id LIMIT 1`,
    [input.organizationSlug ?? null, input.email]
  );
  const row = result.rows[0];
  if (!row) return {};

  const resetToken = generateOpaqueToken(32);
  const expiresAt = new Date(Date.now() + config.passwordResetTtlMinutes * 60 * 1000);
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `UPDATE password_reset_tokens
       SET used_at = now()
       WHERE organization_id = $1 AND membership_id = $2 AND used_at IS NULL`,
      [row.organization_id, row.membership_id]
    );
    await tx.query(
      `INSERT INTO password_reset_tokens (organization_id, membership_id, token_hash, expires_at, requested_by_ip)
       VALUES ($1, $2, $3, $4, $5::inet)`,
      [row.organization_id, row.membership_id, hashOpaqueToken(resetToken, config), expiresAt, req.ip ?? null]
    );
    await recordAudit(tx, {
      organizationId: row.organization_id,
      actorMembershipId: row.membership_id,
      actorUserId: row.user_id,
      action: 'auth.password-reset-requested',
      entityType: 'membership',
      entityId: row.membership_id,
      ...requestMeta(req)
    });
  });
  return config.exposeDevTokens ? { resetToken } : {};
}

export async function resetPassword(pool: pg.Pool, config: AppConfig, input: ResetPasswordInput, req: Request): Promise<void> {
  const tokenHash = hashOpaqueToken(input.token, config);
  await withTransaction(pool, async (tx) => {
    const result = await tx.query<{
      id: string;
      membership_id: string;
      organization_id: string;
      user_id: string;
      expires_at: Date;
      used_at: Date | null;
    }>(
      `SELECT prt.id, prt.membership_id, prt.organization_id, prt.expires_at, prt.used_at, m.user_id
       FROM password_reset_tokens prt
       JOIN memberships m ON m.id = prt.membership_id AND m.organization_id = prt.organization_id
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
       WHERE prt.token_hash = $1
         AND o.status = 'active' AND m.status = 'active' AND u.status = 'active'
       FOR UPDATE OF prt`,
      [tokenHash]
    );
    const token = result.rows[0];
    if (!token || token.used_at || token.expires_at <= new Date()) {
      throw unauthorized('PASSWORD_RESET_INVALID', 'Password reset token is invalid or expired');
    }

    await tx.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [token.id]);
    await tx.query('UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2', [await hashPassword(input.password, config), token.user_id]);
    await revokeUserSessions(tx, token.user_id);
    await recordAudit(tx, {
      organizationId: token.organization_id,
      actorMembershipId: token.membership_id,
      actorUserId: token.user_id,
      action: 'auth.password-reset-completed',
      entityType: 'membership',
      entityId: token.membership_id,
      ...requestMeta(req)
    });
  });
}

export async function listSessions(pool: pg.Pool, auth: AuthContext): Promise<unknown[]> {
  const accessibleBranchIds = await listAccessibleBranchIds(pool, auth);
  const result = await pool.query(
    `SELECT s.id, s.status, s.ip_address::text, s.user_agent, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
            u.email::text AS user_email, u.display_name
     FROM auth_sessions s
     JOIN memberships m ON m.id = s.membership_id AND m.organization_id = s.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE s.organization_id = $1
       AND (
         s.membership_id = $3 OR (
           $2::boolean AND NOT m.all_branches
           AND EXISTS (
             SELECT 1 FROM membership_branches visible_branch
             WHERE visible_branch.membership_id = m.id
               AND visible_branch.organization_id = m.organization_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM membership_branches target_branch
             WHERE target_branch.membership_id = m.id
               AND target_branch.organization_id = m.organization_id
               AND NOT (target_branch.branch_id = ANY($4::uuid[]))
           )
         )
       )
     ORDER BY s.last_seen_at DESC`,
    [auth.organizationId, auth.permissions.has('session.manage'), auth.membershipId, accessibleBranchIds]
  );
  return result.rows;
}

export async function revokeSession(pool: pg.Pool, auth: AuthContext, sessionId: string, req: Request): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const session = await tx.query<{ membership_id: string; status: string }>(
      `SELECT membership_id, status FROM auth_sessions
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [sessionId, auth.organizationId]
    );
    const row = session.rows[0];
    if (!row || row.status !== 'active') throw unauthorized('SESSION_EXPIRED', 'Session was not found or is not active');
    if (row.membership_id !== auth.membershipId) {
      const canManage = auth.permissions.has('session.manage') && await membershipWithinBranchScope(tx, auth, row.membership_id);
      if (!canManage) throw forbidden('FORBIDDEN', 'Cannot revoke another user session');
    }
    await tx.query(
      `UPDATE auth_sessions SET status = 'revoked', revoked_at = now(), revoked_reason = 'manual_revocation'
       WHERE id = $1 AND organization_id = $2`,
      [sessionId, auth.organizationId]
    );
    await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND organization_id = $2', [sessionId, auth.organizationId]);
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'auth.session-revoked',
      entityType: 'auth_session',
      entityId: sessionId,
      ...requestMeta(req)
    });
  });
}
