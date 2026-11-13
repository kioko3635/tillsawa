import type {
  CashMovementInput,
  CloseRegisterSessionInput,
  CompleteSaleInput,
  CreateRegisterInput,
  CreateSaleRefundInput,
  CreateSaleReturnInput,
  OfflineSaleSnapshot,
  OpenRegisterSessionInput,
  PosProductSearchQuery,
  RegisterQuery,
  RegisterSessionQuery,
  ReprintReceiptInput,
  SaleListQuery,
  UpdateRegisterInput,
  VoidSaleInput
} from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import type { Queryable } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import {
  listAccessibleBranchIds,
  membershipHasBranchAccess,
  type AuthContext
} from '../../http/middleware/auth.js';
import { requestPayloadHash } from '../../http/middleware/idempotency.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import {
  basisPointsOfMinor,
  decimalToMinorUnits,
  inclusiveTaxFromMinor,
  minorUnitsToDecimal,
  multiplyMinorByQuantity,
  percentToBasisPoints,
  proportionalMinor,
  scaledIntToDecimal
} from '../../shared/money.js';
import { recordAudit } from '../audit/audit.js';
import { prepareLoyalty, postLoyalty, saleLoyalty, loyaltyReturnCash, reconcileLoyalty } from '../loyalty/service.js';
import {
  getInventoryProduct,
  postMovement,
  toBaseQuantity,
  type InventoryProduct
} from '../inventory/service.js';
import { resolvePrice } from '../pricing/service.js';
import { verifyIntentForSale } from '../payments/verification.js';

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

function mapRegister(row: Record<string, unknown>) {
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    code: row.code,
    name: row.name,
    status: row.status,
    receiptPrefix: row.receipt_prefix,
    receiptFooter: row.receipt_footer,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCashMovement(row: Record<string, unknown>) {
  return {
    id: row.id,
    registerSessionId: row.register_session_id,
    type: row.movement_type,
    direction: row.direction,
    amount: minorUnitsToDecimal(String(row.amount_minor)),
    reason: row.reason,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    actorName: row.actor_name ?? null,
    createdAt: row.created_at
  };
}

function mapSession(row: Record<string, unknown>) {
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    registerId: row.register_id,
    registerCode: row.register_code ?? null,
    registerName: row.register_name ?? null,
    status: row.status,
    openingFloat: minorUnitsToDecimal(String(row.opening_float_minor)),
    expectedCash: row.expected_cash_minor === null || row.expected_cash_minor === undefined ? null : minorUnitsToDecimal(String(row.expected_cash_minor)),
    countedCash: row.counted_cash_minor === null || row.counted_cash_minor === undefined ? null : minorUnitsToDecimal(String(row.counted_cash_minor)),
    cashVariance: row.cash_variance_minor === null || row.cash_variance_minor === undefined ? null : minorUnitsToDecimal(String(row.cash_variance_minor)),
    openedByMembershipId: row.opened_by_membership_id,
    openedByName: row.opened_by_name ?? null,
    openedAt: row.opened_at,
    closedByName: row.closed_by_name ?? null,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSale(row: Record<string, unknown>) {
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    registerId: row.register_id,
    registerCode: row.register_code ?? null,
    registerName: row.register_name ?? null,
    registerSessionId: row.register_session_id,
    cashierMembershipId: row.cashier_membership_id,
    cashierName: row.cashier_name ?? null,
    customerId: row.customer_id,
    customerName: row.customer_name ?? null,
    clientTransactionId: row.client_transaction_id,
    receiptNumber: row.receipt_number,
    status: row.status,
    currency: row.currency_code,
    taxPricingMode: row.tax_pricing_mode,
    subtotal: minorUnitsToDecimal(String(row.subtotal_minor)),
    discountTotal: minorUnitsToDecimal(String(row.discount_total_minor)),
    taxTotal: minorUnitsToDecimal(String(row.tax_total_minor)),
    total: minorUnitsToDecimal(String(row.total_minor)),
    totalCost: minorUnitsToDecimal(String(row.total_cost_minor)),
    soldAt: row.sold_at,
    creditDueDate: row.credit_due_date,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at
  };
}

function mapSaleLine(row: Record<string, unknown>) {
  return {
    id: row.id,
    productId: row.product_id,
    productSku: row.product_sku,
    productName: row.product_name,
    unitId: row.unit_id,
    unitCode: row.unit_code,
    quantity: String(row.quantity),
    baseQuantity: String(row.base_quantity),
    listPrice: minorUnitsToDecimal(String(row.list_price_minor)),
    unitPrice: minorUnitsToDecimal(String(row.unit_price_minor)),
    discountPct: String(row.discount_pct),
    discount: minorUnitsToDecimal(String(row.discount_minor)),
    subtotal: minorUnitsToDecimal(String(row.subtotal_minor)),
    taxRatePct: scaledIntToDecimal(BigInt(String(row.tax_rate_bps)), 2),
    tax: minorUnitsToDecimal(String(row.tax_minor)),
    total: minorUnitsToDecimal(String(row.total_minor)),
    costTotal: minorUnitsToDecimal(String(row.cost_total_minor)),
    returnedQty: String(row.returned_qty),
    returnableQty: String(row.returnable_qty ?? row.quantity),
    batchNo: row.batch_no,
    serialNo: row.serial_no,
    expiryDate: row.expiry_date
  };
}

function mapPayment(row: Record<string, unknown>) {
  return {
    reference: row.reference ?? null,
    verification: row.verification ?? 'legacy',
    id: row.id,
    method: row.method,
    amount: minorUnitsToDecimal(String(row.amount_minor)),
    amountTendered: row.amount_tendered_minor === null ? null : minorUnitsToDecimal(String(row.amount_tendered_minor)),
    change: row.change_minor === null ? null : minorUnitsToDecimal(String(row.change_minor)),
    status: row.status,
    createdAt: row.created_at
  };
}

function mapReturnLine(row: Record<string, unknown>) {
  return {
    id: row.id,
    saleLineId: row.sale_line_id,
    productId: row.product_id,
    productSku: row.product_sku ?? null,
    productName: row.product_name ?? null,
    unitCode: row.unit_code,
    quantity: String(row.quantity),
    baseQuantity: String(row.base_quantity),
    disposition: row.disposition,
    refundAmount: minorUnitsToDecimal(String(row.refund_amount_minor))
  };
}

function mapReturn(row: Record<string, unknown>, lines: Array<Record<string, unknown>> = []) {
  return {
    id: row.id,
    saleId: row.sale_id,
    returnNumber: row.return_number,
    status: row.status,
    reason: row.reason,
    refundableTotal: minorUnitsToDecimal(String(row.refundable_total_minor)),
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    lines: lines.map(mapReturnLine)
  };
}

function mapRefund(row: Record<string, unknown>) {
  return {
    id: row.id,
    saleId: row.sale_id,
    saleReturnId: row.sale_return_id,
    registerSessionId: row.register_session_id,
    method: row.method,
    amount: minorUnitsToDecimal(String(row.amount_minor)),
    status: row.status,
    reason: row.reason,
    authorizedByName: row.authorized_by_name ?? null,
    createdAt: row.created_at
  };
}

async function accessibleBranchIds(db: Queryable, auth: AuthContext): Promise<string[]> {
  const ids = await listAccessibleBranchIds(db, auth);
  if (ids.length === 0) throw forbidden('BRANCH_ACCESS_DENIED', 'No accessible branches');
  return ids;
}

export async function searchPosProducts(pool: pg.Pool, auth: AuthContext, query: PosProductSearchQuery) {
  await ensureBranch(pool, auth, query.branchId);
  const values: unknown[] = [auth.organizationId, query.branchId, query.search ?? ''];
  const where = [`p.organization_id = $1`, `p.status = 'active'`];
  if (query.search) {
    values.push(query.search, `%${query.search}%`);
    where.push(`(p.sku ILIKE $${values.length} OR p.name ILIKE $${values.length} OR p.brand ILIKE $${values.length} OR EXISTS (
      SELECT 1 FROM product_barcodes pb
      WHERE pb.organization_id = p.organization_id AND pb.product_id = p.id AND pb.barcode = $${values.length - 1}
    ) OR EXISTS (
      SELECT 1 FROM product_barcodes pb
      WHERE pb.organization_id = p.organization_id AND pb.product_id = p.id AND pb.barcode ILIKE $${values.length}
    ))`);
  }
  const result = await pool.query(
    `SELECT p.id, p.sku, p.name, p.brand, p.image_url AS "imageUrl", p.item_type AS "itemType",
            p.base_unit_id AS "baseUnitId", u.code AS "unitCode", p.cost_minor::text,
            p.base_price_minor::text, p.tax_rate_bps::text, p.min_stock_level::text,
            p.category_id AS "categoryId", c.name AS "categoryName",
            (SELECT pb.barcode FROM product_barcodes pb
             WHERE pb.organization_id = p.organization_id AND pb.product_id = p.id
             ORDER BY (pb.barcode = $3) DESC, pb.barcode LIMIT 1) AS barcode,
            COALESCE(s.on_hand_qty, 0)::text AS "onHandQty",
            COALESCE(s.avg_cost_minor, 0)::text AS avg_cost_minor
     FROM products p
     JOIN units_of_measure u ON u.id = p.base_unit_id AND u.organization_id = p.organization_id
     LEFT JOIN product_categories c ON c.id = p.category_id AND c.organization_id = p.organization_id
     LEFT JOIN stock_levels s ON s.product_id = p.id AND s.organization_id = p.organization_id AND s.branch_id = $2
     WHERE ${where.join(' AND ')}
     ORDER BY p.name
     LIMIT $${values.length + 1}`,
    [...values, query.pageSize]
  );
  return result.rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    brand: row.brand,
    barcode: row.barcode,
    imageUrl: row.imageUrl,
    itemType: row.itemType,
    baseUnitId: row.baseUnitId,
    unitCode: row.unitCode,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    minStockLevel: row.min_stock_level,
    cost: minorUnitsToDecimal(String(row.cost_minor)),
    basePrice: minorUnitsToDecimal(String(row.base_price_minor)),
    taxRatePct: row.tax_rate_bps === null ? null : scaledIntToDecimal(BigInt(String(row.tax_rate_bps)), 2),
    onHandQty: row.onHandQty,
    averageCost: minorUnitsToDecimal(String(row.avg_cost_minor))
  }));
}

