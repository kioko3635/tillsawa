import { randomUUID } from 'node:crypto';
import type {
  CancelTransferInput,
  CreateAdjustmentInput,
  CreateStockCountInput,
  CreateTransferInput,
  DecideStockCountInput,
  DispatchTransferInput,
  MovementQuery,
  ReceiveTransferInput,
  RecordCountLinesInput,
  StockLevelQuery
} from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import type { Queryable } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { membershipHasBranchAccess } from '../../http/middleware/auth.js';
import type { AuthContext } from '../../http/middleware/auth.js';
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

export interface InventoryProduct {
  id: string;
  sku: string;
  name: string;
  base_unit_id: string;
  item_type: string;
  status: string;
  cost_minor: string;
  costing_method: string;
  track_batch: boolean;
  track_expiry: boolean;
  track_serial: boolean;
}

export async function getInventoryProduct(db: Queryable, organizationId: string, productId: string, allowArchived = false): Promise<InventoryProduct> {
  const result = await db.query<InventoryProduct>(
    `SELECT id, sku, name, base_unit_id, item_type, status, cost_minor::text,
            costing_method, track_batch, track_expiry, track_serial
     FROM products WHERE id = $1 AND organization_id = $2`,
    [productId, organizationId]
  );
  const product = result.rows[0];
  if (!product) throw badRequest('VALIDATION_ERROR', 'Product is not valid for this organization');
  if (product.status !== 'active' && !allowArchived) throw badRequest('VALIDATION_ERROR', 'Archived products cannot be used in inventory operations');
  if (product.item_type !== 'stocked') throw badRequest('VALIDATION_ERROR', 'Only stocked products participate in inventory operations');
  return product;
}

export async function toBaseQuantity(
  db: Queryable,
  organizationId: string,
  product: InventoryProduct,
  unitId: string,
  quantity: string
): Promise<string> {
  if (unitId === product.base_unit_id) return quantity;
  const result = await db.query<{ base_quantity: string }>(
    `SELECT ($3::numeric * ratio)::numeric(20,6)::text AS base_quantity
     FROM product_unit_conversions
     WHERE organization_id = $1 AND product_id = $2 AND from_unit_id = $4 AND to_unit_id = $5`,
    [organizationId, product.id, quantity, unitId, product.base_unit_id]
  );
  if (!result.rows[0]) throw badRequest('VALIDATION_ERROR', 'No conversion is configured from the submitted unit to the product base unit');
  return result.rows[0].base_quantity;
}

export interface MovementInput {
  branchId: string;
  product: InventoryProduct;
  unitId: string;
  quantity: string;
  baseQuantity: string;
  movementType: string;
  referenceType?: string | null;
  referenceId?: string | null;
  unitCostMinor?: bigint | null;
  reason?: string | null;
  batchNo?: string | null;
  serialNo?: string | null;
  expiryDate?: string | null;
  allowNegative?: boolean;
  negativeReason?: string | null;
  reversalOfMovementId?: string | null;
}

export interface MovementResult {
  movementId: string;
  onHandQty: string;
  avgCostMinor: bigint;
}

