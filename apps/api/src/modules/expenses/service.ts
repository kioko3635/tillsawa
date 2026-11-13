import { randomUUID } from 'node:crypto';
import type {
  CreateExpenseCategoryInput,
  CreateExpenseInput,
  ExpenseExportQuery,
  ExpenseQuery,
  PayExpenseInput,
  UpdateExpenseCategoryInput,
  UpdateExpenseInput
} from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import type { Queryable } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { listAccessibleBranchIds, membershipHasBranchAccess, type AuthContext } from '../../http/middleware/auth.js';
import { requestPayloadHash } from '../../http/middleware/idempotency.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { decimalToMinorUnits, minorUnitsToDecimal } from '../../shared/money.js';
import { recordAudit } from '../audit/audit.js';

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function ensureBranch(db: Queryable, auth: AuthContext, branchId: string): Promise<void> {
  if (!(await membershipHasBranchAccess(db, auth, branchId))) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
  }
}

async function accessibleBranchIds(db: Queryable, auth: AuthContext): Promise<string[]> {
  const ids = await listAccessibleBranchIds(db, auth);
  if (ids.length === 0) throw forbidden('BRANCH_ACCESS_DENIED', 'No accessible branches');
  return ids;
}

async function nextDocumentNumber(db: Queryable, organizationId: string, key: string, prefix: string): Promise<string> {
  const result = await db.query<{ value: string }>(
    `INSERT INTO document_sequences (organization_id, sequence_key, next_value)
     VALUES ($1, $2, 2)
     ON CONFLICT (organization_id, sequence_key)
     DO UPDATE SET next_value = document_sequences.next_value + 1, updated_at = now()
     RETURNING (next_value - 1)::text AS value`,
    [organizationId, key]
  );
  return `${prefix}-${result.rows[0]!.value.padStart(6, '0')}`;
}

function mapCategory(row: Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapExpense(row: Record<string, unknown>, events: Array<Record<string, unknown>> = [], payments: Array<Record<string, unknown>> = []) {
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    categoryId: row.category_id,
    categoryCode: row.category_code,
    categoryName: row.category_name,
    expenseNumber: row.expense_number,
    clientTransactionId: row.client_transaction_id,
    status: row.status,
    paymentStatus: row.payment_status,
    description: row.description,
    businessPurpose: row.business_purpose,
    expenseDate: row.expense_date,
    amount: minorUnitsToDecimal(String(row.amount_minor)),
    currencyCode: row.currency_code,
    paymentMethod: row.payment_method,
    payeeName: row.payee_name,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name ?? null,
    supportingDocumentRef: row.supporting_document_ref,
    supportingDocumentName: row.supporting_document_name,
    createdByMembershipId: row.created_by_membership_id,
    createdByName: row.created_by_name ?? null,
    submittedByName: row.submitted_by_name ?? null,
    submittedAt: row.submitted_at,
    approvedByName: row.approved_by_name ?? null,
    approvedAt: row.approved_at,
    rejectedByName: row.rejected_by_name ?? null,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    paidByName: row.paid_by_name ?? null,
    paidAt: row.paid_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    events: events.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      amount: event.amount_minor === null || event.amount_minor === undefined ? null : minorUnitsToDecimal(String(event.amount_minor)),
      reason: event.reason,
      actorName: event.actor_name ?? null,
      createdAt: event.created_at
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      paymentNumber: payment.payment_number,
      method: payment.method,
      status: payment.status,
      amount: minorUnitsToDecimal(String(payment.amount_minor)),
      reason: payment.reason,
      paymentReference: payment.payment_reference,
      paidByName: payment.paid_by_name ?? null,
      registerSessionId: payment.register_session_id,
      cashMovementId: payment.cash_movement_id,
      completedAt: payment.completed_at,
      createdAt: payment.created_at
    }))
  };
}

async function lockCategory(db: Queryable, auth: AuthContext, categoryId: string, requireActive = true) {
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM expense_categories
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [categoryId, auth.organizationId]
  );
  const category = result.rows[0];
  if (!category) throw notFound('Expense category was not found');
  if (requireActive && category.status !== 'active') throw conflict('EXPENSE_CATEGORY_INACTIVE', 'An inactive expense category cannot be used');
  return category;
}

