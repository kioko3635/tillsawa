import { z } from 'zod';
import { receiptDesignSchema } from '../receipt-design.js';

export const API_VERSION = 'v1';
export const SYNC_CONTRACT_VERSION = '2';

export const PERMISSION_CODES = [
  'organization.read',
  'organization.update',
  'branch.read',
  'branch.create',
  'branch.update',
  'user.read',
  'user.invite',
  'user.update',
  'user.deactivate',
  'role.read',
  'role.manage',
  'device.read',
  'device.register',
  'device.revoke',
  'settings.manage',
  'session.manage',
  'audit.view',
  'sync.read',
  'sync.write',
  'sync.resolve-conflict',
  'catalog.read',
  'catalog.manage',
  'customer.read',
  'customer.manage',
  'price-list.read',
  'price-list.manage',
  'pos.sell',
  'sale.read',
  'inventory.read',
  'inventory.adjust',
  'inventory.count',
  'inventory.count-approve',
  'inventory.transfer',
  'inventory.negative-override',
  'sales.create',
  'sales.view',
  'sales.view_all',
  'sales.discount',
  'sales.void',
  'sales.return',
  'sales.refund',
  'sales.credit',
  'credit.override',
  'credit.view',
  'credit.manage',
  'credit.collect',
  'credit.adjust',
  'credit.write-off',
  'supplier.read',
  'supplier.manage',
  'purchase.read',
  'purchase.create',
  'purchase.approve',
  'purchase.receive',
  'purchase.cancel',
  'supplier-invoice.manage',
  'supplier-payment.record',
  'expense.view',
  'expense.create',
  'expense.submit',
  'expense.approve',
  'expense.reject',
  'expense.pay',
  'expense.cancel',
  'expense.adjust',
  'expense-category.manage',
  'registers.manage',
  'registers.open',
  'registers.close',
  'registers.cash-movement',
  'receipts.reprint',
  'reports.view',
  'reports.export',
  'stores.view',
  'stores.manage'
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export const uuidSchema = z.string().uuid();
export const organizationSlugSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens');
export const branchCodeSchema = z
  .string()
  .min(2)
  .max(24)
  .regex(/^[A-Z0-9-]+$/, 'Use uppercase letters, numbers and hyphens');
export const passwordSchema = z
  .string()
  .min(1, 'Enter a password')
  .max(128)
  .refine((value) => value.trim().length > 0, 'Enter a password');
export const currencyCodeSchema = z.string().length(3).regex(/^[A-Z]{3}$/);
export const timezoneSchema = z.string().min(3).max(64);
export const taxPricingModeSchema = z.enum(['inclusive', 'exclusive']);
export const entityStatusSchema = z.enum(['active', 'inactive', 'suspended']);

// ---------------------------------------------------------------------------
// Phase 7 — business profiles, module states and capability configuration
// ---------------------------------------------------------------------------

export const BUSINESS_PROFILE_CODES = [
  'general_retail',
  'wines_spirits',
  'wholesale_distribution',
  'fashion_footwear',
  'electronics_hardware',
  'restaurant_cafe',
  'services'
] as const;
export type BusinessProfileCode = (typeof BUSINESS_PROFILE_CODES)[number];
export const businessProfileSchema = z.enum(BUSINESS_PROFILE_CODES);

export const CORE_MODULE_CODES = ['catalog', 'pricing', 'pos'] as const;
export const CONFIGURABLE_MODULE_CODES = [
  'inventory',
  'credit',
  'procurement',
  'expenses',
  'reports',
  'offline_sync'
] as const;
export const MODULE_CODES = [...CORE_MODULE_CODES, ...CONFIGURABLE_MODULE_CODES] as const;
export type CoreModuleCode = (typeof CORE_MODULE_CODES)[number];
export type ConfigurableModuleCode = (typeof CONFIGURABLE_MODULE_CODES)[number];
export type ModuleCode = (typeof MODULE_CODES)[number];

export const IMPLEMENTED_CAPABILITY_CODES = [
  'service_items',
  'batch_expiry_tracking',
  'serial_tracking',
  'barcode_scanner',
  'cash_drawer'
] as const;
export const PLANNED_CAPABILITY_CODES = [
  'product_variants',
  'warranty_tracking',
  'table_service',
  'kitchen_orders',
  'payment_integrations',
  'fiscal_etims'
] as const;
export const CAPABILITY_CODES = [...IMPLEMENTED_CAPABILITY_CODES, ...PLANNED_CAPABILITY_CODES] as const;
export type ImplementedCapabilityCode = (typeof IMPLEMENTED_CAPABILITY_CODES)[number];
export type PlannedCapabilityCode = (typeof PLANNED_CAPABILITY_CODES)[number];
export type CapabilityCode = (typeof CAPABILITY_CODES)[number];

export interface BusinessProfileDefinition {
  code: BusinessProfileCode;
  label: string;
  summary: string;
  recommendedModules: readonly ConfigurableModuleCode[];
  recommendedCapabilities: readonly ImplementedCapabilityCode[];
  plannedCapabilities: readonly PlannedCapabilityCode[];
  implementedHighlights: readonly string[];
  deferredCapabilities: readonly string[];
}

export const BUSINESS_PROFILE_DEFINITIONS: readonly BusinessProfileDefinition[] = [
  {
    code: 'general_retail',
    label: 'General retail and mini-mart',
    summary: 'Balanced POS, catalogue, pricing, stock, credit, purchasing, expense and reporting defaults for everyday retail.',
    recommendedModules: ['inventory', 'credit', 'procurement', 'expenses', 'reports', 'offline_sync'],
    recommendedCapabilities: ['service_items', 'batch_expiry_tracking', 'serial_tracking'],
    plannedCapabilities: ['product_variants', 'payment_integrations', 'fiscal_etims'],
    implementedHighlights: ['Stocked, non-stock and service items', 'Barcodes, units and quantity price tiers', 'Cash and credit checkout'],
    deferredCapabilities: ['Product variants', 'Electronic payment settlement', 'KRA eTIMS invoices']
  },
  {
    code: 'wines_spirits',
    label: 'Wines and spirits',
    summary: 'Retail defaults suited to bottle, pack and case selling with batch/expiry metadata where configured.',
    recommendedModules: ['inventory', 'credit', 'procurement', 'expenses', 'reports', 'offline_sync'],
    recommendedCapabilities: ['service_items', 'batch_expiry_tracking'],
    plannedCapabilities: ['product_variants', 'payment_integrations', 'fiscal_etims'],
    implementedHighlights: ['Bottle, pack, litre and case units', 'Unit conversions and quantity pricing', 'Batch and expiry movement metadata'],
    deferredCapabilities: ['Age-verification workflows', 'Licensing integrations', 'KRA eTIMS invoices']
  },
  {
    code: 'wholesale_distribution',
    label: 'Wholesale and distribution',
    summary: 'Inventory, customer pricing, receivables and purchasing controls for account-based selling.',
    recommendedModules: ['inventory', 'credit', 'procurement', 'expenses', 'reports', 'offline_sync'],
    recommendedCapabilities: ['service_items', 'batch_expiry_tracking', 'serial_tracking'],
    plannedCapabilities: ['product_variants', 'payment_integrations', 'fiscal_etims'],
    implementedHighlights: ['Wholesale and customer-specific price lists', 'Credit limits, terms and AR ledger', 'Purchase orders and branch transfers'],
    deferredCapabilities: ['Route/accounting integrations', 'Delivery fleet management', 'KRA eTIMS invoices']
  },
  {
    code: 'fashion_footwear',
    label: 'Clothing and footwear',
    summary: 'Standard retail catalogue and checkout defaults; size/colour variants remain a planned product module.',
    recommendedModules: ['inventory', 'credit', 'procurement', 'expenses', 'reports', 'offline_sync'],
    recommendedCapabilities: ['service_items'],
    plannedCapabilities: ['product_variants', 'payment_integrations', 'fiscal_etims'],
    implementedHighlights: ['SKU and barcode catalogue', 'Brand and category attributes', 'Retail, wholesale and customer price lists'],
    deferredCapabilities: ['Size and colour variant matrix', 'Style/season planning', 'KRA eTIMS invoices']
  },
  {
    code: 'electronics_hardware',
    label: 'Electronics and hardware',
    summary: 'Retail and wholesale controls with optional serial-number metadata on products and stock movements.',
    recommendedModules: ['inventory', 'credit', 'procurement', 'expenses', 'reports', 'offline_sync'],
    recommendedCapabilities: ['service_items', 'batch_expiry_tracking', 'serial_tracking'],
    plannedCapabilities: ['warranty_tracking', 'payment_integrations', 'fiscal_etims'],
    implementedHighlights: ['Serial metadata on tracked movements', 'Service and repair items', 'Supplier purchasing and stock controls'],
    deferredCapabilities: ['Warranty lifecycle', 'Serialized stock-state ledger', 'KRA eTIMS invoices']
  },
  {
    code: 'restaurant_cafe',
    label: 'Restaurant and café',
    summary: 'POS, product, service-item, stock, expense and reporting foundations while restaurant workflows remain future modules.',
    recommendedModules: ['inventory', 'credit', 'procurement', 'expenses', 'reports', 'offline_sync'],
    recommendedCapabilities: ['service_items', 'batch_expiry_tracking'],
    plannedCapabilities: ['table_service', 'kitchen_orders', 'product_variants', 'payment_integrations', 'fiscal_etims'],
    implementedHighlights: ['Cash and credit POS checkout', 'Prepared/non-stock and service items', 'Ingredient stock and expense tracking'],
    deferredCapabilities: ['Tables and seat management', 'Modifiers and kitchen routing', 'KRA eTIMS invoices']
  },
  {
    code: 'services',
    label: 'Services',
    summary: 'POS, catalogue, pricing, customer credit, expenses and reporting for service-led businesses that do not manage stock by default.',
    recommendedModules: ['credit', 'expenses', 'reports', 'offline_sync'],
    recommendedCapabilities: ['service_items'],
    plannedCapabilities: ['payment_integrations', 'fiscal_etims'],
    implementedHighlights: ['Service item type without stock ledger requirements', 'Appointments or jobs represented as service products', 'Credit, expenses and operational reports'],
    deferredCapabilities: ['Scheduling and dispatch', 'Time billing', 'KRA eTIMS invoices']
  }
] as const;

export const registerOrganizationSchema = z.object({
  organization: z.object({
    slug: organizationSlugSchema.optional(),
    legalName: z.string().min(2).max(160),
    displayName: z.string().min(2).max(120),
    currencyCode: currencyCodeSchema.default('KES'),
    timezone: timezoneSchema.default('Africa/Nairobi'),
    taxPricingMode: taxPricingModeSchema.default('inclusive'),
    businessProfile: businessProfileSchema.default('general_retail')
  }),
  branch: z.object({
    code: branchCodeSchema.default('HQ'),
    name: z.string().min(2).max(120).default('Head Office')
  }),
  owner: z.object({
    displayName: z.string().min(2).max(120),
    email: z.string().email().max(254),
    password: passwordSchema
  })
});

export const loginSchema = z.object({
  organizationSlug: organizationSlugSchema.optional(),
  organizationId: uuidSchema.optional(),
  email: z.string().email().max(254),
  password: z.string().min(1).max(128)
});

export const requestPasswordResetSchema = z.object({
  organizationSlug: organizationSlugSchema.optional(),
  email: z.string().email().max(254)
});

export const resetPasswordSchema = z.object({
  token: z.string().min(32).max(512),
  password: passwordSchema
});

export const updateOrganizationSchema = z.object({
  legalName: z.string().min(2).max(160).optional(),
  displayName: z.string().min(2).max(120).optional(),
  currencyCode: currencyCodeSchema.optional(),
  timezone: timezoneSchema.optional(),
  taxPricingMode: taxPricingModeSchema.optional(),
  defaultTaxRatePct: decimalString(2).optional(),
  receiptPolicy: z.string().min(2).max(1000).optional(),
  status: entityStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')
  .refine((value) => value.defaultTaxRatePct === undefined || Number(value.defaultTaxRatePct) <= 100, 'Default tax rate cannot exceed 100 percent');

const configurableModuleStateSchema = z.object({
  inventory: z.boolean().optional(),
  credit: z.boolean().optional(),
  procurement: z.boolean().optional(),
  expenses: z.boolean().optional(),
  reports: z.boolean().optional(),
  offline_sync: z.boolean().optional()
}).strict();

const capabilityStateSchema = z.object({
  service_items: z.boolean().optional(),
  batch_expiry_tracking: z.boolean().optional(),
  serial_tracking: z.boolean().optional(),
  barcode_scanner: z.boolean().optional(),
  cash_drawer: z.boolean().optional()
}).strict();

export const updateOrganizationConfigurationSchema = z.object({
  businessProfile: businessProfileSchema.optional(),
  applyProfilePreset: z.boolean().optional(),
  defaultBranchId: uuidSchema.nullish(),
  contactPhone: z.string().max(40).nullish(),
  contactEmail: z.string().email().max(254).nullish(),
  businessAddress: z.string().max(500).nullish(),
  taxPin: z.string().regex(/^[A-Z0-9]{5,20}$/, 'Use a 5-20 character tax registration reference').nullish(),
  receiptHeader: z.string().max(240).nullish(),
  receiptFooter: z.string().max(500).nullish(),
  receiptDesign: receiptDesignSchema.optional(),
  cashDrawerPolicy: z.enum(['cash', 'paid']).optional(),
  receiptLogoUrl: z.string().max(150000).regex(/^(https:\/\/\S+|data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+)$/, 'Upload a PNG/JPEG logo or use a secure HTTPS image URL').nullish(),
  modules: configurableModuleStateSchema.optional(),
  capabilities: capabilityStateSchema.optional(),
  changeReason: z.string().min(2).max(500).optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required')
  .refine((value) => !value.applyProfilePreset || (!value.modules && !value.capabilities), 'Module and capability overrides cannot be combined with a profile preset')
  .refine((value) => !value.applyProfilePreset || value.changeReason !== undefined, 'A change reason is required when applying a profile preset');

export const createBranchSchema = z.object({
  code: branchCodeSchema,
  name: z.string().min(2).max(120),
  timezone: timezoneSchema.nullish(),
  currencyCode: currencyCodeSchema.nullish()
});

export const updateBranchSchema = z.object({
  code: branchCodeSchema.optional(),
  name: z.string().min(2).max(120).optional(),
  timezone: timezoneSchema.nullish(),
  currencyCode: currencyCodeSchema.nullish(),
  status: z.enum(['active', 'inactive']).optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const createUserSchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().min(2).max(120),
  temporaryPassword: passwordSchema.optional(),
  title: z.string().max(120).optional(),
  allBranches: z.boolean().default(false),
  roleIds: z.array(uuidSchema).min(1),
  branchIds: z.array(uuidSchema).default([])
}).refine((value) => value.allBranches || value.branchIds.length > 0, 'Select all branches or at least one branch');

export const updateMembershipSchema = z.object({
  status: z.enum(['active', 'suspended']).optional(),
  title: z.string().max(120).nullish(),
  allBranches: z.boolean().optional(),
  roleIds: z.array(uuidSchema).min(1).optional(),
  branchIds: z.array(uuidSchema).optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const roleSchema = z.object({
  code: z.string().min(2).max(48).regex(/^[a-z0-9-]+$/),
  name: z.string().min(2).max(120),
  description: z.string().max(300).optional(),
  permissionCodes: z.array(z.enum(PERMISSION_CODES)).min(1)
});

export const updateRoleSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(300).nullish(),
  permissionCodes: z.array(z.enum(PERMISSION_CODES)).min(1).optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const registerDeviceSchema = z.object({
  name: z.string().min(2).max(120),
  branchId: uuidSchema,
  platform: z.string().max(80).optional()
});

export const updateDeviceSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  branchId: uuidSchema.optional(),
  status: z.enum(['active', 'suspended', 'revoked']).optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const syncCursorSchema = z.object({
  deviceId: uuidSchema,
  entityType: z.string().min(2).max(80),
  cursor: z.number().int().nonnegative()
});

// ---------------------------------------------------------------------------
// Phase 2 — product catalogue, pricing and inventory contracts
// ---------------------------------------------------------------------------

/**
 * Money is transmitted as an exact decimal string (or JSON number) in major
 * currency units, e.g. "149.95". The API converts it to integer minor units
 * (scale 2) before storage. Floating-point values are never authoritative.
 */
function decimalString(maxFractionDigits: number, allowNegative = false) {
  return z.union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .refine(
      (value) => new RegExp(`^${allowNegative ? '-?' : ''}\\d+(?:\\.\\d{1,${maxFractionDigits}})?$`).test(value),
      allowNegative ? `Use a decimal with at most ${maxFractionDigits} fraction digits` : `Use a non-negative decimal with at most ${maxFractionDigits} fraction digits`
    );
}

export const moneyInputSchema = decimalString(2);
export const quantityInputSchema = decimalString(6);
export const signedQuantityInputSchema = decimalString(6, true);

export const skuSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, numbers, dots, underscores or hyphens');

export const barcodeSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/, 'Barcodes may contain letters, numbers and hyphens');

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

// --- Categories and units --------------------------------------------------

export const createCategorySchema = z.object({
  name: z.string().min(1).max(120),
  parentId: uuidSchema.nullish(),
  status: z.enum(['active', 'inactive']).default('active')
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parentId: uuidSchema.nullish(),
  status: z.enum(['active', 'inactive']).optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const createUnitSchema = z.object({
  code: z.string().min(1).max(20).regex(/^[A-Za-z0-9]+$/, 'Use letters and numbers only'),
  name: z.string().min(1).max(80),
  status: z.enum(['active', 'inactive']).default('active')
});

export const updateUnitSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  status: z.enum(['active', 'inactive']).optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const unitConversionSchema = z.object({
  fromUnitId: uuidSchema,
  toUnitId: uuidSchema,
  ratio: z.union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .refine((value) => /^\d+(?:\.\d{1,8})?$/.test(value) && Number(value) > 0, 'Ratio must be a positive decimal')
}).refine((value) => value.fromUnitId !== value.toUnitId, 'A unit cannot convert to itself');

// --- Products ----------------------------------------------------------------

export const itemTypeSchema = z.enum(['stocked', 'non_stock', 'service']);
export const costingMethodSchema = z.enum(['average', 'latest']);
export const productStatusSchema = z.enum(['active', 'archived']);

export const libraryProductSelectionSchema = z.object({
  entries: z.array(z.object({
    id: z.string().min(1).max(80),
    sellingPrice: moneyInputSchema.refine((value) => Number(value) > 0, 'Enter a selling price above zero'),
    cost: moneyInputSchema.default('0')
  })).min(1).max(50).refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, 'Select each product once')
});

export const createProductSchema = z.object({
  sku: skuSchema,
  name: z.string().min(1).max(160),
  description: z.string().max(2000).nullish(),
  brand: z.string().max(120).nullish(),
  imageUrl: z.string().max(500).nullish(),
  categoryId: uuidSchema.nullish(),
  baseUnitId: uuidSchema,
  itemType: itemTypeSchema.default('stocked'),
  status: productStatusSchema.default('active'),
  cost: moneyInputSchema.default('0'),
  basePrice: moneyInputSchema.default('0'),
  minPrice: moneyInputSchema.nullish(),
  taxRatePct: decimalString(2).refine((value) => Number(value) <= 100, 'Tax rate cannot exceed 100 percent').nullish(),
  costingMethod: costingMethodSchema.default('average'),
  minStockLevel: quantityInputSchema.default('0'),
  reorderQty: quantityInputSchema.nullish(),
  trackBatch: z.boolean().default(false),
  trackExpiry: z.boolean().default(false),
  trackSerial: z.boolean().default(false),
  barcodes: z.array(barcodeSchema).max(8).default([]),
  conversions: z.array(unitConversionSchema).max(16).default([])
});

export const updateProductSchema = createProductSchema
  .omit({ barcodes: true, conversions: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const addBarcodeSchema = z.object({
  barcode: barcodeSchema,
  isPrimary: z.boolean().default(false)
});

export const productListQuerySchema = paginationQuerySchema.extend({
  search: z.string().max(120).optional(),
  categoryId: uuidSchema.optional(),
  status: productStatusSchema.optional(),
  itemType: itemTypeSchema.optional(),
  sort: z.enum(['name', 'sku', 'created_at', 'updated_at']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc')
});

const csvBooleanSchema = z.preprocess(
  (value) => {
    if (typeof value === 'boolean' || value === undefined) return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', ''].includes(normalized)) return false;
    return value;
  },
  z.boolean()
).default(false);

export const productCsvRowSchema = z.object({
  sku: skuSchema,
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  brand: z.string().max(120).optional(),
  barcode: z.string().max(64).optional(),
  category: z.string().max(120).optional(),
  baseUnit: z.string().max(20).optional(),
  itemType: itemTypeSchema.default('stocked'),
  cost: moneyInputSchema.default('0'),
  basePrice: moneyInputSchema.default('0'),
  minStockLevel: quantityInputSchema.default('0'),
  trackBatch: csvBooleanSchema,
  trackExpiry: csvBooleanSchema,
  trackSerial: csvBooleanSchema
});

export const productImportSchema = z.object({
  csv: z.string().min(1).max(1024 * 1024)
});

// --- Customers ----------------------------------------------------------------

export const createCustomerSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().min(1).max(160),
  contactPerson: z.string().max(160).nullish(),
  phone: z.string().max(40).nullish(),
  email: z.string().email().max(254).nullish(),
  address: z.string().max(500).nullish(),
  taxPin: z.string().regex(/^[A-Z0-9]{5,20}$/).nullish(),
  notes: z.string().max(1000).nullish(),
  status: z.enum(['active', 'inactive']).default('active')
});

export const updateCustomerSchema = createCustomerSchema.partial().extend({
  creditStatus: z.enum(['disabled', 'active', 'hold']).optional(),
  creditLimit: moneyInputSchema.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  creditReason: z.string().min(2).max(500).optional()
}).refine(
  (value) => Object.keys(value).length > 0,
  'At least one field is required'
);

// --- Price lists ----------------------------------------------------------------

export const priceListKindSchema = z.enum(['retail', 'wholesale', 'customer', 'branch']);

export const createPriceListSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().min(1).max(160),
  kind: priceListKindSchema,
  branchId: uuidSchema.nullish(),
  customerId: uuidSchema.nullish(),
  status: z.enum(['active', 'inactive']).default('active'),
  validFrom: z.string().datetime({ offset: true }).nullish(),
  validTo: z.string().datetime({ offset: true }).nullish(),
  maxDiscountPct: decimalString(2).nullish(),
  minPrice: moneyInputSchema.nullish(),
  isDefault: z.boolean().default(false)
}).refine((value) => (value.kind === 'branch' ? Boolean(value.branchId) : true), {
  message: 'branchId is required for branch price lists'
}).refine((value) => (value.kind === 'customer' ? Boolean(value.customerId) : true), {
  message: 'customerId is required for customer price lists'
}).refine((value) => (value.kind === 'branch' ? !value.customerId : true), {
  message: 'Branch price lists cannot also be customer-specific'
}).refine((value) => (['retail', 'wholesale'].includes(value.kind) ? !value.branchId && !value.customerId : true), {
  message: 'Retail and wholesale lists cannot be scoped to a branch or customer'
});

export const updatePriceListSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  validFrom: z.string().datetime({ offset: true }).nullish(),
  validTo: z.string().datetime({ offset: true }).nullish(),
  maxDiscountPct: decimalString(2).nullish(),
  minPrice: moneyInputSchema.nullish(),
  isDefault: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const priceLineInputSchema = z.object({
  productId: uuidSchema,
  minQty: quantityInputSchema.default('0'),
  price: moneyInputSchema,
  validFrom: z.string().datetime({ offset: true }).nullish(),
  validTo: z.string().datetime({ offset: true }).nullish(),
  status: z.enum(['active', 'inactive']).default('active')
});

export const upsertPriceLinesSchema = z.object({
  lines: z.array(priceLineInputSchema).min(1).max(500)
});

export const priceResolveSchema = z.object({
  productId: uuidSchema,
  branchId: uuidSchema,
  quantity: quantityInputSchema.default('1'),
  customerId: uuidSchema.nullish(),
  priceListId: uuidSchema.nullish(),
  discountPct: decimalString(2).optional(),
  at: z.string().datetime({ offset: true }).optional()
});

export const priceListQuerySchema = paginationQuerySchema.extend({
  kind: priceListKindSchema.optional(),
  branchId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
  status: z.enum(['active', 'inactive']).optional()
});

// --- Inventory -----------------------------------------------------------------

export const adjustmentTypeSchema = z.enum(['opening', 'correction', 'damage', 'loss', 'write_off']);

export const adjustmentLineSchema = z.object({
  productId: uuidSchema,
  unitId: uuidSchema.optional(),
  quantity: signedQuantityInputSchema,
  unitCost: moneyInputSchema.optional(),
  batchNo: z.string().max(80).nullish(),
  serialNo: z.string().max(120).nullish(),
  expiryDate: z.string().date().nullish()
});

export const createAdjustmentSchema = z.object({
  branchId: uuidSchema,
  type: adjustmentTypeSchema,
  reason: z.string().min(2).max(500),
  allowNegative: z.boolean().default(false),
  negativeReason: z.string().min(2).max(500).nullish(),
  lines: z.array(adjustmentLineSchema).min(1).max(200)
}).refine(
  (value) => !value.allowNegative || Boolean(value.negativeReason),
  'negativeReason is required when allowNegative is set'
);

export const createStockCountSchema = z.object({
  branchId: uuidSchema,
  name: z.string().max(120).optional(),
  notes: z.string().max(500).nullish(),
  productIds: z.array(uuidSchema).max(500).optional()
});

export const recordCountLinesSchema = z.object({
  lines: z.array(z.object({
    productId: uuidSchema,
    countedQty: quantityInputSchema
  })).min(1).max(500)
});

export const decideStockCountSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(500).nullish(),
  allowNegative: z.boolean().default(false),
  negativeReason: z.string().min(2).max(500).nullish()
}).refine(
  (value) => !value.allowNegative || Boolean(value.negativeReason),
  'negativeReason is required when allowNegative is set'
);

export const createTransferSchema = z.object({
  sourceBranchId: uuidSchema,
  destinationBranchId: uuidSchema,
  notes: z.string().max(500).nullish(),
  lines: z.array(z.object({
    productId: uuidSchema,
    unitId: uuidSchema.optional(),
    quantity: quantityInputSchema
  })).min(1).max(200)
}).refine((value) => value.sourceBranchId !== value.destinationBranchId, 'Source and destination branches must differ');

export const dispatchTransferSchema = z.object({
  allowNegative: z.boolean().default(false),
  negativeReason: z.string().min(2).max(500).nullish()
}).refine(
  (value) => !value.allowNegative || Boolean(value.negativeReason),
  'negativeReason is required when allowNegative is set'
);

export const receiveTransferSchema = z.object({
  lines: z.array(z.object({
    transferLineId: uuidSchema,
    quantity: quantityInputSchema
  })).max(200).optional()
});

export const cancelTransferSchema = z.object({
  reason: z.string().min(2).max(500)
});

export const stockLevelQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema,
  search: z.string().max(120).optional(),
  lowStock: z.coerce.boolean().optional(),
  sort: z.enum(['name', 'sku', 'on_hand_qty', 'updated_at']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc')
});

export const movementQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema,
  productId: uuidSchema.optional(),
  movementType: z.enum(['opening', 'adjustment', 'damage', 'loss', 'write_off', 'transfer_out', 'transfer_in', 'transfer_return', 'count_adjustment', 'sale', 'sale_void', 'sale_return', 'purchase_receipt']).optional()
});

// ---------------------------------------------------------------------------
// Phase 3 — POS checkout, cash sales and receipts contracts
// ---------------------------------------------------------------------------

export const posProductSearchQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema,
  search: z.string().max(120).optional()
});

