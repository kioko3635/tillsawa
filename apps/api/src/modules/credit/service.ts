import type {
  CreateCustomerCreditAdjustmentInput,
  RecordCustomerPaymentInput,
  UpdateCustomerCreditInput
} from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import type { Queryable } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { listAccessibleBranchIds, membershipHasBranchAccess } from '../../http/middleware/auth.js';
import type { AuthContext } from '../../http/middleware/auth.js';
import { requestPayloadHash } from '../../http/middleware/idempotency.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { decimalToMinorUnits, minorUnitsToDecimal } from '../../shared/money.js';
import { recordAudit } from '../audit/audit.js';

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

async function ensureBranch(db: Queryable, auth: AuthContext, branchId: string): Promise<void> {
  if (!(await membershipHasBranchAccess(db, auth, branchId))) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
  }
}

function mapCustomerAccount(row: Record<string, unknown>) {
  const balance = BigInt(String(row.outstanding_balance_minor ?? 0));
  const limit = BigInt(String(row.credit_limit_minor ?? 0));
  return {
    customerId: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    creditStatus: row.credit_status,
    creditLimit: minorUnitsToDecimal(limit),
    paymentTermsDays: row.payment_terms_days,
    creditReason: row.credit_reason,
    outstandingBalance: minorUnitsToDecimal(balance),
    availableCredit: minorUnitsToDecimal(limit - balance),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTransaction(row: Record<string, unknown>) {
  return {
    id: row.id,
    branchId: row.branch_id,
    transactionType: row.transaction_type,
    direction: row.direction,
    amount: minorUnitsToDecimal(String(row.amount_minor)),
    saleId: row.sale_id,
    receiptNumber: row.receipt_number ?? null,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    dueDate: row.due_date,
    reason: row.reason,
    actorName: row.actor_name ?? null,
    createdAt: row.created_at
  };
}

function mapOutstandingSale(row: Record<string, unknown>) {
  const total = BigInt(String(row.amount_minor));
  const allocated = BigInt(String(row.allocated_minor ?? 0));
  const remaining = total - allocated;
  return {
    saleId: row.sale_id,
    branchId: row.branch_id,
    branchName: row.branch_name,
    receiptNumber: row.receipt_number,
    soldAt: row.sold_at,
    dueDate: row.credit_due_date,
    total: minorUnitsToDecimal(total),
    allocated: minorUnitsToDecimal(allocated),
    outstanding: minorUnitsToDecimal(remaining),
    overdue: Boolean(row.credit_due_date && String(row.credit_due_date) < new Date().toISOString().slice(0, 10) && remaining > 0n)
  };
}

interface LockedCustomer {
  id: string;
  code: string;
  name: string;
  status: string;
  credit_status: string;
  credit_limit_minor: string;
  payment_terms_days: number;
  outstanding_balance_minor: string;
}

async function lockCustomer(db: Queryable, auth: AuthContext, customerId: string): Promise<LockedCustomer> {
  const result = await db.query<Omit<LockedCustomer, 'outstanding_balance_minor'>>(
    `SELECT * FROM customers
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [customerId, auth.organizationId]
  );
  const customer = result.rows[0];
  if (!customer) throw notFound('Customer was not found');
  const balance = await db.query<{ balance: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)::text AS balance
     FROM customer_credit_transactions
     WHERE customer_id = $1 AND organization_id = $2`,
    [customerId, auth.organizationId]
  );
  return { ...customer, outstanding_balance_minor: balance.rows[0]!.balance };
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

async function salePaymentStatus(db: Queryable, organizationId: string, saleId: string): Promise<string> {
  const result = await db.query<{ amount_minor: string; allocated: string }>(
    `SELECT sp.amount_minor::text, COALESCE(SUM(a.amount_minor),0)::text AS allocated
     FROM sale_payments sp
     LEFT JOIN customer_credit_allocations a ON a.sale_id = sp.sale_id AND a.organization_id = sp.organization_id
     WHERE sp.sale_id = $1 AND sp.organization_id = $2
     GROUP BY sp.id`,
    [saleId, organizationId]
  );
  const row = result.rows[0];
  if (!row) return 'outstanding';
  const remaining = BigInt(row.amount_minor) - BigInt(row.allocated);
  return remaining <= 0n ? 'paid' : BigInt(row.allocated) === 0n ? 'outstanding' : 'partially_paid';
}

async function updateSalePaymentStatus(db: Queryable, organizationId: string, saleId: string): Promise<void> {
  await db.query(
    `UPDATE sale_payments SET status = $3
     WHERE sale_id = $1 AND organization_id = $2 AND method = 'credit'`,
    [saleId, organizationId, await salePaymentStatus(db, organizationId, saleId)]
  );
}

async function validateCreditAllocations(
  db: Queryable,
  auth: AuthContext,
  customerId: string,
  branchId: string,
  allocations: Array<{ saleId: string; amount: string }>,
  maximumMinor: bigint
): Promise<Array<{ saleId: string; amountMinor: bigint; remainingMinor: bigint }>> {
  const requested = allocations.map((line) => ({ saleId: line.saleId, amountMinor: decimalToMinorUnits(line.amount), remainingMinor: 0n }));
  const total = requested.reduce((sum, line) => sum + line.amountMinor, 0n);
  if (total > maximumMinor) throw conflict('ALLOCATION_EXCEEDS_CREDIT', 'Allocations exceed the posted credit amount');
  for (const line of requested) {
    const result = await db.query<{ id: string; branch_id: string; amount_minor: string }>(
      `SELECT sp.id, s.branch_id, sp.amount_minor::text
       FROM sales s
       JOIN sale_payments sp ON sp.sale_id = s.id AND sp.organization_id = s.organization_id
       WHERE s.id = $1 AND s.organization_id = $2 AND s.customer_id = $3
         AND s.branch_id = $4 AND sp.method = 'credit' AND s.status <> 'voided'
       FOR UPDATE OF s, sp`,
      [line.saleId, auth.organizationId, customerId, branchId]
    );
    const sale = result.rows[0];
    if (!sale) throw badRequest('VALIDATION_ERROR', 'An allocation does not reference an eligible credit sale in this branch');
    const allocated = await db.query<{ allocated: string }>(
      `SELECT COALESCE(SUM(amount_minor),0)::text AS allocated
       FROM customer_credit_allocations
       WHERE sale_id = $1 AND organization_id = $2`,
      [line.saleId, auth.organizationId]
    );
    line.remainingMinor = BigInt(sale.amount_minor) - BigInt(allocated.rows[0]!.allocated);
    if (line.amountMinor > line.remainingMinor) {
      throw conflict('OVER_ALLOCATION', 'A payment allocation exceeds the sale outstanding balance');
    }
  }
  return requested;
}

export async function getCreditAccount(pool: pg.Pool, auth: AuthContext, customerId: string) {
  const branchIds = await listAccessibleBranchIds(pool, auth);
  const customer = await pool.query(
    `SELECT c.*, COALESCE(SUM(CASE WHEN ct.direction = 'debit' THEN ct.amount_minor ELSE -ct.amount_minor END), 0)::bigint AS outstanding_balance_minor
     FROM customers c
     LEFT JOIN customer_credit_transactions ct
       ON ct.customer_id = c.id AND ct.organization_id = c.organization_id AND ct.branch_id = ANY($3::uuid[])
     WHERE c.id = $1 AND c.organization_id = $2
     GROUP BY c.id`,
    [customerId, auth.organizationId, branchIds]
  );
  if (!customer.rows[0]) throw notFound('Customer was not found');
  const transactions = await pool.query(
    `SELECT ct.*, s.receipt_number, u.display_name AS actor_name
     FROM customer_credit_transactions ct
     LEFT JOIN sales s ON s.id = ct.sale_id AND s.organization_id = ct.organization_id
     JOIN memberships m ON m.id = ct.actor_membership_id AND m.organization_id = ct.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE ct.customer_id = $1 AND ct.organization_id = $2 AND ct.branch_id = ANY($3::uuid[])
     ORDER BY ct.created_at DESC
     LIMIT 200`,
    [customerId, auth.organizationId, branchIds]
  );
  const outstanding = await pool.query(
    `SELECT s.id AS sale_id, s.branch_id, b.name AS branch_name, s.receipt_number, s.sold_at, s.credit_due_date,
            sp.amount_minor::text, COALESCE(SUM(a.amount_minor),0)::text AS allocated_minor
     FROM sales s
     JOIN branches b ON b.id = s.branch_id AND b.organization_id = s.organization_id
     JOIN sale_payments sp ON sp.sale_id = s.id AND sp.organization_id = s.organization_id
     LEFT JOIN customer_credit_allocations a ON a.sale_id = s.id AND a.organization_id = s.organization_id
     WHERE s.organization_id = $1 AND s.customer_id = $2 AND s.branch_id = ANY($3::uuid[])
       AND sp.method = 'credit' AND s.status <> 'voided'
     GROUP BY s.id, b.name, sp.amount_minor
     HAVING sp.amount_minor > COALESCE(SUM(a.amount_minor),0)
     ORDER BY s.credit_due_date NULLS LAST, s.sold_at`,
    [auth.organizationId, customerId, branchIds]
  );
  return { account: mapCustomerAccount(customer.rows[0]!), transactions: transactions.rows.map(mapTransaction), outstandingSales: outstanding.rows.map(mapOutstandingSale) };
}

export async function updateCreditAccount(pool: pg.Pool, auth: AuthContext, customerId: string, input: UpdateCustomerCreditInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const customer = await lockCustomer(tx, auth, customerId);
    const updates: string[] = [];
    const values: unknown[] = [];
    if (input.creditStatus !== undefined) {
      values.push(input.creditStatus);
      updates.push(`credit_status = $${values.length + 2}`);
    }
    if (input.creditLimit !== undefined) {
      values.push(decimalToMinorUnits(input.creditLimit));
      updates.push(`credit_limit_minor = $${values.length + 2}`);
    }
    if (input.paymentTermsDays !== undefined) {
      values.push(input.paymentTermsDays);
      updates.push(`payment_terms_days = $${values.length + 2}`);
    }
    values.push(input.reason, auth.membershipId);
    updates.push(`credit_reason = $${values.length - 1 + 2}`, `credit_updated_by_membership_id = $${values.length + 2}`, 'credit_updated_at = now()');
    await tx.query(
      `UPDATE customers SET ${updates.join(', ')} WHERE id = $1 AND organization_id = $2`,
      [customerId, auth.organizationId, ...values]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'credit.account-updated',
      entityType: 'customer',
      entityId: customerId,
      metadata: { customerCode: customer.code, input },
      ...requestMeta(req)
    });
  });
  return (await getCreditAccount(pool, auth, customerId)).account;
}