export async function postMovement(tx: pg.PoolClient, auth: AuthContext, input: MovementInput): Promise<MovementResult> {
  if (input.product.track_batch && !input.batchNo) throw badRequest('VALIDATION_ERROR', `Batch number is required for ${input.product.sku}`);
  if (input.product.track_expiry && !input.expiryDate) throw badRequest('VALIDATION_ERROR', `Expiry date is required for ${input.product.sku}`);
  if (input.product.track_serial) {
    if (!input.serialNo) throw badRequest('VALIDATION_ERROR', `Serial number is required for ${input.product.sku}`);
    const absolute = await tx.query<{ is_one: boolean }>('SELECT abs($1::numeric) = 1 AS is_one', [input.baseQuantity]);
    if (!absolute.rows[0]?.is_one) throw badRequest('VALIDATION_ERROR', 'Serial-tracked stock must move one base unit at a time');
  }

  await tx.query(
    `INSERT INTO stock_levels (organization_id, branch_id, product_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, branch_id, product_id) DO NOTHING`,
    [auth.organizationId, input.branchId, input.product.id]
  );
  const levelResult = await tx.query<{ on_hand_qty: string; avg_cost_minor: string }>(
    `SELECT on_hand_qty::text, avg_cost_minor::text
     FROM stock_levels
     WHERE organization_id = $1 AND branch_id = $2 AND product_id = $3
     FOR UPDATE`,
    [auth.organizationId, input.branchId, input.product.id]
  );
  const level = levelResult.rows[0]!;
  const quantityResult = await tx.query<{ next_qty: string; negative: boolean }>(
    `SELECT ($1::numeric + $2::numeric)::text AS next_qty,
            (($1::numeric + $2::numeric) < 0) AS negative`,
    [level.on_hand_qty, input.baseQuantity]
  );
  const nextQty = quantityResult.rows[0]!.next_qty;
  const negative = quantityResult.rows[0]!.negative;
  const authorizedOverride = Boolean(input.allowNegative && input.negativeReason && auth.permissions.has('inventory.negative-override'));
  if (negative && !authorizedOverride) {
    throw conflict('NEGATIVE_STOCK_DENIED', 'This operation would take stock below zero');
  }

  const oldQty = level.on_hand_qty;
  const oldCost = BigInt(level.avg_cost_minor);
  const inbound = !input.baseQuantity.startsWith('-');
  const incoming = inbound ? (input.unitCostMinor ?? BigInt(input.product.cost_minor)) : null;
  const movementCost = input.unitCostMinor ?? (inbound ? BigInt(input.product.cost_minor) : oldCost);
  let nextCost = oldCost;
  if (incoming !== null) {
    const cost = await tx.query<{ avg_cost: string }>(
      `SELECT CASE
         WHEN $4 = 'latest' OR $1::numeric <= 0 THEN $3::bigint
         ELSE ROUND((($1::numeric * $2::bigint) + ($5::numeric * $3::bigint)) / ($1::numeric + $5::numeric))::bigint
       END::text AS avg_cost`,
      [oldQty, oldCost, incoming, input.product.costing_method, input.baseQuantity]
    );
    nextCost = BigInt(cost.rows[0]!.avg_cost);
  }
  await tx.query(
    `UPDATE stock_levels
     SET on_hand_qty = $4::numeric, avg_cost_minor = $5
     WHERE organization_id = $1 AND branch_id = $2 AND product_id = $3`,
    [auth.organizationId, input.branchId, input.product.id, nextQty, nextCost.toString()]
  );
  const movement = await tx.query<{ id: string }>(
    `INSERT INTO stock_movements (
       organization_id, branch_id, product_id, movement_type, unit_id,
       quantity, base_quantity, unit_cost_minor, reference_type, reference_id,
       actor_membership_id, reason, batch_no, serial_no, expiry_date,
       negative_override, override_reason, reversal_of_movement_id
     ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [
      auth.organizationId,
      input.branchId,
      input.product.id,
      input.movementType,
      input.unitId,
      input.quantity,
      input.baseQuantity,
      movementCost.toString(),
      input.referenceType ?? null,
      input.referenceId ?? null,
      auth.membershipId,
      input.reason ?? null,
      input.batchNo ?? null,
      input.serialNo ?? null,
      input.expiryDate ?? null,
      negative,
      negative ? input.negativeReason : null,
      input.reversalOfMovementId ?? null
    ]
  );
  return { movementId: movement.rows[0]!.id, onHandQty: nextQty, avgCostMinor: nextCost };
}

function mapAdjustment(row: Record<string, unknown>) {
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    type: row.adjustment_type,
    reason: row.reason,
    status: row.status,
    negativeOverride: row.negative_override,
    overrideReason: row.override_reason,
    createdAt: row.created_at
  };
}

export async function createAdjustment(pool: pg.Pool, auth: AuthContext, input: CreateAdjustmentInput, req: Request) {
  const adjustmentId = await withTransaction(pool, async (tx) => {
    await ensureBranch(tx, auth, input.branchId);
    const typeToMovement: Record<CreateAdjustmentInput['type'], string> = {
      opening: 'opening',
      correction: 'adjustment',
      damage: 'damage',
      loss: 'loss',
      write_off: 'write_off'
    };
    const header = await tx.query<{ id: string }>(
      `INSERT INTO stock_adjustments (
         organization_id, branch_id, adjustment_type, reason, negative_override,
         override_reason, created_by_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [auth.organizationId, input.branchId, input.type, input.reason, input.allowNegative, input.negativeReason ?? null, auth.membershipId]
    );
    const id = header.rows[0]!.id;
    for (const line of input.lines) {
      const product = await getInventoryProduct(tx, auth.organizationId, line.productId);
      const unitId = line.unitId ?? product.base_unit_id;
      const baseQuantity = await toBaseQuantity(tx, auth.organizationId, product, unitId, line.quantity);
      if (input.type === 'opening' && baseQuantity.startsWith('-')) {
        throw badRequest('VALIDATION_ERROR', 'Opening stock quantities must be positive');
      }
      if (['damage', 'loss', 'write_off'].includes(input.type) && !baseQuantity.startsWith('-')) {
        throw badRequest('VALIDATION_ERROR', 'Damage, loss and write-off quantities must be negative');
      }
      const movement = await postMovement(tx, auth, {
        branchId: input.branchId,
        product,
        unitId,
        quantity: line.quantity,
        baseQuantity,
        movementType: typeToMovement[input.type],
        referenceType: 'stock_adjustment',
        referenceId: id,
        unitCostMinor: line.unitCost === undefined ? null : decimalToMinorUnits(line.unitCost),
        reason: input.reason,
        batchNo: line.batchNo ?? null,
        serialNo: line.serialNo ?? null,
        expiryDate: line.expiryDate ?? null,
        allowNegative: input.allowNegative,
        negativeReason: input.negativeReason ?? null
      });
      await tx.query(
        `INSERT INTO stock_adjustment_lines (
           organization_id, adjustment_id, product_id, unit_id, quantity,
           base_quantity, unit_cost_minor, batch_no, serial_no, expiry_date
         ) VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9,$10)`,
        [
          auth.organizationId,
          id,
          line.productId,
          unitId,
          line.quantity,
          baseQuantity,
          line.unitCost === undefined ? movement.avgCostMinor.toString() : decimalToMinorUnits(line.unitCost).toString(),
          line.batchNo ?? null,
          line.serialNo ?? null,
          line.expiryDate ?? null
        ]
      );
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: input.branchId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'inventory.adjustment-posted',
      entityType: 'stock_adjustment',
      entityId: id,
      metadata: { type: input.type, lineCount: input.lines.length, negativeOverride: input.allowNegative },
      ...requestMeta(req)
    });
    return id;
  });
  return getAdjustment(pool, auth, adjustmentId);
}

