import type {
  AddBarcodeInput,
  CreateCategoryInput,
  CreateProductInput,
  CreateUnitInput,
  ProductCsvRow,
  ProductListQuery,
  UpdateCategoryInput,
  UpdateProductInput,
  UpdateUnitInput
} from '@pos/contracts';
import { businessProfileSchema, createProductSchema, productCsvRowSchema, type libraryProductSelectionSchema } from '@pos/contracts';
import type { z } from 'zod';
import { businessLibraryVersion, libraryEntryForProfile, libraryForProfile, libraryProfileLabel } from './business-library.js';
import type { Request } from 'express';
import type pg from 'pg';
import type { Queryable } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { decimalToMinorUnits, minorUnitsToDecimal, percentToBasisPoints, scaledIntToDecimal } from '../../shared/money.js';
import type { AuthContext } from '../../http/middleware/auth.js';
import { recordAudit } from '../audit/audit.js';
import { createHash } from 'node:crypto';
import { getOnlineProduct, downloadOnlinePhoto, type OnlineImport } from './online.js';

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function normalizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}

function mapCategory(row: Record<string, unknown>) {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapUnit(row: Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProduct(row: Record<string, unknown>) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    brand: row.brand,
    imageUrl: row.image_url,
    barcode: row.barcode ?? null,
    categoryId: row.category_id,
    categoryName: row.category_name ?? null,
    baseUnitId: row.base_unit_id,
    baseUnitCode: row.unit_code ?? null,
    itemType: row.item_type,
    status: row.status,
    cost: minorUnitsToDecimal(String(row.cost_minor)),
    basePrice: minorUnitsToDecimal(String(row.base_price_minor)),
    minPrice: row.min_price_minor === null || row.min_price_minor === undefined ? null : minorUnitsToDecimal(String(row.min_price_minor)),
    taxRatePct: row.tax_rate_bps === null || row.tax_rate_bps === undefined ? null : scaledIntToDecimal(BigInt(String(row.tax_rate_bps)), 2),
    costingMethod: row.costing_method,
    minStockLevel: String(row.min_stock_level),
    reorderQty: row.reorder_qty === null || row.reorder_qty === undefined ? null : String(row.reorder_qty),
    trackBatch: row.track_batch,
    trackExpiry: row.track_expiry,
    trackSerial: row.track_serial,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const productSelect = `
  SELECT p.id, p.sku, p.name, p.description, p.brand, p.image_url, p.category_id,
         c.name AS category_name, p.base_unit_id, u.code AS unit_code, p.item_type,
         p.status, p.cost_minor, p.base_price_minor, p.min_price_minor, p.tax_rate_bps, p.costing_method,
         p.min_stock_level, p.reorder_qty, p.track_batch, p.track_expiry, p.track_serial,
         (SELECT b.barcode FROM product_barcodes b
          WHERE b.organization_id = p.organization_id AND b.product_id = p.id
          ORDER BY b.is_primary DESC, b.barcode LIMIT 1) AS barcode,
         p.created_at, p.updated_at
  FROM products p
  LEFT JOIN product_categories c ON c.id = p.category_id AND c.organization_id = p.organization_id
  JOIN units_of_measure u ON u.id = p.base_unit_id AND u.organization_id = p.organization_id
`;

async function ensureCategory(db: Queryable, organizationId: string, categoryId: string | null | undefined): Promise<void> {
  if (!categoryId) return;
  const result = await db.query(
    `SELECT id FROM product_categories WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
    [categoryId, organizationId]
  );
  if (result.rowCount !== 1) throw badRequest('VALIDATION_ERROR', 'Category is not valid for this organization');
}

async function ensureUnits(db: Queryable, organizationId: string, unitIds: string[]): Promise<void> {
  const unique = [...new Set(unitIds)];
  if (unique.length === 0) return;
  const result = await db.query(
    `SELECT id FROM units_of_measure WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`,
    [organizationId, unique]
  );
  if (result.rowCount !== unique.length) throw badRequest('VALIDATION_ERROR', 'One or more units are not valid for this organization');
}

async function ensureParentCategory(db: Queryable, organizationId: string, parentId: string, categoryId?: string): Promise<void> {
  if (categoryId && parentId === categoryId) throw badRequest('VALIDATION_ERROR', 'A category cannot be its own parent');
  const result = await db.query<{ id: string; parent_id: string | null }>(
    `SELECT id, parent_id FROM product_categories WHERE id = $1 AND organization_id = $2`,
    [parentId, organizationId]
  );
  const parent = result.rows[0];
  if (!parent) throw badRequest('VALIDATION_ERROR', 'Parent category is not valid for this organization');
  if (parent.parent_id) throw badRequest('VALIDATION_ERROR', 'Only one level of subcategories is supported');
  if (categoryId) {
    const children = await db.query(
      `SELECT 1 FROM product_categories WHERE parent_id = $1 AND organization_id = $2`,
      [categoryId, organizationId]
    );
    if (children.rowCount) throw badRequest('VALIDATION_ERROR', 'A category with subcategories cannot become a subcategory');
  }
}

export async function listCategories(pool: pg.Pool, auth: AuthContext) {
  const result = await pool.query(
    `SELECT c.*, parent.name AS parent_name
     FROM product_categories c
     LEFT JOIN product_categories parent ON parent.id = c.parent_id AND parent.organization_id = c.organization_id
     WHERE c.organization_id = $1
     ORDER BY COALESCE(parent.name, c.name), c.parent_id IS NOT NULL, c.name`,
    [auth.organizationId]
  );
  return result.rows.map((row) => ({ ...mapCategory(row), parentName: row.parent_name ?? null }));
}

export async function createCategory(pool: pg.Pool, auth: AuthContext, input: CreateCategoryInput, req: Request) {
  return withTransaction(pool, async (tx) => {
    if (input.parentId) await ensureParentCategory(tx, auth.organizationId, input.parentId);
    try {
      const result = await tx.query(
        `INSERT INTO product_categories (organization_id, parent_id, name, status)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [auth.organizationId, input.parentId ?? null, input.name.trim(), input.status]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'catalog.category-created',
        entityType: 'product_category',
        entityId: result.rows[0]!.id,
        metadata: { name: input.name, parentId: input.parentId ?? null },
        ...requestMeta(req)
      });
      return mapCategory(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('CATEGORY_NAME_TAKEN', 'A category with this name already exists under the selected parent');
      throw error;
    }
  });
}

