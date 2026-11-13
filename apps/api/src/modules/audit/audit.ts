import type { Request } from 'express';
import type { Queryable } from '../../database/pool.js';
import type { AuthContext } from '../../http/middleware/auth.js';

export interface AuditInput {
  organizationId?: string | null;
  branchId?: string | null;
  actorMembershipId?: string | null;
  actorUserId?: string | null;
  deviceId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(db: Queryable, input: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
      (organization_id, branch_id, actor_membership_id, actor_user_id, device_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::inet, $11)`,
    [
      input.organizationId ?? null,
      input.branchId ?? null,
      input.actorMembershipId ?? null,
      input.actorUserId ?? null,
      input.deviceId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.ipAddress ?? null,
      input.userAgent ?? null
    ]
  );
}

export function auditFromRequest(req: Request, auth?: AuthContext): Pick<AuditInput, 'organizationId' | 'actorMembershipId' | 'actorUserId' | 'ipAddress' | 'userAgent'> {
  return {
    organizationId: auth?.organizationId ?? null,
    actorMembershipId: auth?.membershipId ?? null,
    actorUserId: auth?.userId ?? null,
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null
  };
}