export async function getAdjustment(pool: pg.Pool, auth: AuthContext, adjustmentId: string) {
  const result = await pool.query(
    `SELECT a.*, b.name AS branch_name
     FROM stock_adjustments a
     JOIN branches b ON b.id = a.branch_id AND b.organization_id = a.organization_id
     WHERE a.id = $1 AND a.organization_id = $2`,
    [adjustmentId, auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw notFound('Stock adjustment was not found');
  await ensureBranch(pool, auth, row.branch_id);
  const lines = await pool.query(
    `SELECT l.id, l.product_id AS "productId", p.sku AS "productSku", p.name AS "productName",
            l.unit_id AS "unitId", u.code AS "unitCode", l.quantity::text AS quantity,
            l.base_quantity::text AS "baseQuantity", l.unit_cost_minor,
            l.batch_no AS "batchNo", l.serial_no AS "serialNo", l.expiry_date AS "expiryDate"
     FROM stock_adjustment_lines l
     JOIN products p ON p.id = l.product_id AND p.organization_id = l.organization_id
     JOIN units_of_measure u ON u.id = l.unit_id AND u.organization_id = l.organization_id
     WHERE l.adjustment_id = $1 AND l.organization_id = $2
     ORDER BY p.name`,
    [adjustmentId, auth.organizationId]
  );
  return {
    ...mapAdjustment(row),
    lines: lines.rows.map((line) => ({
      ...line,
      unitCost: line.unit_cost_minor === null ? null : minorUnitsToDecimal(String(line.unit_cost_minor)),
      unit_cost_minor: undefined
    }))
  };
}

export async function listAdjustments(pool: pg.Pool, auth: AuthContext, branchId: string) {
  await ensureBranch(pool, auth, branchId);
  const result = await pool.query(
    `SELECT a.*, b.name AS branch_name,
            (SELECT count(*)::int FROM stock_adjustment_lines l WHERE l.adjustment_id = a.id) AS line_count
     FROM stock_adjustments a
     JOIN branches b ON b.id = a.branch_id AND b.organization_id = a.organization_id
     WHERE a.organization_id = $1 AND a.branch_id = $2
     ORDER BY a.created_at DESC
     LIMIT 100`,
    [auth.organizationId, branchId]
  );
  return result.rows.map((row) => ({ ...mapAdjustment(row), lineCount: row.line_count }));
}

export async function listStockLevels(pool: pg.Pool, auth: AuthContext, query: StockLevelQuery) {
  await ensureBranch(pool, auth, query.branchId);
  const where = ['s.organization_id = $1', 's.branch_id = $2'];
  const values: unknown[] = [auth.organizationId, query.branchId];
  if (query.search) {
    values.push(`%${query.search}%`);
    where.push(`(p.name ILIKE $${values.length} OR p.sku ILIKE $${values.length} OR EXISTS (
      SELECT 1 FROM product_barcodes b WHERE b.organization_id = p.organization_id AND b.product_id = p.id AND b.barcode ILIKE $${values.length}
    ))`);
  }
  if (query.lowStock) where.push('s.on_hand_qty <= p.min_stock_level');
  const sortMap: Record<StockLevelQuery['sort'], string> = {
    name: 'p.name',
    sku: 'p.sku',
    on_hand_qty: 's.on_hand_qty',
    updated_at: 's.updated_at'
  };
  const offset = (query.page - 1) * query.pageSize;
  const totalResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM stock_levels s JOIN products p ON p.id = s.product_id AND p.organization_id = s.organization_id
     WHERE ${where.join(' AND ')}`,
    values
  );
  values.push(query.pageSize, offset);
  const result = await pool.query(
    `SELECT s.product_id AS "productId", p.sku, p.name, p.item_type AS "itemType",
            u.code AS "unitCode", s.on_hand_qty::text AS "onHandQty",
            p.min_stock_level::text AS "minStockLevel", p.reorder_qty::text AS "reorderQty",
            s.avg_cost_minor, ROUND(s.on_hand_qty * s.avg_cost_minor)::bigint::text AS valuation_minor,
            s.updated_at AS "updatedAt"
     FROM stock_levels s
     JOIN products p ON p.id = s.product_id AND p.organization_id = s.organization_id
     JOIN units_of_measure u ON u.id = p.base_unit_id AND u.organization_id = p.organization_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${sortMap[query.sort]} ${query.order.toUpperCase()}, p.id
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  return {
    items: result.rows.map((row) => ({
      ...row,
      averageCost: minorUnitsToDecimal(String(row.avg_cost_minor)),
      valuation: minorUnitsToDecimal(String(row.valuation_minor)),
      avg_cost_minor: undefined,
      valuation_minor: undefined
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize))
  };
}

export async function listMovements(pool: pg.Pool, auth: AuthContext, query: MovementQuery) {
  await ensureBranch(pool, auth, query.branchId);
  const where = ['m.organization_id = $1', 'm.branch_id = $2'];
  const values: unknown[] = [auth.organizationId, query.branchId];
  if (query.productId) {
    values.push(query.productId);
    where.push(`m.product_id = $${values.length}`);
  }
  if (query.movementType) {
    values.push(query.movementType);
    where.push(`m.movement_type = $${values.length}`);
  }
  const offset = (query.page - 1) * query.pageSize;
  const totalResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM stock_movements m WHERE ${where.join(' AND ')}`,
    values
  );
  values.push(query.pageSize, offset);
  const result = await pool.query(
    `SELECT m.id, m.seq, m.product_id AS "productId", p.sku AS "productSku", p.name AS "productName",
            m.movement_type AS "movementType", u.code AS "unitCode", m.quantity::text AS quantity,
            m.base_quantity::text AS "baseQuantity", m.unit_cost_minor, m.reference_type AS "referenceType",
            m.reference_id AS "referenceId", m.reason, m.batch_no AS "batchNo", m.serial_no AS "serialNo",
            m.expiry_date AS "expiryDate", m.negative_override AS "negativeOverride",
            m.override_reason AS "overrideReason", m.reversal_of_movement_id AS "reversalOfMovementId",
            m.created_at AS "createdAt", actor.display_name AS "actorName"
     FROM stock_movements m
     JOIN products p ON p.id = m.product_id AND p.organization_id = m.organization_id
     JOIN units_of_measure u ON u.id = m.unit_id AND u.organization_id = m.organization_id
     LEFT JOIN memberships mm ON mm.id = m.actor_membership_id AND mm.organization_id = m.organization_id
     LEFT JOIN users actor ON actor.id = mm.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.seq DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  return {
    items: result.rows.map((row) => ({
      ...row,
      unitCost: row.unit_cost_minor === null ? null : minorUnitsToDecimal(String(row.unit_cost_minor)),
      unit_cost_minor: undefined
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize))
  };
}

export async function inventoryValuation(pool: pg.Pool, auth: AuthContext, branchId: string) {
  await ensureBranch(pool, auth, branchId);
  const levels = await listStockLevels(pool, auth, { branchId, page: 1, pageSize: 100, sort: 'name', order: 'asc' });
  const total = await pool.query<{ total_minor: string }>(
    `SELECT COALESCE(ROUND(SUM(on_hand_qty * avg_cost_minor)), 0)::bigint::text AS total_minor
     FROM stock_levels WHERE organization_id = $1 AND branch_id = $2`,
    [auth.organizationId, branchId]
  );
  return { items: levels.items, total: minorUnitsToDecimal(total.rows[0]!.total_minor), currency: 'KES' };
}

export async function reconcileInventory(pool: pg.Pool, auth: AuthContext, branchId: string) {
  await ensureBranch(pool, auth, branchId);
  const result = await pool.query(
    `SELECT p.id AS "productId", p.sku, p.name,
            COALESCE(s.on_hand_qty, 0)::text AS "balanceQty",
            COALESCE(SUM(m.base_quantity), 0)::text AS "ledgerQty",
            (COALESCE(s.on_hand_qty, 0) - COALESCE(SUM(m.base_quantity), 0))::text AS "varianceQty"
     FROM products p
     LEFT JOIN stock_levels s ON s.product_id = p.id AND s.organization_id = p.organization_id AND s.branch_id = $2
     LEFT JOIN stock_movements m ON m.product_id = p.id AND m.organization_id = p.organization_id AND m.branch_id = $2
     WHERE p.organization_id = $1 AND p.item_type = 'stocked'
       AND (s.product_id IS NOT NULL OR m.product_id IS NOT NULL)
     GROUP BY p.id, s.on_hand_qty
     ORDER BY p.name`
    ,
    [auth.organizationId, branchId]
  );
  return result.rows.map((row) => ({ ...row, reconciled: row.varianceQty === '0' || row.varianceQty === '0.000000' }));
}

function mapCount(row: Record<string, unknown>) {
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    name: row.name,
    notes: row.notes,
    status: row.status,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createStockCount(pool: pg.Pool, auth: AuthContext, input: CreateStockCountInput, req: Request) {
  const countId = await withTransaction(pool, async (tx) => {
    await ensureBranch(tx, auth, input.branchId);
    const count = await tx.query<{ id: string }>(
      `INSERT INTO stock_counts (organization_id, branch_id, name, notes, created_by_membership_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [auth.organizationId, input.branchId, input.name ?? null, input.notes ?? null, auth.membershipId]
    );
    const id = count.rows[0]!.id;
    const productIds = input.productIds ? [...new Set(input.productIds)] : null;
    const products = productIds === null
      ? await tx.query<InventoryProduct>(
          `SELECT id, sku, name, base_unit_id, item_type, status, cost_minor::text,
                  costing_method, track_batch, track_expiry, track_serial
           FROM products WHERE organization_id = $1 AND status = 'active' AND item_type = 'stocked' ORDER BY name`,
          [auth.organizationId]
        )
      : { rows: await Promise.all(productIds.map((productId) => getInventoryProduct(tx, auth.organizationId, productId))) };
    for (const product of products.rows) {
      const level = await tx.query<{ on_hand_qty: string }>(
        `SELECT on_hand_qty::text FROM stock_levels
         WHERE organization_id = $1 AND branch_id = $2 AND product_id = $3`,
        [auth.organizationId, input.branchId, product.id]
      );
      await tx.query(
        `INSERT INTO stock_count_lines (organization_id, count_id, product_id, expected_qty)
         VALUES ($1,$2,$3,$4::numeric)`,
        [auth.organizationId, id, product.id, level.rows[0]?.on_hand_qty ?? '0']
      );
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: input.branchId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'inventory.count-created',
      entityType: 'stock_count',
      entityId: id,
      metadata: { lineCount: products.rows.length },
      ...requestMeta(req)
    });
    return id;
  });
  return getStockCount(pool, auth, countId);
}

export async function listStockCounts(pool: pg.Pool, auth: AuthContext, branchId: string) {
  await ensureBranch(pool, auth, branchId);
  const result = await pool.query(
    `SELECT c.*, b.name AS branch_name,
            (SELECT count(*)::int FROM stock_count_lines l WHERE l.count_id = c.id) AS line_count
     FROM stock_counts c
     JOIN branches b ON b.id = c.branch_id AND b.organization_id = c.organization_id
     WHERE c.organization_id = $1 AND c.branch_id = $2
     ORDER BY c.created_at DESC
     LIMIT 100`,
    [auth.organizationId, branchId]
  );
  return result.rows.map((row) => ({ ...mapCount(row), lineCount: row.line_count }));
}

export async function getStockCount(pool: pg.Pool, auth: AuthContext, countId: string) {
  const result = await pool.query(
    `SELECT c.*, b.name AS branch_name
     FROM stock_counts c
     JOIN branches b ON b.id = c.branch_id AND b.organization_id = c.organization_id
     WHERE c.id = $1 AND c.organization_id = $2`,
    [countId, auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw notFound('Stock count was not found');
  await ensureBranch(pool, auth, row.branch_id);
  const lines = await pool.query(
    `SELECT l.id, l.product_id AS "productId", p.sku AS "productSku", p.name AS "productName",
            u.code AS "unitCode", l.expected_qty::text AS "expectedQty",
            l.counted_qty::text AS "countedQty", l.variance_qty::text AS "varianceQty",
            l.counted_at AS "countedAt"
     FROM stock_count_lines l
     JOIN products p ON p.id = l.product_id AND p.organization_id = l.organization_id
     JOIN units_of_measure u ON u.id = p.base_unit_id AND u.organization_id = p.organization_id
     WHERE l.count_id = $1 AND l.organization_id = $2
     ORDER BY p.name`,
    [countId, auth.organizationId]
  );
  return { ...mapCount(row), lines: lines.rows };
}

export async function recordStockCountLines(pool: pg.Pool, auth: AuthContext, countId: string, input: RecordCountLinesInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const count = await tx.query<{ branch_id: string; status: string }>(
      'SELECT branch_id, status FROM stock_counts WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [countId, auth.organizationId]
    );
    const row = count.rows[0];
    if (!row) throw notFound('Stock count was not found');
    await ensureBranch(tx, auth, row.branch_id);
    if (row.status !== 'draft') throw conflict('COUNT_NOT_DRAFT', 'Counted quantities can only be recorded while the count is draft');
    for (const line of input.lines) {
      const updated = await tx.query(
        `UPDATE stock_count_lines
         SET counted_qty = $4::numeric, counted_by_membership_id = $5, counted_at = now()
         WHERE count_id = $1 AND organization_id = $2 AND product_id = $3`,
        [countId, auth.organizationId, line.productId, line.countedQty, auth.membershipId]
      );
      if (updated.rowCount !== 1) throw badRequest('VALIDATION_ERROR', 'A submitted product is not part of this stock count');
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: row.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'inventory.count-lines-recorded',
      entityType: 'stock_count',
      entityId: countId,
      metadata: { lineCount: input.lines.length },
      ...requestMeta(req)
    });
  });
  return getStockCount(pool, auth, countId);
}

export async function submitStockCount(pool: pg.Pool, auth: AuthContext, countId: string, req: Request) {
  await withTransaction(pool, async (tx) => {
    const count = await tx.query<{ branch_id: string; status: string }>(
      'SELECT branch_id, status FROM stock_counts WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [countId, auth.organizationId]
    );
    const row = count.rows[0];
    if (!row) throw notFound('Stock count was not found');
    await ensureBranch(tx, auth, row.branch_id);
    if (row.status !== 'draft') throw conflict('COUNT_NOT_DRAFT', 'Only draft stock counts can be submitted');
    const missing = await tx.query(
      `SELECT 1 FROM stock_count_lines WHERE count_id = $1 AND organization_id = $2 AND counted_qty IS NULL LIMIT 1`,
      [countId, auth.organizationId]
    );
    if (missing.rowCount) throw badRequest('VALIDATION_ERROR', 'All count lines must have a counted quantity before submission');
    await tx.query(
      `UPDATE stock_counts SET status = 'submitted', submitted_by_membership_id = $3, submitted_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [countId, auth.organizationId, auth.membershipId]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: row.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'inventory.count-submitted',
      entityType: 'stock_count',
      entityId: countId,
      ...requestMeta(req)
    });
  });
  return getStockCount(pool, auth, countId);
}

export async function decideStockCount(pool: pg.Pool, auth: AuthContext, countId: string, input: DecideStockCountInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const count = await tx.query<{ branch_id: string; status: string }>(
      'SELECT branch_id, status FROM stock_counts WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [countId, auth.organizationId]
    );
    const row = count.rows[0];
    if (!row) throw notFound('Stock count was not found');
    await ensureBranch(tx, auth, row.branch_id);
    if (row.status !== 'submitted') throw conflict('COUNT_NOT_SUBMITTED', 'Only submitted stock counts can be decided');
    if (input.decision === 'approved') {
      const lines = await tx.query<{
        product_id: string;
        variance_qty: string;
        base_unit_id: string;
      }>(
        `SELECT l.product_id, l.variance_qty::text, p.base_unit_id
         FROM stock_count_lines l
         JOIN products p ON p.id = l.product_id AND p.organization_id = l.organization_id
         WHERE l.count_id = $1 AND l.organization_id = $2 AND l.variance_qty <> 0`,
        [countId, auth.organizationId]
      );
      for (const line of lines.rows) {
        const product = await getInventoryProduct(tx, auth.organizationId, line.product_id);
        await postMovement(tx, auth, {
          branchId: row.branch_id,
          product,
          unitId: product.base_unit_id,
          quantity: line.variance_qty,
          baseQuantity: line.variance_qty,
          movementType: 'count_adjustment',
          referenceType: 'stock_count',
          referenceId: countId,
          reason: input.reason ?? 'Approved stock count variance',
          allowNegative: input.allowNegative,
          negativeReason: input.negativeReason ?? null
        });
      }
    }
    await tx.query(
      `UPDATE stock_counts
       SET status = $3, decided_by_membership_id = $4, decided_at = now(), decision_reason = $5
       WHERE id = $1 AND organization_id = $2`,
      [countId, auth.organizationId, input.decision, auth.membershipId, input.reason ?? null]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: row.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: `inventory.count-${input.decision}`,
      entityType: 'stock_count',
      entityId: countId,
      metadata: { reason: input.reason ?? null, negativeOverride: input.allowNegative },
      ...requestMeta(req)
    });
  });
  return getStockCount(pool, auth, countId);
}

function mapTransfer(row: Record<string, unknown>) {
  return {
    id: row.id,
    sourceBranchId: row.source_branch_id,
    sourceBranchName: row.source_branch_name ?? null,
    destinationBranchId: row.destination_branch_id,
    destinationBranchName: row.destination_branch_name ?? null,
    referenceCode: row.reference_code,
    notes: row.notes,
    status: row.status,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
    cancelledReason: row.cancelled_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const transferSelect = `
  SELECT t.*, source.name AS source_branch_name, destination.name AS destination_branch_name
  FROM stock_transfers t
  JOIN branches source ON source.id = t.source_branch_id AND source.organization_id = t.organization_id
  JOIN branches destination ON destination.id = t.destination_branch_id AND destination.organization_id = t.organization_id
`;

export async function createTransfer(pool: pg.Pool, auth: AuthContext, input: CreateTransferInput, req: Request) {
  const transferId = await withTransaction(pool, async (tx) => {
    await ensureBranch(tx, auth, input.sourceBranchId);
    await ensureBranch(tx, auth, input.destinationBranchId);
    const referenceCode = `TR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const transfer = await tx.query<{ id: string }>(
      `INSERT INTO stock_transfers (
         organization_id, source_branch_id, destination_branch_id, reference_code,
         notes, created_by_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [auth.organizationId, input.sourceBranchId, input.destinationBranchId, referenceCode, input.notes ?? null, auth.membershipId]
    );
    const id = transfer.rows[0]!.id;
    for (const line of input.lines) {
      const product = await getInventoryProduct(tx, auth.organizationId, line.productId);
      const unitId = line.unitId ?? product.base_unit_id;
      const baseQuantity = await toBaseQuantity(tx, auth.organizationId, product, unitId, line.quantity);
      await tx.query(
        `INSERT INTO stock_transfer_lines (
           organization_id, transfer_id, product_id, unit_id, quantity, base_quantity
         ) VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric)`,
        [auth.organizationId, id, line.productId, unitId, line.quantity, baseQuantity]
      );
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: input.sourceBranchId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'inventory.transfer-created',
      entityType: 'stock_transfer',
      entityId: id,
      metadata: { destinationBranchId: input.destinationBranchId, lineCount: input.lines.length },
      ...requestMeta(req)
    });
    return id;
  });
  return getTransfer(pool, auth, transferId);
}

export async function getTransfer(pool: pg.Pool, auth: AuthContext, transferId: string) {
  const result = await pool.query(
    `${transferSelect} WHERE t.id = $1 AND t.organization_id = $2`,
    [transferId, auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw notFound('Stock transfer was not found');
  const canAccessSource = await membershipHasBranchAccess(pool, auth, row.source_branch_id);
  const canAccessDestination = await membershipHasBranchAccess(pool, auth, row.destination_branch_id);
  if (!canAccessSource && !canAccessDestination) throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
  const lines = await pool.query(
    `SELECT l.id, l.product_id AS "productId", p.sku AS "productSku", p.name AS "productName",
            l.unit_id AS "unitId", u.code AS "unitCode", l.quantity::text AS quantity,
            l.base_quantity::text AS "baseQuantity", l.qty_dispatched::text AS "qtyDispatched",
            l.qty_received::text AS "qtyReceived", l.qty_cancelled::text AS "qtyCancelled",
            (l.qty_dispatched - l.qty_received - l.qty_cancelled)::text AS "inTransitQty"
     FROM stock_transfer_lines l
     JOIN products p ON p.id = l.product_id AND p.organization_id = l.organization_id
     JOIN units_of_measure u ON u.id = l.unit_id AND u.organization_id = l.organization_id
     WHERE l.transfer_id = $1 AND l.organization_id = $2
     ORDER BY p.name`,
    [transferId, auth.organizationId]
  );
  return { ...mapTransfer(row), lines: lines.rows };
}

export async function listTransfers(pool: pg.Pool, auth: AuthContext, branchId: string) {
  await ensureBranch(pool, auth, branchId);
  const result = await pool.query(
    `${transferSelect}
     WHERE t.organization_id = $1 AND (t.source_branch_id = $2 OR t.destination_branch_id = $2)
     ORDER BY t.created_at DESC
     LIMIT 100`,
    [auth.organizationId, branchId]
  );
  return result.rows.map(mapTransfer);
}

export async function dispatchTransfer(pool: pg.Pool, auth: AuthContext, transferId: string, input: DispatchTransferInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const transfer = await tx.query<{ source_branch_id: string; destination_branch_id: string; status: string }>(
      `SELECT source_branch_id, destination_branch_id, status
       FROM stock_transfers WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [transferId, auth.organizationId]
    );
    const row = transfer.rows[0];
    if (!row) throw notFound('Stock transfer was not found');
    await ensureBranch(tx, auth, row.source_branch_id);
    await ensureBranch(tx, auth, row.destination_branch_id);
    if (row.status !== 'draft') throw conflict('TRANSFER_NOT_DRAFT', 'Only draft transfers can be dispatched');
    const lines = await tx.query<{
      id: string;
      product_id: string;
      unit_id: string;
      quantity: string;
      base_quantity: string;
    }>(
      `SELECT id, product_id, unit_id, quantity::text, base_quantity::text
       FROM stock_transfer_lines WHERE transfer_id = $1 AND organization_id = $2 FOR UPDATE`,
      [transferId, auth.organizationId]
    );
    for (const line of lines.rows) {
      const product = await getInventoryProduct(tx, auth.organizationId, line.product_id);
      const current = await tx.query<{ avg_cost_minor: string }>(
        `SELECT avg_cost_minor::text FROM stock_levels
         WHERE organization_id = $1 AND branch_id = $2 AND product_id = $3`,
        [auth.organizationId, row.source_branch_id, line.product_id]
      );
      await postMovement(tx, auth, {
        branchId: row.source_branch_id,
        product,
        unitId: line.unit_id,
        quantity: `-${line.quantity}`,
        baseQuantity: `-${line.base_quantity}`,
        movementType: 'transfer_out',
        referenceType: 'stock_transfer_line',
        referenceId: line.id,
        unitCostMinor: BigInt(current.rows[0]?.avg_cost_minor ?? product.cost_minor),
        reason: `Transfer dispatch ${transferId}`,
        allowNegative: input.allowNegative,
        negativeReason: input.negativeReason ?? null
      });
      await tx.query(
        `UPDATE stock_transfer_lines SET qty_dispatched = base_quantity
         WHERE id = $1 AND organization_id = $2`,
        [line.id, auth.organizationId]
      );
    }
    await tx.query(
      `UPDATE stock_transfers SET status = 'dispatched', dispatched_by_membership_id = $3, dispatched_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [transferId, auth.organizationId, auth.membershipId]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: row.source_branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'inventory.transfer-dispatched',
      entityType: 'stock_transfer',
      entityId: transferId,
      metadata: { lineCount: lines.rowCount, negativeOverride: input.allowNegative },
      ...requestMeta(req)
    });
  });
  return getTransfer(pool, auth, transferId);
}

export async function receiveTransfer(pool: pg.Pool, auth: AuthContext, transferId: string, input: ReceiveTransferInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const transfer = await tx.query<{ source_branch_id: string; destination_branch_id: string; status: string }>(
      `SELECT source_branch_id, destination_branch_id, status
       FROM stock_transfers WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [transferId, auth.organizationId]
    );
    const row = transfer.rows[0];
    if (!row) throw notFound('Stock transfer was not found');
    await ensureBranch(tx, auth, row.source_branch_id);
    await ensureBranch(tx, auth, row.destination_branch_id);
    if (!['dispatched', 'partially_received'].includes(row.status)) {
      throw conflict('TRANSFER_NOT_RECEIVABLE', 'Only dispatched or partially received transfers can be received');
    }
    const requested = new Map((input.lines ?? []).map((line) => [line.transferLineId, line.quantity]));
    const lines = await tx.query<{
      id: string;
      product_id: string;
      unit_id: string;
      base_quantity: string;
      outstanding: string;
    }>(
      `SELECT id, product_id, unit_id, base_quantity::text,
              (qty_dispatched - qty_received - qty_cancelled)::text AS outstanding
       FROM stock_transfer_lines
       WHERE transfer_id = $1 AND organization_id = $2
       FOR UPDATE`,
      [transferId, auth.organizationId]
    );
    for (const line of lines.rows) {
      if (requested.size && !requested.has(line.id)) continue;
      const product = await getInventoryProduct(tx, auth.organizationId, line.product_id);
      const requestedQuantity = requested.get(line.id);
      const baseQuantity = requestedQuantity === undefined
        ? line.outstanding
        : await toBaseQuantity(tx, auth.organizationId, product, line.unit_id, requestedQuantity);
      const exceeds = await tx.query<{ exceeds: boolean }>(
        'SELECT ($1::numeric > $2::numeric) AS exceeds',
        [baseQuantity, line.outstanding]
      );
      if (exceeds.rows[0]!.exceeds) throw badRequest('VALIDATION_ERROR', 'Received quantity exceeds the outstanding transfer quantity');
      if (baseQuantity === '0' || baseQuantity === '0.000000') continue;
      const outbound = await tx.query<{ unit_cost_minor: string | null }>(
        `SELECT unit_cost_minor::text FROM stock_movements
         WHERE organization_id = $1 AND reference_type = 'stock_transfer_line' AND reference_id = $2
           AND movement_type = 'transfer_out'
         ORDER BY seq DESC LIMIT 1`,
        [auth.organizationId, line.id]
      );
      await postMovement(tx, auth, {
        branchId: row.destination_branch_id,
        product,
        unitId: requestedQuantity === undefined ? product.base_unit_id : line.unit_id,
        quantity: requestedQuantity ?? baseQuantity,
        baseQuantity,
        movementType: 'transfer_in',
        referenceType: 'stock_transfer_line',
        referenceId: line.id,
        unitCostMinor: outbound.rows[0]?.unit_cost_minor ? BigInt(outbound.rows[0].unit_cost_minor) : null,
        reason: `Transfer receipt ${transferId}`
      });
      await tx.query(
        `UPDATE stock_transfer_lines SET qty_received = qty_received + $3::numeric
         WHERE id = $1 AND organization_id = $2`,
        [line.id, auth.organizationId, baseQuantity]
      );
    }
    const outstanding = await tx.query<{ remaining: string }>(
      `SELECT COALESCE(SUM(qty_dispatched - qty_received - qty_cancelled), 0)::text AS remaining
       FROM stock_transfer_lines WHERE transfer_id = $1 AND organization_id = $2`,
      [transferId, auth.organizationId]
    );
    const remaining = outstanding.rows[0]!.remaining;
    const complete = remaining === '0' || remaining === '0.000000';
    await tx.query(
      `UPDATE stock_transfers SET status = $3, completed_at = CASE WHEN $3 = 'received' THEN now() ELSE completed_at END
       WHERE id = $1 AND organization_id = $2`,
      [transferId, auth.organizationId, complete ? 'received' : 'partially_received']
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: row.destination_branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'inventory.transfer-received',
      entityType: 'stock_transfer',
      entityId: transferId,
      metadata: { complete },
      ...requestMeta(req)
    });
  });
  return getTransfer(pool, auth, transferId);
}

export async function cancelTransfer(pool: pg.Pool, auth: AuthContext, transferId: string, input: CancelTransferInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const transfer = await tx.query<{ source_branch_id: string; destination_branch_id: string; status: string }>(
      `SELECT source_branch_id, destination_branch_id, status
       FROM stock_transfers WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [transferId, auth.organizationId]
    );
    const row = transfer.rows[0];
    if (!row) throw notFound('Stock transfer was not found');
    await ensureBranch(tx, auth, row.source_branch_id);
    await ensureBranch(tx, auth, row.destination_branch_id);
    if (!['draft', 'dispatched', 'partially_received'].includes(row.status)) {
      throw conflict('TRANSFER_NOT_CANCELLABLE', 'Only open transfers can be cancelled');
    }
    const lines = await tx.query<{
      id: string;
      product_id: string;
      unit_id: string;
      quantity: string;
      outstanding: string;
    }>(
      `SELECT id, product_id, unit_id, quantity::text,
              (qty_dispatched - qty_received - qty_cancelled)::text AS outstanding
       FROM stock_transfer_lines WHERE transfer_id = $1 AND organization_id = $2
       FOR UPDATE`,
      [transferId, auth.organizationId]
    );
    for (const line of lines.rows) {
      if (line.outstanding === '0' || line.outstanding === '0.000000') continue;
      const product = await getInventoryProduct(tx, auth.organizationId, line.product_id);
      const outbound = await tx.query<{ unit_cost_minor: string | null }>(
        `SELECT unit_cost_minor::text FROM stock_movements
         WHERE organization_id = $1 AND reference_type = 'stock_transfer_line' AND reference_id = $2
           AND movement_type = 'transfer_out'
         ORDER BY seq DESC LIMIT 1`,
        [auth.organizationId, line.id]
      );
      await postMovement(tx, auth, {
        branchId: row.source_branch_id,
        product,
        unitId: product.base_unit_id,
        quantity: line.outstanding,
        baseQuantity: line.outstanding,
        movementType: 'transfer_return',
        referenceType: 'stock_transfer_line',
        referenceId: line.id,
        unitCostMinor: outbound.rows[0]?.unit_cost_minor ? BigInt(outbound.rows[0].unit_cost_minor) : null,
        reason: input.reason
      });
      await tx.query(
        `UPDATE stock_transfer_lines SET qty_cancelled = qty_cancelled + $3::numeric
         WHERE id = $1 AND organization_id = $2`,
        [line.id, auth.organizationId, line.outstanding]
      );
    }
    await tx.query(
      `UPDATE stock_transfers SET status = 'cancelled', cancelled_reason = $3, completed_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [transferId, auth.organizationId, input.reason]
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: row.source_branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'inventory.transfer-cancelled',
      entityType: 'stock_transfer',
      entityId: transferId,
      metadata: { reason: input.reason },
      ...requestMeta(req)
    });
  });
  return getTransfer(pool, auth, transferId);
}

export async function listInTransit(pool: pg.Pool, auth: AuthContext, branchId: string) {
  await ensureBranch(pool, auth, branchId);
  const result = await pool.query(
    `SELECT t.id AS "transferId", t.reference_code AS "referenceCode", t.status,
            source.name AS "sourceBranchName", destination.name AS "destinationBranchName",
            p.sku AS "productSku", p.name AS "productName", u.code AS "unitCode",
            (l.qty_dispatched - l.qty_received - l.qty_cancelled)::text AS "inTransitQty",
            t.dispatched_at AS "dispatchedAt"
     FROM stock_transfer_lines l
     JOIN stock_transfers t ON t.id = l.transfer_id AND t.organization_id = l.organization_id
     JOIN branches source ON source.id = t.source_branch_id AND source.organization_id = t.organization_id
     JOIN branches destination ON destination.id = t.destination_branch_id AND destination.organization_id = t.organization_id
     JOIN products p ON p.id = l.product_id AND p.organization_id = l.organization_id
     JOIN units_of_measure u ON u.id = l.unit_id AND u.organization_id = l.organization_id
     WHERE l.organization_id = $1
       AND (t.source_branch_id = $2 OR t.destination_branch_id = $2)
       AND t.status IN ('dispatched', 'partially_received')
       AND (l.qty_dispatched - l.qty_received - l.qty_cancelled) > 0
     ORDER BY t.dispatched_at, p.name`,
    [auth.organizationId, branchId]
  );
  return result.rows;
}