export async function updateCategory(pool: pg.Pool, auth: AuthContext, categoryId: string, input: UpdateCategoryInput, req: Request) {
  return withTransaction(pool, async (tx) => {
    const existing = await tx.query(
      'SELECT id, parent_id, name, status FROM product_categories WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [categoryId, auth.organizationId]
    );
    if (!existing.rows[0]) throw notFound('Category was not found');
    if (input.parentId !== undefined && input.parentId !== null) {
      await ensureParentCategory(tx, auth.organizationId, input.parentId, categoryId);
    }
    const updates: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      values.push(input.name.trim());
      updates.push(`name = $${values.length + 2}`);
    }
    if (input.parentId !== undefined) {
      values.push(input.parentId);
      updates.push(`parent_id = $${values.length + 2}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      updates.push(`status = $${values.length + 2}`);
    }
    try {
      const result = await tx.query(
        `UPDATE product_categories SET ${updates.join(', ')}
         WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [categoryId, auth.organizationId, ...values]
      );
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorMembershipId: auth.membershipId,
        actorUserId: auth.userId,
        action: 'catalog.category-updated',
        entityType: 'product_category',
        entityId: categoryId,
        metadata: input as Record<string, unknown>,
        ...requestMeta(req)
      });
      return mapCategory(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('CATEGORY_NAME_TAKEN', 'A category with this name already exists under the selected parent');
      throw error;
    }
  });
}

export async function listUnits(pool: pg.Pool, auth: AuthContext) {
  const result = await pool.query(
    'SELECT * FROM units_of_measure WHERE organization_id = $1 ORDER BY code',
    [auth.organizationId]
  );
  return result.rows.map(mapUnit);
}