export const createRegisterSchema = z.object({
  branchId: uuidSchema,
  code: z.string().min(1).max(32).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().min(2).max(120),
  status: z.enum(['active', 'inactive']).default('active'),
  receiptPrefix: z.string().min(1).max(16).regex(/^[A-Za-z0-9-]+$/).optional(),
  receiptFooter: z.string().max(500).nullish()
});

export const updateRegisterSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  receiptPrefix: z.string().min(1).max(16).regex(/^[A-Za-z0-9-]+$/).optional(),
  receiptFooter: z.string().max(500).nullish()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const registerQuerySchema = z.object({
  branchId: uuidSchema.optional(),
  status: z.enum(['active', 'inactive']).optional()
});

export const openRegisterSessionSchema = z.object({
  registerId: uuidSchema,
  openingFloat: moneyInputSchema.default('0'),
  notes: z.string().max(500).nullish()
});

export const registerSessionQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema.optional(),
  registerId: uuidSchema.optional(),
  status: z.enum(['open', 'closed']).optional()
});

export const cashMovementSchema = z.object({
  type: z.enum(['cash_in', 'cash_out', 'cash_adjustment']),
  direction: z.enum(['in', 'out']).optional(),
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Amount must be positive'),
  reason: z.string().min(2).max(500)
}).refine(
  (value) => value.type === 'cash_adjustment' ? Boolean(value.direction) : true,
  'direction is required for cash adjustments'
);

