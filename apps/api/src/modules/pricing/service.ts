import type {
  CreatePriceListInput,
  PriceListQuery,
  PriceResolveInput,
  UpdatePriceListInput,
  UpsertPriceLinesInput
} from '@pos/contracts';
import type { Request } from 'express';
import type pg from 'pg';
import type { Queryable } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { decimalToMinorUnits, minorUnitsToDecimal, percentToBasisPoints } from '../../shared/money.js';
import { listAccessibleBranchIds, membershipHasBranchAccess } from '../../http/middleware/auth.js';
import type { AuthContext } from '../../http/middleware/auth.js';
import { recordAudit } from '../audit/audit.js';

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function mapPriceList(row: Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    customerId: row.customer_id,
    customerName: row.customer_name ?? null,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    maxDiscountPct: row.max_discount_pct === null || row.max_discount_pct === undefined ? null : String(row.max_discount_pct),
    minPrice: row.min_price_minor === null || row.min_price_minor === undefined ? null : minorUnitsToDecimal(String(row.min_price_minor)),
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPriceLine(row: Record<string, unknown>) {
  return {
    id: row.id,
    priceListId: row.price_list_id,
    productId: row.product_id,
    productSku: row.product_sku ?? null,
    productName: row.product_name ?? null,
    minQty: String(row.min_qty),
    price: minorUnitsToDecimal(String(row.price_minor)),
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const priceListSelect = `
  SELECT pl.*, b.name AS branch_name, c.name AS customer_name
  FROM price_lists pl
  LEFT JOIN branches b ON b.id = pl.branch_id AND b.organization_id = pl.organization_id
  LEFT JOIN customers c ON c.id = pl.customer_id AND c.organization_id = pl.organization_id
`;

async function validatePriceListScope(
  db: Queryable,
  auth: AuthContext,
  input: Pick<CreatePriceListInput, 'kind' | 'branchId' | 'customerId'>
): Promise<void> {
  if (input.branchId) {
    if (!(await membershipHasBranchAccess(db, auth, input.branchId))) {
      throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied for this price list');
    }
  }
  if (input.customerId) {
    const customer = await db.query(
      `SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
      [input.customerId, auth.organizationId]
    );
    if (customer.rowCount !== 1) throw badRequest('VALIDATION_ERROR', 'Customer is not valid for this organization');
  }
  if (input.kind === 'branch' && !input.branchId) throw badRequest('VALIDATION_ERROR', 'branchId is required for branch price lists');
  if (input.kind === 'customer' && !input.customerId) throw badRequest('VALIDATION_ERROR', 'customerId is required for customer price lists');
}

export async function listPriceLists(pool: pg.Pool, auth: AuthContext, query: PriceListQuery) {
  const where = ['pl.organization_id = $1'];
  const values: unknown[] = [auth.organizationId];
  if (!auth.allBranches) {
    const branchIds = await listAccessibleBranchIds(pool, auth);
    values.push(branchIds);
    where.push(`(pl.branch_id IS NULL OR pl.branch_id = ANY($${values.length}::uuid[]))`);
  }
  if (query.kind) {
    values.push(query.kind);
    where.push(`pl.kind = $${values.length}`);
  }
  if (query.branchId) {
    values.push(query.branchId);
    where.push(`pl.branch_id = $${values.length}`);
  }
  if (query.customerId) {
    values.push(query.customerId);
    where.push(`pl.customer_id = $${values.length}`);
  }
  if (query.status) {
    values.push(query.status);
    where.push(`pl.status = $${values.length}`);
  }
  const offset = (query.page - 1) * query.pageSize;
  const totalResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM price_lists pl WHERE ${where.join(' AND ')}`,
    values
  );
  values.push(query.pageSize, offset);
  const result = await pool.query(
    `${priceListSelect}
     WHERE ${where.join(' AND ')}
     ORDER BY pl.is_default DESC, pl.code
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  return {
    items: result.rows.map(mapPriceList),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize))
  };
}

export async function getPriceList(pool: pg.Pool, auth: AuthContext, priceListId: string) {
  const result = await pool.query(
    `${priceListSelect} WHERE pl.id = $1 AND pl.organization_id = $2`,
    [priceListId, auth.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw notFound('Price list was not found');
  if (row.branch_id && !(await membershipHasBranchAccess(pool, auth, row.branch_id))) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied for this price list');
  }
  const lines = await pool.query(
    `SELECT pp.*, p.sku AS product_sku, p.name AS product_name
     FROM product_prices pp
     JOIN products p ON p.id = pp.product_id AND p.organization_id = pp.organization_id
     WHERE pp.price_list_id = $1 AND pp.organization_id = $2
     ORDER BY p.name, pp.min_qty`,
    [priceListId, auth.organizationId]
  );
  return { ...mapPriceList(row), lines: lines.rows.map(mapPriceLine) };
}

export async function createPriceList(pool: pg.Pool, auth: AuthContext, input: CreatePriceListInput, req: Request) {
  const priceListId = await withTransaction(pool, async (tx) => {
    await validatePriceListScope(tx, auth, input);
    if (input.isDefault) {
      await tx.query('UPDATE price_lists SET is_default = false WHERE organization_id = $1', [auth.organizationId]);
    }
    try {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO price_lists (
           organization_id, code, name, kind, branch_id, customer_id, status,
           valid_from, valid_to, max_discount_pct, min_price_minor, is_default,
           created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          auth.organizationId,
          input.code.toUpperCase(),
          input.name.trim(),
          input.kind,
          input.branchId ?? null,
          input.customerId ?? null,
          input.status,
          input.validFrom ?? null,
          input.validTo ?? null,
          input.maxDiscountPct ?? null,
          input.minPrice === null || input.minPrice === undefined ? null : decimalToMinorUnits(input.minPrice).toString(),
          input.isDefault,
          auth.membershipId
        ]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        branchId: input.branchId ?? null,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'pricing.list-created',
        entityType: 'price_list',
        entityId: result.rows[0]!.id,
        metadata: { code: input.code, kind: input.kind },
        ...requestMeta(req)
      });
      return result.rows[0]!.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('PRICE_LIST_CODE_TAKEN', 'A price list with this code already exists');
      throw error;
    }
  });
  return getPriceList(pool, auth, priceListId);
}

export async function updatePriceList(pool: pg.Pool, auth: AuthContext, priceListId: string, input: UpdatePriceListInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const existing = await tx.query<{ branch_id: string | null }>(
      'SELECT branch_id FROM price_lists WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [priceListId, auth.organizationId]
    );
    const row = existing.rows[0];
    if (!row) throw notFound('Price list was not found');
    if (row.branch_id && !(await membershipHasBranchAccess(tx, auth, row.branch_id))) {
      throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied for this price list');
    }
    if (input.isDefault) {
      await tx.query('UPDATE price_lists SET is_default = false WHERE organization_id = $1 AND id <> $2', [auth.organizationId, priceListId]);
    }
    const fieldMap: Partial<Record<keyof UpdatePriceListInput, string>> = {
      name: 'name',
      status: 'status',
      validFrom: 'valid_from',
      validTo: 'valid_to',
      maxDiscountPct: 'max_discount_pct',
      minPrice: 'min_price_minor',
      isDefault: 'is_default'
    };
    const updates: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(fieldMap)) {
      const value = input[key as keyof UpdatePriceListInput];
      if (value === undefined) continue;
      values.push(key === 'minPrice' && value !== null ? decimalToMinorUnits(String(value)).toString() : value);
      updates.push(`${column} = $${values.length + 2}`);
    }
    try {
      await tx.query(
        `UPDATE price_lists SET ${updates.join(', ')} WHERE id = $1 AND organization_id = $2`,
        [priceListId, auth.organizationId, ...values]
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('PRICE_LIST_CODE_TAKEN', 'The price list update conflicts with an existing row');
      throw error;
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: row.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'pricing.list-updated',
      entityType: 'price_list',
      entityId: priceListId,
      metadata: input as Record<string, unknown>,
      ...requestMeta(req)
    });
  });
  return getPriceList(pool, auth, priceListId);
}

export async function upsertPriceLines(pool: pg.Pool, auth: AuthContext, priceListId: string, input: UpsertPriceLinesInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const priceList = await tx.query<{ id: string; branch_id: string | null }>(
      'SELECT id, branch_id FROM price_lists WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [priceListId, auth.organizationId]
    );
    const list = priceList.rows[0];
    if (!list) throw notFound('Price list was not found');
    if (list.branch_id && !(await membershipHasBranchAccess(tx, auth, list.branch_id))) {
      throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied for this price list');
    }
    for (const line of input.lines) {
      const product = await tx.query(
        `SELECT 1 FROM products WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
        [line.productId, auth.organizationId]
      );
      if (product.rowCount !== 1) throw badRequest('VALIDATION_ERROR', 'Price lines must reference active products in this organization');
      const existing = await tx.query<{ id: string; price_minor: string; status: string }>(
        `SELECT id, price_minor::text, status FROM product_prices
         WHERE organization_id = $1 AND price_list_id = $2 AND product_id = $3 AND min_qty = $4::numeric`,
        [auth.organizationId, priceListId, line.productId, line.minQty]
      );
      const oldLine = existing.rows[0];
      const saved = await tx.query<{ id: string }>(
        `INSERT INTO product_prices (
           organization_id, price_list_id, product_id, min_qty, price_minor,
           valid_from, valid_to, status
         ) VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,$8)
         ON CONFLICT (price_list_id, product_id, min_qty)
         DO UPDATE SET price_minor = EXCLUDED.price_minor,
           valid_from = EXCLUDED.valid_from,
           valid_to = EXCLUDED.valid_to,
           status = EXCLUDED.status
         RETURNING id`,
        [
          auth.organizationId,
          priceListId,
          line.productId,
          line.minQty,
          decimalToMinorUnits(line.price).toString(),
          line.validFrom ?? null,
          line.validTo ?? null,
          line.status
        ]
      );
      await tx.query(
        `INSERT INTO price_change_events (
           organization_id, price_list_id, product_id, change_type,
           old_price_minor, new_price_minor, actor_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          auth.organizationId,
          priceListId,
          line.productId,
          !oldLine ? 'created' : line.status === 'inactive' ? 'deactivated' : 'updated',
          oldLine?.price_minor ?? null,
          decimalToMinorUnits(line.price).toString(),
          auth.membershipId
        ]
      );
      void saved;
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      branchId: list.branch_id,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'pricing.lines-updated',
      entityType: 'price_list',
      entityId: priceListId,
      metadata: { lineCount: input.lines.length },
      ...requestMeta(req)
    });
  });
  return getPriceList(pool, auth, priceListId);
}

export async function listPriceHistory(pool: pg.Pool, auth: AuthContext, priceListId: string) {
  const priceList = await pool.query<{ branch_id: string | null }>(
    'SELECT branch_id FROM price_lists WHERE id = $1 AND organization_id = $2',
    [priceListId, auth.organizationId]
  );
  const row = priceList.rows[0];
  if (!row) throw notFound('Price list was not found');
  if (row.branch_id && !(await membershipHasBranchAccess(pool, auth, row.branch_id))) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied for this price list');
  }
  const result = await pool.query(
    `SELECT e.id, e.price_list_id AS "priceListId", p.sku AS "productSku", p.name AS "productName",
            e.product_id AS "productId", e.change_type AS "changeType",
            e.old_price_minor, e.new_price_minor, e.created_at AS "createdAt",
            u.display_name AS "actorName"
     FROM price_change_events e
     JOIN products p ON p.id = e.product_id AND p.organization_id = e.organization_id
     LEFT JOIN memberships m ON m.id = e.actor_membership_id AND m.organization_id = e.organization_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE e.organization_id = $1 AND e.price_list_id = $2
     ORDER BY e.created_at DESC
     LIMIT 200`,
    [auth.organizationId, priceListId]
  );
  return result.rows.map((row) => ({
    ...row,
    oldPrice: row.old_price_minor === null ? null : minorUnitsToDecimal(String(row.old_price_minor)),
    newPrice: row.new_price_minor === null ? null : minorUnitsToDecimal(String(row.new_price_minor)),
    old_price_minor: undefined,
    new_price_minor: undefined
  }));
}

interface PriceListRow {
  id: string;
  kind: string;
  min_price_minor: string | null;
  max_discount_pct: string | null;
}

interface PriceLineRow {
  id: string;
  price_list_id: string;
  min_qty: string;
  price_minor: string;
}

async function applicableLine(
  db: Queryable,
  organizationId: string,
  productId: string,
  priceListId: string,
  quantity: string,
  at: string
): Promise<PriceLineRow | undefined> {
  const result = await db.query<PriceLineRow>(
    `SELECT id, price_list_id, min_qty::text, price_minor::text
     FROM product_prices
     WHERE organization_id = $1 AND price_list_id = $2 AND product_id = $3
       AND status = 'active'
       AND min_qty <= $4::numeric
       AND (valid_from IS NULL OR valid_from <= $5::timestamptz)
       AND (valid_to IS NULL OR valid_to > $5::timestamptz)
     ORDER BY min_qty DESC
     LIMIT 1`,
    [organizationId, priceListId, productId, quantity, at]
  );
  return result.rows[0];
}

async function candidateLists(
  db: Queryable,
  auth: AuthContext,
  input: PriceResolveInput,
  at: string
): Promise<Array<{ list: PriceListRow; source: 'customer' | 'branch' | 'selected' | 'default' }>> {
  const candidates: Array<{ list: PriceListRow; source: 'customer' | 'branch' | 'selected' | 'default' }> = [];
  if (input.customerId) {
    const customerLists = await db.query<PriceListRow>(
      `SELECT id, kind, min_price_minor::text, max_discount_pct::text
       FROM price_lists
       WHERE organization_id = $1 AND kind = 'customer' AND customer_id = $2
         AND (branch_id IS NULL OR branch_id = $3)
         AND status = 'active'
         AND (valid_from IS NULL OR valid_from <= $4::timestamptz)
         AND (valid_to IS NULL OR valid_to > $4::timestamptz)
       ORDER BY branch_id NULLS LAST, code`,
      [auth.organizationId, input.customerId, input.branchId, at]
    );
    candidates.push(...customerLists.rows.map((list) => ({ list, source: 'customer' as const })));
  }
  const branchLists = await db.query<PriceListRow>(
    `SELECT id, kind, min_price_minor::text, max_discount_pct::text
     FROM price_lists
     WHERE organization_id = $1 AND kind = 'branch' AND branch_id = $2
       AND status = 'active'
       AND (valid_from IS NULL OR valid_from <= $3::timestamptz)
       AND (valid_to IS NULL OR valid_to > $3::timestamptz)
     ORDER BY code`,
    [auth.organizationId, input.branchId, at]
  );
  candidates.push(...branchLists.rows.map((list) => ({ list, source: 'branch' as const })));
  if (input.priceListId) {
    const selected = await db.query<PriceListRow>(
      `SELECT id, kind, min_price_minor::text, max_discount_pct::text
       FROM price_lists
       WHERE organization_id = $1 AND id = $2 AND status = 'active'
         AND (valid_from IS NULL OR valid_from <= $3::timestamptz)
         AND (valid_to IS NULL OR valid_to > $3::timestamptz)`,
      [auth.organizationId, input.priceListId, at]
    );
    const list = selected.rows[0];
    if (list) {
      const applicable =
        ['retail', 'wholesale'].includes(list.kind) ||
        (list.kind === 'branch' && (await db.query('SELECT 1 FROM price_lists WHERE id = $1 AND branch_id = $2', [list.id, input.branchId])).rowCount === 1) ||
        (list.kind === 'customer' && input.customerId !== null && input.customerId !== undefined && (await db.query(
          'SELECT 1 FROM price_lists WHERE id = $1 AND customer_id = $2 AND (branch_id IS NULL OR branch_id = $3)',
          [list.id, input.customerId, input.branchId]
        )).rowCount === 1);
      if (applicable && !candidates.some((candidate) => candidate.list.id === list.id)) {
        candidates.push({ list, source: 'selected' });
      }
    }
  }
  const defaults = await db.query<PriceListRow>(
    `SELECT id, kind, min_price_minor::text, max_discount_pct::text
     FROM price_lists
     WHERE organization_id = $1 AND is_default = true AND status = 'active'
       AND (valid_from IS NULL OR valid_from <= $2::timestamptz)
       AND (valid_to IS NULL OR valid_to > $2::timestamptz)
     ORDER BY code
     LIMIT 1`,
    [auth.organizationId, at]
  );
  candidates.push(...defaults.rows.filter((list) => !candidates.some((candidate) => candidate.list.id === list.id)).map((list) => ({ list, source: 'default' as const })));
  return candidates;
}

export async function resolvePrice(db: Queryable, auth: AuthContext, input: PriceResolveInput) {
  if (!(await membershipHasBranchAccess(db, auth, input.branchId))) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
  }
  const at = input.at ?? new Date().toISOString();
  const productResult = await db.query<{
    id: string;
    sku: string;
    name: string;
    base_price_minor: string;
    min_price_minor: string | null;
  }>(
    `SELECT id, sku, name, base_price_minor::text, min_price_minor::text
     FROM products WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
    [input.productId, auth.organizationId]
  );
  const product = productResult.rows[0];
  if (!product) throw notFound('Active product was not found');
  if (input.customerId) {
    const customer = await db.query(
      `SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
      [input.customerId, auth.organizationId]
    );
    if (customer.rowCount !== 1) throw badRequest('VALIDATION_ERROR', 'Customer is not valid for this organization');
  }
  let match: { list: PriceListRow; line: PriceLineRow; source: string } | undefined;
  for (const candidate of await candidateLists(db, auth, input, at)) {
    const line = await applicableLine(db, auth.organizationId, input.productId, candidate.list.id, input.quantity, at);
    if (line) {
      match = { list: candidate.list, line, source: candidate.source };
      break;
    }
  }
  const listPriceMinor = match ? BigInt(match.line.price_minor) : BigInt(product.base_price_minor);
  const priceListMin = match?.list.min_price_minor === null || match?.list.min_price_minor === undefined ? 0n : BigInt(match.list.min_price_minor);
  const productMin = product.min_price_minor === null ? 0n : BigInt(product.min_price_minor);
  const floor = priceListMin > productMin ? priceListMin : productMin;
  let finalPriceMinor = listPriceMinor;
  if (input.discountPct !== undefined) {
    const maxDiscount = match?.list.max_discount_pct;
    if (maxDiscount === null || maxDiscount === undefined || Number(input.discountPct) > Number(maxDiscount)) {
      throw forbidden('PRICE_DISCOUNT_DENIED', 'The requested discount exceeds the permitted discount for the resolved price list');
    }
    const bps = percentToBasisPoints(input.discountPct);
    finalPriceMinor = (listPriceMinor * (10_000n - bps) + 5_000n) / 10_000n;
  }
  if (finalPriceMinor < floor) {
    throw new AppError(422, 'PRICE_BELOW_MINIMUM', 'The resolved price is below the permitted minimum price');
  }
  return {
    productId: product.id,
    productSku: product.sku,
    productName: product.name,
    branchId: input.branchId,
    customerId: input.customerId ?? null,
    quantity: input.quantity,
    source: match?.source ?? 'base',
    priceListId: match?.list.id ?? null,
    priceLineId: match?.line.id ?? null,
    minQty: match?.line.min_qty ?? '0',
    listPrice: minorUnitsToDecimal(listPriceMinor),
    discountPct: input.discountPct ?? null,
    price: minorUnitsToDecimal(finalPriceMinor),
    currency: 'KES'
  };
}