export async function createUnit(pool: pg.Pool, auth: AuthContext, input: CreateUnitInput, req: Request) {
  try {
    const result = await pool.query(
      `INSERT INTO units_of_measure (organization_id, code, name, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [auth.organizationId, input.code.toUpperCase(), input.name.trim(), input.status]
    );
    await recordAudit(pool, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'catalog.unit-created',
      entityType: 'unit_of_measure',
      entityId: result.rows[0]!.id,
      metadata: { code: input.code, name: input.name },
      ...requestMeta(req)
    });
    return mapUnit(result.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('UNIT_CODE_TAKEN', 'A unit with this code already exists');
    throw error;
  }
}

export async function updateUnit(pool: pg.Pool, auth: AuthContext, unitId: string, input: UpdateUnitInput, req: Request) {
  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    values.push(input.name.trim());
    updates.push(`name = $${values.length + 2}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    updates.push(`status = $${values.length + 2}`);
  }
  const result = await pool.query(
    `UPDATE units_of_measure SET ${updates.join(', ')}
     WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [unitId, auth.organizationId, ...values]
  );
  if (!result.rows[0]) throw notFound('Unit was not found');
  await recordAudit(pool, {
    organizationId: auth.organizationId,
    actorMembershipId: auth.membershipId,
    actorUserId: auth.userId,
    action: 'catalog.unit-updated',
    entityType: 'unit_of_measure',
    entityId: unitId,
    metadata: input as Record<string, unknown>,
    ...requestMeta(req)
  });
  return mapUnit(result.rows[0]!);
}

function assertProductCapabilities(auth: AuthContext, input: { itemType?: string | undefined; trackBatch?: boolean | undefined; trackExpiry?: boolean | undefined; trackSerial?: boolean | undefined }) {
  if (input.itemType === 'service' && !auth.enabledCapabilities.has('service_items')) {
    throw forbidden('CAPABILITY_DISABLED', 'Service items are disabled for this organization');
  }
  if ((input.trackBatch === true || input.trackExpiry === true) && !auth.enabledCapabilities.has('batch_expiry_tracking')) {
    throw forbidden('CAPABILITY_DISABLED', 'Batch and expiry tracking is disabled for this organization');
  }
  if (input.trackSerial === true && !auth.enabledCapabilities.has('serial_tracking')) {
    throw forbidden('CAPABILITY_DISABLED', 'Serial tracking is disabled for this organization');
  }
}

async function insertProduct(tx: pg.PoolClient, auth: AuthContext, input: CreateProductInput, req?: Request) {
  const sku = normalizeSku(input.sku);
  const unitIds = [input.baseUnitId, ...input.conversions.flatMap((conversion) => [conversion.fromUnitId, conversion.toUnitId])];
  assertProductCapabilities(auth, input);
  await ensureUnits(tx, auth.organizationId, unitIds);
  await ensureCategory(tx, auth.organizationId, input.categoryId);
  for (const conversion of input.conversions) {
    if (conversion.toUnitId !== input.baseUnitId) {
      throw badRequest('VALIDATION_ERROR', 'Unit conversions must convert into the product base unit');
    }
  }
  try {
    const result = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO products (
         organization_id, sku, name, description, brand, image_url, category_id,
         base_unit_id, item_type, status, cost_minor, base_price_minor, min_price_minor,
         tax_rate_bps, costing_method, min_stock_level, reorder_qty, track_batch, track_expiry,
         track_serial, created_by_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id, created_at`,
      [
        auth.organizationId,
        sku,
        input.name.trim(),
        input.description ?? null,
        input.brand ?? null,
        input.imageUrl ?? null,
        input.categoryId ?? null,
        input.baseUnitId,
        input.itemType,
        input.status,
        decimalToMinorUnits(input.cost).toString(),
        decimalToMinorUnits(input.basePrice).toString(),
        input.minPrice === null || input.minPrice === undefined ? null : decimalToMinorUnits(input.minPrice).toString(),
        input.taxRatePct === null || input.taxRatePct === undefined ? null : percentToBasisPoints(input.taxRatePct).toString(),
        input.costingMethod,
        input.minStockLevel,
        input.reorderQty ?? null,
        input.trackBatch,
        input.trackExpiry,
        input.trackSerial,
        auth.membershipId
      ]
    );
    const productId = result.rows[0]!.id;
    const barcodes = [...new Set(input.barcodes.map((barcode) => barcode.trim()))];
    for (const [index, barcode] of barcodes.entries()) {
      await tx.query(
        `INSERT INTO product_barcodes (organization_id, product_id, barcode, is_primary)
         VALUES ($1, $2, $3, $4)`,
        [auth.organizationId, productId, barcode, index === 0]
      );
    }
    for (const conversion of input.conversions) {
      await tx.query(
        `INSERT INTO product_unit_conversions (organization_id, product_id, from_unit_id, to_unit_id, ratio)
         VALUES ($1, $2, $3, $4, $5)`,
        [auth.organizationId, productId, conversion.fromUnitId, conversion.toUnitId, conversion.ratio]
      );
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'catalog.product-created',
      entityType: 'product',
      entityId: productId,
      metadata: { sku, name: input.name, itemType: input.itemType },
      ...(req ? requestMeta(req) : {})
    });
    return productId;
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('PRODUCT_IDENTIFIER_TAKEN', 'The SKU or barcode is already assigned in this organization');
    throw error;
  }
}