export async function listRegisters(pool: pg.Pool, auth: AuthContext, query: RegisterQuery) {
  const branchIds = query.branchId ? [query.branchId] : await accessibleBranchIds(pool, auth);
  if (query.branchId) await ensureBranch(pool, auth, query.branchId);
  const values: unknown[] = [auth.organizationId, branchIds];
  const where = ['r.organization_id = $1', 'r.branch_id = ANY($2::uuid[])'];
  if (query.status) {
    values.push(query.status);
    where.push(`r.status = $${values.length}`);
  }
  const result = await pool.query(
    `SELECT r.*, b.name AS branch_name
     FROM pos_registers r
     JOIN branches b ON b.id = r.branch_id AND b.organization_id = r.organization_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.code, r.code`,
    values
  );
  return result.rows.map(mapRegister);
}

export async function createRegister(pool: pg.Pool, auth: AuthContext, input: CreateRegisterInput, req: Request) {
  const registerId = await withTransaction(pool, async (tx) => {
    await ensureBranch(tx, auth, input.branchId);
    const code = input.code.trim().toUpperCase();
    const prefix = (input.receiptPrefix ?? code).trim().toUpperCase();
    try {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO pos_registers (
          organization_id, branch_id, code, name, status, receipt_prefix, receipt_footer, created_by_membership_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [auth.organizationId, input.branchId, code, input.name.trim(), input.status, prefix, input.receiptFooter ?? null, auth.membershipId]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: input.branchId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'pos.register-created',
        entityType: 'pos_register',
        entityId: result.rows[0]!.id,
        metadata: { code, name: input.name },
        ...requestMeta(req)
      });
      return result.rows[0]!.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('REGISTER_CODE_TAKEN', 'A register with this code already exists at the branch');
      throw error;
    }
  });
  const registers = await listRegisters(pool, auth, { branchId: input.branchId });
  return registers.find((register) => register.id === registerId)!;
}

export async function updateRegister(pool: pg.Pool, auth: AuthContext, registerId: string, input: UpdateRegisterInput, req: Request) {
  const existing = await pool.query<{ branch_id: string }>(
    'SELECT branch_id FROM pos_registers WHERE id = $1 AND organization_id = $2',
    [registerId, auth.organizationId]
  );
  const row = existing.rows[0];
  if (!row) throw notFound('Register was not found');
  await ensureBranch(pool, auth, row.branch_id);
  const fieldMap: Partial<Record<keyof UpdateRegisterInput, string>> = {
    name: 'name',
    status: 'status',
    receiptPrefix: 'receipt_prefix',
    receiptFooter: 'receipt_footer'
  };
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(fieldMap)) {
    const value = input[key as keyof UpdateRegisterInput];
    if (value === undefined) continue;
    values.push(key === 'receiptPrefix' ? String(value).toUpperCase() : value);
    updates.push(`${column} = $${values.length + 2}`);
  }
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `UPDATE pos_registers SET ${updates.join(', ')}
       WHERE id = $1 AND organization_id = $2`,
      [registerId, auth.organizationId, ...values]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: row.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'pos.register-updated',
      entityType: 'pos_register',
      entityId: registerId,
      metadata: input as Record<string, unknown>,
      ...requestMeta(req)
    });
  });
  const registers = await listRegisters(pool, auth, { branchId: row.branch_id });
  return registers.find((register) => register.id === registerId)!;
}

interface SessionRow {
  id: string;
  organization_id: string;
  branch_id: string;
  register_id: string;
  status: string;
  opening_float_minor: string;
  next_receipt_seq: number;
  opened_by_membership_id: string;
  branch_name: string;
  register_code: string;
  register_name: string;
  receipt_prefix: string;
  receipt_footer: string | null;
}

async function lockSession(tx: pg.PoolClient, auth: AuthContext, sessionId: string): Promise<SessionRow> {
  const result = await tx.query<SessionRow>(
    `SELECT s.id, s.organization_id, s.branch_id, s.register_id, s.status,
            s.opening_float_minor::text, s.next_receipt_seq, s.opened_by_membership_id,
            b.name AS branch_name, r.code AS register_code, r.name AS register_name,
            r.receipt_prefix, r.receipt_footer
     FROM register_sessions s
     JOIN pos_registers r ON r.id = s.register_id AND r.organization_id = s.organization_id
     JOIN branches b ON b.id = s.branch_id AND b.organization_id = s.organization_id
     WHERE s.id = $1 AND s.organization_id = $2
     FOR UPDATE OF s`,
    [sessionId, auth.organizationId]
  );
  const session = result.rows[0];
  if (!session) throw notFound('Register session was not found');
  await ensureBranch(tx, auth, session.branch_id);
  return session;
}

function assertSessionOperator(auth: AuthContext, session: Pick<SessionRow, 'opened_by_membership_id'>, operatorMembershipId = auth.membershipId): void {
  if (session.opened_by_membership_id !== operatorMembershipId && !auth.permissions.has('registers.manage')) {
    throw forbidden('REGISTER_SESSION_DENIED', 'Only the session operator or a register manager can use this session');
  }
}

function assertSessionViewer(auth: AuthContext, session: Pick<SessionRow, 'opened_by_membership_id'>): void {
  if (
    session.opened_by_membership_id !== auth.membershipId &&
    !auth.permissions.has('registers.manage') &&
    !auth.permissions.has('sales.view_all')
  ) {
    throw forbidden('REGISTER_SESSION_DENIED', 'Only the session operator or an authorized manager can view this session');
  }
}

const expectedCashSql = `
  SELECT ($3::bigint + COALESCE((
      SELECT SUM(sp.amount_minor)
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id AND s.organization_id = sp.organization_id
      WHERE sp.organization_id = $1 AND s.register_session_id = $2
        AND sp.method = 'cash'
    ), 0) + COALESCE((
      SELECT SUM(CASE WHEN cm.direction = 'in' THEN cm.amount_minor ELSE -cm.amount_minor END)
      FROM cash_movements cm
      WHERE cm.organization_id = $1 AND cm.register_session_id = $2
    ), 0))::bigint::text AS expected
`;

const sessionExpectedCashExpression = `
  (s.opening_float_minor + COALESCE((
    SELECT SUM(sp.amount_minor)
    FROM sale_payments sp
    JOIN sales sale ON sale.id = sp.sale_id AND sale.organization_id = sp.organization_id
    WHERE sp.organization_id = s.organization_id AND sale.register_session_id = s.id
      AND sp.method = 'cash'
  ), 0) + COALESCE((
    SELECT SUM(CASE WHEN cm.direction = 'in' THEN cm.amount_minor ELSE -cm.amount_minor END)
    FROM cash_movements cm
    WHERE cm.organization_id = s.organization_id AND cm.register_session_id = s.id
  ), 0))::bigint
`;

async function expectedCashMinor(db: Queryable, organizationId: string, sessionId: string, openingFloat: string): Promise<bigint> {
  const result = await db.query<{ expected: string }>(expectedCashSql, [organizationId, sessionId, openingFloat]);
  return BigInt(result.rows[0]!.expected);
}

export async function openRegisterSession(pool: pg.Pool, auth: AuthContext, input: OpenRegisterSessionInput, req: Request) {
  const sessionId = await withTransaction(pool, async (tx) => {
    const register = await tx.query<{ id: string; branch_id: string; status: string }>(
      `SELECT id, branch_id, status FROM pos_registers
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [input.registerId, auth.organizationId]
    );
    const row = register.rows[0];
    if (!row) throw notFound('Register was not found');
    if (row.status !== 'active') throw conflict('REGISTER_INACTIVE', 'An inactive register cannot be opened');
    await ensureBranch(tx, auth, row.branch_id);
    try {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO register_sessions (
          organization_id, branch_id, register_id, opening_float_minor, opened_by_membership_id, next_receipt_seq
        )
        SELECT $1,$2,$3,$4,$5,
          COALESCE((SELECT MAX(s.receipt_seq) FROM sales s WHERE s.register_id = $3 AND s.organization_id = $1), 0) + 1
        RETURNING id`,
        [auth.organizationId, row.branch_id, row.id, decimalToMinorUnits(input.openingFloat).toString(), auth.membershipId]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: row.branch_id,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'pos.register-session-opened',
        entityType: 'register_session',
        entityId: inserted.rows[0]!.id,
        metadata: { openingFloat: input.openingFloat, notes: input.notes ?? null },
        ...requestMeta(req)
      });
      return inserted.rows[0]!.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('REGISTER_SESSION_EXISTS', 'The register or operator already has an open session');
      throw error;
    }
  });
  return getRegisterSession(pool, auth, sessionId);
}

