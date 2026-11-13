import type {
  CreateBranchInput,
  CreateUserInput,
  RoleInput,
  UpdateBranchInput,
  UpdateMembershipInput,
  UpdateOrganizationConfigurationInput,
  UpdateOrganizationInput,
  UpdateRoleInput
} from '@pos/contracts';
import {
  BUSINESS_PROFILE_DEFINITIONS,
  CONFIGURABLE_MODULE_CODES,
  IMPLEMENTED_CAPABILITY_CODES,
  PERMISSION_CODES,
  type ConfigurableModuleCode,
  type ImplementedCapabilityCode
} from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import type { Queryable } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { percentToBasisPoints, scaledIntToDecimal } from '../../shared/money.js';
import type { AuthContext } from '../../http/middleware/auth.js';
import { listAccessibleBranchIds, membershipHasBranchAccess, membershipWithinBranchScope } from '../../http/middleware/auth.js';
import { hashPassword } from '../identity/security.js';
import type { AppConfig } from '../../config/env.js';
import { recordAudit } from '../audit/audit.js';
import { enforceLicenseUserLimit } from '../licensing/service.js';

function requestMeta(req: Request) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null
  };
}

async function ensureBranchesExist(db: Queryable, organizationId: string, branchIds: string[]): Promise<void> {
  if (branchIds.length === 0) return;
  const result = await db.query(
    'SELECT id FROM branches WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [organizationId, branchIds]
  );
  if (result.rowCount !== new Set(branchIds).size) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'One or more branches are not valid for this organization');
  }
}

async function ensureRolesExist(db: Queryable, organizationId: string, roleIds: string[]): Promise<void> {
  const result = await db.query(
    'SELECT id FROM roles WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [organizationId, roleIds]
  );
  if (result.rowCount !== new Set(roleIds).size) {
    throw badRequest('VALIDATION_ERROR', 'One or more roles are not valid for this organization');
  }
}

async function ensureAssignableBranches(db: Queryable, auth: AuthContext, branchIds: string[]): Promise<void> {
  await ensureBranchesExist(db, auth.organizationId, branchIds);
  for (const branchId of new Set(branchIds)) {
    if (!(await membershipHasBranchAccess(db, auth, branchId))) {
      throw forbidden('BRANCH_ACCESS_DENIED', 'You cannot assign a branch outside your permitted access');
    }
  }
}

async function ensureAssignableRoles(db: Queryable, auth: AuthContext, roleIds: string[]): Promise<void> {
  await ensureRolesExist(db, auth.organizationId, roleIds);
  const result = await db.query<{ role_id: string; permission_codes: string[] | null }>(
    `SELECT rp.role_id, array_agg(rp.permission_code) AS permission_codes
     FROM role_permissions rp
     WHERE rp.organization_id = $1 AND rp.role_id = ANY($2::uuid[])
     GROUP BY rp.role_id`,
    [auth.organizationId, roleIds]
  );
  const permissionsByRole = new Map(result.rows.map((row) => [row.role_id, row.permission_codes ?? []]));
  for (const roleId of new Set(roleIds)) {
    const missing = (permissionsByRole.get(roleId) ?? []).filter((permission) => !auth.permissions.has(permission));
    if (missing.length > 0) {
      throw forbidden('ROLE_ESCALATION_DENIED', 'You cannot assign a role with permissions you do not have');
    }
  }
}

async function replaceMembershipRoles(db: Queryable, organizationId: string, membershipId: string, roleIds: string[]): Promise<void> {
  await db.query('DELETE FROM membership_roles WHERE membership_id = $1 AND organization_id = $2', [membershipId, organizationId]);
  await db.query(
    `INSERT INTO membership_roles (membership_id, organization_id, role_id)
     SELECT $1::uuid, $2::uuid, role_id FROM unnest($3::uuid[]) AS role_id`,
    [membershipId, organizationId, [...new Set(roleIds)]]
  );
}