export async function createProduct(pool: pg.Pool, auth: AuthContext, input: CreateProductInput, req: Request) {
  const productId = await withTransaction(pool, (tx) => insertProduct(tx, auth, input, req));
  return getProduct(pool, auth, productId);
}

export async function importOnlineProduct(pool: pg.Pool, auth: AuthContext, input: OnlineImport, req: Request) {
  const sku = `ONLINE-OFF-${input.code}`;
  const duplicate = await pool.query(`SELECT p.id FROM products p WHERE p.organization_id=$1 AND (p.sku=$2 OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id=p.id AND b.organization_id=$1 AND b.barcode IN ($3,$4))) LIMIT 1`,[auth.organizationId,sku,input.code,input.barcode || input.code]);
  if (duplicate.rows[0]) return {product:await getProduct(pool,auth,duplicate.rows[0].id as string),created:false};
  // Re-read canonical provider data: clients cannot make the server fetch arbitrary URLs.
  const source = await getOnlineProduct(input.code);
  const photo = input.includePhoto ? await downloadOnlinePhoto(source) : null;
  const result = await withTransaction(pool, async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`online-catalog:${auth.organizationId}`]);
    const existing = await tx.query(`SELECT p.id FROM products p WHERE p.organization_id=$1 AND (p.sku=$2 OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id=p.id AND b.organization_id=$1 AND b.barcode IN ($3,$4))) LIMIT 1`, [auth.organizationId, sku, input.code, input.barcode || input.code]);
    if (existing.rows[0]) return { id: existing.rows[0].id as string, created: false };
    let imageUrl: string | null = null;
    if (photo) {
      const id = createHash('sha256').update(photo.bytes).digest('hex');
      await tx.query('INSERT INTO online_catalog_photos (id,content,mime_type,source_url) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, photo.bytes, photo.mime, photo.sourceUrl]);
      imageUrl = `/api/v1/catalog/online/images/${id}`;
    }
    const id = await insertProduct(tx, auth, createProductSchema.parse({
      sku, name: input.name, brand: input.brand, imageUrl, categoryId: input.categoryId, baseUnitId: input.baseUnitId, cost: input.cost, basePrice: input.basePrice,
      barcodes: input.barcode ? [input.barcode] : [],
      description: `Size / pack: ${input.size || 'Confirm physical pack'}. Source: Open Food Facts (${source.sourceUrl}). Product data: ODbL / Database Contents License. ${photo ? `Photo: Open Food Facts contributors, CC BY-SA 3.0 (${photo.sourceUrl}). ` : ''}Reviewed by shop owner; record opening stock separately.`
    }), req);
    return { id, created: true };
  });
  return { product: await getProduct(pool, auth, result.id), created: result.created };
}

async function readLibraryProfile(pool: Queryable, organizationId: string, lock = false) {
  const result = await pool.query(`SELECT business_profile FROM organization_profiles WHERE organization_id = $1${lock ? ' FOR SHARE' : ''}`, [organizationId]);
  return businessProfileSchema.parse(result.rows[0]?.business_profile ?? 'general_retail');
}