export async function listRegisterSessions(pool: pg.Pool, auth: AuthContext, query: RegisterSessionQuery) {
  const branchIds = query.branchId ? [query.branchId] : await accessibleBranchIds(pool, auth);
  if (query.branchId) await ensureBranch(pool, auth, query.branchId);
  const values: unknown[] = [auth.organizationId, branchIds];
  const where = ['s.organization_id = $1', 's.branch_id = ANY($2::uuid[])'];
  if (query.registerId) {
    values.push(query.registerId);
    where.push(`s.register_id = $${values.length}`);
  }
  if (query.status) {
    values.push(query.status);
    where.push(`s.status = $${values.length}`);
  }
  if (!auth.permissions.has('registers.manage') && !auth.permissions.has('sales.view_all')) {
    values.push(auth.membershipId);
    where.push(`s.opened_by_membership_id = $${values.length}`);
  }
  values.push(query.pageSize, (query.page - 1) * query.pageSize);
  const result = await pool.query(
    `SELECT s.*, b.name AS branch_name, r.code AS register_code, r.name AS register_name,
            opened.display_name AS opened_by_name, closed.display_name AS closed_by_name,
            ${sessionExpectedCashExpression} AS expected_live_minor
     FROM register_sessions s
     JOIN branches b ON b.id = s.branch_id AND b.organization_id = s.organization_id
     JOIN pos_registers r ON r.id = s.register_id AND r.organization_id = s.organization_id
     JOIN memberships om ON om.id = s.opened_by_membership_id AND om.organization_id = s.organization_id
     JOIN users opened ON opened.id = om.user_id
     LEFT JOIN memberships cm ON cm.id = s.closed_by_membership_id AND cm.organization_id = s.organization_id
     LEFT JOIN users closed ON closed.id = cm.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.opened_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return result.rows.map((row) => {
    const liveExpected = row.expected_live_minor as string | undefined;
    return {
      ...mapSession(row),
      expectedCash: row.status === 'open' && liveExpected !== undefined
        ? minorUnitsToDecimal(liveExpected)
        : mapSession(row).expectedCash
    };
  });
}

export async function getRegisterSession(pool: pg.Pool, auth: AuthContext, sessionId: string) {
  const result = await pool.query(
    `SELECT s.*, b.name AS branch_name, r.code AS register_code, r.name AS register_name,
            opened.display_name AS opened_by_name, closed.display_name AS closed_by_name,
            ${sessionExpectedCashExpression} AS expected_live_minor
     FROM register_sessions s
     JOIN branches b ON b.id = s.branch_id AND b.organization_id = s.organization_id
     JOIN pos_registers r ON r.id = s.register_id AND r.organization_id = s.organization_id
     JOIN memberships om ON om.id = s.opened_by_membership_id AND om.organization_id = s.organization_id
     JOIN users opened ON opened.id = om.user_id
     LEFT JOIN memberships cm ON cm.id = s.closed_by_membership_id AND cm.organization_id = s.organization_id
     LEFT JOIN users closed ON closed.id = cm.user_id
     WHERE s.id = $1 AND s.organization_id = $2`,
    [sessionId, auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw notFound('Register session was not found');
  await ensureBranch(pool, auth, row.branch_id);
  assertSessionViewer(auth, row);
  const mapped = mapSession(row);
  return {
    ...mapped,
    expectedCash: row.status === 'open' ? minorUnitsToDecimal(String(row.expected_live_minor)) : mapped.expectedCash,
    sales: (await pool.query(
      `SELECT s.*, b.name AS branch_name, r.code AS register_code, r.name AS register_name,
              u.display_name AS cashier_name, c.name AS customer_name
       FROM sales s
       JOIN branches b ON b.id = s.branch_id AND b.organization_id = s.organization_id
       JOIN pos_registers r ON r.id = s.register_id AND r.organization_id = s.organization_id
       JOIN memberships m ON m.id = s.cashier_membership_id AND m.organization_id = s.organization_id
       JOIN users u ON u.id = m.user_id
       LEFT JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
       WHERE s.register_session_id = $1 AND s.organization_id = $2
       ORDER BY s.sold_at DESC`,
      [sessionId, auth.organizationId]
    )).rows.map(mapSale),
    cashMovements: (await pool.query(
      `SELECT cm.*, u.display_name AS actor_name
       FROM cash_movements cm
       JOIN memberships m ON m.id = cm.actor_membership_id AND m.organization_id = cm.organization_id
       JOIN users u ON u.id = m.user_id
       WHERE cm.register_session_id = $1 AND cm.organization_id = $2
       ORDER BY cm.created_at`,
      [sessionId, auth.organizationId]
    )).rows.map(mapCashMovement)
  };
}

export async function recordCashMovement(pool: pg.Pool, auth: AuthContext, sessionId: string, input: CashMovementInput, req: Request) {
  const movementId = await withTransaction(pool, async (tx) => {
    const session = await lockSession(tx, auth, sessionId);
    assertSessionOperator(auth, session);
    if (session.status !== 'open') throw conflict('REGISTER_SESSION_CLOSED', 'A closed session cannot accept cash movements');
    const direction = input.type === 'cash_in' ? 'in' : input.type === 'cash_out' ? 'out' : input.direction!;
    const result = await tx.query<{ id: string }>(
      `INSERT INTO cash_movements (
        organization_id, branch_id, register_session_id, movement_type, direction,
        amount_minor, reason, actor_membership_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [auth.organizationId, session.branch_id, session.id, input.type, direction, decimalToMinorUnits(input.amount).toString(), input.reason, auth.membershipId]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: session.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'pos.cash-movement-recorded',
      entityType: 'cash_movement',
      entityId: result.rows[0]!.id,
      metadata: { type: input.type, direction, amount: input.amount, reason: input.reason },
      ...requestMeta(req)
    });
    return result.rows[0]!.id;
  });
  const session = await getRegisterSession(pool, auth, sessionId);
  return { movement: session.cashMovements.find((movement) => movement.id === movementId), session };
}

export async function closeRegisterSession(pool: pg.Pool, auth: AuthContext, sessionId: string, input: CloseRegisterSessionInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const session = await lockSession(tx, auth, sessionId);
    assertSessionOperator(auth, session);
    if (session.status !== 'open') throw conflict('REGISTER_SESSION_CLOSED', 'This register session is already closed');
    const expected = await expectedCashMinor(tx, auth.organizationId, session.id, session.opening_float_minor);
    const counted = decimalToMinorUnits(input.countedCash);
    await tx.query(
      `UPDATE register_sessions
       SET status = 'closed', closed_by_membership_id = $3, closed_at = now(),
           counted_cash_minor = $4, expected_cash_minor = $5,
           cash_variance_minor = $4::bigint - $5::bigint, close_reason = $6
       WHERE id = $1 AND organization_id = $2`,
      [session.id, auth.organizationId, auth.membershipId, counted.toString(), expected.toString(), input.reason ?? null]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: session.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'pos.register-session-closed',
      entityType: 'register_session',
      entityId: session.id,
      metadata: { expectedCash: minorUnitsToDecimal(expected), countedCash: input.countedCash, variance: minorUnitsToDecimal(counted - expected) },
      ...requestMeta(req)
    });
  });
  return getRegisterSession(pool, auth, sessionId);
}

interface SaleProduct extends InventoryProduct {
  unit_code: string;
  tax_rate_bps: string | null;
}

async function getSellableProduct(db: Queryable, organizationId: string, productId: string): Promise<SaleProduct> {
  const result = await db.query<SaleProduct>(
    `SELECT p.id, p.sku, p.name, p.base_unit_id, u.code AS unit_code, p.item_type, p.status,
            p.cost_minor::text, p.costing_method, p.track_batch, p.track_expiry, p.track_serial,
            p.tax_rate_bps::text
     FROM products p
     JOIN units_of_measure u ON u.id = p.base_unit_id AND u.organization_id = p.organization_id
     WHERE p.id = $1 AND p.organization_id = $2`,
    [productId, organizationId]
  );
  const product = result.rows[0];
  if (!product || product.status !== 'active') throw notFound('Active product was not found');
  return product;
}

interface PreparedSaleLine {
  order: number;
  input: CompleteSaleInput['items'][number];
  product: SaleProduct;
  unitId: string;
  unitCode: string;
  quantity: string;
  baseQuantity: string;
  price: Awaited<ReturnType<typeof resolvePrice>>;
  listUnitPriceMinor: bigint;
  unitPriceMinor: bigint;
  listLineMinor: bigint;
  discountMinor: bigint;
  subtotalMinor: bigint;
  taxRateBps: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  costTotalMinor: bigint;
  saleLineId?: string;
}

async function prepareSaleLines(
  tx: pg.PoolClient,
  auth: AuthContext,
  input: CompleteSaleInput,
  branchId: string,
  defaultTaxRateBps: bigint,
  taxMode: string
): Promise<PreparedSaleLine[]> {
  const prepared: PreparedSaleLine[] = [];
  for (const [index, item] of input.items.entries()) {
    if (item.discountPct !== undefined && Number(item.discountPct) > 0 && !auth.permissions.has('sales.discount')) {
      throw forbidden('SALE_DISCOUNT_DENIED', 'You do not have permission to apply a sale discount');
    }
    const product = await getSellableProduct(tx, auth.organizationId, item.productId);
    const unitId = item.unitId ?? product.base_unit_id;
    const baseQuantity = await toBaseQuantity(tx, auth.organizationId, product, unitId, item.quantity);
    const price = await resolvePrice(tx, auth, {
      productId: product.id,
      branchId,
      quantity: baseQuantity,
      customerId: input.customerId ?? null,
      priceListId: input.priceListId ?? null,
      discountPct: item.discountPct
    });
    const unitResult = await tx.query<{ code: string }>(
      'SELECT code FROM units_of_measure WHERE id = $1 AND organization_id = $2',
      [unitId, auth.organizationId]
    );
    const unitCode = unitResult.rows[0]?.code;
    if (!unitCode) throw badRequest('VALIDATION_ERROR', 'Sale unit is not valid for this organization');
    // Resolved prices are per base unit; scale to the sold unit for
    // display/storage and multiply by the base quantity for the line total.
    const unitFactor = String(Number(baseQuantity) / Number(item.quantity));
    const listUnitPriceMinor = multiplyMinorByQuantity(BigInt(decimalToMinorUnits(price.listPrice)), unitFactor);
    const unitPriceMinor = multiplyMinorByQuantity(BigInt(decimalToMinorUnits(price.price)), unitFactor);
    const listLineMinor = multiplyMinorByQuantity(listUnitPriceMinor, item.quantity);
    const netMinor = multiplyMinorByQuantity(unitPriceMinor, item.quantity);
    const taxRateBps = product.tax_rate_bps === null ? defaultTaxRateBps : BigInt(product.tax_rate_bps);
    const discountMinor = listLineMinor - netMinor;
    const taxMinor = taxMode === 'inclusive'
      ? inclusiveTaxFromMinor(netMinor, taxRateBps)
      : basisPointsOfMinor(netMinor, taxRateBps);
    const subtotalMinor = taxMode === 'inclusive' ? netMinor - taxMinor : netMinor;
    const totalMinor = taxMode === 'inclusive' ? netMinor : netMinor + taxMinor;
    prepared.push({
      order: index,
      input: item,
      product,
      unitId,
      unitCode,
      quantity: item.quantity,
      baseQuantity,
      price,
      listUnitPriceMinor,
      unitPriceMinor,
      listLineMinor,
      discountMinor,
      subtotalMinor,
      taxRateBps,
      taxMinor,
      totalMinor,
      costTotalMinor: 0n
    });
  }
  return prepared;
}