async function lockExpense(db: Queryable, auth: AuthContext, expenseId: string) {
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM expenses
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [expenseId, auth.organizationId]
  );
  const expense = result.rows[0];
  if (!expense) throw notFound('Expense was not found');
  await ensureBranch(db, auth, String(expense.branch_id));
  return expense;
}

async function assertSupplier(db: Queryable, auth: AuthContext, supplierId: string | null | undefined): Promise<void> {
  if (!supplierId) return;
  const result = await db.query(
    `SELECT id FROM suppliers
     WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
    [supplierId, auth.organizationId]
  );
  if (!result.rows[0]) throw badRequest('VALIDATION_ERROR', 'Supplier is not active in this organization');
}

async function organizationCurrency(db: Queryable, organizationId: string): Promise<string> {
  const result = await db.query<{ currency_code: string }>(
    'SELECT currency_code FROM organizations WHERE id = $1',
    [organizationId]
  );
  return result.rows[0]!.currency_code;
}

async function recordExpenseEvent(
  db: Queryable,
  auth: AuthContext,
  expense: Record<string, unknown>,
  eventType: string,
  fromStatus: string | null,
  toStatus: string,
  reason: string | null,
  amountMinor?: bigint
): Promise<void> {
  await db.query(
    `INSERT INTO expense_events (
      organization_id, branch_id, expense_id, event_type, from_status, to_status,
      amount_minor, reason, actor_membership_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      auth.organizationId,
      expense.branch_id,
      expense.id,
      eventType,
      fromStatus,
      toStatus,
      amountMinor?.toString() ?? null,
      reason,
      auth.membershipId
    ]
  );
}

export async function listExpenseCategories(pool: pg.Pool, auth: AuthContext) {
  const result = await pool.query(
    `SELECT * FROM expense_categories
     WHERE organization_id = $1
     ORDER BY status = 'inactive', name`,
    [auth.organizationId]
  );
  return { categories: result.rows.map(mapCategory) };
}

export async function createExpenseCategory(pool: pg.Pool, auth: AuthContext, input: CreateExpenseCategoryInput, req: Request) {
  const code = input.code.toUpperCase();
  try {
    const result = await withTransaction(pool, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO expense_categories (organization_id, code, name, description, status, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [auth.organizationId, code, input.name.trim(), input.description ?? null, input.status, auth.membershipId]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'expense.category-created',
        entityType: 'expense_category',
        entityId: inserted.rows[0]!.id,
        metadata: { code, name: input.name },
        ...requestMeta(req)
      });
      return inserted.rows[0]!.id;
    });
    const category = await pool.query('SELECT * FROM expense_categories WHERE id = $1 AND organization_id = $2', [result, auth.organizationId]);
    return mapCategory(category.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('EXPENSE_CATEGORY_EXISTS', 'An expense category with this code or name already exists');
    throw error;
  }
}

export async function updateExpenseCategory(pool: pg.Pool, auth: AuthContext, categoryId: string, input: UpdateExpenseCategoryInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const category = await lockCategory(tx, auth, categoryId, false);
    const fields: string[] = [];
    const values: unknown[] = [categoryId, auth.organizationId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (input.code !== undefined) add('code', input.code.toUpperCase());
    if (input.name !== undefined) add('name', input.name.trim());
    if (input.description !== undefined) add('description', input.description);
    if (input.status !== undefined) add('status', input.status);
    try {
      await tx.query(`UPDATE expense_categories SET ${fields.join(', ')} WHERE id = $1 AND organization_id = $2`, values);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('EXPENSE_CATEGORY_EXISTS', 'An expense category with this code or name already exists');
      throw error;
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'expense.category-updated',
      entityType: 'expense_category',
      entityId: categoryId,
      metadata: { previousStatus: category.status, fields: fields.map((field) => field.split(' ')[0]) },
      ...requestMeta(req)
    });
  });
  const category = await pool.query('SELECT * FROM expense_categories WHERE id = $1 AND organization_id = $2', [categoryId, auth.organizationId]);
  return mapCategory(category.rows[0]!);
}

