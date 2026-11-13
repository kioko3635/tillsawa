import type {
  CancelPurchaseOrderInput,
  CreatePurchaseOrderInput,
  CreateSupplierInput,
  CreateSupplierInvoiceInput,
  PurchaseOrderQuery,
  RecordSupplierPaymentInput,
  ReceivePurchaseOrderInput,
  SupplierInvoiceQuery,
  SupplierQuery,
  UpdateSupplierInput
} from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import type { Queryable } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { listAccessibleBranchIds, membershipHasBranchAccess } from '../../http/middleware/auth.js';
import type { AuthContext } from '../../http/middleware/auth.js';
import { requestPayloadHash } from '../../http/middleware/idempotency.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { decimalToMinorUnits, minorUnitsToDecimal, multiplyMinorByQuantity } from '../../shared/money.js';
import { recordAudit } from '../audit/audit.js';
import { getInventoryProduct, postMovement, toBaseQuantity } from '../inventory/service.js';

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

function mapSupplier(row: Record<string, unknown>) {
  const invoiced = BigInt(String(row.invoiced_minor ?? 0));
  const allocated = BigInt(String(row.allocated_minor ?? 0));
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    taxPin: row.tax_pin,
    supplierReference: row.supplier_reference,
    paymentTermsDays: row.payment_terms_days,
    status: row.status,
    notes: row.notes,
    outstandingBalance: minorUnitsToDecimal(invoiced - allocated),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPurchaseOrder(row: Record<string, unknown>, lines: Array<Record<string, unknown>> = []) {
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code ?? null,
    supplierName: row.supplier_name ?? null,
    poNumber: row.po_number,
    clientTransactionId: row.client_transaction_id,
    status: row.status,
    expectedDeliveryDate: row.expected_delivery_date,
    supplierReference: row.supplier_reference,
    notes: row.notes,
    total: minorUnitsToDecimal(String(row.total_minor)),
    createdByName: row.created_by_name ?? null,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      productId: line.product_id,
      productSku: line.product_sku,
      productName: line.product_name,
      unitId: line.unit_id,
      unitCode: line.unit_code,
      orderedQty: String(line.ordered_qty),
      baseOrderedQty: String(line.base_ordered_qty),
      unitCost: minorUnitsToDecimal(String(line.unit_cost_minor)),
      lineTotal: minorUnitsToDecimal(String(line.line_total_minor)),
      receivedQty: String(line.received_qty),
      damagedQty: String(line.damaged_qty),
      rejectedQty: String(line.rejected_qty),
      remainingQty: String(line.remaining_qty ?? line.ordered_qty)
    }))
  };
}

function mapReceipt(row: Record<string, unknown>, lines: Array<Record<string, unknown>> = []) {
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    receiptNumber: row.receipt_number,
    status: row.status,
    notes: row.notes,
    receivedByName: row.received_by_name ?? null,
    receivedAt: row.received_at,
    lines: lines.map((line) => ({
      id: line.id,
      purchaseOrderLineId: line.purchase_order_line_id,
      productId: line.product_id,
      productSku: line.product_sku,
      productName: line.product_name,
      unitCode: line.unit_code,
      orderedQty: String(line.ordered_qty),
      receivedQty: String(line.received_qty),
      damagedQty: String(line.damaged_qty),
      rejectedQty: String(line.rejected_qty),
      discrepancyReason: line.discrepancy_reason
    }))
  };
}

function mapInvoice(row: Record<string, unknown>) {
  const amount = BigInt(String(row.amount_minor));
  const allocated = BigInt(String(row.allocated_minor ?? 0));
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code ?? null,
    supplierName: row.supplier_name ?? null,
    purchaseOrderId: row.purchase_order_id,
    poNumber: row.po_number ?? null,
    invoiceNumber: row.invoice_number,
    amount: minorUnitsToDecimal(amount),
    allocated: minorUnitsToDecimal(allocated),
    outstanding: minorUnitsToDecimal(amount - allocated),
    status: row.status,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function lockSupplier(db: Queryable, auth: AuthContext, supplierId: string, requireActive = false) {
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM suppliers WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [supplierId, auth.organizationId]
  );
  const supplier = result.rows[0];
  if (!supplier) throw notFound('Supplier was not found');
  if (requireActive && supplier.status !== 'active') throw conflict('SUPPLIER_INACTIVE', 'An inactive supplier cannot be used');
  return supplier;
}

export async function listSuppliers(pool: pg.Pool, auth: AuthContext, query: SupplierQuery) {
  const branchIds = await accessibleBranchIds(pool, auth);
  const values: unknown[] = [auth.organizationId];
  const where = ['s.organization_id = $1'];
  if (query.search) {
    values.push(`%${query.search}%`);
    where.push(`(s.name ILIKE $${values.length} OR s.code ILIKE $${values.length} OR COALESCE(s.supplier_reference, '') ILIKE $${values.length})`);
  }
  if (query.status) {
    values.push(query.status);
    where.push(`s.status = $${values.length}`);
  }
  const offset = (query.page - 1) * query.pageSize;
  const totalResult = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM suppliers s WHERE ${where.join(' AND ')}`, values);
  const listValues = [...values, branchIds, query.pageSize, offset];
  const branchParam = values.length + 1;
  const result = await pool.query(
    `SELECT s.*, COALESCE(SUM(si.amount_minor),0)::text AS invoiced_minor,
            COALESCE((SELECT SUM(a.amount_minor) FROM supplier_payment_allocations a
              JOIN supplier_invoices i ON i.id = a.supplier_invoice_id AND i.organization_id = a.organization_id
              WHERE i.supplier_id = s.id AND i.organization_id = s.organization_id AND i.branch_id = ANY($${branchParam}::uuid[])),0)::text AS allocated_minor
     FROM suppliers s
     LEFT JOIN supplier_invoices si ON si.supplier_id = s.id AND si.organization_id = s.organization_id AND si.branch_id = ANY($${branchParam}::uuid[]) AND si.status <> 'voided'
     WHERE ${where.join(' AND ')}
     GROUP BY s.id
     ORDER BY s.name
     LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
    listValues
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  return { items: result.rows.map(mapSupplier), page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) };
}