export async function listBusinessLibrary(pool: pg.Pool, auth: AuthContext, liquorOnly = false) {
  const profile = await readLibraryProfile(pool, auth.organizationId);
  if (liquorOnly && profile !== 'wines_spirits') throw badRequest('LIQUOR_PROFILE_REQUIRED', 'Choose the Wines & spirits business profile to use this library');
  const products = await pool.query('SELECT id, sku FROM products WHERE organization_id = $1 AND sku LIKE $2', [auth.organizationId, 'LIB-%']);
  const added = new Map(products.rows.map((row) => [row.sku, row.id as string]));
  return { version: businessLibraryVersion, profile, label: libraryProfileLabel(profile), entries: libraryForProfile(profile).map((entry) => ({
    id: entry.id, sku: entry.sku, name: entry.name, family: entry.family, size: entry.size,
    category: entry.category, imageUrl: entry.imageUrl, sourceUrl: entry.sourceUrl,
    photoKind: entry.photoKind, template: entry.template ?? false, itemType: entry.itemType,
    productId: added.get(entry.sku) ?? null
  })) };
}

export async function listLiquorLibrary(pool: pg.Pool, auth: AuthContext) {
  return listBusinessLibrary(pool, auth, true);
}

export async function selectBusinessLibraryProducts(pool: pg.Pool, auth: AuthContext, input: z.infer<typeof libraryProductSelectionSchema>, req: Request, liquorOnly = false) {
  return withTransaction(pool, async (tx) => {
    const profile = await readLibraryProfile(tx, auth.organizationId, true);
    if (liquorOnly && profile !== 'wines_spirits') throw badRequest('LIQUOR_PROFILE_REQUIRED', 'Choose the Wines & spirits business profile to use this library');
    // Serialize library additions per shop; retries never overwrite prices or create duplicates.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`business-library:${auth.organizationId}`]);
    const unit = await tx.query("SELECT id FROM units_of_measure WHERE organization_id = $1 AND code = 'EA' AND status = 'active'", [auth.organizationId]);
    if (!unit.rows[0]) throw badRequest('UNIT_REQUIRED', 'Activate the EA (each) unit before adding library products');
    let created = 0;
    let skipped = 0;
    for (const selection of input.entries) {
      const entry = libraryEntryForProfile(selection.id, profile);
      if (!entry) throw badRequest('UNKNOWN_LIBRARY_PRODUCT', 'A selected item is unavailable for your business type; refresh the library');
      const existing = await tx.query('SELECT id FROM products WHERE organization_id = $1 AND sku = $2', [auth.organizationId, entry.sku]);
      if (existing.rowCount) { skipped++; continue; }
      await tx.query(`INSERT INTO product_categories (organization_id, name, status) VALUES ($1, $2, 'active') ON CONFLICT DO NOTHING`, [auth.organizationId, entry.category]);
      const category = await tx.query('SELECT id FROM product_categories WHERE organization_id = $1 AND lower(name) = lower($2) AND parent_id IS NULL', [auth.organizationId, entry.category]);
      await insertProduct(tx, auth, createProductSchema.parse({
        sku: entry.sku, name: entry.name, brand: entry.brand, imageUrl: entry.imageUrl, itemType: entry.itemType,
        description: `${entry.template ? 'Editable template. Confirm the item and portion/specification before selling. ' : ''}Variant: ${entry.size}. ${entry.itemType === 'stocked' ? 'Verify packaging and scan the physical barcode before use. Pack variants hold separate stock; no case conversion is assumed.' : 'Priced per named portion or service. No ingredient or parts stock is deducted automatically.'}`,
        categoryId: category.rows[0]?.id ?? null, baseUnitId: unit.rows[0].id,
        cost: selection.cost, basePrice: selection.sellingPrice
      }), req);
      created++;
    }
    return { created, skipped };
  });
}

export async function selectLibraryProducts(pool: pg.Pool, auth: AuthContext, input: z.infer<typeof libraryProductSelectionSchema>, req: Request) {
  return selectBusinessLibraryProducts(pool, auth, input, req, true);
}