const expenseSelect = `
  SELECT e.*, b.name AS branch_name, s.name AS supplier_name,
         created.display_name AS created_by_name,
         submitted.display_name AS submitted_by_name,
         approved.display_name AS approved_by_name,
         rejected.display_name AS rejected_by_name,
         paid.display_name AS paid_by_name
  FROM expenses e
  JOIN branches b ON b.id = e.branch_id AND b.organization_id = e.organization_id
  LEFT JOIN suppliers s ON s.id = e.supplier_id AND s.organization_id = e.organization_id
  JOIN memberships cm ON cm.id = e.created_by_membership_id AND cm.organization_id = e.organization_id
  JOIN users created ON created.id = cm.user_id
  LEFT JOIN memberships sm ON sm.id = e.submitted_by_membership_id AND sm.organization_id = e.organization_id
  LEFT JOIN users submitted ON submitted.id = sm.user_id
  LEFT JOIN memberships am ON am.id = e.approved_by_membership_id AND am.organization_id = e.organization_id
  LEFT JOIN users approved ON approved.id = am.user_id
  LEFT JOIN memberships rm ON rm.id = e.rejected_by_membership_id AND rm.organization_id = e.organization_id
  LEFT JOIN users rejected ON rejected.id = rm.user_id
  LEFT JOIN memberships pm ON pm.id = e.paid_by_membership_id AND pm.organization_id = e.organization_id
  LEFT JOIN users paid ON paid.id = pm.user_id
`;

function expenseWhere(auth: AuthContext, branchIds: string[], query: ExpenseQuery | ExpenseExportQuery) {
  const values: unknown[] = [auth.organizationId, branchIds];
  const where = ['e.organization_id = $1', 'e.branch_id = ANY($2::uuid[])'];
  const filters: Array<[keyof ExpenseQuery | keyof ExpenseExportQuery, string]> = [
    ['branchId', 'e.branch_id'],
    ['categoryId', 'e.category_id'],
    ['status', 'e.status'],
    ['paymentStatus', 'e.payment_status'],
    ['paymentMethod', 'e.payment_method'],
    ['supplierId', 'e.supplier_id'],
    ['createdByMembershipId', 'e.created_by_membership_id'],
    ['approvedByMembershipId', 'e.approved_by_membership_id'],
    ['from', 'e.expense_date'],
    ['to', 'e.expense_date']
  ];
  for (const [key, column] of filters) {
    const value = query[key as keyof typeof query] as string | undefined;
    if (!value) continue;
    values.push(value);
    if (key === 'from') where.push(`${column} >= $${values.length}::date`);
    else if (key === 'to') where.push(`${column} <= $${values.length}::date`);
    else where.push(`${column} = $${values.length}`);
  }
  if (query.search) {
    values.push(`%${query.search.trim()}%`);
    where.push(`(
      e.expense_number ILIKE $${values.length} OR e.description ILIKE $${values.length}
      OR e.business_purpose ILIKE $${values.length} OR e.payee_name ILIKE $${values.length}
      OR e.supporting_document_ref ILIKE $${values.length}
    )`);
  }
  return { where, values };
}

export async function listExpenses(pool: pg.Pool, auth: AuthContext, query: ExpenseQuery) {
  if (query.branchId) await ensureBranch(pool, auth, query.branchId);
  const branchIds = query.branchId ? [query.branchId] : await accessibleBranchIds(pool, auth);
  const { where, values } = expenseWhere(auth, branchIds, query);
  const totalResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM expenses e WHERE ${where.join(' AND ')}`,
    values
  );
  values.push(query.pageSize, (query.page - 1) * query.pageSize);
  const result = await pool.query(
    `${expenseSelect}
     WHERE ${where.join(' AND ')}
     ORDER BY e.expense_date DESC, e.created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  return {
    items: result.rows.map((row) => mapExpense(row)),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize))
  };
}

export async function getExpense(pool: pg.Pool, auth: AuthContext, expenseId: string) {
  const result = await pool.query(`${expenseSelect} WHERE e.id = $1 AND e.organization_id = $2`, [expenseId, auth.organizationId]);
  const row = result.rows[0];
  if (!row) throw notFound('Expense was not found');
  await ensureBranch(pool, auth, String(row.branch_id));
  const [events, payments] = await Promise.all([
    pool.query(
      `SELECT ee.*, u.display_name AS actor_name
       FROM expense_events ee
       JOIN memberships m ON m.id = ee.actor_membership_id AND m.organization_id = ee.organization_id
       JOIN users u ON u.id = m.user_id
       WHERE ee.expense_id = $1 AND ee.organization_id = $2
       ORDER BY ee.created_at`,
      [expenseId, auth.organizationId]
    ),
    pool.query(
      `SELECT ep.*, u.display_name AS paid_by_name
       FROM expense_payments ep
       JOIN memberships m ON m.id = ep.paid_by_membership_id AND m.organization_id = ep.organization_id
       JOIN users u ON u.id = m.user_id
       WHERE ep.expense_id = $1 AND ep.organization_id = $2
       ORDER BY ep.created_at DESC`,
      [expenseId, auth.organizationId]
    )
  ]);
  return { expense: mapExpense(row, events.rows, payments.rows) };
}