export const closeRegisterSessionSchema = z.object({
  countedCash: moneyInputSchema,
  reason: z.string().max(500).nullish()
});

export const saleLineInputSchema = z.object({
  productId: uuidSchema,
  unitId: uuidSchema.optional(),
  quantity: quantityInputSchema.refine((value) => Number(value) > 0, 'Quantity must be positive'),
  discountPct: decimalString(2).optional(),
  batchNo: z.string().max(80).nullish(),
  serialNo: z.string().max(120).nullish(),
  expiryDate: z.string().date().nullish()
}).refine((value) => value.discountPct === undefined || Number(value.discountPct) <= 100, 'Discount cannot exceed 100 percent');

export const completeSaleSchema = z.object({
  clientTransactionId: uuidSchema,
  registerSessionId: uuidSchema,
  customerId: uuidSchema.nullish(),
  loyaltyPointsToRedeem: z.number().int().min(0).max(1000000000).optional(),
  priceListId: uuidSchema.nullish(),
  deviceId: uuidSchema.nullish(),
  allowNegative: z.boolean().default(false),
  negativeReason: z.string().min(2).max(500).nullish(),
  allowCreditOverride: z.boolean().default(false),
  creditOverrideReason: z.string().min(2).max(500).nullish(),
  items: z.array(saleLineInputSchema).min(1).max(100),
  payment: z.object({
    method: z.enum(['cash', 'credit', 'mpesa', 'card']),
    amountTendered: moneyInputSchema.optional(),
    intentId: uuidSchema.optional()
  })
}).refine(
  (value) => !value.allowNegative || Boolean(value.negativeReason),
  'negativeReason is required when allowNegative is set'
).refine(
  (value) => value.payment.method !== 'cash' || value.payment.amountTendered !== undefined,
  'Cash sales require amountTendered'
).refine(
  (value) => !['mpesa', 'card'].includes(value.payment.method) || Boolean(value.payment.intentId),
  'Electronic payments require a confirmed payment intent'
).refine(
  (value) => value.payment.method !== 'credit' || Boolean(value.customerId),
  'Credit sales require a customer'
).refine(
  (value) => !value.allowCreditOverride || Boolean(value.creditOverrideReason),
  'creditOverrideReason is required when allowCreditOverride is set'
);