export async function getProduct(pool: pg.Pool, auth: AuthContext, productId: string) {
  const result = await pool.query(`${productSelect} WHERE p.id = $1 AND p.organization_id = $2`, [productId, auth.organizationId]);
  const row = result.rows[0];
  if (!row) throw notFound('Product was not found');
  const [barcodes, conversions] = await Promise.all([
    pool.query(
      `SELECT id, barcode, is_primary AS "isPrimary", created_at AS "createdAt"
       FROM product_barcodes WHERE organization_id = $1 AND product_id = $2 ORDER BY is_primary DESC, barcode`,
      [auth.organizationId, productId]
    ),
    pool.query(
      `SELECT c.id, c.from_unit_id AS "fromUnitId", fu.code AS "fromUnitCode", c.to_unit_id AS "toUnitId",
              tu.code AS "toUnitCode", c.ratio::text AS ratio
       FROM product_unit_conversions c
       JOIN units_of_measure fu ON fu.id = c.from_unit_id AND fu.organization_id = c.organization_id
       JOIN units_of_measure tu ON tu.id = c.to_unit_id AND tu.organization_id = c.organization_id
       WHERE c.organization_id = $1 AND c.product_id = $2`,
      [auth.organizationId, productId]
    )
  ]);
  return { ...mapProduct(row), barcodes: barcodes.rows, conversions: conversions.rows };
}

export async function listProducts(pool: pg.Pool, auth: AuthContext, query: ProductListQuery) {
  const where = ['p.organization_id = $1'];
  const values: unknown[] = [auth.organizationId];
  if (query.search) {
    values.push(`%${query.search}%`);
    where.push(`(p.name ILIKE $${values.length} OR p.sku ILIKE $${values.length} OR EXISTS (
      SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.organization_id = p.organization_id AND b.barcode ILIKE $${values.length}
    ))`);
  }
  if (query.categoryId) {
    values.push(query.categoryId);
    where.push(`p.category_id = $${values.length}`);
  }
  if (query.status) {
    values.push(query.status);
    where.push(`p.status = $${values.length}`);
  }
  if (query.itemType) {
    values.push(query.itemType);
    where.push(`p.item_type = $${values.length}`);
  }
  const sortMap: Record<ProductListQuery['sort'], string> = {
    name: 'p.name',
    sku: 'p.sku',
    created_at: 'p.created_at',
    updated_at: 'p.updated_at'
  };
  const offset = (query.page - 1) * query.pageSize;
  const totalResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM products p WHERE ${where.join(' AND ')}`,
    values
  );
  values.push(query.pageSize, offset);
  const result = await pool.query(
    `${productSelect}
     WHERE ${where.join(' AND ')}
     ORDER BY ${sortMap[query.sort]} ${query.order.toUpperCase()}, p.id
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);
  return {
    items: result.rows.map(mapProduct),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize))
  };
}

export async function updateProduct(pool: pg.Pool, auth: AuthContext, productId: string, input: UpdateProductInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const existing = await tx.query(
      'SELECT id FROM products WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [productId, auth.organizationId]
    );
    if (!existing.rows[0]) throw notFound('Product was not found');
    assertProductCapabilities(auth, input);
    if (input.categoryId) await ensureCategory(tx, auth.organizationId, input.categoryId);
    if (input.baseUnitId) await ensureUnits(tx, auth.organizationId, [input.baseUnitId]);
    const fieldMap: Partial<Record<keyof UpdateProductInput, string>> = {
      sku: 'sku',
      name: 'name',
      description: 'description',
      brand: 'brand',
      imageUrl: 'image_url',
      categoryId: 'category_id',
      baseUnitId: 'base_unit_id',
      itemType: 'item_type',
      status: 'status',
      cost: 'cost_minor',
      basePrice: 'base_price_minor',
      minPrice: 'min_price_minor',
      taxRatePct: 'tax_rate_bps',
      costingMethod: 'costing_method',
      minStockLevel: 'min_stock_level',
      reorderQty: 'reorder_qty',
      trackBatch: 'track_batch',
      trackExpiry: 'track_expiry',
      trackSerial: 'track_serial'
    };
    const updates: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(fieldMap)) {
      const value = input[key as keyof UpdateProductInput];
      if (value === undefined) continue;
      let stored = value;
      if (key === 'sku') stored = normalizeSku(String(value));
      if (key === 'cost' || key === 'basePrice') stored = decimalToMinorUnits(String(value)).toString();
      if (key === 'minPrice') stored = value === null ? null : decimalToMinorUnits(String(value)).toString();
      if (key === 'taxRatePct') stored = value === null ? null : percentToBasisPoints(String(value)).toString();
      values.push(stored);
      updates.push(`${column} = $${values.length + 2}`);
    }
    try {
      await tx.query(
        `UPDATE products SET ${updates.join(', ')} WHERE id = $1 AND organization_id = $2`,
        [productId, auth.organizationId, ...values]
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('PRODUCT_IDENTIFIER_TAKEN', 'The SKU is already assigned in this organization');
      throw error;
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: input.status === 'archived' ? 'catalog.product-archived' : input.status === 'active' ? 'catalog.product-reactivated' : 'catalog.product-updated',
      entityType: 'product',
      entityId: productId,
      metadata: input as Record<string, unknown>,
      ...requestMeta(req)
    });
  });
  return getProduct(pool, auth, productId);
}