export async function getCustomerPayment(pool: pg.Pool, auth: AuthContext, paymentId: string) {
  const result = await pool.query(
    `SELECT cp.*, u.display_name AS received_by_name
     FROM customer_payments cp
     JOIN memberships m ON m.id = cp.received_by_membership_id AND m.organization_id = cp.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE cp.id = $1 AND cp.organization_id = $2`,
    [paymentId, auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw notFound('Customer payment was not found');
  await ensureBranch(pool, auth, row.branch_id);
  const allocations = await pool.query(
    `SELECT a.*, s.receipt_number
     FROM customer_credit_allocations a
     JOIN sales s ON s.id = a.sale_id AND s.organization_id = a.organization_id
     WHERE a.customer_payment_id = $1 AND a.organization_id = $2`,
    [paymentId, auth.organizationId]
  );
  return {
    id: row.id,
    customerId: row.customer_id,
    branchId: row.branch_id,
    registerSessionId: row.register_session_id,
    paymentNumber: row.payment_number,
    clientTransactionId: row.client_transaction_id,
    method: row.method,
    amount: minorUnitsToDecimal(String(row.amount_minor)),
    status: row.status,
    reason: row.reason,
    receivedByName: row.received_by_name,
    createdAt: row.created_at,
    allocations: allocations.rows.map((line) => ({
      id: line.id,
      saleId: line.sale_id,
      receiptNumber: line.receipt_number,
      amount: minorUnitsToDecimal(String(line.amount_minor)),
      createdAt: line.created_at
    }))
  };
}

export async function recordCustomerPayment(pool: pg.Pool, auth: AuthContext, customerId: string, input: RecordCustomerPaymentInput, req: Request) {
  const payloadHash = requestPayloadHash({ customerId, ...input });
  const existing = await pool.query<{ id: string; client_payload_hash: string | null }>(
    'SELECT id, client_payload_hash FROM customer_payments WHERE organization_id = $1 AND client_transaction_id = $2',
    [auth.organizationId, input.clientTransactionId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0]!.client_payload_hash !== payloadHash) {
      throw conflict('PAYMENT_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different payment payload');
    }
    return { payment: await getCustomerPayment(pool, auth, existing.rows[0]!.id), replayed: true };
  }

  let paymentId: string;
  try {
    paymentId = await withTransaction(pool, async (tx) => {
      const customer = await lockCustomer(tx, auth, customerId);
      const session = await tx.query<{ id: string; branch_id: string; status: string; opened_by_membership_id: string }>(
        `SELECT id, branch_id, status, opened_by_membership_id FROM register_sessions
         WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [input.registerSessionId, auth.organizationId]
      );
      const registerSession = session.rows[0];
      if (!registerSession) throw notFound('Register session was not found');
      await ensureBranch(tx, auth, registerSession.branch_id);
      if (registerSession.status !== 'open') throw conflict('REGISTER_SESSION_CLOSED', 'Customer payments require an open register session');
      if (registerSession.opened_by_membership_id !== auth.membershipId && !auth.permissions.has('registers.manage')) {
        throw forbidden('SESSION_ACCESS_DENIED', 'You can only collect payments into your own open drawer');
      }
      const amount = decimalToMinorUnits(input.amount);
      const allocations = await validateCreditAllocations(tx, auth, customerId, registerSession.branch_id, input.allocations, amount);
      const paymentNumber = await nextDocumentNumber(tx, auth.organizationId, 'CUSTOMER-PAYMENT', 'CP');
      const payment = await tx.query<{ id: string }>(
        `INSERT INTO customer_payments (
          organization_id, branch_id, customer_id, register_session_id, payment_number,
          client_transaction_id, client_payload_hash, method, amount_minor, status, reason,
          received_by_membership_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'cash',$8,'completed',$9,$10)
        RETURNING id`,
        [auth.organizationId, registerSession.branch_id, customerId, registerSession.id, paymentNumber, input.clientTransactionId, payloadHash, amount.toString(), input.reason, auth.membershipId]
      );
      const id = payment.rows[0]!.id;
      const ledger = await tx.query<{ id: string }>(
        `INSERT INTO customer_credit_transactions (
          organization_id, branch_id, customer_id, transaction_type, direction, amount_minor,
          reference_type, reference_id, client_transaction_id, client_payload_hash, reason, actor_membership_id
        ) VALUES ($1,$2,$3,'payment','credit',$4,'customer_payment',$5,$6,$7,$8,$9)
        RETURNING id`,
        [auth.organizationId, registerSession.branch_id, customerId, amount.toString(), id, input.clientTransactionId, payloadHash, input.reason, auth.membershipId]
      );
      for (const allocation of allocations) {
        await tx.query(
          `INSERT INTO customer_credit_allocations (
            organization_id, branch_id, customer_id, source_transaction_id,
            customer_payment_id, sale_id, amount_minor
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [auth.organizationId, registerSession.branch_id, customerId, ledger.rows[0]!.id, id, allocation.saleId, allocation.amountMinor.toString()]
        );
        await updateSalePaymentStatus(tx, auth.organizationId, allocation.saleId);
      }
      await tx.query(
        `INSERT INTO cash_movements (
          organization_id, branch_id, register_session_id, movement_type, direction,
          amount_minor, reason, reference_type, reference_id, actor_membership_id
        ) VALUES ($1,$2,$3,'customer_payment','in',$4,$5,'customer_payment',$6,$7)`,
        [auth.organizationId, registerSession.branch_id, registerSession.id, amount.toString(), `Customer payment ${paymentNumber}: ${input.reason}`, id, auth.membershipId]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: registerSession.branch_id,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'credit.payment-recorded',
        entityType: 'customer_payment',
        entityId: id,
        metadata: { customerId, customerCode: customer.code, paymentNumber, amount: input.amount, allocations: allocations.length },
        ...requestMeta(req)
      });
      return id;
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      const replayed = await pool.query<{ id: string; client_payload_hash: string }>(
        'SELECT id, client_payload_hash FROM customer_payments WHERE organization_id = $1 AND client_transaction_id = $2',
        [auth.organizationId, input.clientTransactionId]
      );
      if (replayed.rows[0]?.client_payload_hash === payloadHash) {
        return { payment: await getCustomerPayment(pool, auth, replayed.rows[0]!.id), replayed: true };
      }
      throw conflict('PAYMENT_IDENTIFIER_CONFLICT', 'The payment number or client transaction identifier conflicts with an existing payment');
    }
    throw error;
  }
  return { payment: await getCustomerPayment(pool, auth, paymentId), replayed: false };
}

export async function createCreditAdjustment(pool: pg.Pool, auth: AuthContext, customerId: string, input: CreateCustomerCreditAdjustmentInput, req: Request) {
  if (input.type === 'write_off' && !auth.permissions.has('credit.write-off')) {
    throw forbidden('CREDIT_WRITE_OFF_DENIED', 'You do not have permission to write off customer balances');
  }
  const payloadHash = requestPayloadHash({ customerId, ...input });
  const existing = await pool.query<{ id: string; client_payload_hash: string | null }>(
    'SELECT id, client_payload_hash FROM customer_credit_transactions WHERE organization_id = $1 AND client_transaction_id = $2',
    [auth.organizationId, input.clientTransactionId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0]!.client_payload_hash !== payloadHash) {
      throw conflict('ADJUSTMENT_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different adjustment payload');
    }
    return { transaction: (await getCreditAccount(pool, auth, customerId)).transactions.find((row) => row.id === existing.rows[0]!.id), replayed: true };
  }

  let transactionId: string;
  await withTransaction(pool, async (tx) => {
    await lockCustomer(tx, auth, customerId);
    const amount = decimalToMinorUnits(input.amount);
    let branchId = input.branchId ?? null;
    if (input.allocations?.length) {
      const branch = await tx.query<{ branch_id: string }>(
        'SELECT branch_id FROM sales WHERE id = $1 AND organization_id = $2',
        [input.allocations[0]!.saleId, auth.organizationId]
      );
      branchId = branch.rows[0]?.branch_id ?? branchId;
    }
    if (!branchId) throw badRequest('VALIDATION_ERROR', 'A branch is required for a customer credit adjustment');
    await ensureBranch(tx, auth, branchId);
    const direction = input.type === 'debit_adjustment' ? 'debit' : 'credit';
    const transaction = await tx.query<{ id: string }>(
      `INSERT INTO customer_credit_transactions (
        organization_id, branch_id, customer_id, transaction_type, direction, amount_minor,
        client_transaction_id, client_payload_hash, reason, actor_membership_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id`,
      [auth.organizationId, branchId, customerId, input.type, direction, amount.toString(), input.clientTransactionId, payloadHash, input.reason, auth.membershipId]
    );
    transactionId = transaction.rows[0]!.id;
    if (input.allocations?.length) {
      const allocations = await validateCreditAllocations(tx, auth, customerId, branchId, input.allocations, amount);
      for (const allocation of allocations) {
        await tx.query(
          `INSERT INTO customer_credit_allocations (
            organization_id, branch_id, customer_id, source_transaction_id, sale_id, amount_minor
          ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [auth.organizationId, branchId, customerId, transactionId, allocation.saleId, allocation.amountMinor.toString()]
        );
        await updateSalePaymentStatus(tx, auth.organizationId, allocation.saleId);
      }
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: `credit.${input.type.replace('_', '-')}`,
      entityType: 'customer_credit_transaction',
      entityId: transactionId,
      metadata: { customerId, type: input.type, amount: input.amount, reason: input.reason },
      ...requestMeta(req)
    });
  });
  return { transaction: (await getCreditAccount(pool, auth, customerId)).transactions.find((row) => row.id === transactionId), replayed: false };
}