export const saleListQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema.optional(),
  registerSessionId: uuidSchema.optional(),
  status: z.enum(['completed', 'partially_returned', 'returned', 'voided']).optional(),
  search: z.string().max(120).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional()
});

export const voidSaleSchema = z.object({
  reason: z.string().min(2).max(500)
});

export const saleReturnLineSchema = z.object({
  saleLineId: uuidSchema,
  quantity: quantityInputSchema.refine((value) => Number(value) > 0, 'Quantity must be positive'),
  disposition: z.enum(['restock', 'damaged', 'write_off']).default('restock')
});

export const createSaleReturnSchema = z.object({
  reason: z.string().min(2).max(500),
  lines: z.array(saleReturnLineSchema).min(1).max(100)
}).refine(
  (value) => new Set(value.lines.map((line) => line.saleLineId)).size === value.lines.length,
  'A sale line can only be returned once per request'
);

export const createSaleRefundSchema = z.object({
  registerSessionId: uuidSchema,
  saleReturnId: uuidSchema.nullish(),
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Refund amount must be positive'),
  reason: z.string().min(2).max(500)
});

export const reprintReceiptSchema = z.object({
  reason: z.string().max(500).nullish()
});

// ---------------------------------------------------------------------------
// Phase 6 — durable offline outbox and synchronization contracts
// ---------------------------------------------------------------------------