async function saleAccessAllowed(db: Queryable, auth: AuthContext, saleId: string): Promise<void> {
  const result = await db.query<{ branch_id: string; cashier_membership_id: string }>(
    'SELECT branch_id, cashier_membership_id FROM sales WHERE id = $1 AND organization_id = $2',
    [saleId, auth.organizationId]
  );
  const sale = result.rows[0];
  if (!sale) throw notFound('Sale was not found');
  await ensureBranch(db, auth, sale.branch_id);
  if (!auth.permissions.has('sales.view_all') && sale.cashier_membership_id !== auth.membershipId) {
    throw forbidden('SALE_ACCESS_DENIED', 'You can only view sales you completed');
  }
}

interface CompleteSaleTransactionOptions {
  paymentTestMode?: boolean;
  expectedSnapshot?: OfflineSaleSnapshot | undefined;
  clientOccurredAt?: string | undefined;
  cashierMembershipId?: string | undefined;
}

function minorEquals(left: string, right: bigint): boolean {
  return decimalToMinorUnits(left) === right;
}

function assertOfflineSnapshot(lines: PreparedSaleLine[], expected: OfflineSaleSnapshot, total: bigint): void {
  if (expected.lines.length !== lines.length) {
    throw conflict('SALE_REFERENCE_CONFLICT', 'The saved offline sale no longer matches the sellable product lines', {
      expectedLineCount: expected.lines.length,
      currentLineCount: lines.length
    });
  }
  const differences: Array<Record<string, unknown>> = [];
  for (const [index, line] of lines.entries()) {
    const expectedLine = expected.lines[index]!;
    if (expectedLine.productId !== line.product.id || Number(expectedLine.quantity) !== Number(line.quantity)) {
      differences.push({ productId: line.product.id, expectedProductId: expectedLine.productId, expectedQuantity: expectedLine.quantity, quantity: line.quantity });
      continue;
    }
    if (!minorEquals(expectedLine.listPrice, decimalToMinorUnits(line.price.listPrice)) || !minorEquals(expectedLine.unitPrice, decimalToMinorUnits(line.price.price))) {
      differences.push({
        productId: line.product.id,
        field: 'price',
        expectedListPrice: expectedLine.listPrice,
        listPrice: line.price.listPrice,
        expectedUnitPrice: expectedLine.unitPrice,
        unitPrice: line.price.price
      });
    }
    if (!minorEquals(expectedLine.subtotal, line.subtotalMinor) || !minorEquals(expectedLine.tax, line.taxMinor) || !minorEquals(expectedLine.total, line.totalMinor)) {
      differences.push({
        productId: line.product.id,
        field: 'totals',
        expectedSubtotal: expectedLine.subtotal,
        subtotal: minorUnitsToDecimal(line.subtotalMinor),
        expectedTax: expectedLine.tax,
        tax: minorUnitsToDecimal(line.taxMinor),
        expectedTotal: expectedLine.total,
        total: minorUnitsToDecimal(line.totalMinor)
      });
    }
    const expectedTaxRate = expectedLine.taxRatePct === null || expectedLine.taxRatePct === undefined
      ? null
      : percentToBasisPoints(expectedLine.taxRatePct);
    if (expectedTaxRate !== null && expectedTaxRate !== line.taxRateBps) {
      differences.push({
        productId: line.product.id,
        field: 'taxRate',
        expectedTaxRatePct: expectedLine.taxRatePct,
        taxRatePct: scaledIntToDecimal(line.taxRateBps, 2)
      });
    }
  }
  if (!minorEquals(expected.totals.total, total)) {
    differences.push({ field: 'saleTotal', expectedTotal: expected.totals.total, total: minorUnitsToDecimal(total) });
  }
  if (differences.length > 0) {
    throw conflict('SALE_PRICE_CONFLICT', 'The server price, tax or sale total changed while the device was offline', { differences });
  }
}

async function existingSaleForClientId(db: Queryable, organizationId: string, clientTransactionId: string, payloadHash: string) {
  const existing = await db.query<{ id: string; client_payload_hash: string }>(
    `SELECT id, client_payload_hash FROM sales
     WHERE organization_id = $1 AND client_transaction_id = $2
     FOR UPDATE`,
    [organizationId, clientTransactionId]
  );
  const sale = existing.rows[0];
  if (!sale) return undefined;
  if (sale.client_payload_hash !== payloadHash) {
    throw conflict('SALE_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different sale payload');
  }
  return sale;
}

export interface CompleteSaleTransactionResult {
  saleId: string;
  receiptNumber: string;
  replayed: boolean;
}

export async function quoteElectronicSale(pool: pg.Pool, auth: AuthContext, input: CompleteSaleInput) {
  return withTransaction(pool, async tx => {
    const session = await lockSession(tx, auth, input.registerSessionId);
    assertSessionOperator(auth, session);
    if (session.status !== 'open') throw conflict('REGISTER_SESSION_CLOSED', 'Open the till before requesting payment');
    const result = await tx.query<{ default_tax_rate_bps: string; tax_pricing_mode: string; currency_code: string }>('SELECT default_tax_rate_bps::text,tax_pricing_mode,currency_code FROM organizations WHERE id=$1', [auth.organizationId]);
    const org = result.rows[0]!;
    if (org.currency_code !== 'KES') throw badRequest('PAYMENT_CURRENCY_UNSUPPORTED', 'M-Pesa and card confirmation in this test edition requires Kenyan shillings (KES).');
    const lines = await prepareSaleLines(tx, auth, input, session.branch_id, BigInt(org.default_tax_rate_bps), org.tax_pricing_mode);
    return { amountMinor: lines.reduce((sum, line) => sum + line.totalMinor, 0n), currency: org.currency_code, branchId: session.branch_id };
  });
}