export async function addBarcode(pool: pg.Pool, auth: AuthContext, productId: string, input: AddBarcodeInput, req: Request) {
  await withTransaction(pool, async (tx) => {
    const product = await tx.query(
      `SELECT id FROM products WHERE id = $1 AND organization_id = $2 AND status = 'active' FOR UPDATE`,
      [productId, auth.organizationId]
    );
    if (!product.rows[0]) throw notFound('Active product was not found');
    if (input.isPrimary) {
      await tx.query('UPDATE product_barcodes SET is_primary = false WHERE organization_id = $1 AND product_id = $2', [auth.organizationId, productId]);
    }
    try {
      await tx.query(
        `INSERT INTO product_barcodes (organization_id, product_id, barcode, is_primary)
         VALUES ($1, $2, $3, $4)`,
        [auth.organizationId, productId, input.barcode, input.isPrimary]
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('BARCODE_TAKEN', 'This barcode is already assigned in this organization');
      throw error;
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'catalog.barcode-added',
      entityType: 'product',
      entityId: productId,
      metadata: { barcode: input.barcode, isPrimary: input.isPrimary },
      ...requestMeta(req)
    });
  });
  return getProduct(pool, auth, productId);
}

export async function removeBarcode(pool: pg.Pool, auth: AuthContext, productId: string, barcodeId: string, req: Request) {
  await withTransaction(pool, async (tx) => {
    const deleted = await tx.query<{ barcode: string; is_primary: boolean }>(
      `DELETE FROM product_barcodes WHERE id = $1 AND organization_id = $2 AND product_id = $3
       RETURNING barcode, is_primary`,
      [barcodeId, auth.organizationId, productId]
    );
    if (!deleted.rows[0]) throw notFound('Barcode was not found');
    if (deleted.rows[0].is_primary) {
      await tx.query(
        `UPDATE product_barcodes SET is_primary = true
         WHERE id = (
           SELECT id FROM product_barcodes WHERE organization_id = $1 AND product_id = $2 ORDER BY barcode LIMIT 1
         )`,
        [auth.organizationId, productId]
      );
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorMembershipId: auth.membershipId,
      actorUserId: auth.userId,
      action: 'catalog.barcode-removed',
      entityType: 'product',
      entityId: productId,
      metadata: { barcode: deleted.rows[0].barcode },
      ...requestMeta(req)
    });
  });
  return getProduct(pool, auth, productId);
}