async function replaceMembershipBranches(db: Queryable, organizationId: string, membershipId: string, branchIds: string[]): Promise<void> {
  await db.query('DELETE FROM membership_branches WHERE membership_id = $1 AND organization_id = $2', [membershipId, organizationId]);
  await db.query(
    `INSERT INTO membership_branches (membership_id, organization_id, branch_id)
     SELECT $1::uuid, $2::uuid, branch_id FROM unnest($3::uuid[]) AS branch_id`,
    [membershipId, organizationId, [...new Set(branchIds)]]
  );
}

export async function getOrganization(pool: pg.Pool | Queryable, auth: AuthContext) {
  const result = await pool.query(
    `SELECT o.id, o.slug, o.legal_name AS "legalName", o.display_name AS "displayName", o.currency_code AS "currencyCode",
            o.timezone, o.tax_pricing_mode AS "taxPricingMode", o.default_tax_rate_bps, o.receipt_policy AS "receiptPolicy",
            o.status, o.created_at AS "createdAt", o.updated_at AS "updatedAt",
            COALESCE(p.business_profile, 'general_retail') AS "businessProfile",
            p.default_branch_id AS "defaultBranchId", p.contact_phone AS "contactPhone",
            p.contact_email::text AS "contactEmail", p.business_address AS "businessAddress",
            p.tax_pin AS "taxPin", p.receipt_header AS "receiptHeader",
            p.receipt_footer AS "receiptFooter", p.receipt_logo_url AS "receiptLogoUrl", p.receipt_design AS "receiptDesign", p.cash_drawer_policy AS "cashDrawerPolicy"
     FROM organizations o
     LEFT JOIN organization_profiles p ON p.organization_id = o.id
     WHERE o.id = $1`,
    [auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    defaultTaxRatePct: scaledIntToDecimal(BigInt(String(row.default_tax_rate_bps)), 2),
    default_tax_rate_bps: undefined
  };
}

export async function updateOrganization(pool: pg.Pool, auth: AuthContext, input: UpdateOrganizationInput, req: Request) {
  const fieldMap: Record<keyof UpdateOrganizationInput, string> = {
    legalName: 'legal_name',
    displayName: 'display_name',
    currencyCode: 'currency_code',
    timezone: 'timezone',
    taxPricingMode: 'tax_pricing_mode',
    defaultTaxRatePct: 'default_tax_rate_bps',
    receiptPolicy: 'receipt_policy',
    status: 'status'
  };
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw badRequest('VALIDATION_ERROR', 'At least one field is required');
  const assignments = entries.map(([key], index) => `${fieldMap[key as keyof UpdateOrganizationInput]} = $${index + 2}`).join(', ');
  const values = entries.map(([key, value]) => key === 'defaultTaxRatePct' ? percentToBasisPoints(String(value)).toString() : value);
  await withTransaction(pool, async (tx) => {
    const result = await tx.query(
      `UPDATE organizations SET ${assignments} WHERE id = $1 RETURNING id`,
      [auth.organizationId, ...values]
    );
    if (!result.rows[0]) throw notFound('Organization was not found');
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'organization.updated',
      entityType: 'organization',
      entityId: auth.organizationId,
      metadata: { fields: entries.map(([key]) => key) },
      ...requestMeta(req)
    });
  });
  return getOrganization(pool, auth);
}

interface ModuleCatalogRow {
  code: string;
  name: string;
  description: string;
  kind: 'module' | 'capability';
  availability: 'implemented' | 'planned';
  core: boolean;
  depends_on: string[];
  enabled: boolean;
}

interface OrganizationProfileRow {
  business_profile: string;
  default_branch_id: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  business_address: string | null;
  tax_pin: string | null;
  receipt_header: string | null;
  receipt_footer: string | null;
  receipt_logo_url: string | null;
  receipt_design: unknown;
  cash_drawer_policy: string;
}