export async function completeSaleInTransaction(
  tx: pg.PoolClient,
  auth: AuthContext,
  input: CompleteSaleInput,
  req: Request,
  options: CompleteSaleTransactionOptions = {}
): Promise<CompleteSaleTransactionResult> {
  const payloadHash = requestPayloadHash(input);
  const cashierMembershipId = options.cashierMembershipId ?? auth.membershipId;
  const existing = await existingSaleForClientId(tx, auth.organizationId, input.clientTransactionId, payloadHash);
  if (existing) {
    const receipt = await tx.query<{ receipt_number: string }>(
      'SELECT receipt_number FROM sales WHERE id = $1 AND organization_id = $2',
      [existing.id, auth.organizationId]
    );
    return { saleId: existing.id, receiptNumber: receipt.rows[0]!.receipt_number, replayed: true };
  }

  const session = await lockSession(tx, auth, input.registerSessionId);
  if (session.status !== 'open') throw conflict('REGISTER_SESSION_CLOSED', 'A closed session cannot accept new sales');
  assertSessionOperator(auth, session, cashierMembershipId);
  let customer: { credit_status: string; credit_limit_minor: string; payment_terms_days: number | null } | undefined;
  if (input.customerId) {
    const customerResult = await tx.query<{ credit_status: string; credit_limit_minor: string; payment_terms_days: number | null }>(
      `SELECT credit_status, credit_limit_minor::text, payment_terms_days
       FROM customers WHERE id = $1 AND organization_id = $2 AND status = 'active'
       FOR UPDATE`,
      [input.customerId, auth.organizationId]
    );
    customer = customerResult.rows[0];
    if (!customer) throw badRequest('VALIDATION_ERROR', 'Customer is not valid for this organization');
  }
  if (input.deviceId) {
    const device = await tx.query(
      `SELECT 1 FROM registered_devices
       WHERE id = $1 AND organization_id = $2 AND branch_id = $3 AND status = 'active'`,
      [input.deviceId, auth.organizationId, session.branch_id]
    );
    if (device.rowCount !== 1) throw badRequest('VALIDATION_ERROR', 'Device is not valid for this sale branch');
  }
  const organization = await tx.query<{ default_tax_rate_bps: string; tax_pricing_mode: string; currency_code: string }>(
    `SELECT default_tax_rate_bps::text, tax_pricing_mode, currency_code FROM organizations WHERE id = $1`,
    [auth.organizationId]
  );
  const org = organization.rows[0]!;
  const lines = await prepareSaleLines(tx, auth, input, session.branch_id, BigInt(org.default_tax_rate_bps), org.tax_pricing_mode);
  const subtotal = lines.reduce((sum, line) => sum + line.subtotalMinor, 0n);
  const discountTotal = lines.reduce((sum, line) => sum + line.discountMinor, 0n);
  const taxTotal = lines.reduce((sum, line) => sum + line.taxMinor, 0n);
  const total = lines.reduce((sum, line) => sum + line.totalMinor, 0n);
  if (org.currency_code!=='KES' && input.loyaltyPointsToRedeem) throw badRequest('LOYALTY_CURRENCY_UNSUPPORTED','Loyalty redemption currently supports Kenyan shillings only.');
  const loyalty = await prepareLoyalty(tx,auth,org.currency_code==='KES'?input.customerId:null,input.loyaltyPointsToRedeem ?? 0,input.payment.method,total,Boolean(options.expectedSnapshot));
  const cashDue = total - (loyalty?.redeemedMinor ?? 0n);
  if (options.expectedSnapshot) assertOfflineSnapshot(lines, options.expectedSnapshot, total);
  const paymentMethod = input.payment.method;
  let tendered = 0n;
  let change = 0n;
  let paymentStatus = 'completed';
  let confirmedPayment: Awaited<ReturnType<typeof verifyIntentForSale>> | undefined;
  if (paymentMethod === 'cash') {
    tendered = decimalToMinorUnits(input.payment.amountTendered!);
    if (tendered < cashDue) {
      throw badRequest('INSUFFICIENT_TENDER', 'Cash tendered is less than the sale total');
    }
    change = tendered - cashDue;
  } else if (paymentMethod === 'credit') {
    if (!auth.enabledModules.has('credit')) {
      throw forbidden('MODULE_DISABLED', 'Credit sales are disabled for this organization');
    }
    if (!auth.permissions.has('sales.credit')) {
      throw forbidden('CREDIT_SALE_DENIED', 'You do not have permission to complete a credit sale');
    }
    if (!customer || customer.credit_status !== 'active') {
      throw conflict('CREDIT_ACCOUNT_INACTIVE', 'The selected customer does not have an active credit account');
    }
    const outstandingResult = await tx.query<{ balance: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)::text AS balance
       FROM customer_credit_transactions
       WHERE organization_id = $1 AND customer_id = $2`,
      [auth.organizationId, input.customerId]
    );
    const outstanding = BigInt(outstandingResult.rows[0]!.balance);
    const available = BigInt(customer.credit_limit_minor) - outstanding;
    if (total > available && (!input.allowCreditOverride || !auth.permissions.has('credit.override'))) {
      throw conflict('CREDIT_LIMIT_EXCEEDED', 'The sale exceeds the customer available credit', {
        outstandingBalance: minorUnitsToDecimal(outstanding),
        availableCredit: minorUnitsToDecimal(available)
      });
    }
    paymentStatus = 'outstanding';
  } else {
    if (org.currency_code !== 'KES') throw conflict('PAYMENT_CURRENCY_CHANGED', 'Electronic payment was prepared in Kenyan shillings. Reconcile the received payment before changing shop currency.');
    confirmedPayment = await verifyIntentForSale(tx, auth, input, total, options.paymentTestMode ?? false);
    tendered = total;
  }
  const creditDueDate = paymentMethod === 'credit'
    ? (await tx.query<{ due: string }>(`SELECT (CURRENT_DATE + $1::int)::text AS due`, [customer!.payment_terms_days ?? 0])).rows[0]!.due
    : null;
  const receiptSeq = session.next_receipt_seq;
  await tx.query(
    `UPDATE register_sessions SET next_receipt_seq = next_receipt_seq + 1
     WHERE id = $1 AND organization_id = $2`,
    [session.id, auth.organizationId]
  );
  const receiptNumber = `${session.receipt_prefix}-${String(receiptSeq).padStart(6, '0')}`;
  const sale = await tx.query<{ id: string }>(
    `INSERT INTO sales (
      organization_id, branch_id, register_id, register_session_id, cashier_membership_id,
      customer_id, client_transaction_id, client_payload_hash, receipt_number, receipt_seq, status, currency_code,
      tax_pricing_mode, subtotal_minor, discount_total_minor, tax_total_minor, total_minor,
      credit_due_date, device_id, client_created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING id`,
    [
      auth.organizationId,
      session.branch_id,
      session.register_id,
      session.id,
      cashierMembershipId,
      input.customerId ?? null,
      input.clientTransactionId,
      payloadHash,
      receiptNumber,
      receiptSeq,
      org.currency_code,
      org.tax_pricing_mode,
      subtotal.toString(),
      discountTotal.toString(),
      taxTotal.toString(),
      total.toString(),
      creditDueDate,
      input.deviceId ?? null,
      options.clientOccurredAt ?? null
    ]
  );
  const id = sale.rows[0]!.id;
  for (const line of lines) {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO sale_items (
        organization_id, sale_id, product_id, product_sku, product_name, unit_id, unit_code,
        quantity, base_quantity, list_price_minor, unit_price_minor, discount_pct,
        discount_minor, subtotal_minor, tax_rate_bps, tax_minor, total_minor,
        price_list_id, price_line_id, batch_no, serial_no, expiry_date
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING id`,
      [
        auth.organizationId,
        id,
        line.product.id,
        line.product.sku,
        line.product.name,
        line.unitId,
        line.unitCode,
        line.quantity,
        line.baseQuantity,
        line.listUnitPriceMinor.toString(),
        line.unitPriceMinor.toString(),
        line.input.discountPct ?? '0',
        line.discountMinor.toString(),
        line.subtotalMinor.toString(),
        line.taxRateBps.toString(),
        line.taxMinor.toString(),
        line.totalMinor.toString(),
        line.price.priceListId ?? null,
        line.price.priceLineId ?? null,
        line.input.batchNo ?? null,
        line.input.serialNo ?? null,
        line.input.expiryDate ?? null
      ]
    );
    line.saleLineId = inserted.rows[0]!.id;
  }

  const stockLines = lines.filter((line) => line.product.item_type === 'stocked').sort((left, right) => left.product.id.localeCompare(right.product.id));
  for (const line of stockLines) {
    const movement = await postMovement(tx, auth, {
      branchId: session.branch_id,
      product: line.product,
      unitId: line.unitId,
      quantity: `-${line.quantity}`,
      baseQuantity: `-${line.baseQuantity}`,
      movementType: 'sale',
      referenceType: 'sale',
      referenceId: id,
      reason: `Sale ${receiptNumber}`,
      batchNo: line.input.batchNo ?? null,
      serialNo: line.input.serialNo ?? null,
      expiryDate: line.input.expiryDate ?? null,
      allowNegative: input.allowNegative,
      negativeReason: input.negativeReason ?? null
    });
    line.costTotalMinor = multiplyMinorByQuantity(movement.avgCostMinor, line.baseQuantity);
  }
  const totalCost = lines.reduce((sum, line) => sum + line.costTotalMinor, 0n);
  await tx.query('UPDATE sales SET total_cost_minor = $3 WHERE id = $1 AND organization_id = $2', [id, auth.organizationId, totalCost.toString()]);
  for (const line of stockLines) {
    await tx.query('UPDATE sale_items SET cost_total_minor = $3 WHERE id = $1 AND organization_id = $2', [line.saleLineId!, auth.organizationId, line.costTotalMinor.toString()]);
  }
  const salePayment = await tx.query<{ id: string }>(
    `INSERT INTO sale_payments (
      organization_id, sale_id, method, amount_minor, amount_tendered_minor, change_minor, status, payment_intent_id, reference, verification
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING id`,
    [auth.organizationId, id, paymentMethod, (paymentMethod==='cash'?cashDue:total).toString(), tendered.toString(), change.toString(), paymentStatus, confirmedPayment?.id ?? null, confirmedPayment?.reference ?? null, confirmedPayment?.verification ?? 'legacy']
  );
  await postLoyalty(tx,auth,id,loyalty);
  if (confirmedPayment) await tx.query('UPDATE payment_intents SET sale_id=$3 WHERE id=$1 AND organization_id=$2', [confirmedPayment.id, auth.organizationId, id]);
  if (paymentMethod === 'credit') {
    await tx.query(
      `INSERT INTO customer_credit_transactions (
        organization_id, branch_id, customer_id, transaction_type, direction, amount_minor,
        sale_id, reference_type, reference_id, due_date, reason, actor_membership_id
      ) VALUES ($1,$2,$3,'sale_charge','debit',$4,$5,'sale_payment',$6,$7,$8,$9)`,
      [
        auth.organizationId,
        session.branch_id,
        input.customerId,
        total.toString(),
        id,
        salePayment.rows[0]!.id,
        creditDueDate,
        input.allowCreditOverride ? input.creditOverrideReason : 'Credit sale',
        cashierMembershipId
      ]
    );
  }
  await recordAudit(tx, {
    organizationId: auth.organizationId,
    branchId: session.branch_id,
    actorMembershipId: auth.membershipId,
    actorUserId: auth.userId,
    deviceId: input.deviceId ?? null,
    action: 'pos.sale-completed',
    entityType: 'sale',
    entityId: id,
    metadata: { receiptNumber, total: minorUnitsToDecimal(total), itemCount: lines.length, clientTransactionId: input.clientTransactionId },
    ...requestMeta(req)
  });
  return { saleId: id, receiptNumber, replayed: false };
}

export async function completeSale(pool: pg.Pool, auth: AuthContext, input: CompleteSaleInput, req: Request, paymentTestMode = false) {
  const payloadHash = requestPayloadHash(input);
  const existing = await pool.query<{ id: string; client_payload_hash: string }>(
    'SELECT id, client_payload_hash FROM sales WHERE organization_id = $1 AND client_transaction_id = $2',
    [auth.organizationId, input.clientTransactionId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0]!.client_payload_hash !== payloadHash) {
      throw conflict('SALE_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different sale payload');
    }
    return { sale: await getSale(pool, auth, existing.rows[0]!.id), replayed: true };
  }

  let result: CompleteSaleTransactionResult;
  try {
    result = await withTransaction(pool, (tx) => completeSaleInTransaction(tx, auth, input, req, { paymentTestMode }));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await pool.query<{ id: string; client_payload_hash: string }>(
        'SELECT id, client_payload_hash FROM sales WHERE organization_id = $1 AND client_transaction_id = $2',
        [auth.organizationId, input.clientTransactionId]
      );
      if (replayed.rows[0] && replayed.rows[0]!.client_payload_hash === payloadHash) {
        return { sale: await getSale(pool, auth, replayed.rows[0]!.id), replayed: true };
      }
      throw conflict('SALE_IDENTIFIER_CONFLICT', 'The receipt number or client transaction identifier conflicts with an existing sale');
    }
    throw error;
  }
  return { sale: await getSale(pool, auth, result.saleId), replayed: result.replayed };
}