export async function createSupplier(pool: pg.Pool, auth: AuthContext, input: CreateSupplierInput, req: Request) {
  try {
    const result = await withTransaction(pool, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO suppliers (
          organization_id, code, name, contact_person, phone, email, address, tax_pin,
          supplier_reference, payment_terms_days, status, notes, created_by_membership_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id`,
        [auth.organizationId, input.code.toUpperCase(), input.name.trim(), input.contactPerson ?? null, input.phone ?? null, input.email ?? null, input.address ?? null, input.taxPin ?? null, input.supplierReference ?? null, input.paymentTermsDays, input.status, input.notes ?? null, auth.membershipId]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'procurement.supplier-created',
        entityType: 'supplier',
        entityId: inserted.rows[0]!.id,
        metadata: { code: input.code, name: input.name },
        ...requestMeta(req)
      });
      return inserted.rows[0]!.id;
    });
    return getSupplier(pool, auth, result);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('SUPPLIER_CODE_TAKEN', 'A supplier with this code already exists');
    throw error;
  }
}

export async function getSupplier(pool: pg.Pool, auth: AuthContext, supplierId: string) {
  const branchIds = await accessibleBranchIds(pool, auth);
  const result = await pool.query(
    `SELECT s.*, COALESCE(SUM(si.amount_minor),0)::text AS invoiced_minor,
            COALESCE((SELECT SUM(a.amount_minor) FROM supplier_payment_allocations a
              JOIN supplier_invoices i ON i.id = a.supplier_invoice_id AND i.organization_id = a.organization_id
              WHERE i.supplier_id = s.id AND i.organization_id = s.organization_id AND i.branch_id = ANY($3::uuid[])),0)::text AS allocated_minor
     FROM suppliers s
     LEFT JOIN supplier_invoices si ON si.supplier_id = s.id AND si.organization_id = s.organization_id AND si.branch_id = ANY($3::uuid[]) AND si.status <> 'voided'
     WHERE s.id = $1 AND s.organization_id = $2
     GROUP BY s.id`,
    [supplierId, auth.organizationId, branchIds]
  );
  if (!result.rows[0]) throw notFound('Supplier was not found');
  return mapSupplier(result.rows[0]!);
}

export async function updateSupplier(pool: pg.Pool, auth: AuthContext, supplierId: string, input: UpdateSupplierInput, req: Request) {
  const fields: Record<string, string> = {
    code: 'code',
    name: 'name',
    contactPerson: 'contact_person',
    phone: 'phone',
    email: 'email',
    address: 'address',
    taxPin: 'tax_pin',
    supplierReference: 'supplier_reference',
    paymentTermsDays: 'payment_terms_days',
    status: 'status',
    notes: 'notes'
  };
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(fields)) {
    const value = input[key as keyof UpdateSupplierInput];
    if (value === undefined) continue;
    values.push(key === 'code' ? String(value).toUpperCase() : value);
    updates.push(`${column} = $${values.length + 2}`);
  }
  try {
    await withTransaction(pool, async (tx) => {
      const existing = await tx.query('SELECT id FROM suppliers WHERE id = $1 AND organization_id = $2 FOR UPDATE', [supplierId, auth.organizationId]);
      if (!existing.rows[0]) throw notFound('Supplier was not found');
      await tx.query(
        `UPDATE suppliers SET ${updates.join(', ')} WHERE id = $1 AND organization_id = $2`,
        [supplierId, auth.organizationId, ...values]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'procurement.supplier-updated',
        entityType: 'supplier',
        entityId: supplierId,
        metadata: input as Record<string, unknown>,
        ...requestMeta(req)
      });
    });
    return getSupplier(pool, auth, supplierId);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('SUPPLIER_CODE_TAKEN', 'A supplier with this code already exists');
    throw error;
  }
}

async function purchaseOrderLines(db: Queryable, organizationId: string, purchaseOrderId: string) {
  const result = await db.query(
    `SELECT *, (ordered_qty - received_qty - damaged_qty - rejected_qty)::text AS remaining_qty
     FROM purchase_order_lines
     WHERE purchase_order_id = $1 AND organization_id = $2
     ORDER BY created_at, id`,
    [purchaseOrderId, organizationId]
  );
  return result.rows;
}

export async function getPurchaseOrder(pool: pg.Pool, auth: AuthContext, purchaseOrderId: string) {
  const result = await pool.query(
    `SELECT po.*, b.name AS branch_name, s.code AS supplier_code, s.name AS supplier_name,
            u.display_name AS created_by_name
     FROM purchase_orders po
     JOIN branches b ON b.id = po.branch_id AND b.organization_id = po.organization_id
     JOIN suppliers s ON s.id = po.supplier_id AND s.organization_id = po.organization_id
     JOIN memberships m ON m.id = po.created_by_membership_id AND m.organization_id = po.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE po.id = $1 AND po.organization_id = $2`,
    [purchaseOrderId, auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw notFound('Purchase order was not found');
  await ensureBranch(pool, auth, row.branch_id);
  const receipts = await pool.query(
    `SELECT gr.*, u.display_name AS received_by_name
     FROM goods_receipts gr
     JOIN memberships m ON m.id = gr.received_by_membership_id AND m.organization_id = gr.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE gr.purchase_order_id = $1 AND gr.organization_id = $2
     ORDER BY gr.received_at`,
    [purchaseOrderId, auth.organizationId]
  );
  const receiptLines = await pool.query(
    `SELECT gl.*, pl.product_sku, pl.product_name, pl.unit_code
     FROM goods_receipt_lines gl
     JOIN purchase_order_lines pl ON pl.id = gl.purchase_order_line_id AND pl.organization_id = gl.organization_id
     WHERE gl.organization_id = $1 AND gl.goods_receipt_id = ANY($2::uuid[])
     ORDER BY gl.created_at`,
    [auth.organizationId, receipts.rows.map((receipt) => receipt.id)]
  );
  return {
    purchaseOrder: mapPurchaseOrder(row, await purchaseOrderLines(pool, auth.organizationId, purchaseOrderId)),
    receipts: receipts.rows.map((receipt) => mapReceipt(receipt, receiptLines.rows.filter((line) => line.goods_receipt_id === receipt.id)))
  };
}

export async function listPurchaseOrders(pool: pg.Pool, auth: AuthContext, query: PurchaseOrderQuery) {
  const branchIds = query.branchId ? [query.branchId] : await accessibleBranchIds(pool, auth);
  if (query.branchId) await ensureBranch(pool, auth, query.branchId);
  const values: unknown[] = [auth.organizationId, branchIds];
  const where = ['po.organization_id = $1', 'po.branch_id = ANY($2::uuid[])'];
  if (query.supplierId) {
    values.push(query.supplierId);
    where.push(`po.supplier_id = $${values.length}`);
  }
  if (query.status) {
    values.push(query.status);
    where.push(`po.status = $${values.length}`);
  }
  if (query.search) {
    values.push(`%${query.search}%`);
    where.push(`(po.po_number ILIKE $${values.length} OR s.name ILIKE $${values.length} OR COALESCE(po.supplier_reference, '') ILIKE $${values.length})`);
  }
  const offset = (query.page - 1) * query.pageSize;
  const totalResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id AND s.organization_id = po.organization_id WHERE ${where.join(' AND ')}`,
    values
  );
  values.push(query.pageSize, offset);
  const result = await pool.query(
    `SELECT po.*, b.name AS branch_name, s.code AS supplier_code, s.name AS supplier_name,
            u.display_name AS created_by_name
     FROM purchase_orders po
     JOIN branches b ON b.id = po.branch_id AND b.organization_id = po.organization_id
     JOIN suppliers s ON s.id = po.supplier_id AND s.organization_id = po.organization_id
     JOIN memberships m ON m.id = po.created_by_membership_id AND m.organization_id = po.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY po.created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  return { items: result.rows.map((row) => mapPurchaseOrder(row)), page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) };
}

export async function createPurchaseOrder(pool: pg.Pool, auth: AuthContext, input: CreatePurchaseOrderInput, req: Request) {
  const payloadHash = requestPayloadHash(input);
  const existing = await pool.query<{ id: string; client_payload_hash: string | null }>(
    'SELECT id, client_payload_hash FROM purchase_orders WHERE organization_id = $1 AND client_transaction_id = $2',
    [auth.organizationId, input.clientTransactionId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0]!.client_payload_hash !== payloadHash) throw conflict('PURCHASE_ORDER_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different purchase order');
    return { ...(await getPurchaseOrder(pool, auth, existing.rows[0]!.id)), replayed: true };
  }
  let purchaseOrderId: string;
  try {
    purchaseOrderId = await withTransaction(pool, async (tx) => {
      await ensureBranch(tx, auth, input.branchId);
      await lockSupplier(tx, auth, input.supplierId, true);
      const poNumber = await nextDocumentNumber(tx, auth.organizationId, 'PURCHASE-ORDER', 'PO');
      const po = await tx.query<{ id: string }>(
        `INSERT INTO purchase_orders (
          organization_id, branch_id, supplier_id, po_number, client_transaction_id,
          client_payload_hash, expected_delivery_date, supplier_reference, notes,
          created_by_membership_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id`,
        [auth.organizationId, input.branchId, input.supplierId, poNumber, input.clientTransactionId, payloadHash, input.expectedDeliveryDate ?? null, input.supplierReference ?? null, input.notes ?? null, auth.membershipId]
      );
      const id = po.rows[0]!.id;
      let total = 0n;
      for (const line of input.lines) {
        const product = await getInventoryProduct(tx, auth.organizationId, line.productId);
        const unitId = line.unitId ?? product.base_unit_id;
        const unit = await tx.query<{ code: string }>('SELECT code FROM units_of_measure WHERE id = $1 AND organization_id = $2', [unitId, auth.organizationId]);
        if (!unit.rows[0]) throw badRequest('VALIDATION_ERROR', 'Purchase unit is not valid for this organization');
        const baseQuantity = await toBaseQuantity(tx, auth.organizationId, product, unitId, line.quantity);
        const unitCost = decimalToMinorUnits(line.unitCost);
        const lineTotal = multiplyMinorByQuantity(unitCost, line.quantity);
        total += lineTotal;
        await tx.query(
          `INSERT INTO purchase_order_lines (
            organization_id, purchase_order_id, product_id, product_sku, product_name,
            unit_id, unit_code, ordered_qty, base_ordered_qty, unit_cost_minor, line_total_minor
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10,$11)`,
          [auth.organizationId, id, product.id, product.sku, product.name, unitId, unit.rows[0]!.code, line.quantity, baseQuantity, unitCost.toString(), lineTotal.toString()]
        );
      }
      await tx.query('UPDATE purchase_orders SET total_minor = $3 WHERE id = $1 AND organization_id = $2', [id, auth.organizationId, total.toString()]);
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: input.branchId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'procurement.purchase-order-created',
        entityType: 'purchase_order',
        entityId: id,
        metadata: { poNumber, supplierId: input.supplierId, total: minorUnitsToDecimal(total), lines: input.lines.length },
        ...requestMeta(req)
      });
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await pool.query<{ id: string; client_payload_hash: string }>(
        'SELECT id, client_payload_hash FROM purchase_orders WHERE organization_id = $1 AND client_transaction_id = $2',
        [auth.organizationId, input.clientTransactionId]
      );
      if (replayed.rows[0]?.client_payload_hash === payloadHash) return { ...(await getPurchaseOrder(pool, auth, replayed.rows[0]!.id)), replayed: true };
      throw conflict('PURCHASE_ORDER_IDENTIFIER_CONFLICT', 'The purchase-order number or client transaction identifier conflicts with an existing order');
    }
    throw error;
  }
  return { ...(await getPurchaseOrder(pool, auth, purchaseOrderId)), replayed: false };
}

async function transitionPurchaseOrder(
  pool: pg.Pool,
  auth: AuthContext,
  purchaseOrderId: string,
  action: 'submit' | 'approve' | 'cancel',
  input: CancelPurchaseOrderInput | undefined,
  req: Request
) {
  await withTransaction(pool, async (tx) => {
    const result = await tx.query<{ id: string; branch_id: string; status: string; po_number: string }>(
      'SELECT id, branch_id, status, po_number FROM purchase_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [purchaseOrderId, auth.organizationId]
    );
    const po = result.rows[0];
    if (!po) throw notFound('Purchase order was not found');
    await ensureBranch(tx, auth, po.branch_id);
    if (action === 'submit') {
      if (po.status !== 'draft') throw conflict('PURCHASE_ORDER_STATE_INVALID', 'Only a draft purchase order can be submitted');
      await tx.query(`UPDATE purchase_orders SET status = 'submitted', submitted_by_membership_id = $3, submitted_at = now() WHERE id = $1 AND organization_id = $2`, [po.id, auth.organizationId, auth.membershipId]);
    } else if (action === 'approve') {
      if (po.status !== 'submitted') throw conflict('PURCHASE_ORDER_STATE_INVALID', 'Only a submitted purchase order can be approved');
      await tx.query(`UPDATE purchase_orders SET status = 'approved', approved_by_membership_id = $3, approved_at = now() WHERE id = $1 AND organization_id = $2`, [po.id, auth.organizationId, auth.membershipId]);
    } else {
      if (!['draft', 'submitted', 'approved'].includes(po.status)) throw conflict('PURCHASE_ORDER_STATE_INVALID', 'A purchase order with receipts cannot be cancelled');
      await tx.query(`UPDATE purchase_orders SET status = 'cancelled', cancelled_by_membership_id = $3, cancelled_at = now(), cancellation_reason = $4 WHERE id = $1 AND organization_id = $2`, [po.id, auth.organizationId, auth.membershipId, input!.reason]);
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: po.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: `procurement.purchase-order-${action === 'submit' ? 'submitted' : action === 'approve' ? 'approved' : 'cancelled'}`,
      entityType: 'purchase_order',
      entityId: po.id,
      metadata: { poNumber: po.po_number, reason: input?.reason ?? null },
      ...requestMeta(req)
    });
  });
  return getPurchaseOrder(pool, auth, purchaseOrderId);
}

export function submitPurchaseOrder(pool: pg.Pool, auth: AuthContext, purchaseOrderId: string, req: Request) {
  return transitionPurchaseOrder(pool, auth, purchaseOrderId, 'submit', undefined, req);
}
export function approvePurchaseOrder(pool: pg.Pool, auth: AuthContext, purchaseOrderId: string, req: Request) {
  return transitionPurchaseOrder(pool, auth, purchaseOrderId, 'approve', undefined, req);
}
export function cancelPurchaseOrder(pool: pg.Pool, auth: AuthContext, purchaseOrderId: string, input: CancelPurchaseOrderInput, req: Request) {
  return transitionPurchaseOrder(pool, auth, purchaseOrderId, 'cancel', input, req);
}

export async function receivePurchaseOrder(pool: pg.Pool, auth: AuthContext, purchaseOrderId: string, input: ReceivePurchaseOrderInput, req: Request) {
  const payloadHash = requestPayloadHash({ purchaseOrderId, ...input });
  const existing = await pool.query<{ id: string; client_payload_hash: string | null }>(
    'SELECT id, client_payload_hash FROM goods_receipts WHERE organization_id = $1 AND client_transaction_id = $2',
    [auth.organizationId, input.clientTransactionId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0]!.client_payload_hash !== payloadHash) throw conflict('RECEIPT_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different receipt');
    return { ...(await getPurchaseOrder(pool, auth, purchaseOrderId)), replayed: true };
  }
  let receiptId: string;
  try {
    receiptId = await withTransaction(pool, async (tx) => {
      const poResult = await tx.query<{ id: string; branch_id: string; status: string; po_number: string }>(
        'SELECT id, branch_id, status, po_number FROM purchase_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [purchaseOrderId, auth.organizationId]
      );
      const po = poResult.rows[0];
      if (!po) throw notFound('Purchase order was not found');
      await ensureBranch(tx, auth, po.branch_id);
      if (!['approved', 'partially_received'].includes(po.status)) throw conflict('PURCHASE_ORDER_NOT_RECEIVABLE', 'Only an approved purchase order can receive goods');
      const receiptNumber = await nextDocumentNumber(tx, auth.organizationId, 'GOODS-RECEIPT', 'GRN');
      const receipt = await tx.query<{ id: string }>(
        `INSERT INTO goods_receipts (
          organization_id, branch_id, purchase_order_id, receipt_number, client_transaction_id,
          client_payload_hash, notes, received_by_membership_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id`,
        [auth.organizationId, po.branch_id, po.id, receiptNumber, input.clientTransactionId, payloadHash, input.notes ?? null, auth.membershipId]
      );
      const id = receipt.rows[0]!.id;
      for (const requested of input.lines) {
        const lineResult = await tx.query<Record<string, unknown>>(
          `SELECT * FROM purchase_order_lines
           WHERE id = $1 AND purchase_order_id = $2 AND organization_id = $3
           FOR UPDATE`,
          [requested.purchaseOrderLineId, po.id, auth.organizationId]
        );
        const line = lineResult.rows[0];
        if (!line) throw badRequest('VALIDATION_ERROR', 'A receipt line does not belong to this purchase order');
        const quantities = await tx.query<{ valid: boolean; base_received: string }>(
          `SELECT ($1::numeric + $2::numeric + $3::numeric > 0
                   AND $1::numeric + $2::numeric + $3::numeric <= ($4::numeric - $5::numeric - $6::numeric - $7::numeric)) AS valid,
                  ($1::numeric * ($8::numeric / NULLIF($4::numeric,0)))::text AS base_received`,
          [requested.receivedQty, requested.damagedQty, requested.rejectedQty, line.ordered_qty, line.received_qty, line.damaged_qty, line.rejected_qty, line.base_ordered_qty]
        );
        if (!quantities.rows[0]?.valid) throw conflict('RECEIPT_QUANTITY_EXCEEDED', 'Receipt quantities exceed the remaining ordered quantity');
        const lineTotal = multiplyMinorByQuantity(BigInt(String(line.unit_cost_minor)), requested.receivedQty);
        await tx.query(
          `INSERT INTO goods_receipt_lines (
            organization_id, goods_receipt_id, purchase_order_id, purchase_order_line_id, product_id,
            unit_id, ordered_qty, received_qty, damaged_qty, rejected_qty, base_received_qty,
            unit_cost_minor, line_total_minor, discrepancy_reason
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::numeric,$11::numeric,$12,$13,$14)`,
          [auth.organizationId, id, po.id, line.id, line.product_id, line.unit_id, line.ordered_qty, requested.receivedQty, requested.damagedQty, requested.rejectedQty, quantities.rows[0]!.base_received, line.unit_cost_minor, lineTotal.toString(), requested.discrepancyReason ?? null]
        );
        await tx.query(
          `UPDATE purchase_order_lines
           SET received_qty = received_qty + $3::numeric,
               damaged_qty = damaged_qty + $4::numeric,
               rejected_qty = rejected_qty + $5::numeric
           WHERE id = $1 AND organization_id = $2`,
          [line.id, auth.organizationId, requested.receivedQty, requested.damagedQty, requested.rejectedQty]
        );
        if (Number(requested.receivedQty) > 0) {
          const product = await getInventoryProduct(tx, auth.organizationId, line.product_id as string, true);
          const perBaseCost = await tx.query<{ cost: string }>(
            `SELECT ROUND($1::bigint * $2::numeric / NULLIF($3::numeric,0))::bigint::text AS cost`,
            [line.unit_cost_minor, line.ordered_qty, line.base_ordered_qty]
          );
          await postMovement(tx, auth, {
            branchId: po.branch_id,
            product,
            unitId: line.unit_id as string,
            quantity: requested.receivedQty,
            baseQuantity: quantities.rows[0]!.base_received,
            movementType: 'purchase_receipt',
            referenceType: 'goods_receipt',
            referenceId: id,
            unitCostMinor: BigInt(perBaseCost.rows[0]!.cost),
            reason: `Receipt ${receiptNumber} for ${po.po_number}`
          });
        }
      }
      const status = await tx.query<{ complete: boolean }>(
        `SELECT NOT EXISTS (
           SELECT 1 FROM purchase_order_lines
           WHERE purchase_order_id = $1 AND organization_id = $2
             AND received_qty + damaged_qty + rejected_qty < ordered_qty
         ) AS complete`,
        [po.id, auth.organizationId]
      );
      await tx.query(
        'UPDATE purchase_orders SET status = $3 WHERE id = $1 AND organization_id = $2',
        [po.id, auth.organizationId, status.rows[0]!.complete ? 'received' : 'partially_received']
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: po.branch_id,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'procurement.goods-receipt-posted',
        entityType: 'goods_receipt',
        entityId: id,
        metadata: { poNumber: po.po_number, receiptNumber, lines: input.lines.length },
        ...requestMeta(req)
      });
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await pool.query<{ id: string; purchase_order_id: string; client_payload_hash: string }>(
        'SELECT id, purchase_order_id, client_payload_hash FROM goods_receipts WHERE organization_id = $1 AND client_transaction_id = $2',
        [auth.organizationId, input.clientTransactionId]
      );
      if (replayed.rows[0]?.client_payload_hash === payloadHash) return { ...(await getPurchaseOrder(pool, auth, replayed.rows[0]!.purchase_order_id)), replayed: true };
      throw conflict('RECEIPT_IDENTIFIER_CONFLICT', 'The receipt number or client transaction identifier conflicts with an existing receipt');
    }
    throw error;
  }
  void receiptId;
  return { ...(await getPurchaseOrder(pool, auth, purchaseOrderId)), replayed: false };
}

export async function createSupplierInvoice(pool: pg.Pool, auth: AuthContext, input: CreateSupplierInvoiceInput, req: Request) {
  const payloadHash = requestPayloadHash(input);
  const existing = await pool.query<{ id: string; client_payload_hash: string | null }>(
    'SELECT id, client_payload_hash FROM supplier_invoices WHERE organization_id = $1 AND client_transaction_id = $2',
    [auth.organizationId, input.clientTransactionId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0]!.client_payload_hash !== payloadHash) throw conflict('SUPPLIER_INVOICE_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different invoice');
    return { invoice: await getSupplierInvoice(pool, auth, existing.rows[0]!.id), replayed: true };
  }
  let invoiceId: string;
  try {
    invoiceId = await withTransaction(pool, async (tx) => {
      await ensureBranch(tx, auth, input.branchId);
      await lockSupplier(tx, auth, input.supplierId, true);
      if (input.purchaseOrderId) {
        const po = await tx.query<{ branch_id: string; supplier_id: string; status: string }>(
          'SELECT branch_id, supplier_id, status FROM purchase_orders WHERE id = $1 AND organization_id = $2',
          [input.purchaseOrderId, auth.organizationId]
        );
        if (!po.rows[0] || po.rows[0]!.branch_id !== input.branchId || po.rows[0]!.supplier_id !== input.supplierId || po.rows[0]!.status === 'cancelled') {
          throw badRequest('VALIDATION_ERROR', 'The selected purchase order is not valid for this supplier invoice');
        }
      }
      const invoice = await tx.query<{ id: string }>(
        `INSERT INTO supplier_invoices (
          organization_id, branch_id, supplier_id, purchase_order_id, invoice_number,
          client_transaction_id, client_payload_hash, amount_minor, issue_date, due_date,
          notes, created_by_membership_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, CURRENT_DATE),$10,$11,$12)
        RETURNING id`,
        [auth.organizationId, input.branchId, input.supplierId, input.purchaseOrderId ?? null, input.invoiceNumber.trim(), input.clientTransactionId, payloadHash, decimalToMinorUnits(input.amount).toString(), input.issueDate ?? null, input.dueDate ?? null, input.notes ?? null, auth.membershipId]
      );
      const id = invoice.rows[0]!.id;
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: input.branchId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'procurement.supplier-invoice-recorded',
        entityType: 'supplier_invoice',
        entityId: id,
        metadata: { supplierId: input.supplierId, invoiceNumber: input.invoiceNumber, amount: input.amount },
        ...requestMeta(req)
      });
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await pool.query<{ id: string; client_payload_hash: string }>(
        'SELECT id, client_payload_hash FROM supplier_invoices WHERE organization_id = $1 AND client_transaction_id = $2',
        [auth.organizationId, input.clientTransactionId]
      );
      if (replayed.rows[0]?.client_payload_hash === payloadHash) return { invoice: await getSupplierInvoice(pool, auth, replayed.rows[0]!.id), replayed: true };
      throw conflict('SUPPLIER_INVOICE_IDENTIFIER_CONFLICT', 'The supplier invoice number or client transaction identifier conflicts with an existing invoice');
    }
    throw error;
  }
  return { invoice: await getSupplierInvoice(pool, auth, invoiceId), replayed: false };
}

export async function getSupplierInvoice(pool: pg.Pool, auth: AuthContext, invoiceId: string) {
  const result = await pool.query(
    `SELECT si.*, b.name AS branch_name, s.code AS supplier_code, s.name AS supplier_name,
            po.po_number, COALESCE(SUM(a.amount_minor),0)::text AS allocated_minor
     FROM supplier_invoices si
     JOIN branches b ON b.id = si.branch_id AND b.organization_id = si.organization_id
     JOIN suppliers s ON s.id = si.supplier_id AND s.organization_id = si.organization_id
     LEFT JOIN purchase_orders po ON po.id = si.purchase_order_id AND po.organization_id = si.organization_id
     LEFT JOIN supplier_payment_allocations a ON a.supplier_invoice_id = si.id AND a.organization_id = si.organization_id
     WHERE si.id = $1 AND si.organization_id = $2
     GROUP BY si.id, b.name, s.code, s.name, po.po_number`,
    [invoiceId, auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw notFound('Supplier invoice was not found');
  await ensureBranch(pool, auth, row.branch_id);
  return mapInvoice(row);
}

export async function listSupplierInvoices(pool: pg.Pool, auth: AuthContext, query: SupplierInvoiceQuery) {
  const branchIds = query.branchId ? [query.branchId] : await accessibleBranchIds(pool, auth);
  if (query.branchId) await ensureBranch(pool, auth, query.branchId);
  const values: unknown[] = [auth.organizationId, branchIds];
  const where = ['si.organization_id = $1', 'si.branch_id = ANY($2::uuid[])'];
  if (query.supplierId) {
    values.push(query.supplierId);
    where.push(`si.supplier_id = $${values.length}`);
  }
  if (query.status) {
    values.push(query.status);
    where.push(`si.status = $${values.length}`);
  }
  if (query.search) {
    values.push(`%${query.search}%`);
    where.push(`(si.invoice_number ILIKE $${values.length} OR s.name ILIKE $${values.length} OR COALESCE(po.po_number, '') ILIKE $${values.length})`);
  }
  const offset = (query.page - 1) * query.pageSize;
  const totalResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id AND s.organization_id = si.organization_id LEFT JOIN purchase_orders po ON po.id = si.purchase_order_id AND po.organization_id = si.organization_id WHERE ${where.join(' AND ')}`,
    values
  );
  values.push(query.pageSize, offset);
  const result = await pool.query(
    `SELECT si.*, b.name AS branch_name, s.code AS supplier_code, s.name AS supplier_name,
            po.po_number, COALESCE(SUM(a.amount_minor),0)::text AS allocated_minor
     FROM supplier_invoices si
     JOIN branches b ON b.id = si.branch_id AND b.organization_id = si.organization_id
     JOIN suppliers s ON s.id = si.supplier_id AND s.organization_id = si.organization_id
     LEFT JOIN purchase_orders po ON po.id = si.purchase_order_id AND po.organization_id = si.organization_id
     LEFT JOIN supplier_payment_allocations a ON a.supplier_invoice_id = si.id AND a.organization_id = si.organization_id
     WHERE ${where.join(' AND ')}
     GROUP BY si.id, b.name, s.code, s.name, po.po_number
     ORDER BY si.created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  return { items: result.rows.map(mapInvoice), page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) };
}

export async function getSupplierPayment(pool: pg.Pool, auth: AuthContext, paymentId: string) {
  const result = await pool.query(
    `SELECT sp.*, u.display_name AS paid_by_name
     FROM supplier_payments sp
     JOIN memberships m ON m.id = sp.paid_by_membership_id AND m.organization_id = sp.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE sp.id = $1 AND sp.organization_id = $2`,
    [paymentId, auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw notFound('Supplier payment was not found');
  await ensureBranch(pool, auth, row.branch_id);
  const allocations = await pool.query(
    `SELECT a.*, si.invoice_number
     FROM supplier_payment_allocations a
     JOIN supplier_invoices si ON si.id = a.supplier_invoice_id AND si.organization_id = a.organization_id
     WHERE a.supplier_payment_id = $1 AND a.organization_id = $2`,
    [paymentId, auth.organizationId]
  );
  const allocated = allocations.rows.reduce((sum, line) => sum + BigInt(String(line.amount_minor)), 0n);
  return {
    id: row.id,
    supplierId: row.supplier_id,
    branchId: row.branch_id,
    registerSessionId: row.register_session_id,
    paymentNumber: row.payment_number,
    clientTransactionId: row.client_transaction_id,
    method: row.method,
    amount: minorUnitsToDecimal(String(row.amount_minor)),
    allocated: minorUnitsToDecimal(allocated),
    unallocated: minorUnitsToDecimal(BigInt(String(row.amount_minor)) - allocated),
    status: row.status,
    reason: row.reason,
    paidByName: row.paid_by_name,
    createdAt: row.created_at,
    allocations: allocations.rows.map((line) => ({
      id: line.id,
      supplierInvoiceId: line.supplier_invoice_id,
      invoiceNumber: line.invoice_number,
      amount: minorUnitsToDecimal(String(line.amount_minor)),
      createdAt: line.created_at
    }))
  };
}

export async function recordSupplierPayment(pool: pg.Pool, auth: AuthContext, supplierId: string, input: RecordSupplierPaymentInput, req: Request) {
  const payloadHash = requestPayloadHash({ supplierId, ...input });
  const existing = await pool.query<{ id: string; client_payload_hash: string | null }>(
    'SELECT id, client_payload_hash FROM supplier_payments WHERE organization_id = $1 AND client_transaction_id = $2',
    [auth.organizationId, input.clientTransactionId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0]!.client_payload_hash !== payloadHash) throw conflict('SUPPLIER_PAYMENT_IDENTIFIER_CONFLICT', 'The client transaction identifier was reused with a different payment');
    return { payment: await getSupplierPayment(pool, auth, existing.rows[0]!.id), replayed: true };
  }
  let paymentId: string;
  try {
    paymentId = await withTransaction(pool, async (tx) => {
      await lockSupplier(tx, auth, supplierId, true);
      const session = await tx.query<{ id: string; branch_id: string; status: string; opened_by_membership_id: string }>(
        'SELECT id, branch_id, status, opened_by_membership_id FROM register_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [input.registerSessionId, auth.organizationId]
      );
      const registerSession = session.rows[0];
      if (!registerSession) throw notFound('Register session was not found');
      await ensureBranch(tx, auth, registerSession.branch_id);
      if (registerSession.status !== 'open') throw conflict('REGISTER_SESSION_CLOSED', 'Supplier payments require an open register session');
      if (registerSession.opened_by_membership_id !== auth.membershipId && !auth.permissions.has('registers.manage')) {
        throw forbidden('SESSION_ACCESS_DENIED', 'You can only pay suppliers from your own open drawer');
      }
      const amount = decimalToMinorUnits(input.amount);
      const requested = input.allocations.map((line) => ({ invoiceId: line.supplierInvoiceId, amountMinor: decimalToMinorUnits(line.amount) }));
      const allocationTotal = requested.reduce((sum, line) => sum + line.amountMinor, 0n);
      if (allocationTotal > amount) throw conflict('ALLOCATION_EXCEEDS_PAYMENT', 'Invoice allocations exceed the supplier payment amount');
      for (const allocation of requested) {
        const invoice = await tx.query<{ id: string; amount_minor: string }>(
          `SELECT si.id, si.amount_minor::text
           FROM supplier_invoices si
           WHERE si.id = $1 AND si.organization_id = $2 AND si.supplier_id = $3
             AND si.branch_id = $4 AND si.status <> 'voided'
           FOR UPDATE`,
          [allocation.invoiceId, auth.organizationId, supplierId, registerSession.branch_id]
        );
        const row = invoice.rows[0];
        if (!row) throw badRequest('VALIDATION_ERROR', 'A payment allocation does not reference an eligible supplier invoice in this branch');
        const allocated = await tx.query<{ allocated: string }>(
          `SELECT COALESCE(SUM(amount_minor),0)::text AS allocated
           FROM supplier_payment_allocations
           WHERE supplier_invoice_id = $1 AND organization_id = $2`,
          [allocation.invoiceId, auth.organizationId]
        );
        const remaining = BigInt(row.amount_minor) - BigInt(allocated.rows[0]!.allocated);
        if (allocation.amountMinor > remaining) throw conflict('OVER_ALLOCATION', 'A supplier payment allocation exceeds the invoice outstanding balance');
      }
      const paymentNumber = await nextDocumentNumber(tx, auth.organizationId, 'SUPPLIER-PAYMENT', 'SP');
      const payment = await tx.query<{ id: string }>(
        `INSERT INTO supplier_payments (
          organization_id, branch_id, supplier_id, register_session_id, payment_number,
          client_transaction_id, client_payload_hash, method, amount_minor, status,
          reason, paid_by_membership_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'cash',$8,'completed',$9,$10)
        RETURNING id`,
        [auth.organizationId, registerSession.branch_id, supplierId, registerSession.id, paymentNumber, input.clientTransactionId, payloadHash, amount.toString(), input.reason, auth.membershipId]
      );
      const id = payment.rows[0]!.id;
      for (const allocation of requested) {
        await tx.query(
          `INSERT INTO supplier_payment_allocations (
            organization_id, branch_id, supplier_id, supplier_payment_id, supplier_invoice_id, amount_minor
          ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [auth.organizationId, registerSession.branch_id, supplierId, id, allocation.invoiceId, allocation.amountMinor.toString()]
        );
        await tx.query(
          `UPDATE supplier_invoices si
           SET status = CASE
             WHEN si.amount_minor <= COALESCE((SELECT SUM(a.amount_minor) FROM supplier_payment_allocations a WHERE a.supplier_invoice_id = si.id AND a.organization_id = si.organization_id),0) THEN 'paid'
             WHEN COALESCE((SELECT SUM(a.amount_minor) FROM supplier_payment_allocations a WHERE a.supplier_invoice_id = si.id AND a.organization_id = si.organization_id),0) > 0 THEN 'partially_paid'
             ELSE 'outstanding'
           END
           WHERE si.id = $1 AND si.organization_id = $2`,
          [allocation.invoiceId, auth.organizationId]
        );
      }
      await tx.query(
        `INSERT INTO cash_movements (
          organization_id, branch_id, register_session_id, movement_type, direction,
          amount_minor, reason, reference_type, reference_id, actor_membership_id
        ) VALUES ($1,$2,$3,'supplier_payment','out',$4,$5,'supplier_payment',$6,$7)`,
        [auth.organizationId, registerSession.branch_id, registerSession.id, amount.toString(), `Supplier payment ${paymentNumber}: ${input.reason}`, id, auth.membershipId]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: registerSession.branch_id,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'procurement.supplier-payment-recorded',
        entityType: 'supplier_payment',
        entityId: id,
        metadata: { supplierId, paymentNumber, amount: input.amount, allocations: requested.length },
        ...requestMeta(req)
      });
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayed = await pool.query<{ id: string; client_payload_hash: string }>(
        'SELECT id, client_payload_hash FROM supplier_payments WHERE organization_id = $1 AND client_transaction_id = $2',
        [auth.organizationId, input.clientTransactionId]
      );
      if (replayed.rows[0]?.client_payload_hash === payloadHash) return { payment: await getSupplierPayment(pool, auth, replayed.rows[0]!.id), replayed: true };
      throw conflict('SUPPLIER_PAYMENT_IDENTIFIER_CONFLICT', 'The supplier payment number or client transaction identifier conflicts with an existing payment');
    }
    throw error;
  }
  return { payment: await getSupplierPayment(pool, auth, paymentId), replayed: false };
}