async function moduleRows(db: Queryable, organizationId: string, lock = false): Promise<ModuleCatalogRow[]> {
  if (lock) {
    await db.query('SELECT 1 FROM organization_module_states WHERE organization_id = $1 FOR UPDATE', [organizationId]);
  }
  const result = await db.query<ModuleCatalogRow>(
    `SELECT catalog.code, catalog.name, catalog.description, catalog.kind, catalog.availability,
            catalog.core, catalog.depends_on, COALESCE(state.enabled, false) AS enabled
     FROM module_catalog catalog
     LEFT JOIN organization_module_states state
       ON state.organization_id = $1 AND state.module_code = catalog.code
     ORDER BY catalog.sort_order, catalog.code`,
    [organizationId]
  );
  return result.rows;
}

function mapModuleRow(row: ModuleCatalogRow) {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    availability: row.availability,
    core: row.core,
    dependsOn: row.depends_on,
    enabled: row.availability === 'implemented' && row.enabled,
    configurable: row.availability === 'implemented' && !row.core
  };
}

export async function getOrganizationConfiguration(pool: pg.Pool | Queryable, auth: AuthContext) {
  const [organization, modules] = await Promise.all([
    getOrganization(pool, auth),
    moduleRows(pool, auth.organizationId)
  ]);
  return {
    organization,
    profiles: BUSINESS_PROFILE_DEFINITIONS,
    modules: modules.map(mapModuleRow)
  };
}

function businessProfileDefinition(code: string) {
  return BUSINESS_PROFILE_DEFINITIONS.find((profile) => profile.code === code);
}

