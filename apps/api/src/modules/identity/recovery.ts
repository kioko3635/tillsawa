import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Request } from 'express';
import type { AppConfig } from '../../config/env.js';
import { membershipWithinBranchScope, type AuthContext } from '../../http/middleware/auth.js';
import { withTransaction, type Queryable } from '../../database/pool.js';
import { forbidden, unauthorized } from '../../shared/errors.js';
import { recordAudit } from '../audit/audit.js';
import { hashOpaqueToken, hashPassword, verifyPassword } from './security.js';

const digest = (code: string, config: AppConfig) => hashOpaqueToken('recovery:' + code.replace(/[\s-]/g, '').toUpperCase(), config);
const metadata = (req: Request) => ({ ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null });
async function requireCurrentPassword(db: Queryable, userId: string, password: string) {
  const result = await db.query('SELECT password_hash FROM users WHERE id=$1 AND status=\'active\' FOR UPDATE', [userId]);
  if (!result.rows[0] || !await verifyPassword(password, result.rows[0].password_hash)) throw unauthorized('PASSWORD_INVALID', 'Your current password is incorrect.');
}
export async function revokeUserSessions(db: Queryable, userId: string) {
  await db.query(`UPDATE auth_sessions SET status='revoked',revoked_at=now(),revoked_reason='password_reset' WHERE membership_id IN (SELECT id FROM memberships WHERE user_id=$1)`, [userId]);
  await db.query(`UPDATE refresh_tokens SET revoked_at=now() WHERE session_id IN (SELECT s.id FROM auth_sessions s JOIN memberships m ON m.id=s.membership_id WHERE m.user_id=$1)`, [userId]);
  await db.query(`UPDATE password_reset_tokens SET used_at=now() WHERE membership_id IN (SELECT id FROM memberships WHERE user_id=$1) AND used_at IS NULL`, [userId]);
}
export async function recoveryStatus(pool: pg.Pool, auth: AuthContext) {
  const result = await pool.query('SELECT count(*) FILTER (WHERE used_at IS NULL)::int AS remaining,max(created_at) AS generated_at FROM account_recovery_codes WHERE user_id=$1', [auth.userId]);
  return { remaining: result.rows[0].remaining as number, generatedAt: result.rows[0].generated_at };
}
export async function generateRecoveryCodes(pool: pg.Pool, config: AppConfig, auth: AuthContext, password: string, req: Request) {
  return withTransaction(pool, async db => {
    await requireCurrentPassword(db, auth.userId, password);
    await db.query('UPDATE account_recovery_codes SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [auth.userId]);
    const codes = Array.from({ length: 8 }, () => randomBytes(20).toString('hex').toUpperCase().match(/.{1,8}/g)!.join('-'));
    for (const code of codes) await db.query('INSERT INTO account_recovery_codes(user_id,token_hash) VALUES($1,$2)', [auth.userId, digest(code, config)]);
    await recordAudit(db, { organizationId: auth.organizationId, actorMembershipId: auth.membershipId, actorUserId: auth.userId, action: 'auth.recovery-codes-generated', entityType: 'membership', entityId: auth.membershipId, ...metadata(req) });
    return { codes };
  });
}
export async function recoverAccount(pool: pg.Pool, config: AppConfig, input: { email: string; code: string; password: string }, req: Request) {
  await withTransaction(pool, async db => {
    const user = (await db.query('SELECT id FROM users WHERE email=$1 AND status=\'active\' FOR UPDATE', [input.email])).rows[0];
    const invalid = () => unauthorized('RECOVERY_INVALID', 'The email or recovery code is invalid or has already been used.');
    if (!user) throw invalid();
    const code = (await db.query('UPDATE account_recovery_codes SET used_at=now() WHERE user_id=$1 AND token_hash=$2 AND used_at IS NULL RETURNING id', [user.id, digest(input.code, config)])).rows[0];
    if (!code) throw invalid();
    await db.query('UPDATE users SET password_hash=$1,password_changed_at=now() WHERE id=$2', [await hashPassword(input.password, config), user.id]);
    await revokeUserSessions(db, user.id);
    const memberships = await db.query('SELECT id,organization_id FROM memberships WHERE user_id=$1', [user.id]);
    for (const member of memberships.rows) await recordAudit(db, { organizationId: member.organization_id, actorMembershipId: member.id, actorUserId: user.id, action: 'auth.recovery-code-used', entityType: 'membership', entityId: member.id, ...metadata(req) });
  });
}
export async function ownerResetStaff(pool: pg.Pool, config: AppConfig, auth: AuthContext, input: { membershipId: string; currentPassword: string; password: string }, req: Request) {
  await withTransaction(pool, async db => {
    await requireCurrentPassword(db, auth.userId, input.currentPassword);
    const owner = await db.query(`SELECT 1 FROM membership_roles mr JOIN roles r ON r.id=mr.role_id AND r.organization_id=mr.organization_id WHERE mr.membership_id=$1 AND mr.organization_id=$2 AND r.code='owner' AND r.is_system`, [auth.membershipId, auth.organizationId]);
    if (!owner.rows.length) throw forbidden('OWNER_REQUIRED', 'Only a shop owner can reset staff passwords.');
    if (!await membershipWithinBranchScope(db, auth, input.membershipId)) throw forbidden('STAFF_RESET_DENIED', 'This staff account is outside your branch access.');
    const target = (await db.query(`SELECT m.user_id,EXISTS(SELECT 1 FROM membership_roles mr JOIN roles r ON r.id=mr.role_id AND r.organization_id=mr.organization_id WHERE mr.membership_id=m.id AND r.code='owner' AND r.is_system) AS owner FROM memberships m WHERE m.id=$1 AND m.organization_id=$2 AND m.status='active'`, [input.membershipId, auth.organizationId])).rows[0];
    if (!target || target.owner || target.user_id === auth.userId) throw forbidden('STAFF_RESET_DENIED', 'Choose an active staff account in this shop. Owners recover their own accounts with recovery codes.');
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [target.user_id]);
    const count = await db.query('SELECT count(*)::int AS total FROM memberships WHERE user_id=$1', [target.user_id]);
    if (count.rows[0].total !== 1) throw forbidden('PERSONAL_RECOVERY_REQUIRED', 'This account is shared across businesses. Its user must use personal recovery codes.');
    await db.query('UPDATE users SET password_hash=$1,password_changed_at=now() WHERE id=$2', [await hashPassword(input.password, config), target.user_id]);
    await revokeUserSessions(db, target.user_id);
    await db.query('UPDATE account_recovery_codes SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [target.user_id]);
    await recordAudit(db, { organizationId: auth.organizationId, actorMembershipId: auth.membershipId, actorUserId: auth.userId, action: 'auth.owner-reset-staff-password', entityType: 'membership', entityId: input.membershipId, ...metadata(req) });
  });
}