export async function lookupBarcode(pool: pg.Pool, auth: AuthContext, barcode: string) {
  const result = await pool.query(
    `${productSelect}
     JOIN product_barcodes b ON b.product_id = p.id AND b.organization_id = p.organization_id
     WHERE p.organization_id = $1 AND b.barcode = $2`,
    [auth.organizationId, barcode]
  );
  if (!result.rows[0]) throw notFound('No product is assigned to this barcode');
  return getProduct(pool, auth, result.rows[0].id);
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    const next = csv[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (quoted) throw badRequest('CSV_INVALID', 'CSV contains an unterminated quoted field');
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

export async function importProducts(pool: pg.Pool, auth: AuthContext, csv: string, req: Request) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest('CSV_INVALID', 'CSV must include a header row and at least one product row');
  const headers = rows[0]!.map((header) => header.trim().toLowerCase());
  const required = ['sku', 'name'];
  if (!required.every((header) => headers.includes(header))) {
    throw badRequest('CSV_INVALID', 'CSV must contain sku and name headers');
  }
  const errors: Array<{ row: number; message: string }> = [];
  const created: string[] = [];
  await withTransaction(pool, async (tx) => {
    const units = await tx.query<{ id: string; code: string }>(
      `SELECT id, code FROM units_of_measure WHERE organization_id = $1 AND status = 'active'`,
      [auth.organizationId]
    );
    const unitByCode = new Map(units.rows.map((unit) => [unit.code.toUpperCase(), unit.id]));
    for (const [index, row] of rows.slice(1).entries()) {
      const line = index + 2;
      await tx.query('SAVEPOINT catalog_import_row');
      try {
        const record = Object.fromEntries(headers.map((header, column) => [header, row[column]?.trim() || undefined]));
        const parsed = productCsvRowSchema.parse(record) as ProductCsvRow;
        const baseUnitCode = (parsed.baseUnit ?? 'EA').toUpperCase();
        const baseUnitId = unitByCode.get(baseUnitCode);
        if (!baseUnitId) throw badRequest('VALIDATION_ERROR', `Unknown base unit ${baseUnitCode}`);
        let categoryId: string | null = null;
        if (parsed.category) {
          const existing = await tx.query<{ id: string }>(
            `SELECT id FROM product_categories
             WHERE organization_id = $1 AND parent_id IS NULL AND lower(name) = lower($2)`,
            [auth.organizationId, parsed.category]
          );
          categoryId = existing.rows[0]?.id ?? null;
          if (!categoryId) {
            const inserted = await tx.query<{ id: string }>(
              `INSERT INTO product_categories (organization_id, name)
               VALUES ($1, $2) RETURNING id`,
              [auth.organizationId, parsed.category]
            );
            categoryId = inserted.rows[0]!.id;
          }
        }
        const productId = await insertProduct(tx, auth, {
          sku: parsed.sku,
          name: parsed.name,
          description: parsed.description ?? null,
          brand: parsed.brand ?? null,
          imageUrl: null,
          categoryId,
          baseUnitId,
          itemType: parsed.itemType,
          status: 'active',
          cost: parsed.cost,
          basePrice: parsed.basePrice,
          minPrice: null,
          taxRatePct: null,
          costingMethod: 'average',
          minStockLevel: parsed.minStockLevel,
          reorderQty: null,
          trackBatch: parsed.trackBatch,
          trackExpiry: parsed.trackExpiry,
          trackSerial: parsed.trackSerial,
          barcodes: parsed.barcode ? [parsed.barcode] : [],
          conversions: []
        });
        created.push(productId);
        await tx.query('RELEASE SAVEPOINT catalog_import_row');
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT catalog_import_row');
        errors.push({ row: line, message: error instanceof Error ? error.message : 'Invalid product row' });
      }
    }
  });
  await recordAudit(pool, {
    organizationId: auth.organizationId,
    actorMembershipId: auth.membershipId,
    actorUserId: auth.userId,
    action: 'catalog.products-imported',
    entityType: 'product_import',
    metadata: { created: created.length, errors: errors.length },
    ...requestMeta(req)
  });
  return { created: created.length, errors };
}

export async function exportProducts(pool: pg.Pool, auth: AuthContext): Promise<string> {
  const result = await pool.query(
    `${productSelect}
     WHERE p.organization_id = $1
     ORDER BY p.sku`,
    [auth.organizationId]
  );
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [
    'sku,name,description,brand,barcode,category,baseUnit,itemType,cost,basePrice,minStockLevel,status',
    ...result.rows.map((row) => [
      row.sku,
      row.name,
      row.description,
      row.brand,
      row.barcode,
      row.category_name,
      row.unit_code,
      row.item_type,
      minorUnitsToDecimal(String(row.cost_minor)),
      minorUnitsToDecimal(String(row.base_price_minor)),
      row.min_stock_level,
      row.status
    ].map(escape).join(','))
  ];
  return `${lines.join('\n')}\n`;
}