export async function listSales(pool: pg.Pool, auth: AuthContext, query: SaleListQuery) {
  const branchIds = query.branchId ? [query.branchId] : await accessibleBranchIds(pool, auth);
  if (query.branchId) await ensureBranch(pool, auth, query.branchId);
  const values: unknown[] = [auth.organizationId, branchIds];
  const where = ['s.organization_id = $1', 's.branch_id = ANY($2::uuid[])'];
  if (!auth.permissions.has('sales.view_all')) {
    values.push(auth.membershipId);
    where.push(`s.cashier_membership_id = $${values.length}`);
  }
  if (query.registerSessionId) {
    values.push(query.registerSessionId);
    where.push(`s.register_session_id = $${values.length}`);
  }
  if (query.status) {
    values.push(query.status);
    where.push(`s.status = $${values.length}`);
  }
  if (query.search) {
    values.push(`%${query.search}%`);
    where.push(`(s.receipt_number ILIKE $${values.length} OR c.name ILIKE $${values.length})`);
  }
  if (query.from) {
    values.push(query.from);
    where.push(`s.sold_at >= $${values.length}::timestamptz`);
  }
  if (query.to) {
    values.push(query.to);
    where.push(`s.sold_at < $${values.length}::timestamptz`);
  }
  const offset = (query.page - 1) * query.pageSize;
  const totalResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
     WHERE ${where.join(' AND ')}`,
    values
  );
  values.push(query.pageSize, offset);
  const result = await pool.query(
    `SELECT s.*, b.name AS branch_name, r.code AS register_code, r.name AS register_name,
            u.display_name AS cashier_name, c.name AS customer_name
     FROM sales s
     JOIN branches b ON b.id = s.branch_id AND b.organization_id = s.organization_id
     JOIN pos_registers r ON r.id = s.register_id AND r.organization_id = s.organization_id
     JOIN memberships m ON m.id = s.cashier_membership_id AND m.organization_id = s.organization_id
     JOIN users u ON u.id = m.user_id
     LEFT JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.sold_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  return {
    items: result.rows.map(mapSale),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize))
  };
}

export async function getSale(pool: pg.Pool, auth: AuthContext, saleId: string) {
  await saleAccessAllowed(pool, auth, saleId);
  const result = await pool.query(
    `SELECT s.*, b.name AS branch_name, r.code AS register_code, r.name AS register_name,
            u.display_name AS cashier_name, c.name AS customer_name
     FROM sales s
     JOIN branches b ON b.id = s.branch_id AND b.organization_id = s.organization_id
     JOIN pos_registers r ON r.id = s.register_id AND r.organization_id = s.organization_id
     JOIN memberships m ON m.id = s.cashier_membership_id AND m.organization_id = s.organization_id
     JOIN users u ON u.id = m.user_id
     LEFT JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
     WHERE s.id = $1 AND s.organization_id = $2`,
    [saleId, auth.organizationId]
  );
  const sale = mapSale(result.rows[0]!);
  const lines = await pool.query(
    `SELECT li.*, (li.quantity - li.returned_qty)::text AS returnable_qty
     FROM sale_items li
     WHERE li.sale_id = $1 AND li.organization_id = $2
     ORDER BY li.created_at, li.id`,
    [saleId, auth.organizationId]
  );
  const payments = await pool.query(
    `SELECT * FROM sale_payments WHERE sale_id = $1 AND organization_id = $2 ORDER BY created_at`,
    [saleId, auth.organizationId]
  );
  const returns = await pool.query(
    `SELECT sr.*, u.display_name AS created_by_name
     FROM sale_returns sr
     JOIN memberships m ON m.id = sr.created_by_membership_id AND m.organization_id = sr.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE sr.sale_id = $1 AND sr.organization_id = $2
     ORDER BY sr.created_at`,
    [saleId, auth.organizationId]
  );
  const returnLines = await pool.query(
    `SELECT rl.*, li.product_sku, li.product_name, rl.unit_id, u.code AS unit_code
     FROM sale_return_lines rl
     JOIN sale_items li ON li.id = rl.sale_line_id AND li.organization_id = rl.organization_id
     JOIN units_of_measure u ON u.id = rl.unit_id AND u.organization_id = rl.organization_id
     WHERE rl.organization_id = $1 AND rl.sale_return_id = ANY($2::uuid[])
     ORDER BY rl.created_at`,
    [auth.organizationId, returns.rows.map((row) => row.id)]
  );
  const refunds = await pool.query(
    `SELECT rf.*, u.display_name AS authorized_by_name
     FROM sale_refunds rf
     JOIN memberships m ON m.id = rf.authorized_by_membership_id AND m.organization_id = rf.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE rf.sale_id = $1 AND rf.organization_id = $2
     ORDER BY rf.created_at`,
    [saleId, auth.organizationId]
  );
  return {
    ...sale,
    lines: lines.rows.map(mapSaleLine),
    payments: payments.rows.map(mapPayment),
    returns: returns.rows.map((row) => mapReturn(row, returnLines.rows.filter((line) => line.sale_return_id === row.id))),
    refunds: refunds.rows.map(mapRefund)
  };
}

export async function getReceipt(pool: pg.Pool, auth: AuthContext, saleId: string) {
  await saleAccessAllowed(pool, auth, saleId);
  const sale = await getSale(pool, auth, saleId);
  const result = await pool.query(
    `SELECT o.legal_name, o.display_name, o.receipt_policy, b.name AS branch_name, b.code AS branch_code,
            r.name AS register_name, r.code AS register_code, COALESCE(r.receipt_footer,p.receipt_footer) AS receipt_footer,
            p.receipt_header, p.receipt_logo_url, p.contact_phone, p.contact_email, p.business_address, p.tax_pin, p.receipt_design
     FROM sales s
     JOIN organizations o ON o.id = s.organization_id
     LEFT JOIN organization_profiles p ON p.organization_id = s.organization_id
     JOIN branches b ON b.id = s.branch_id AND b.organization_id = s.organization_id
     JOIN pos_registers r ON r.id = s.register_id AND r.organization_id = s.organization_id
     WHERE s.id = $1 AND s.organization_id = $2`,
    [saleId, auth.organizationId]
  );
  const organization = result.rows[0]!;
  return {
    sale,
    loyalty: await saleLoyalty(pool,auth.organizationId,saleId),
    organization: {
      legalName: organization.legal_name,
      displayName: organization.display_name,
      receiptPolicy: organization.receipt_policy,
      branchName: organization.branch_name,
      branchCode: organization.branch_code,
      registerName: organization.register_name,
      registerCode: organization.register_code,
      receiptFooter: organization.receipt_footer,
      receiptHeader: organization.receipt_header, receiptLogoUrl: organization.receipt_logo_url,
      contactPhone: organization.contact_phone, contactEmail: organization.contact_email,
      businessAddress: organization.business_address, taxPin: organization.tax_pin, receiptDesign: organization.receipt_design
    },
    complianceNotice: 'This is a sales receipt, not a KRA eTIMS tax invoice. Fiscal integration remains pending.'
  };
}

export async function reprintReceipt(pool: pg.Pool, auth: AuthContext, saleId: string, input: ReprintReceiptInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    await saleAccessAllowed(tx, auth, saleId);
    await tx.query(
      `INSERT INTO receipt_reprints (organization_id, sale_id, actor_membership_id, reason)
       VALUES ($1,$2,$3,$4)`,
      [auth.organizationId, saleId, auth.membershipId, input.reason ?? null]
    );
    const sale = await tx.query<{ branch_id: string; receipt_number: string }>(
      'SELECT branch_id, receipt_number FROM sales WHERE id = $1 AND organization_id = $2',
      [saleId, auth.organizationId]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: sale.rows[0]!.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'pos.receipt-reprinted',
      entityType: 'sale',
      entityId: saleId,
      metadata: { receiptNumber: sale.rows[0]!.receipt_number, reason: input.reason ?? null },
      ...requestMeta(req)
    });
  });
  return getReceipt(pool, auth, saleId);
}