export const offlineSaleLineSnapshotSchema = z.object({
  productId: uuidSchema,
  productSku: z.string().min(1).max(80),
  productName: z.string().min(1).max(240),
  unitId: uuidSchema,
  unitCode: z.string().min(1).max(24),
  quantity: quantityInputSchema.refine((value) => Number(value) > 0, 'Quantity must be positive'),
  baseQuantity: quantityInputSchema.refine((value) => Number(value) > 0, 'Base quantity must be positive'),
  listPrice: moneyInputSchema,
  unitPrice: moneyInputSchema,
  discountPct: z.string().max(8).default('0'),
  discount: moneyInputSchema,
  subtotal: moneyInputSchema,
  taxRatePct: z.string().max(8).nullable(),
  tax: moneyInputSchema,
  total: moneyInputSchema,
  onHandQty: quantityInputSchema.nullish(),
  priceSource: z.string().max(32).nullish(),
  priceListId: uuidSchema.nullish(),
  priceLineId: uuidSchema.nullish()
});

export const offlineSaleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string().datetime({ offset: true }),
  referenceRevision: z.string().min(8).max(128),
  currencyCode: currencyCodeSchema,
  taxPricingMode: taxPricingModeSchema,
  lines: z.array(offlineSaleLineSnapshotSchema).min(1).max(100),
  totals: z.object({
    subtotal: moneyInputSchema,
    discountTotal: moneyInputSchema,
    taxTotal: moneyInputSchema,
    total: moneyInputSchema,
    amountTendered: moneyInputSchema,
    change: moneyInputSchema
  })
});