async function assertCapabilityCanDisable(db: Queryable, organizationId: string, code: ImplementedCapabilityCode): Promise<void> {
  if (code === 'barcode_scanner' || code === 'cash_drawer') return;
  const checks: Record<Exclude<ImplementedCapabilityCode, 'barcode_scanner' | 'cash_drawer'>, string> = {
    service_items: `item_type = 'service'`,
    batch_expiry_tracking: `(track_batch OR track_expiry)`,
    serial_tracking: `track_serial`
  };
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM products
       WHERE organization_id = $1 AND status = 'active' AND ${checks[code]}
     ) AS exists`,
    [organizationId]
  );
  if (result.rows[0]?.exists) {
    throw conflict('CAPABILITY_IN_USE', 'This capability cannot be disabled while active products depend on it');
  }
}

export async function updateOrganizationConfiguration(pool: pg.Pool, auth: AuthContext, input: UpdateOrganizationConfigurationInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const organization = await tx.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [auth.organizationId]);
    if (!organization.rows[0]) throw notFound('Organization was not found');
    await tx.query(
      `INSERT INTO organization_profiles (organization_id)
       VALUES ($1) ON CONFLICT (organization_id) DO NOTHING`,
      [auth.organizationId]
    );
    const profileResult = await tx.query<OrganizationProfileRow>(
      `SELECT business_profile, default_branch_id, contact_phone, contact_email::text AS contact_email,
              business_address, tax_pin, receipt_header, receipt_footer, receipt_logo_url, receipt_design, cash_drawer_policy
       FROM organization_profiles
       WHERE organization_id = $1
       FOR UPDATE`,
      [auth.organizationId]
    );
    const profile = profileResult.rows[0]!;
    const modules = await moduleRows(tx, auth.organizationId, true);
    const currentModules = new Map(modules.map((row) => [row.code, row.availability === 'implemented' && row.enabled]));

    const targetModules = new Map<ConfigurableModuleCode, boolean>(
      CONFIGURABLE_MODULE_CODES.map((code) => [code, currentModules.get(code) === true])
    );
    const targetCapabilities = new Map<ImplementedCapabilityCode, boolean>(
      IMPLEMENTED_CAPABILITY_CODES.map((code) => [code, currentModules.get(code) === true])
    );
    const targetProfile = input.businessProfile ?? profile.business_profile;

    if (input.applyProfilePreset) {
      const definition = businessProfileDefinition(targetProfile);
      if (!definition) throw badRequest('VALIDATION_ERROR', 'Unknown business profile');
      for (const code of CONFIGURABLE_MODULE_CODES) targetModules.set(code, definition.recommendedModules.includes(code));
      for (const code of IMPLEMENTED_CAPABILITY_CODES) targetCapabilities.set(code, definition.recommendedCapabilities.includes(code));
    } else {
      for (const [code, enabled] of Object.entries(input.modules ?? {}) as Array<[ConfigurableModuleCode, boolean | undefined]>) {
        if (enabled !== undefined) targetModules.set(code, enabled);
      }
      for (const [code, enabled] of Object.entries(input.capabilities ?? {}) as Array<[ImplementedCapabilityCode, boolean | undefined]>) {
        if (enabled !== undefined) targetCapabilities.set(code, enabled);
      }
    }

    const moduleChanges = Object.fromEntries([...targetModules.entries()]
      .filter(([code, enabled]) => currentModules.get(code) !== enabled)
      .map(([code, enabled]) => [code, { from: currentModules.get(code), to: enabled }]));
    const capabilityChanges = Object.fromEntries([...targetCapabilities.entries()]
      .filter(([code, enabled]) => currentModules.get(code) !== enabled)
      .map(([code, enabled]) => [code, { from: currentModules.get(code), to: enabled }]));
    const profileChanged = targetProfile !== profile.business_profile;
    const structuralChange = profileChanged || Object.keys(moduleChanges).length > 0 || Object.keys(capabilityChanges).length > 0;
    if (structuralChange && !input.changeReason) {
      throw badRequest('CONFIGURATION_REASON_REQUIRED', 'A change reason is required for profile, module or capability changes');
    }

    if (input.defaultBranchId !== undefined && input.defaultBranchId !== null) {
      const branch = await tx.query(
        `SELECT 1 FROM branches
         WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
        [input.defaultBranchId, auth.organizationId]
      );
      if (!branch.rows[0]) throw badRequest('VALIDATION_ERROR', 'Default branch must be an active branch in this organization');
    }

    if (targetModules.get('procurement') && !targetModules.get('inventory')) {
      throw badRequest('MODULE_DEPENDENCY_UNMET', 'Procurement requires the inventory operations module');
    }
    if (currentModules.get('offline_sync') === true && targetModules.get('offline_sync') === false) {
      const pendingSync = await tx.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM sync_transactions
           WHERE organization_id = $1 AND status IN ('pending', 'processing', 'retryable', 'conflict')
         ) AS exists`,
        [auth.organizationId]
      );
      if (pendingSync.rows[0]?.exists) {
        throw conflict('OFFLINE_SYNC_PENDING', 'Resolve pending offline synchronization before disabling offline sync');
      }
    }
    for (const [code, enabled] of targetCapabilities) {
      if (currentModules.get(code) === true && !enabled) await assertCapabilityCanDisable(tx, auth.organizationId, code);
    }

    const nextProfile = {
      business_profile: targetProfile,
      default_branch_id: input.defaultBranchId !== undefined ? input.defaultBranchId : profile.default_branch_id,
      contact_phone: input.contactPhone !== undefined ? input.contactPhone : profile.contact_phone,
      contact_email: input.contactEmail !== undefined ? input.contactEmail : profile.contact_email,
      business_address: input.businessAddress !== undefined ? input.businessAddress : profile.business_address,
      tax_pin: input.taxPin !== undefined ? input.taxPin : profile.tax_pin,
      receipt_header: input.receiptHeader !== undefined ? input.receiptHeader : profile.receipt_header,
      receipt_footer: input.receiptFooter !== undefined ? input.receiptFooter : profile.receipt_footer,
      receipt_logo_url: input.receiptLogoUrl !== undefined ? input.receiptLogoUrl : profile.receipt_logo_url,
      receipt_design: input.receiptDesign ?? profile.receipt_design,
      cash_drawer_policy: input.cashDrawerPolicy ?? profile.cash_drawer_policy
    };
    await tx.query(
      `UPDATE organization_profiles
       SET business_profile = $2, default_branch_id = $3, contact_phone = $4, contact_email = $5,
           business_address = $6, tax_pin = $7, receipt_header = $8, receipt_footer = $9,
           receipt_logo_url = $10, configured_by_membership_id = $11, receipt_design = $12::jsonb, cash_drawer_policy = $13
       WHERE organization_id = $1`,
      [
        auth.organizationId,
        nextProfile.business_profile,
        nextProfile.default_branch_id,
        nextProfile.contact_phone,
        nextProfile.contact_email,
        nextProfile.business_address,
        nextProfile.tax_pin,
        nextProfile.receipt_header,
        nextProfile.receipt_footer,
        nextProfile.receipt_logo_url,
        auth.membershipId,
        JSON.stringify(nextProfile.receipt_design),
        nextProfile.cash_drawer_policy
      ]
    );

    for (const [code, enabled] of [...targetModules, ...targetCapabilities] as Array<[ConfigurableModuleCode | ImplementedCapabilityCode, boolean]>) {
      await tx.query(
        `INSERT INTO organization_module_states (organization_id, module_code, enabled, configured_by_membership_id, configured_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (organization_id, module_code)
         DO UPDATE SET enabled = EXCLUDED.enabled,
                       configured_by_membership_id = EXCLUDED.configured_by_membership_id,
                       configured_at = EXCLUDED.configured_at`,
        [auth.organizationId, code, enabled, auth.membershipId]
      );
    }

    const updatedFields = [
      ...(input.businessProfile !== undefined ? ['businessProfile'] : []),
      ...(input.defaultBranchId !== undefined ? ['defaultBranchId'] : []),
      ...(input.contactPhone !== undefined ? ['contactPhone'] : []),
      ...(input.contactEmail !== undefined ? ['contactEmail'] : []),
      ...(input.businessAddress !== undefined ? ['businessAddress'] : []),
      ...(input.taxPin !== undefined ? ['taxPin'] : []),
      ...(input.receiptHeader !== undefined ? ['receiptHeader'] : []),
      ...(input.receiptFooter !== undefined ? ['receiptFooter'] : []),
      ...(input.receiptLogoUrl !== undefined ? ['receiptLogoUrl'] : []),
      ...(input.receiptDesign !== undefined ? ['receiptDesign'] : []),
      ...(input.cashDrawerPolicy !== undefined ? ['cashDrawerPolicy'] : [])
    ];
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'organization.configuration-updated',
      entityType: 'organization',
      entityId: auth.organizationId,
      metadata: {
        fields: updatedFields,
        businessProfile: { from: profile.business_profile, to: targetProfile },
        modules: moduleChanges,
        capabilities: capabilityChanges,
        presetApplied: input.applyProfilePreset === true,
        reason: input.changeReason ?? null
      },
      ...requestMeta(req)
    });
  });
  return getOrganizationConfiguration(pool, auth);
}

export async function listBranches(pool: pg.Pool, auth: AuthContext) {
  const branchIds = await listAccessibleBranchIds(pool, auth);
  if (branchIds.length === 0) return [];
  const result = await pool.query(
    `SELECT id, code, name, timezone, currency_code AS "currencyCode", status,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM branches
     WHERE organization_id = $1 AND id = ANY($2::uuid[])
     ORDER BY code`,
    [auth.organizationId, branchIds]
  );
  return result.rows;
}

export async function createBranch(pool: pg.Pool, auth: AuthContext, input: CreateBranchInput, req: Request) {
  if (!auth.allBranches) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Only all-branch members can create branches');
  }
  return withTransaction(pool, async (tx) => {
    try {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO branches (organization_id, code, name, timezone, currency_code)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [auth.organizationId, input.code, input.name, input.timezone ?? null, input.currencyCode ?? null]
      );
      const branchId = result.rows[0]!.id;
      if (!auth.allBranches) {
        await tx.query(
          `INSERT INTO membership_branches (membership_id, organization_id, branch_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [auth.membershipId, auth.organizationId, branchId]
        );
      }
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'branch.created',
        entityType: 'branch',
        entityId: branchId,
        metadata: { code: input.code },
        ...requestMeta(req)
      });
      return { id: branchId, ...input };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw conflict('BRANCH_CODE_TAKEN', 'A branch with this code already exists');
      }
      throw error;
    }
  });
}