export async function voidSale(pool: pg.Pool, auth: AuthContext, saleId: string, input: VoidSaleInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const saleResult = await tx.query<{ id: string; branch_id: string; status: string; register_session_id: string; total_minor: string; receipt_number: string; customer_id: string | null }>(
      `SELECT id, branch_id, status, register_session_id, total_minor::text, receipt_number, customer_id
       FROM sales WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [saleId, auth.organizationId]
    );
    const sale = saleResult.rows[0];
    if (!sale) throw notFound('Sale was not found');
    await ensureBranch(tx, auth, sale.branch_id);
    if (sale.status !== 'completed') throw conflict('SALE_NOT_VOIDABLE', 'Only a completed sale with no returns can be voided');
    const returns = await tx.query('SELECT 1 FROM sale_returns WHERE sale_id = $1 AND organization_id = $2 LIMIT 1', [sale.id, auth.organizationId]);
    if (returns.rowCount) throw conflict('SALE_NOT_VOIDABLE', 'A sale with returns cannot be voided');
    const refunds = await tx.query('SELECT 1 FROM sale_refunds WHERE sale_id = $1 AND organization_id = $2 LIMIT 1', [sale.id, auth.organizationId]);
    if (refunds.rowCount) throw conflict('SALE_NOT_VOIDABLE', 'A sale with refunds cannot be voided');
    const payment = await tx.query<{ method: string }>(
      `SELECT method FROM sale_payments WHERE sale_id = $1 AND organization_id = $2 LIMIT 1`,
      [sale.id, auth.organizationId]
    );
      if (payment.rows[0]?.method === 'mpesa' || payment.rows[0]?.method === 'card') throw conflict('ELECTRONIC_REFUND_REQUIRED', 'Reconcile the electronic payment with its provider before refunding. Automatic electronic refunds are not available in this test build.');
      if (payment.rows[0]?.method === 'credit') {
      const allocations = await tx.query(
        'SELECT 1 FROM customer_credit_allocations WHERE sale_id = $1 AND organization_id = $2 LIMIT 1',
        [sale.id, auth.organizationId]
      );
      if (allocations.rowCount) throw conflict('CREDIT_SALE_HAS_PAYMENTS', 'A credit sale with payments or credit allocations cannot be voided');
    }
    const session = await lockSession(tx, auth, sale.register_session_id);
    if (session.status !== 'open') throw conflict('REGISTER_SESSION_CLOSED', 'The sale session is closed; process a return and refund from an open drawer instead');
    if (sale.customer_id) await tx.query('SELECT id FROM customers WHERE organization_id=$1 AND id=$2 FOR UPDATE',[auth.organizationId,sale.customer_id]);

    const movements = await tx.query<{
      id: string;
      product_id: string;
      unit_id: string;
      quantity: string;
      base_quantity: string;
      unit_cost_minor: string;
    }>(
      `SELECT id, product_id, unit_id, abs(quantity)::text AS quantity, abs(base_quantity)::text AS base_quantity,
              unit_cost_minor::text
       FROM stock_movements
       WHERE organization_id = $1 AND reference_type = 'sale' AND reference_id = $2
       ORDER BY product_id, seq`,
      [auth.organizationId, sale.id]
    );
    for (const movement of movements.rows) {
      const product = await getInventoryProduct(tx, auth.organizationId, movement.product_id, true);
      await postMovement(tx, auth, {
        branchId: sale.branch_id,
        product,
        unitId: movement.unit_id,
        quantity: movement.quantity,
        baseQuantity: movement.base_quantity,
        movementType: 'sale_void',
        referenceType: 'sale',
        referenceId: sale.id,
        unitCostMinor: BigInt(movement.unit_cost_minor),
        reason: `Voided sale ${sale.receipt_number}: ${input.reason}`,
        reversalOfMovementId: movement.id
      });
    }
    await tx.query(
      `INSERT INTO sale_voids (organization_id, sale_id, reason, voided_by_membership_id)
       VALUES ($1,$2,$3,$4)`,
      [auth.organizationId, sale.id, input.reason, auth.membershipId]
    );
    await tx.query(
      `UPDATE sale_payments SET status = 'voided'
       WHERE sale_id = $1 AND organization_id = $2`,
      [sale.id, auth.organizationId]
    );
    const loyaltySummary = await saleLoyalty(tx,auth.organizationId,sale.id);
    const voidCash = BigInt(sale.total_minor)-decimalToMinorUnits(loyaltySummary?.redeemedValue ?? '0');
    if (payment.rows[0]?.method === 'cash' && voidCash>0n) {
      await tx.query(
        `INSERT INTO cash_movements (
          organization_id, branch_id, register_session_id, movement_type, direction,
          amount_minor, reason, reference_type, reference_id, actor_membership_id
        ) VALUES ($1,$2,$3,'sale_void','out',$4,$5,'sale',$6,$7)`,
        [auth.organizationId, sale.branch_id, sale.register_session_id, voidCash.toString(), `Voided sale ${sale.receipt_number}: ${input.reason}`, sale.id, auth.membershipId]
      );
    } else if (payment.rows[0]?.method === 'credit') {
      await tx.query(
        `INSERT INTO customer_credit_transactions (
          organization_id, branch_id, customer_id, transaction_type, direction, amount_minor,
          sale_id, reference_type, reference_id, reason, actor_membership_id
        ) VALUES ($1,$2,$3,'sale_void','credit',$4,$5,'sale',$6,$7,$8)`,
        [auth.organizationId, sale.branch_id, sale.customer_id, sale.total_minor, sale.id, sale.id, input.reason, auth.membershipId]
      );
    }
    await reconcileLoyalty(tx,auth.organizationId,sale.id,true);
    await tx.query(
      `UPDATE sales SET status = 'voided', voided_by_membership_id = $3, voided_at = now(), void_reason = $4
       WHERE id = $1 AND organization_id = $2`,
      [sale.id, auth.organizationId, auth.membershipId, input.reason]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: sale.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'pos.sale-voided',
      entityType: 'sale',
      entityId: sale.id,
      metadata: { receiptNumber: sale.receipt_number, reason: input.reason },
      ...requestMeta(req)
    });
  });
  return getSale(pool, auth, saleId);
}

export async function createSaleReturn(pool: pg.Pool, auth: AuthContext, saleId: string, input: CreateSaleReturnInput, req: Request) {
  const returnId = await withTransaction(pool, async (tx) => {
    const saleResult = await tx.query<{ id: string; branch_id: string; status: string; receipt_number: string; customer_id: string | null }>(
      `SELECT id, branch_id, status, receipt_number, customer_id FROM sales
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [saleId, auth.organizationId]
    );
    const sale = saleResult.rows[0];
    if (!sale) throw notFound('Sale was not found');
    await ensureBranch(tx, auth, sale.branch_id);
    if (sale.status === 'voided' || sale.status === 'returned') throw conflict('SALE_NOT_RETURNABLE', 'This sale cannot accept further returns');
    if (sale.customer_id) await tx.query('SELECT id FROM customers WHERE organization_id=$1 AND id=$2 FOR UPDATE',[auth.organizationId,sale.customer_id]);
    const returnCount = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sale_returns WHERE sale_id = $1 AND organization_id = $2',
      [sale.id, auth.organizationId]
    );
    const returnNumber = `RET-${sale.receipt_number}-${String(Number(returnCount.rows[0]!.count) + 1).padStart(3, '0')}`;
    const lines = [] as Array<{
      saleLine: Record<string, unknown>;
      product: InventoryProduct | null;
      quantity: string;
      baseQuantity: string;
      disposition: string;
      refundMinor: bigint;
    }>;
    let refundable = 0n;
    for (const requested of input.lines) {
      const lineResult = await tx.query(
        `SELECT id, product_id, unit_id, quantity::text, base_quantity::text, total_minor::text,
                returned_qty::text, batch_no, serial_no, expiry_date
         FROM sale_items
         WHERE id = $1 AND sale_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [requested.saleLineId, sale.id, auth.organizationId]
      );
      const line = lineResult.rows[0];
      if (!line) throw badRequest('VALIDATION_ERROR', 'A return line does not belong to this sale');
      const valid = await tx.query<{ valid: boolean; base_quantity: string }>(
        `SELECT ($1::numeric > 0 AND $1::numeric <= ($2::numeric - $3::numeric)) AS valid,
                ($1::numeric * ($4::numeric / NULLIF($2::numeric,0)))::numeric(20,6)::text AS base_quantity`,
        [requested.quantity, line.quantity, line.returned_qty, line.base_quantity]
      );
      if (!valid.rows[0]?.valid) throw conflict('RETURN_QUANTITY_EXCEEDED', 'Returned quantity exceeds the remaining returnable quantity');
      const product = await tx.query<{ item_type: string }>('SELECT item_type FROM products WHERE id = $1 AND organization_id = $2', [line.product_id, auth.organizationId]);
      const refundMinor = await loyaltyReturnCash(tx,auth.organizationId,sale.id,line.id,requested.quantity) ?? proportionalMinor(BigInt(line.total_minor), requested.quantity, line.quantity);
      refundable += refundMinor;
      lines.push({
        saleLine: line,
        product: product.rows[0]?.item_type === 'stocked' ? await getInventoryProduct(tx, auth.organizationId, line.product_id, true) : null,
        quantity: requested.quantity,
        baseQuantity: valid.rows[0]!.base_quantity,
        disposition: requested.disposition,
        refundMinor
      });
    }
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO sale_returns (
        organization_id, branch_id, sale_id, return_number, reason, refundable_total_minor,
        created_by_membership_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [auth.organizationId, sale.branch_id, sale.id, returnNumber, input.reason, refundable.toString(), auth.membershipId]
    );
    const id = inserted.rows[0]!.id;
    for (const line of lines) {
      await tx.query(
        `INSERT INTO sale_return_lines (
          organization_id, sale_return_id, sale_line_id, product_id, unit_id,
          quantity, base_quantity, disposition, refund_amount_minor
        ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8,$9)`,
        [auth.organizationId, id, line.saleLine.id, line.saleLine.product_id, line.saleLine.unit_id, line.quantity, line.baseQuantity, line.disposition, line.refundMinor.toString()]
      );
      await tx.query(
        `UPDATE sale_items SET returned_qty = returned_qty + $3::numeric
         WHERE id = $1 AND organization_id = $2`,
        [line.saleLine.id, auth.organizationId, line.quantity]
      );
      if (line.product) {
        await postMovement(tx, auth, {
          branchId: sale.branch_id,
          product: line.product,
          unitId: line.saleLine.unit_id as string,
          quantity: line.quantity,
          baseQuantity: line.baseQuantity,
          movementType: 'sale_return',
          referenceType: 'sale_return',
          referenceId: id,
          reason: `Return ${returnNumber}: ${input.reason}`,
          batchNo: line.saleLine.batch_no as string | null,
          serialNo: line.saleLine.serial_no as string | null,
          expiryDate: line.saleLine.expiry_date as string | null
        });
        if (line.disposition !== 'restock') {
          await postMovement(tx, auth, {
            branchId: sale.branch_id,
            product: line.product,
            unitId: line.saleLine.unit_id as string,
            quantity: `-${line.quantity}`,
            baseQuantity: `-${line.baseQuantity}`,
            movementType: line.disposition === 'damaged' ? 'damage' : 'write_off',
            referenceType: 'sale_return',
            referenceId: id,
            reason: `Returned item disposition ${line.disposition} for ${returnNumber}`,
            batchNo: line.saleLine.batch_no as string | null,
            serialNo: line.saleLine.serial_no as string | null,
            expiryDate: line.saleLine.expiry_date as string | null
          });
        }
      }
    }
    const fullyReturned = await tx.query(
      `SELECT NOT EXISTS (
         SELECT 1 FROM sale_items
         WHERE sale_id = $1 AND organization_id = $2 AND returned_qty < quantity
       ) AS complete`,
      [sale.id, auth.organizationId]
    );
    await tx.query(
      `UPDATE sales SET status = $3 WHERE id = $1 AND organization_id = $2`,
      [sale.id, auth.organizationId, fullyReturned.rows[0]!.complete ? 'returned' : 'partially_returned']
    );
    const payment = await tx.query<{ id: string; method: string; amount_minor: string }>(
      `SELECT id, method, amount_minor::text FROM sale_payments
       WHERE sale_id = $1 AND organization_id = $2 LIMIT 1 FOR UPDATE`,
      [sale.id, auth.organizationId]
    );
    if (payment.rows[0]?.method === 'credit') {
      const credit = await tx.query<{ id: string }>(
        `INSERT INTO customer_credit_transactions (
          organization_id, branch_id, customer_id, transaction_type, direction, amount_minor,
          sale_id, reference_type, reference_id, reason, actor_membership_id
        ) VALUES ($1,$2,$3,'return_credit','credit',$4,$5,'sale_return',$6,$7,$8)
        RETURNING id`,
        [auth.organizationId, sale.branch_id, sale.customer_id, refundable.toString(), sale.id, id, `Return ${returnNumber}: ${input.reason}`, auth.membershipId]
      );
      const allocatedBefore = await tx.query<{ allocated: string }>(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS allocated
         FROM customer_credit_allocations
         WHERE organization_id = $1 AND sale_id = $2`,
        [auth.organizationId, sale.id]
      );
      const invoiceRemaining = BigInt(payment.rows[0]!.amount_minor) - BigInt(allocatedBefore.rows[0]!.allocated);
      const appliedCredit = refundable < invoiceRemaining ? refundable : invoiceRemaining;
      if (appliedCredit > 0n) {
        await tx.query(
          `INSERT INTO customer_credit_allocations (
            organization_id, branch_id, customer_id, source_transaction_id, sale_id, amount_minor
          ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [auth.organizationId, sale.branch_id, sale.customer_id, credit.rows[0]!.id, sale.id, appliedCredit.toString()]
        );
      }
      const allocated = await tx.query<{ allocated: string }>(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS allocated
         FROM customer_credit_allocations
         WHERE organization_id = $1 AND sale_id = $2`,
        [auth.organizationId, sale.id]
      );
      const remaining = BigInt(payment.rows[0]!.amount_minor) - BigInt(allocated.rows[0]!.allocated);
      await tx.query(
        `UPDATE sale_payments SET status = $3
         WHERE id = $1 AND organization_id = $2`,
        [payment.rows[0]!.id, auth.organizationId, remaining <= 0n ? 'paid' : remaining === BigInt(payment.rows[0]!.amount_minor) ? 'outstanding' : 'partially_paid']
      );
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: sale.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'pos.sale-return-posted',
      entityType: 'sale_return',
      entityId: id,
      metadata: { saleId: sale.id, returnNumber, refundable: minorUnitsToDecimal(refundable), reason: input.reason },
      ...requestMeta(req)
    });
    await reconcileLoyalty(tx,auth.organizationId,sale.id);
    return id;
  });
  const sale = await getSale(pool, auth, saleId);
  return { sale, saleReturn: sale.returns.find((item) => item.id === returnId)! };
}