export const syncTransactionItemSchema = z.object({
  clientTransactionId: uuidSchema,
  entityType: z.string().min(2).max(80),
  occurredAt: z.string().datetime({ offset: true }),
  branchId: uuidSchema,
  deviceId: uuidSchema,
  registerSessionId: uuidSchema,
  cashierMembershipId: uuidSchema,
  payload: z.unknown()
});

export const offlineSaleTransactionPayloadSchema = z.object({
  sale: completeSaleSchema,
  snapshot: offlineSaleSnapshotSchema
});

export const syncBatchSchema = z.object({
  batchId: uuidSchema,
  deviceId: uuidSchema,
  contractVersion: z.literal(SYNC_CONTRACT_VERSION),
  transactions: z.array(syncTransactionItemSchema).min(1).max(20)
}).refine(
  (value) => value.transactions.every((transaction) => transaction.deviceId === value.deviceId),
  'Every transaction must belong to the submitted device'
);

export const syncTransactionQuerySchema = z.object({
  deviceId: uuidSchema,
  status: z.enum(['pending', 'processing', 'accepted', 'duplicate', 'retryable', 'rejected', 'conflict', 'resolved']).optional(),
  clientTransactionId: uuidSchema.optional()
});

export const resolveSyncTransactionSchema = z.object({
  action: z.enum(['retry', 'accept-current-price', 'override-negative-stock', 'cancel-local']),
  reason: z.string().min(2).max(500)
});

export type OfflineSaleLineSnapshot = z.infer<typeof offlineSaleLineSnapshotSchema>;
export type OfflineSaleSnapshot = z.infer<typeof offlineSaleSnapshotSchema>;
export type SyncTransactionItem = z.infer<typeof syncTransactionItemSchema>;
export type OfflineSaleTransactionPayload = z.infer<typeof offlineSaleTransactionPayloadSchema>;
export type SyncBatchInput = z.infer<typeof syncBatchSchema>;
export type SyncTransactionQuery = z.infer<typeof syncTransactionQuerySchema>;
export type ResolveSyncTransactionInput = z.infer<typeof resolveSyncTransactionSchema>;

// ---------------------------------------------------------------------------
// Phase 4 — customer credit, suppliers and procurement contracts
// ---------------------------------------------------------------------------

export const customerCreditStatusSchema = z.enum(['disabled', 'active', 'hold']);

export const updateCustomerCreditSchema = z.object({
  creditStatus: customerCreditStatusSchema.optional(),
  creditLimit: moneyInputSchema.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  reason: z.string().min(2).max(500)
}).refine(
  (value) => value.creditStatus !== undefined || value.creditLimit !== undefined || value.paymentTermsDays !== undefined,
  'At least one credit field is required'
);

export const creditAllocationSchema = z.object({
  saleId: uuidSchema,
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Allocation amount must be positive')
});

export const recordCustomerPaymentSchema = z.object({
  clientTransactionId: uuidSchema,
  registerSessionId: uuidSchema,
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Payment amount must be positive'),
  allocations: z.array(creditAllocationSchema).min(1).max(100),
  reason: z.string().min(2).max(500)
}).refine(
  (value) => new Set(value.allocations.map((line) => line.saleId)).size === value.allocations.length,
  'A sale can only be allocated once per payment'
);

export const createCustomerCreditAdjustmentSchema = z.object({
  clientTransactionId: uuidSchema,
  type: z.enum(['debit_adjustment', 'credit_adjustment', 'write_off']),
  branchId: uuidSchema.optional(),
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Adjustment amount must be positive'),
  reason: z.string().min(2).max(500),
  allocations: z.array(creditAllocationSchema).max(100).optional()
}).refine(
  (value) => value.type !== 'debit_adjustment' || !value.allocations?.length,
  'Debit adjustments cannot be allocated to sales'
).refine(
  (value) => value.type === 'debit_adjustment' || Boolean(value.allocations?.length),
  'Credit adjustments and write-offs require sale allocations'
);