export async function updateBranch(pool: pg.Pool, auth: AuthContext, branchId: string, input: UpdateBranchInput, req: Request) {
  if (!(await membershipHasBranchAccess(pool, auth, branchId))) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
  }
  const fieldMap: Record<keyof UpdateBranchInput, string> = {
    code: 'code',
    name: 'name',
    timezone: 'timezone',
    currencyCode: 'currency_code',
    status: 'status'
  };
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  const assignments = entries.map(([key], index) => `${fieldMap[key as keyof UpdateBranchInput]} = $${index + 3}`).join(', ');
  const values = entries.map(([, value]) => value);
  await withTransaction(pool, async (tx) => {
    const result = await tx.query(
      `UPDATE branches SET ${assignments}
       WHERE id = $1 AND organization_id = $2
       RETURNING id`,
      [branchId, auth.organizationId, ...values]
    );
    if (!result.rows[0]) throw notFound('Branch was not found');
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'branch.updated',
      entityType: 'branch',
      entityId: branchId,
      metadata: { fields: entries.map(([key]) => key) },
      ...requestMeta(req)
    });
  });
  return { id: branchId, ...input };
}

export async function listMemberships(pool: pg.Pool, auth: AuthContext) {
  const accessibleBranchIds = await listAccessibleBranchIds(pool, auth);
  const result = await pool.query(
    `SELECT
       m.id,
       u.id AS "userId",
       u.email::text,
       u.display_name AS "displayName",
       m.title,
       m.status,
       m.all_branches AS "allBranches",
       m.created_at AS "createdAt",
       COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name)) FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS roles,
       COALESCE(array_agg(DISTINCT mb.branch_id) FILTER (WHERE mb.branch_id IS NOT NULL), '{}'::uuid[]) AS "branchIds"
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN membership_roles mr ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
     LEFT JOIN roles r ON r.id = mr.role_id AND r.organization_id = m.organization_id
     LEFT JOIN membership_branches mb ON mb.membership_id = m.id AND mb.organization_id = m.organization_id
     WHERE m.organization_id = $1
       AND (
         $2::boolean OR (
           NOT m.all_branches
           AND EXISTS (
             SELECT 1 FROM membership_branches visible_branch
             WHERE visible_branch.membership_id = m.id
               AND visible_branch.organization_id = m.organization_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM membership_branches inaccessible_branch
             WHERE inaccessible_branch.membership_id = m.id
               AND inaccessible_branch.organization_id = m.organization_id
               AND NOT (inaccessible_branch.branch_id = ANY($3::uuid[]))
           )
         )
       )
     GROUP BY m.id, u.id
     ORDER BY u.display_name`,
    [auth.organizationId, auth.allBranches, accessibleBranchIds]
  );
  return result.rows;
}

