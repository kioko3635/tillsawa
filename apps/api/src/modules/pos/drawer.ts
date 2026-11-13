import type pg from 'pg';
import type { Request } from 'express';
import type { AuthContext } from '../../http/middleware/auth.js';
import { withTransaction } from '../../database/pool.js';
import { forbidden, conflict } from '../../shared/errors.js';
import { recordAudit } from '../audit/audit.js';

export async function claimSaleDrawer(pool: pg.Pool, auth: AuthContext, saleId: string, terminalId: string, req: Request) {
  if (!auth.enabledCapabilities.has('cash_drawer')) throw forbidden('DRAWER_DISABLED', 'The cash drawer module is disabled for this shop.');
  return withTransaction(pool, async db => {
    const result = await db.query(`SELECT s.status,s.cashier_membership_id,s.sold_at,s.receipt_number,p.method,p.status AS payment_status,p.verification,p.amount_minor AS amount,
      COALESCE(op.cash_drawer_policy,'cash') AS policy FROM sales s JOIN sale_payments p ON p.sale_id=s.id AND p.organization_id=s.organization_id
      LEFT JOIN organization_profiles op ON op.organization_id=s.organization_id WHERE s.id=$1 AND s.organization_id=$2 FOR UPDATE OF s`, [saleId, auth.organizationId]);
    const sale = result.rows[0];
    if (!sale || sale.cashier_membership_id !== auth.membershipId) throw forbidden('DRAWER_SALE_ACCESS', 'The drawer can open only for the current cashier\'s confirmed sale.');
    if (sale.status !== 'completed' || sale.payment_status !== 'completed' || Number(sale.amount) <= 0 || Date.now() - new Date(sale.sold_at).getTime() > 300000 || !['cash', 'mpesa', 'card'].includes(sale.method) || (sale.method !== 'cash' && (sale.policy !== 'paid' || sale.verification !== 'manual'))) throw conflict('DRAWER_SALE_INELIGIBLE', 'This sale is unpaid, too old, reversed, simulated, or outside the selected drawer payment policy.');
    const claim = await db.query('INSERT INTO drawer_sale_claims(sale_id,organization_id,terminal_id,membership_id) VALUES($1,$2,$3,$4) ON CONFLICT(sale_id) DO NOTHING RETURNING sale_id', [saleId, auth.organizationId, terminalId, auth.membershipId]);
    if (!claim.rows.length) return { allowed: false, reason: 'already_requested', receiptNumber: sale.receipt_number };
    await recordAudit(db, { organizationId: auth.organizationId, actorMembershipId: auth.membershipId, actorUserId: auth.userId, action: 'pos.drawer-requested', entityType: 'sale', entityId: saleId, metadata: { terminalId, method: sale.method }, ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null });
    return { allowed: true, receiptNumber: sale.receipt_number };
  });
}