export async function createSaleRefund(pool: pg.Pool, auth: AuthContext, saleId: string, input: CreateSaleRefundInput, req: Request) {
  const refundId = await withTransaction(pool, async (tx) => {
    const saleResult = await tx.query<{ id: string; branch_id: string; status: string; receipt_number: string }>(
      `SELECT id, branch_id, status, receipt_number FROM sales
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [saleId, auth.organizationId]
    );
    const sale = saleResult.rows[0];
    if (!sale) throw notFound('Sale was not found');
    await ensureBranch(tx, auth, sale.branch_id);
    if (sale.status === 'voided') throw conflict('SALE_NOT_REFUNDABLE', 'A voided sale cannot be refunded');
    const session = await lockSession(tx, auth, input.registerSessionId);
    assertSessionOperator(auth, session);
    if (session.status !== 'open') throw conflict('REGISTER_SESSION_CLOSED', 'Cash refunds require an open register session');
    if (session.branch_id !== sale.branch_id) throw forbidden('BRANCH_ACCESS_DENIED', 'The refund drawer must belong to the sale branch');
    const payment = await tx.query<{ id: string; amount_minor: string; status: string }>(
      `SELECT id, amount_minor::text, status FROM sale_payments
       WHERE sale_id = $1 AND organization_id = $2 AND method = 'cash'
       ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [sale.id, auth.organizationId]
    );
    const cashPayment = payment.rows[0];
    if (!cashPayment || cashPayment.status === 'voided') throw conflict('PAYMENT_NOT_REFUNDABLE', 'No refundable cash payment exists for this sale');
    const requested = decimalToMinorUnits(input.amount);
    const allRefunds = await tx.query('SELECT COALESCE(SUM(amount_minor),0)::text AS total FROM sale_refunds WHERE organization_id=$1 AND sale_id=$2',[auth.organizationId,sale.id]);
    if (requested>BigInt(cashPayment.amount_minor)-BigInt(allRefunds.rows[0].total)) throw conflict('REFUND_LIMIT_EXCEEDED','The refund exceeds the remaining cash paid. Redeemed loyalty points are restored when items are returned.');
    let eligible: bigint;
    if (input.saleReturnId) {
      const saleReturn = await tx.query<{ refundable_total_minor: string }>(
        `SELECT refundable_total_minor::text FROM sale_returns
         WHERE id = $1 AND sale_id = $2 AND organization_id = $3 FOR UPDATE`,
        [input.saleReturnId, sale.id, auth.organizationId]
      );
      if (!saleReturn.rows[0]) throw badRequest('VALIDATION_ERROR', 'The selected return does not belong to this sale');
      const refunded = await tx.query<{ refunded: string }>(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS refunded FROM sale_refunds
         WHERE organization_id = $1 AND sale_return_id = $2`,
        [auth.organizationId, input.saleReturnId]
      );
      eligible = BigInt(saleReturn.rows[0]!.refundable_total_minor) - BigInt(refunded.rows[0]!.refunded);
    } else {
      const refunded = await tx.query<{ refunded: string }>(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS refunded FROM sale_refunds
         WHERE organization_id = $1 AND sale_id = $2`,
        [auth.organizationId, sale.id]
      );
      eligible = BigInt(cashPayment.amount_minor) - BigInt(refunded.rows[0]!.refunded);
    }
    if (requested > eligible || eligible <= 0n) {
      throw conflict('REFUND_LIMIT_EXCEEDED', 'The requested refund exceeds the eligible refundable amount');
    }
    const refund = await tx.query<{ id: string }>(
      `INSERT INTO sale_refunds (
        organization_id, branch_id, sale_id, sale_return_id, register_session_id,
        sale_payment_id, method, amount_minor, status, reason, authorized_by_membership_id
      ) VALUES ($1,$2,$3,$4,$5,$6,'cash',$7,'completed',$8,$9) RETURNING id`,
      [auth.organizationId, sale.branch_id, sale.id, input.saleReturnId ?? null, session.id, cashPayment.id, requested.toString(), input.reason, auth.membershipId]
    );
    await tx.query(
      `INSERT INTO cash_movements (
        organization_id, branch_id, register_session_id, movement_type, direction,
        amount_minor, reason, reference_type, reference_id, actor_membership_id
      ) VALUES ($1,$2,$3,'sale_refund','out',$4,$5,'sale_refund',$6,$7)`,
      [auth.organizationId, sale.branch_id, session.id, requested.toString(), `Refund for ${sale.receipt_number}: ${input.reason}`, refund.rows[0]!.id, auth.membershipId]
    );
    const refundedNow = await tx.query<{ refunded: string }>(
      'SELECT COALESCE(SUM(amount_minor),0)::text AS refunded FROM sale_refunds WHERE organization_id = $1 AND sale_id = $2',
      [auth.organizationId, sale.id]
    );
    await tx.query(
      `UPDATE sale_payments SET status = $3 WHERE id = $1 AND organization_id = $2`,
      [cashPayment.id, auth.organizationId, BigInt(refundedNow.rows[0]!.refunded) >= BigInt(cashPayment.amount_minor) ? 'refunded' : 'partially_refunded']
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: sale.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'pos.sale-refund-completed',
      entityType: 'sale_refund',
      entityId: refund.rows[0]!.id,
      metadata: { saleId: sale.id, receiptNumber: sale.receipt_number, amount: input.amount, reason: input.reason },
      ...requestMeta(req)
    });
    await reconcileLoyalty(tx,auth.organizationId,sale.id);
    return refund.rows[0]!.id;
  });
  const sale = await getSale(pool, auth, saleId);
  return { sale, refund: sale.refunds.find((item) => item.id === refundId)! };
}