export async function createMembership(pool: pg.Pool, systemDb: Queryable, config: AppConfig, auth: AuthContext, input: CreateUserInput, req: Request) {
  if (input.allBranches && !auth.allBranches) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Only all-branch members can grant all-branch access');
  }
  // users is a global table: resolving or creating the invited account is a
  // deliberate cross-tenant identity operation that runs on the system path.
  // Only organization-scoped membership rows are written inside the tenant
  // transaction below.
  return withTransaction(pool, async (tx) => {
    await ensureAssignableBranches(tx, auth, input.branchIds);
    await ensureAssignableRoles(tx, auth, input.roleIds);
    await enforceLicenseUserLimit(tx, config, auth.organizationId);
    const existingUser = await systemDb.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [input.email]);
    let userId = existingUser.rows[0]?.id;
    if (!userId) {
      if (!input.temporaryPassword) throw badRequest('VALIDATION_ERROR', 'A temporary password is required for a new user');
      const user = await systemDb.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [input.email, await hashPassword(input.temporaryPassword, config), input.displayName]
      );
      userId = user.rows[0]!.id;
    }

    let membershipId: string;
    try {
      const membership = await tx.query<{ id: string }>(
        `INSERT INTO memberships (organization_id, user_id, title, all_branches, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [auth.organizationId, userId, input.title ?? null, input.allBranches, auth.userId]
      );
      membershipId = membership.rows[0]!.id;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw conflict('MEMBERSHIP_EXISTS', 'This user is already a member of the organization');
      }
      throw error;
    }

    await replaceMembershipRoles(tx, auth.organizationId, membershipId, input.roleIds);
    if (!input.allBranches) await replaceMembershipBranches(tx, auth.organizationId, membershipId, input.branchIds);
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'membership.created',
      entityType: 'membership',
      entityId: membershipId,
      metadata: { email: input.email, roleIds: input.roleIds, branchIds: input.branchIds, allBranches: input.allBranches },
      ...requestMeta(req)
    });
    return { id: membershipId, userId, email: input.email, displayName: input.displayName };
  });
}

export async function updateMembership(pool: pg.Pool, auth: AuthContext, membershipId: string, input: UpdateMembershipInput, req: Request, config: AppConfig) {
  if (membershipId === auth.membershipId && (input.status !== undefined || input.allBranches !== undefined || input.roleIds !== undefined || input.branchIds !== undefined)) {
    throw forbidden('SELF_ACCESS_MODIFICATION_DENIED', 'You cannot change your own status, roles or branch access');
  }
  if (input.status === 'suspended' && !auth.permissions.has('user.deactivate')) {
    throw forbidden();
  }
  if (input.allBranches && !auth.allBranches) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Only all-branch members can grant all-branch access');
  }
  return withTransaction(pool, async (tx) => {
    if (config.licensing) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('license-users:' || $1, 0))", [auth.organizationId]);
    const membership = await tx.query<{ id: string; status: string }>(
      'SELECT id, status FROM memberships WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [membershipId, auth.organizationId]
    );
    if (!membership.rows[0]) throw notFound('Membership was not found');
    if (input.status === 'active' && membership.rows[0].status !== 'active') await enforceLicenseUserLimit(tx, config, auth.organizationId);
    if (!(await membershipWithinBranchScope(tx, auth, membershipId))) {
      throw forbidden('BRANCH_ACCESS_DENIED', 'Membership is outside your permitted branch access');
    }
    if (input.roleIds) await ensureAssignableRoles(tx, auth, input.roleIds);
    if (input.branchIds) await ensureAssignableBranches(tx, auth, input.branchIds);

    const updates: string[] = [];
    const values: unknown[] = [];
    if (input.status !== undefined) {
      values.push(input.status);
      updates.push(`status = $${values.length + 2}`);
    }
    if (input.title !== undefined) {
      values.push(input.title);
      updates.push(`title = $${values.length + 2}`);
    }
    if (input.allBranches !== undefined) {
      values.push(input.allBranches);
      updates.push(`all_branches = $${values.length + 2}`);
    }
    if (updates.length > 0) {
      await tx.query(`UPDATE memberships SET ${updates.join(', ')} WHERE id = $1 AND organization_id = $2`, [membershipId, auth.organizationId, ...values]);
    }
    if (input.roleIds) await replaceMembershipRoles(tx, auth.organizationId, membershipId, input.roleIds);
    if (input.branchIds || input.allBranches === true) {
      await replaceMembershipBranches(tx, auth.organizationId, membershipId, input.allBranches === true ? [] : input.branchIds ?? []);
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'membership.updated',
      entityType: 'membership',
      entityId: membershipId,
      metadata: input as Record<string, unknown>,
      ...requestMeta(req)
    });
    return { id: membershipId, ...input };
  });
}

export async function listRoles(pool: pg.Pool, auth: AuthContext) {
  const result = await pool.query(
    `SELECT r.id, r.code, r.name, r.description, r.is_system AS "isSystem",
            COALESCE(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}'::text[]) AS "permissionCodes"
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.organization_id = r.organization_id
     WHERE r.organization_id = $1
     GROUP BY r.id
     ORDER BY r.is_system DESC, r.code`,
    [auth.organizationId]
  );
  return result.rows;
}

export async function createRole(pool: pg.Pool, auth: AuthContext, input: RoleInput, req: Request) {
  return withTransaction(pool, async (tx) => {
    const invalid = input.permissionCodes.filter((code) => !(PERMISSION_CODES as readonly string[]).includes(code));
    if (invalid.length > 0) throw badRequest('VALIDATION_ERROR', 'Invalid permission codes', invalid);
    try {
      const role = await tx.query<{ id: string }>(
        `INSERT INTO roles (organization_id, code, name, description)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [auth.organizationId, input.code, input.name, input.description ?? null]
      );
      const roleId = role.rows[0]!.id;
      await tx.query(
        `INSERT INTO role_permissions (role_id, organization_id, permission_code)
         SELECT $1::uuid, $2::uuid, permission_code FROM unnest($3::text[]) AS permission_code`,
        [roleId, auth.organizationId, [...new Set(input.permissionCodes)]]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'role.created',
        entityType: 'role',
        entityId: roleId,
        metadata: { code: input.code, permissionCodes: input.permissionCodes },
        ...requestMeta(req)
      });
      return { id: roleId, ...input };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw conflict('ROLE_CODE_TAKEN', 'A role with this code already exists');
      }
      throw error;
    }
  });
}

