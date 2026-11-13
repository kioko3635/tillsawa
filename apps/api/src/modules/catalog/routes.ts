import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { z } from 'zod';
import {
  addBarcodeSchema,
  createCategorySchema,
  createProductSchema,
  createUnitSchema,
  libraryProductSelectionSchema,
  productImportSchema,
  productListQuerySchema,
  updateCategorySchema,
  updateProductSchema,
  updateUnitSchema,
  uuidSchema
} from '@pos/contracts';
import { idempotency } from '../../http/middleware/idempotency.js';
import { requirePermission } from '../../http/middleware/auth.js';
import { badRequest } from '../../shared/errors.js';
import { AppError } from '../../shared/errors.js';
import { asyncHandler, sendData, validateBody } from '../../shared/http.js';
import {
  addBarcode,
  createCategory,
  createProduct,
  importOnlineProduct,
  createUnit,
  exportProducts,
  getProduct,
  importProducts,
  listCategories,
  listProducts,
  listUnits,
  listLiquorLibrary,
  selectLibraryProducts,
  listBusinessLibrary,
  selectBusinessLibraryProducts,
  lookupBarcode,
  removeBarcode,
  updateCategory,
  updateProduct,
  updateUnit
} from './service.js';
import { onlineImportSchema, onlineSearchSchema, searchOnlineProducts } from './online.js';

interface CatalogRoutesDeps {
  pool: pg.Pool;
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
}

function parseQuery<S extends z.ZodTypeAny>(schema: S, req: Request): z.output<S> {
  const result = schema.safeParse(req.query);
  if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', 'Query validation failed', result.error.flatten());
  return result.data as z.output<S>;
}

function uuidParam(req: Request, name: string): string {
  const result = uuidSchema.safeParse(req.params[name]);
  if (!result.success) throw badRequest('VALIDATION_ERROR', `A valid ${name} is required`);
  return result.data;
}

export function createCatalogRoutes({ pool, authenticate }: CatalogRoutesDeps): Router {
  const router = Router();
  router.use(authenticate);
  router.get('/catalog/online/search', requirePermission('catalog.manage'), asyncHandler(async (req, res) => {
    const input = parseQuery(onlineSearchSchema, req);
    sendData(res, await searchOnlineProducts(input.query));
  }));
  router.post('/catalog/online/import', requirePermission('catalog.manage'), validateBody(onlineImportSchema), idempotency(pool, 'catalog.online.import'), asyncHandler(async (req, res) => {
    const result = await importOnlineProduct(pool, req.auth!, req.body, req);
    sendData(res, result, result.created ? 201 : 200);
  }));

  router.get('/catalog/library', requirePermission('catalog.manage'), asyncHandler(async (req, res) => {
    sendData(res, await listBusinessLibrary(pool, req.auth!));
  }));
  router.post('/catalog/library/select', requirePermission('catalog.manage'), validateBody(libraryProductSelectionSchema), idempotency(pool, 'catalog.library.select'), asyncHandler(async (req, res) => {
    sendData(res, await selectBusinessLibraryProducts(pool, req.auth!, req.body, req), 201);
  }));

  router.get('/catalog/library/liquor', requirePermission('catalog.manage'), asyncHandler(async (req, res) => {
    sendData(res, await listLiquorLibrary(pool, req.auth!));
  }));
  router.post('/catalog/library/liquor/select', requirePermission('catalog.manage'), validateBody(libraryProductSelectionSchema), idempotency(pool, 'catalog.library.select'), asyncHandler(async (req, res) => {
    sendData(res, await selectLibraryProducts(pool, req.auth!, req.body, req), 201);
  }));

  router.get('/catalog/categories', requirePermission('catalog.read'), asyncHandler(async (req, res) => {
    sendData(res, { categories: await listCategories(pool, req.auth!) });
  }));

  router.post('/catalog/categories', requirePermission('catalog.manage'), validateBody(createCategorySchema), idempotency(pool, 'catalog.categories.create'), asyncHandler(async (req, res) => {
    sendData(res, { category: await createCategory(pool, req.auth!, req.body, req) }, 201);
  }));

  router.patch('/catalog/categories/:categoryId', requirePermission('catalog.manage'), validateBody(updateCategorySchema), asyncHandler(async (req, res) => {
    sendData(res, { category: await updateCategory(pool, req.auth!, uuidParam(req, 'categoryId'), req.body, req) });
  }));

  router.get('/catalog/units', requirePermission('catalog.read'), asyncHandler(async (req, res) => {
    sendData(res, { units: await listUnits(pool, req.auth!) });
  }));

  router.post('/catalog/units', requirePermission('catalog.manage'), validateBody(createUnitSchema), idempotency(pool, 'catalog.units.create'), asyncHandler(async (req, res) => {
    sendData(res, { unit: await createUnit(pool, req.auth!, req.body, req) }, 201);
  }));

  router.patch('/catalog/units/:unitId', requirePermission('catalog.manage'), validateBody(updateUnitSchema), asyncHandler(async (req, res) => {
    sendData(res, { unit: await updateUnit(pool, req.auth!, uuidParam(req, 'unitId'), req.body, req) });
  }));

  router.get('/catalog/products', requirePermission('catalog.read'), asyncHandler(async (req, res) => {
    sendData(res, await listProducts(pool, req.auth!, parseQuery(productListQuerySchema, req)));
  }));

  router.post('/catalog/products', requirePermission('catalog.manage'), validateBody(createProductSchema), idempotency(pool, 'catalog.products.create'), asyncHandler(async (req, res) => {
    sendData(res, { product: await createProduct(pool, req.auth!, req.body, req) }, 201);
  }));

  router.get('/catalog/products/export.csv', requirePermission('catalog.read'), asyncHandler(async (req, res) => {
    const csv = await exportProducts(pool, req.auth!);
    res.status(200).type('text/csv').send(csv);
  }));

  router.post('/catalog/products/import', requirePermission('catalog.manage'), validateBody(productImportSchema), idempotency(pool, 'catalog.products.import'), asyncHandler(async (req, res) => {
    sendData(res, { import: await importProducts(pool, req.auth!, req.body.csv, req) }, 201);
  }));

  router.get('/catalog/products/barcode/:barcode', requirePermission('catalog.read'), asyncHandler(async (req, res) => {
    sendData(res, { product: await lookupBarcode(pool, req.auth!, req.params.barcode!) });
  }));

  router.get('/catalog/products/:productId', requirePermission('catalog.read'), asyncHandler(async (req, res) => {
    sendData(res, { product: await getProduct(pool, req.auth!, uuidParam(req, 'productId')) });
  }));

  router.patch('/catalog/products/:productId', requirePermission('catalog.manage'), validateBody(updateProductSchema), asyncHandler(async (req, res) => {
    sendData(res, { product: await updateProduct(pool, req.auth!, uuidParam(req, 'productId'), req.body, req) });
  }));

  router.post('/catalog/products/:productId/barcodes', requirePermission('catalog.manage'), validateBody(addBarcodeSchema), idempotency(pool, 'catalog.barcodes.add'), asyncHandler(async (req, res) => {
    sendData(res, { product: await addBarcode(pool, req.auth!, uuidParam(req, 'productId'), req.body, req) }, 201);
  }));

  router.delete('/catalog/products/:productId/barcodes/:barcodeId', requirePermission('catalog.manage'), asyncHandler(async (req, res) => {
    sendData(res, { product: await removeBarcode(pool, req.auth!, uuidParam(req, 'productId'), uuidParam(req, 'barcodeId'), req) });
  }));

  return router;
}