export const customerQuerySchema = paginationQuerySchema.extend({
  search: z.string().max(120).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  creditStatus: customerCreditStatusSchema.optional()
});

export const createSupplierSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().min(1).max(160),
  contactPerson: z.string().max(160).nullish(),
  phone: z.string().max(40).nullish(),
  email: z.string().email().max(254).nullish(),
  address: z.string().max(500).nullish(),
  taxPin: z.string().regex(/^[A-Z0-9]{5,20}$/).nullish(),
  supplierReference: z.string().max(80).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  status: z.enum(['active', 'inactive']).default('active'),
  notes: z.string().max(1000).nullish()
});

export const updateSupplierSchema = createSupplierSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one field is required'
);

export const supplierQuerySchema = paginationQuerySchema.extend({
  search: z.string().max(120).optional(),
  status: z.enum(['active', 'inactive']).optional()
});

export const purchaseOrderLineInputSchema = z.object({
  productId: uuidSchema,
  unitId: uuidSchema.optional(),
  quantity: quantityInputSchema.refine((value) => Number(value) > 0, 'Quantity must be positive'),
  unitCost: moneyInputSchema
});

export const createPurchaseOrderSchema = z.object({
  clientTransactionId: uuidSchema,
  branchId: uuidSchema,
  supplierId: uuidSchema,
  expectedDeliveryDate: z.string().date().nullish(),
  supplierReference: z.string().max(80).nullish(),
  notes: z.string().max(1000).nullish(),
  lines: z.array(purchaseOrderLineInputSchema).min(1).max(200)
}).refine(
  (value) => new Set(value.lines.map((line) => line.productId)).size === value.lines.length,
  'A product can only appear once per purchase order'
);

export const purchaseOrderQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema.optional(),
  supplierId: uuidSchema.optional(),
  status: z.enum(['draft', 'submitted', 'approved', 'partially_received', 'received', 'cancelled']).optional(),
  search: z.string().max(120).optional()
});

export const cancelPurchaseOrderSchema = z.object({
  reason: z.string().min(2).max(500)
});

export const receivePurchaseOrderLineSchema = z.object({
  purchaseOrderLineId: uuidSchema,
  receivedQty: quantityInputSchema.default('0'),
  damagedQty: quantityInputSchema.default('0'),
  rejectedQty: quantityInputSchema.default('0'),
  discrepancyReason: z.string().max(500).nullish()
}).refine(
  (value) => Number(value.receivedQty) > 0 || Number(value.damagedQty) > 0 || Number(value.rejectedQty) > 0,
  'At least one receipt quantity is required'
).refine(
  (value) => (Number(value.damagedQty) > 0 || Number(value.rejectedQty) > 0) ? Boolean(value.discrepancyReason) : true,
  'A discrepancy reason is required for damaged or rejected goods'
);

export const receivePurchaseOrderSchema = z.object({
  clientTransactionId: uuidSchema,
  notes: z.string().max(1000).nullish(),
  lines: z.array(receivePurchaseOrderLineSchema).min(1).max(200)
}).refine(
  (value) => new Set(value.lines.map((line) => line.purchaseOrderLineId)).size === value.lines.length,
  'A purchase-order line can only be received once per receipt'
);

export const createSupplierInvoiceSchema = z.object({
  clientTransactionId: uuidSchema,
  branchId: uuidSchema,
  supplierId: uuidSchema,
  purchaseOrderId: uuidSchema.nullish(),
  invoiceNumber: z.string().min(1).max(80),
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Invoice amount must be positive'),
  issueDate: z.string().date().optional(),
  dueDate: z.string().date().nullish(),
  notes: z.string().max(1000).nullish()
});

export const supplierInvoiceQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema.optional(),
  supplierId: uuidSchema.optional(),
  status: z.enum(['outstanding', 'partially_paid', 'paid', 'voided']).optional(),
  search: z.string().max(120).optional()
});

export const supplierPaymentAllocationSchema = z.object({
  supplierInvoiceId: uuidSchema,
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Allocation amount must be positive')
});

export const recordSupplierPaymentSchema = z.object({
  clientTransactionId: uuidSchema,
  registerSessionId: uuidSchema,
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Payment amount must be positive'),
  allocations: z.array(supplierPaymentAllocationSchema).min(1).max(100),
  reason: z.string().min(2).max(500)
}).refine(
  (value) => new Set(value.allocations.map((line) => line.supplierInvoiceId)).size === value.allocations.length,
  'An invoice can only be allocated once per payment'
);

// ---------------------------------------------------------------------------
// Phase 5 — expenses and operational reporting contracts
// ---------------------------------------------------------------------------

export const expenseStatusSchema = z.enum(['draft', 'submitted', 'approved', 'rejected', 'paid', 'cancelled']);
export const expensePaymentStatusSchema = z.enum(['unpaid', 'pending', 'paid']);
export const expensePaymentMethodSchema = z.enum(['cash', 'bank_transfer', 'mobile_money', 'other']);

export const createExpenseCategorySchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens'),
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullish(),
  status: z.enum(['active', 'inactive']).default('active')
});

export const updateExpenseCategorySchema = createExpenseCategorySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one field is required'
);

const expenseFilterFields = {
  branchId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  status: expenseStatusSchema.optional(),
  paymentStatus: expensePaymentStatusSchema.optional(),
  paymentMethod: expensePaymentMethodSchema.optional(),
  supplierId: uuidSchema.optional(),
  createdByMembershipId: uuidSchema.optional(),
  approvedByMembershipId: uuidSchema.optional(),
  search: z.string().max(160).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional()
};

export const expenseQuerySchema = paginationQuerySchema.extend(expenseFilterFields).refine(
  (value) => !value.from || !value.to || value.from <= value.to,
  'The report start date must not be after the end date'
);

export const expenseExportQuerySchema = z.object(expenseFilterFields).refine(
  (value) => !value.from || !value.to || value.from <= value.to,
  'The report start date must not be after the end date'
);