export async function createExpense(pool: pg.Pool, auth: AuthContext, input: CreateExpenseInput, req: Request) {
  const payloadHash = requestPayloadHash(input);
  const existing = await pool.query<{ id: string; client_payload_hash: string }>(
    'SELECT id, client_payload_hash FROM expenses WHERE organization_id = $1 AND client_transaction_id = $2',
    [auth.organizationId, input.clientTransactionId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0]!.client_payload_hash !== payloadHash) throw conflict('EXPENSE_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different expense');
    return { ...(await getExpense(pool, auth, existing.rows[0]!.id)), replayed: true };
  }
  let expenseId: string;
  try {
    expenseId = await withTransaction(pool, async (tx) => {
      await ensureBranch(tx, auth, input.branchId);
      const currency = await organizationCurrency(tx, auth.organizationId);
      if ((input.currencyCode ?? currency) !== currency) {
        throw badRequest('EXPENSE_CURRENCY_UNSUPPORTED', 'Expenses must use the organization currency until exchange-rate support is added');
      }
      const category = await lockCategory(tx, auth, input.categoryId);
      await assertSupplier(tx, auth, input.supplierId);
      const amount = decimalToMinorUnits(input.amount);
      const expenseNumber = await nextDocumentNumber(tx, auth.organizationId, 'EXPENSE', 'EXP');
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO expenses (
          organization_id, branch_id, category_id, category_code, category_name,
          expense_number, client_transaction_id, client_payload_hash, description,
          business_purpose, expense_date, amount_minor, currency_code, payment_method,
          payee_name, supplier_id, supporting_document_ref, supporting_document_name,
          created_by_membership_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING id`,
        [
          auth.organizationId, input.branchId, input.categoryId, category.code, category.name,
          expenseNumber, input.clientTransactionId, payloadHash, input.description.trim(),
          input.businessPurpose ?? null, input.expenseDate, amount.toString(), currency, input.paymentMethod,
          input.payeeName ?? null, input.supplierId ?? null, input.supportingDocumentRef ?? null,
          input.supportingDocumentName ?? null, auth.membershipId
        ]
      );
      const id = inserted.rows[0]!.id;
      await tx.query(
        `INSERT INTO expense_events (organization_id, branch_id, expense_id, event_type, to_status, amount_minor, actor_membership_id)
         VALUES ($1,$2,$3,'created','draft',$4,$5)`,
        [auth.organizationId, input.branchId, id, amount.toString(), auth.membershipId]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: input.branchId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'expense.created',
        entityType: 'expense',
        entityId: id,
        metadata: { expenseNumber, amount: input.amount, paymentMethod: input.paymentMethod },
        ...requestMeta(req)
      });
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await pool.query<{ id: string; client_payload_hash: string }>(
        'SELECT id, client_payload_hash FROM expenses WHERE organization_id = $1 AND client_transaction_id = $2',
        [auth.organizationId, input.clientTransactionId]
      );
      if (replayed.rows[0]?.client_payload_hash === payloadHash) return { ...(await getExpense(pool, auth, replayed.rows[0]!.id)), replayed: true };
      throw conflict('EXPENSE_IDENTIFIER_CONFLICT', 'The expense number or client transaction identifier conflicts with an existing expense');
    }
    throw error;
  }
  return { ...(await getExpense(pool, auth, expenseId)), replayed: false };
}

export async function updateExpense(pool: pg.Pool, auth: AuthContext, expenseId: string, input: UpdateExpenseInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const expense = await lockExpense(tx, auth, expenseId);
    if (!['draft', 'submitted'].includes(String(expense.status))) {
      throw conflict('EXPENSE_NOT_EDITABLE', 'Only draft or submitted expenses can be adjusted');
    }
    if (expense.status === 'submitted') {
      if (!auth.permissions.has('expense.adjust')) throw forbidden('EXPENSE_ADJUST_DENIED', 'You do not have permission to adjust submitted expenses');
      if (!input.reason) throw badRequest('VALIDATION_ERROR', 'A reason is required when adjusting a submitted expense');
    }
    const fields: string[] = [];
    const values: unknown[] = [expenseId, auth.organizationId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (input.categoryId) {
      const category = await lockCategory(tx, auth, input.categoryId);
      add('category_id', input.categoryId);
      add('category_code', category.code);
      add('category_name', category.name);
    }
    if (input.description !== undefined) add('description', input.description.trim());
    if (input.businessPurpose !== undefined) add('business_purpose', input.businessPurpose);
    if (input.expenseDate !== undefined) add('expense_date', input.expenseDate);
    if (input.amount !== undefined) add('amount_minor', decimalToMinorUnits(input.amount).toString());
    if (input.currencyCode !== undefined) {
      const currency = await organizationCurrency(tx, auth.organizationId);
      if (input.currencyCode !== currency) throw badRequest('EXPENSE_CURRENCY_UNSUPPORTED', 'Expenses must use the organization currency until exchange-rate support is added');
      add('currency_code', input.currencyCode);
    }
    if (input.paymentMethod !== undefined) add('payment_method', input.paymentMethod);
    if (input.payeeName !== undefined) add('payee_name', input.payeeName);
    if (input.supplierId !== undefined) {
      await assertSupplier(tx, auth, input.supplierId);
      add('supplier_id', input.supplierId);
    }
    if (input.supportingDocumentRef !== undefined) add('supporting_document_ref', input.supportingDocumentRef);
    if (input.supportingDocumentName !== undefined) add('supporting_document_name', input.supportingDocumentName);
    await tx.query(`UPDATE expenses SET ${fields.join(', ')} WHERE id = $1 AND organization_id = $2`, values);
    await recordExpenseEvent(tx, auth, expense, 'updated', String(expense.status), String(expense.status), input.reason ?? null, input.amount ? decimalToMinorUnits(input.amount) : undefined);
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: String(expense.branch_id),
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'expense.updated',
      entityType: 'expense',
      entityId: expenseId,
      metadata: { fields: fields.map((field) => field.split(' ')[0]), reason: input.reason ?? null },
      ...requestMeta(req)
    });
  });
  return getExpense(pool, auth, expenseId);
}

async function transitionExpense(
  pool: pg.Pool,
  auth: AuthContext,
  expenseId: string,
  action: 'submit' | 'approve' | 'reject' | 'cancel',
  reason: string | null,
  req: Request
) {
  await withTransaction(pool, async (tx) => {
    const expense = await lockExpense(tx, auth, expenseId);
    const status = String(expense.status);
    if (action === 'submit' && status !== 'draft') throw conflict('EXPENSE_NOT_SUBMITTABLE', 'Only a draft expense can be submitted');
    if (action === 'approve' && status !== 'submitted') throw conflict('EXPENSE_NOT_APPROVABLE', 'Only a submitted expense can be approved');
    if (action === 'reject' && status !== 'submitted') throw conflict('EXPENSE_NOT_REJECTABLE', 'Only a submitted expense can be rejected');
    if (action === 'cancel' && (!['draft', 'submitted', 'approved'].includes(status) || expense.payment_status === 'paid')) {
      throw conflict('EXPENSE_NOT_CANCELLABLE', 'Only an unpaid draft, submitted or approved expense can be cancelled');
    }
    const toStatus = action === 'submit' ? 'submitted' : action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
    const actorColumn = `${toStatus === 'cancelled' ? 'cancelled' : toStatus}_by_membership_id`;
    const timeColumn = `${toStatus === 'cancelled' ? 'cancelled' : toStatus}_at`;
    const reasonColumn = toStatus === 'rejected' ? 'rejection_reason' : toStatus === 'cancelled' ? 'cancellation_reason' : null;
    await tx.query(
      `UPDATE expenses
       SET status = $3,
           payment_status = CASE WHEN $3 = 'cancelled' AND payment_status = 'pending' THEN 'unpaid' ELSE payment_status END,
           ${actorColumn} = $4,
           ${timeColumn} = now()
           ${reasonColumn ? `, ${reasonColumn} = $5` : ''}
       WHERE id = $1 AND organization_id = $2`,
      reasonColumn
        ? [expenseId, auth.organizationId, toStatus, auth.membershipId, reason]
        : [expenseId, auth.organizationId, toStatus, auth.membershipId]
    );
    if (action === 'cancel') {
      await tx.query(
        `UPDATE expense_payments
         SET status = 'cancelled'
         WHERE expense_id = $1 AND organization_id = $2 AND status = 'pending'`,
        [expenseId, auth.organizationId]
      );
    }
    await recordExpenseEvent(tx, auth, expense, `${toStatus === 'cancelled' ? 'cancelled' : toStatus}`, status, toStatus, reason);
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: String(expense.branch_id),
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: `expense.${toStatus === 'submitted' ? 'submitted' : toStatus === 'approved' ? 'approved' : toStatus === 'rejected' ? 'rejected' : 'cancelled'}`,
      entityType: 'expense',
      entityId: expenseId,
      metadata: { expenseNumber: expense.expense_number, fromStatus: status, toStatus, reason },
      ...requestMeta(req)
    });
  });
  return getExpense(pool, auth, expenseId);
}

export function submitExpense(pool: pg.Pool, auth: AuthContext, expenseId: string, req: Request) {
  return transitionExpense(pool, auth, expenseId, 'submit', null, req);
}

export function decideExpense(pool: pg.Pool, auth: AuthContext, expenseId: string, action: 'approve' | 'reject' | 'cancel', reason: string, req: Request) {
  return transitionExpense(pool, auth, expenseId, action, reason, req);
}

export async function payExpense(pool: pg.Pool, auth: AuthContext, expenseId: string, input: PayExpenseInput, req: Request) {
  const payloadHash = requestPayloadHash({ expenseId, ...input });
  const existing = await pool.query<{ id: string; client_payload_hash: string; expense_id: string }>(
    'SELECT id, expense_id, client_payload_hash FROM expense_payments WHERE organization_id = $1 AND client_transaction_id = $2',
    [auth.organizationId, input.clientTransactionId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0]!.expense_id !== expenseId || existing.rows[0]!.client_payload_hash !== payloadHash) {
      throw conflict('EXPENSE_PAYMENT_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different expense payment');
    }
    return { ...(await getExpense(pool, auth, expenseId)), replayed: true };
  }
  try {
    await withTransaction(pool, async (tx) => {
      const expense = await lockExpense(tx, auth, expenseId);
      if (expense.status !== 'approved') throw conflict('EXPENSE_NOT_PAYABLE', 'Only an approved unpaid expense can be paid');
      if (expense.payment_status !== 'unpaid') throw conflict('EXPENSE_PAYMENT_EXISTS', 'This expense already has a payment request');
      const amount = BigInt(String(expense.amount_minor));
      const method = String(expense.payment_method);
      const paymentNumber = await nextDocumentNumber(tx, auth.organizationId, 'EXPENSE-PAYMENT', 'EXP-PAY');
      let registerSessionId: string | null = null;
      if (method === 'cash') {
        if (!input.registerSessionId) throw badRequest('VALIDATION_ERROR', 'An open register session is required for a cash expense');
        const session = await tx.query<{ id: string; branch_id: string; status: string; opened_by_membership_id: string }>(
          `SELECT id, branch_id, status, opened_by_membership_id
           FROM register_sessions
           WHERE id = $1 AND organization_id = $2
           FOR UPDATE`,
          [input.registerSessionId, auth.organizationId]
        );
        const registerSession = session.rows[0];
        if (!registerSession) throw notFound('Register session was not found');
        if (registerSession.branch_id !== expense.branch_id) throw badRequest('VALIDATION_ERROR', 'Cash expenses must be paid from a register in the same branch');
        await ensureBranch(tx, auth, registerSession.branch_id);
        if (registerSession.status !== 'open') throw conflict('REGISTER_SESSION_CLOSED', 'Expense payments require an open register session');
        if (registerSession.opened_by_membership_id !== auth.membershipId && !auth.permissions.has('registers.manage')) {
          throw forbidden('SESSION_ACCESS_DENIED', 'You can only pay expenses from your own open drawer');
        }
        registerSessionId = registerSession.id;
      } else {
        if (input.registerSessionId) throw badRequest('VALIDATION_ERROR', 'A register session is only valid for cash expense payments');
        if (!input.paymentReference) throw badRequest('VALIDATION_ERROR', 'A payment reference is required for a pending non-cash expense payment');
      }
      const paymentId = randomUUID();
      let cashMovementId: string | null = null;
      if (method === 'cash') {
        const movement = await tx.query<{ id: string }>(
          `INSERT INTO cash_movements (
            organization_id, branch_id, register_session_id, movement_type, direction,
            amount_minor, reason, reference_type, reference_id, actor_membership_id
          ) VALUES ($1,$2,$3,'expense_payment','out',$4,$5,'expense_payment',$6,$7)
          RETURNING id`,
          [auth.organizationId, expense.branch_id, registerSessionId, amount.toString(), `Expense ${expense.expense_number}: ${input.reason}`, paymentId, auth.membershipId]
        );
        cashMovementId = movement.rows[0]!.id;
      }
      await tx.query(
        `INSERT INTO expense_payments (
          id, organization_id, branch_id, expense_id, register_session_id, cash_movement_id,
          payment_number, client_transaction_id, client_payload_hash, method, status,
          amount_minor, reason, payment_reference, paid_by_membership_id, completed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          paymentId, auth.organizationId, expense.branch_id, expenseId, registerSessionId, cashMovementId,
          paymentNumber, input.clientTransactionId, payloadHash, method, method === 'cash' ? 'completed' : 'pending',
          amount.toString(), input.reason, input.paymentReference ?? null, auth.membershipId,
          method === 'cash' ? new Date() : null
        ]
      );
      if (method === 'cash') {
        await tx.query(
          `UPDATE expenses
           SET status = 'paid', payment_status = 'paid', paid_by_membership_id = $3, paid_at = now()
           WHERE id = $1 AND organization_id = $2`,
          [expenseId, auth.organizationId, auth.membershipId]
        );
      } else {
        await tx.query(
          `UPDATE expenses SET payment_status = 'pending'
           WHERE id = $1 AND organization_id = $2`,
          [expenseId, auth.organizationId]
        );
      }
      await recordExpenseEvent(tx, auth, expense, 'payment_recorded', String(expense.status), method === 'cash' ? 'paid' : 'approved', input.reason, amount);
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: String(expense.branch_id),
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: method === 'cash' ? 'expense.paid' : 'expense.payment-pending',
        entityType: 'expense_payment',
        entityId: paymentId,
        metadata: { expenseId, expenseNumber: expense.expense_number, paymentNumber, method, amount: minorUnitsToDecimal(amount), reference: input.paymentReference ?? null },
        ...requestMeta(req)
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await pool.query<{ id: string; client_payload_hash: string; expense_id: string }>(
        'SELECT id, expense_id, client_payload_hash FROM expense_payments WHERE organization_id = $1 AND client_transaction_id = $2',
        [auth.organizationId, input.clientTransactionId]
      );
      if (replayed.rows[0]?.expense_id === expenseId && replayed.rows[0]!.client_payload_hash === payloadHash) {
        return { ...(await getExpense(pool, auth, expenseId)), replayed: true };
      }
      throw conflict('EXPENSE_PAYMENT_IDENTIFIER_CONFLICT', 'The expense payment number or client transaction identifier conflicts with an existing payment');
    }
    throw error;
  }
  return { ...(await getExpense(pool, auth, expenseId)), replayed: false };
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportExpensesCsv(pool: pg.Pool, auth: AuthContext, query: ExpenseExportQuery) {
  if (query.branchId) await ensureBranch(pool, auth, query.branchId);
  const branchIds = query.branchId ? [query.branchId] : await accessibleBranchIds(pool, auth);
  const { where, values } = expenseWhere(auth, branchIds, query);
  const result = await pool.query(
    `${expenseSelect}
     WHERE ${where.join(' AND ')}
     ORDER BY e.expense_date DESC, e.created_at DESC
     LIMIT 10000`,
    values
  );
  const rows = result.rows.map((row) => mapExpense(row));
  const lines = [
    ['Expense number', 'Date', 'Branch', 'Category', 'Status', 'Payment status', 'Method', 'Amount', 'Currency', 'Description', 'Payee', 'Supplier', 'Reference', 'Created by', 'Approved by', 'Paid at'].map(csvCell).join(','),
    ...rows.map((expense) => [
      expense.expenseNumber,
      expense.expenseDate,
      expense.branchName,
      expense.categoryName,
      expense.status,
      expense.paymentStatus,
      expense.paymentMethod,
      expense.amount,
      expense.currencyCode,
      expense.description,
      expense.payeeName,
      expense.supplierName,
      expense.supportingDocumentRef,
      expense.createdByName,
      expense.approvedByName,
      expense.paidAt
    ].map(csvCell).join(','))
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}