export async function updateRole(pool: pg.Pool, auth: AuthContext, roleId: string, input: UpdateRoleInput, req: Request) {
  return withTransaction(pool, async (tx) => {
    const existing = await tx.query<{ code: string; is_system: boolean }>(
      'SELECT code, is_system FROM roles WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [roleId, auth.organizationId]
    );
    const role = existing.rows[0];
    if (!role) throw notFound('Role was not found');
    if (role.code === 'owner' && input.permissionCodes) {
      throw forbidden('OWNER_ROLE_LOCKED', 'Owner role permissions cannot be removed');
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      values.push(input.name);
      updates.push(`name = $${values.length + 2}`);
    }
    if (input.description !== undefined) {
      values.push(input.description);
      updates.push(`description = $${values.length + 2}`);
    }
    if (updates.length > 0) {
      await tx.query(`UPDATE roles SET ${updates.join(', ')} WHERE id = $1 AND organization_id = $2`, [roleId, auth.organizationId, ...values]);
    }
    if (input.permissionCodes) {
      await tx.query('DELETE FROM role_permissions WHERE role_id = $1 AND organization_id = $2', [roleId, auth.organizationId]);
      await tx.query(
        `INSERT INTO role_permissions (role_id, organization_id, permission_code)
         SELECT $1::uuid, $2::uuid, permission_code FROM unnest($3::text[]) AS permission_code`,
        [roleId, auth.organizationId, [...new Set(input.permissionCodes)]]
      );
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'role.updated',
      entityType: 'role',
      entityId: roleId,
      metadata: input as Record<string, unknown>,
      ...requestMeta(req)
    });
    return { id: roleId, ...input };
  });
}

export async function listAuditEvents(pool: pg.Pool, auth: AuthContext) {
  const accessibleBranchIds = await listAccessibleBranchIds(pool, auth);
  const result = await pool.query(
    `SELECT id, action, entity_type AS "entityType", entity_id AS "entityId", metadata,
            branch_id AS "branchId", actor_membership_id AS "actorMembershipId",
            actor_user_id AS "actorUserId", device_id AS "deviceId", ip_address::text AS "ipAddress",
            user_agent AS "userAgent", created_at AS "createdAt"
     FROM audit_events
     WHERE organization_id = $1
       AND ($2::boolean OR branch_id IS NULL OR branch_id = ANY($3::uuid[]))
     ORDER BY created_at DESC
     LIMIT 200`,
    [auth.organizationId, auth.allBranches, accessibleBranchIds]
  );
  return result.rows;
}