export const createExpenseSchema = z.object({
  clientTransactionId: uuidSchema,
  branchId: uuidSchema,
  categoryId: uuidSchema,
  description: z.string().min(2).max(240),
  businessPurpose: z.string().max(1000).nullish(),
  expenseDate: z.string().date(),
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Expense amount must be positive'),
  currencyCode: currencyCodeSchema.optional(),
  paymentMethod: expensePaymentMethodSchema.default('cash'),
  payeeName: z.string().max(160).nullish(),
  supplierId: uuidSchema.nullish(),
  supportingDocumentRef: z.string().max(120).nullish(),
  supportingDocumentName: z.string().max(240).nullish()
});

export const updateExpenseSchema = z.object({
  categoryId: uuidSchema.optional(),
  description: z.string().min(2).max(240).optional(),
  businessPurpose: z.string().max(1000).nullish(),
  expenseDate: z.string().date().optional(),
  amount: moneyInputSchema.refine((value) => Number(value) > 0, 'Expense amount must be positive').optional(),
  currencyCode: currencyCodeSchema.optional(),
  paymentMethod: expensePaymentMethodSchema.optional(),
  payeeName: z.string().max(160).nullish(),
  supplierId: uuidSchema.nullish(),
  supportingDocumentRef: z.string().max(120).nullish(),
  supportingDocumentName: z.string().max(240).nullish(),
  reason: z.string().min(2).max(500).optional()
}).refine(
  (value) => Object.keys(value).some((key) => key !== 'reason' && value[key as keyof typeof value] !== undefined),
  'At least one expense field is required'
);

export const expenseDecisionSchema = z.object({
  reason: z.string().min(2).max(500)
});

export const expenseReasonSchema = z.object({
  reason: z.string().min(2).max(500)
});

export const payExpenseSchema = z.object({
  clientTransactionId: uuidSchema,
  registerSessionId: uuidSchema.optional(),
  reason: z.string().min(2).max(500),
  paymentReference: z.string().max(120).nullish()
});

export const operationsReportQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  branchId: uuidSchema.optional()
}).refine(
  (value) => !value.from || !value.to || value.from <= value.to,
  'The report start date must not be after the end date'
);

export type RegisterOrganizationInput = z.infer<typeof registerOrganizationSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type UpdateOrganizationConfigurationInput = z.infer<typeof updateOrganizationConfigurationSchema>;
export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;
export type RoleInput = z.infer<typeof roleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
export type SyncCursorInput = z.infer<typeof syncCursorSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;
export type UnitConversionInput = z.infer<typeof unitConversionSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type AddBarcodeInput = z.infer<typeof addBarcodeSchema>;
export type ProductListQuery = z.infer<typeof productListQuerySchema>;
export type ProductCsvRow = z.infer<typeof productCsvRowSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CreatePriceListInput = z.infer<typeof createPriceListSchema>;
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;
export type PriceLineInput = z.infer<typeof priceLineInputSchema>;
export type UpsertPriceLinesInput = z.infer<typeof upsertPriceLinesSchema>;
export type PriceResolveInput = z.infer<typeof priceResolveSchema>;
export type PriceListQuery = z.infer<typeof priceListQuerySchema>;
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
export type CreateStockCountInput = z.infer<typeof createStockCountSchema>;
export type RecordCountLinesInput = z.infer<typeof recordCountLinesSchema>;
export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type DispatchTransferInput = z.infer<typeof dispatchTransferSchema>;
export type ReceiveTransferInput = z.infer<typeof receiveTransferSchema>;
export type DecideStockCountInput = z.infer<typeof decideStockCountSchema>;
export type CancelTransferInput = z.infer<typeof cancelTransferSchema>;
export type StockLevelQuery = z.infer<typeof stockLevelQuerySchema>;
export type MovementQuery = z.infer<typeof movementQuerySchema>;
export type PosProductSearchQuery = z.infer<typeof posProductSearchQuerySchema>;
export type CreateRegisterInput = z.infer<typeof createRegisterSchema>;
export type UpdateRegisterInput = z.infer<typeof updateRegisterSchema>;
export type RegisterQuery = z.infer<typeof registerQuerySchema>;
export type OpenRegisterSessionInput = z.infer<typeof openRegisterSessionSchema>;
export type RegisterSessionQuery = z.infer<typeof registerSessionQuerySchema>;
export type CashMovementInput = z.infer<typeof cashMovementSchema>;
export type CloseRegisterSessionInput = z.infer<typeof closeRegisterSessionSchema>;
export type SaleLineInput = z.infer<typeof saleLineInputSchema>;
export type CompleteSaleInput = z.infer<typeof completeSaleSchema>;
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;
export type VoidSaleInput = z.infer<typeof voidSaleSchema>;
export type SaleReturnLineInput = z.infer<typeof saleReturnLineSchema>;
export type CreateSaleReturnInput = z.infer<typeof createSaleReturnSchema>;
export type CreateSaleRefundInput = z.infer<typeof createSaleRefundSchema>;
export type ReprintReceiptInput = z.infer<typeof reprintReceiptSchema>;
export type UpdateCustomerCreditInput = z.infer<typeof updateCustomerCreditSchema>;
export type CreditAllocationInput = z.infer<typeof creditAllocationSchema>;
export type RecordCustomerPaymentInput = z.infer<typeof recordCustomerPaymentSchema>;
export type CreateCustomerCreditAdjustmentInput = z.infer<typeof createCustomerCreditAdjustmentSchema>;
export type CustomerQuery = z.infer<typeof customerQuerySchema>;
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type SupplierQuery = z.infer<typeof supplierQuerySchema>;
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineInputSchema>;
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type PurchaseOrderQuery = z.infer<typeof purchaseOrderQuerySchema>;
export type CancelPurchaseOrderInput = z.infer<typeof cancelPurchaseOrderSchema>;
export type ReceivePurchaseOrderInput = z.infer<typeof receivePurchaseOrderSchema>;
export type CreateSupplierInvoiceInput = z.infer<typeof createSupplierInvoiceSchema>;
export type SupplierInvoiceQuery = z.infer<typeof supplierInvoiceQuerySchema>;
export type RecordSupplierPaymentInput = z.infer<typeof recordSupplierPaymentSchema>;
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;
export type ExpenseQuery = z.infer<typeof expenseQuerySchema>;
export type ExpenseExportQuery = z.infer<typeof expenseExportQuerySchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type ExpenseDecisionInput = z.infer<typeof expenseDecisionSchema>;
export type ExpenseReasonInput = z.infer<typeof expenseReasonSchema>;
export type PayExpenseInput = z.infer<typeof payExpenseSchema>;
export type OperationsReportQuery = z.infer<typeof operationsReportQuerySchema>;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
