import type { CreateCustomerInput, UpdateCustomerInput } from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import { withTransaction } from '../../database/pool.js';
import type { AuthContext } from '../../http/middleware/auth.js';
import { listAccessibleBranchIds } from '../../http/middleware/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { decimalToMinorUnits, minorUnitsToDecimal } from '../../shared/money.js';
import { recordAudit } from '../audit/audit.js';

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function mapCustomer(row: Record<string, unknown>) {
  const balance = row.outstanding_balance_minor === undefined || row.outstanding_balance_minor === null ? 0n : BigInt(String(row.outstanding_balance_minor));
  const limit = BigInt(String(row.credit_limit_minor ?? 0));
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    taxPin: row.tax_pin,
    notes: row.notes,
    status: row.status,
    creditStatus: row.credit_status,
    creditLimit: row.credit_limit_minor === undefined ? '0' : minorUnitsToDecimal(String(row.credit_limit_minor)),
    paymentTermsDays: row.payment_terms_days,
    creditReason: row.credit_reason,
    outstandingBalance: row.outstanding_balance_minor === undefined ? '0' : minorUnitsToDecimal(balance),
    availableCredit: row.outstanding_balance_minor === undefined ? undefined : minorUnitsToDecimal(limit - balance),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listCustomers(pool: pg.Pool, auth: AuthContext, query: { search?: string | undefined; status?: string | undefined; creditStatus?: string | undefined } = {}) {
  const branchIds = await listAccessibleBranchIds(pool, auth);
  const values: unknown[] = [auth.organizationId, branchIds];
  const where = ['c.organization_id = $1'];
  if (query.search) {
    values.push(`%${query.search}%`);
    where.push(`(c.name ILIKE $${values.length} OR c.code ILIKE $${values.length} OR COALESCE(c.phone, '') ILIKE $${values.length} OR COALESCE(c.email::text, '') ILIKE $${values.length})`);
  }
  if (query.status) {
    values.push(query.status);
    where.push(`c.status = $${values.length}`);
  }
  if (query.creditStatus) {
    values.push(query.creditStatus);
    where.push(`c.credit_status = $${values.length}`);
  }
  const result = await pool.query(
    `SELECT c.*, COALESCE(SUM(CASE WHEN ct.direction = 'debit' THEN ct.amount_minor ELSE -ct.amount_minor END), 0)::bigint AS outstanding_balance_minor
     FROM customers c
     LEFT JOIN customer_credit_transactions ct
       ON ct.customer_id = c.id AND ct.organization_id = c.organization_id AND ct.branch_id = ANY($2::uuid[])
     WHERE ${where.join(' AND ')}
     GROUP BY c.id
     ORDER BY c.name`,
    values
  );
  return result.rows.map(mapCustomer);
}

export async function createCustomer(pool: pg.Pool, auth: AuthContext, input: CreateCustomerInput, req: Request) {
  return withTransaction(pool, async (tx) => {
    try {
      const result = await tx.query(
        `INSERT INTO customers (
          organization_id, code, name, contact_person, phone, email, address, tax_pin, notes,
          status, credit_status, credit_limit_minor, payment_terms_days, credit_reason
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [
          auth.organizationId,
          input.code.toUpperCase(),
          input.name.trim(),
          input.contactPerson ?? null,
          input.phone ?? null,
          input.email ?? null,
          input.address ?? null,
          input.taxPin ?? null,
          input.notes ?? null,
          input.status,
          'disabled',
          '0',
          0,
          null
        ]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'customer.created',
        entityType: 'customer',
        entityId: result.rows[0]!.id,
        metadata: { code: input.code, name: input.name },
        ...requestMeta(req)
      });
      return mapCustomer(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('CUSTOMER_CODE_TAKEN', 'A customer with this code already exists');
      throw error;
    }
  });
}

export async function updateCustomer(pool: pg.Pool, auth: AuthContext, customerId: string, input: UpdateCustomerInput, req: Request) {
  const changesCredit = input.creditStatus !== undefined || input.creditLimit !== undefined || input.paymentTermsDays !== undefined;
  if (changesCredit && !auth.permissions.has('credit.manage')) {
    throw forbidden('CREDIT_MANAGE_DENIED', 'You do not have permission to change customer credit settings');
  }
  if (changesCredit && !input.creditReason) {
    throw badRequest('CREDIT_REASON_REQUIRED', 'A reason is required when changing customer credit settings');
  }
  const fields: Record<string, string> = {
    code: 'code',
    name: 'name',
    contactPerson: 'contact_person',
    phone: 'phone',
    email: 'email',
    address: 'address',
    taxPin: 'tax_pin',
    notes: 'notes',
    status: 'status',
    creditStatus: 'credit_status',
    paymentTermsDays: 'payment_terms_days'
  };
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(fields)) {
    const value = input[key as keyof UpdateCustomerInput];
    if (value === undefined) continue;
    values.push(key === 'code' ? String(value).toUpperCase() : value);
    updates.push(`${column} = $${values.length + 2}`);
  }
  if (input.creditLimit !== undefined) {
    values.push(decimalToMinorUnits(input.creditLimit));
    updates.push(`credit_limit_minor = $${values.length + 2}`);
  }
  if (changesCredit) {
    values.push(input.creditReason!, auth.membershipId);
    updates.push(
      `credit_reason = $${values.length - 1 + 2}`,
      `credit_updated_by_membership_id = $${values.length + 2}`,
      'credit_updated_at = now()'
    );
  }
  if (updates.length === 0) throw badRequest('CUSTOMER_UPDATE_EMPTY', 'At least one customer field must be provided');
  try {
    return await withTransaction(pool, async (tx) => {
      const existing = await tx.query('SELECT id FROM customers WHERE id = $1 AND organization_id = $2 FOR UPDATE', [customerId, auth.organizationId]);
      if (!existing.rows[0]) throw notFound('Customer was not found');
      const result = await tx.query(
        `UPDATE customers SET ${updates.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [customerId, auth.organizationId, ...values]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'customer.updated',
        entityType: 'customer',
        entityId: customerId,
        metadata: input as Record<string, unknown>,
        ...requestMeta(req)
      });
      return mapCustomer(result.rows[0]!);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('CUSTOMER_CODE_TAKEN', 'A customer with this code already exists');
    throw error;
  }
}
