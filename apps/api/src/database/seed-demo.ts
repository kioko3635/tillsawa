/**
 * Demo seed: "Kiambu Road Wines & Spirits — DEMO"
 *
 * Populates a DEVELOPMENT database with a realistic fictional wines & spirits
 * tenant so the application can be exercised in a browser. Everything goes
 * through the real API surface (in-process Express app over the tenant pool),
 * so RLS, module gates, stock ledger, idempotency and audit rules all apply.
 * Timestamps of the seeded demo sales are shifted after creation (org-scoped
 * UPDATE via the system pool) to give reports a few days of history.
 *
 * Safeguards:
 *   - refuses unless the target database name matches dev/test/demo
 *   - refuses when NODE_ENV=production
 *   - requires an explicit --yes flag (or DEMO_SEED_CONFIRM=YES)
 *
 * Idempotency: natural keys (org slug, SKU, supplier/customer codes,
 * deterministic client-transaction UUIDs) plus deterministic Idempotency-Key
 * headers. Re-running reuses existing records instead of duplicating them.
 *
 * Usage: npm run db:seed:demo -- --yes
 */
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { loadConfig } from '../config/env.js';
import { createSystemPool, createTenantPool, roleFromUrl } from './pool.js';
import { createApp } from '../http/app.js';

// --------------------------------------------------------------------------
// Safeguards
// --------------------------------------------------------------------------

export function assertDemoSeedAllowed(databaseUrl: string, argv: string[], env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('Demo seed refused: NODE_ENV=production');
  }
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!/(_dev|_test|demo)/i.test(databaseName)) {
    throw new Error(
      `Demo seed refused: database "${databaseName}" is not a recognised development/test database ` +
      '(name must end in _dev or _test, or contain "demo")'
    );
  }
  if (!argv.includes('--yes') && env.DEMO_SEED_CONFIRM !== 'YES') {
    throw new Error('Demo seed refused: re-run with --yes (or DEMO_SEED_CONFIRM=YES) to confirm dev-database seeding');
  }
}

// --------------------------------------------------------------------------
// Deterministic identifiers
// --------------------------------------------------------------------------

const DEMO_NAMESPACE = 'f4b7e1d2-3a4c-5b6d-8e9f-0a1b2c3d4e5f';

export function demoUuid(name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(DEMO_NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(`pos-demo:${name}`)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const DEMO = {
  slug: 'kiambu-road-wines-demo',
  legalName: 'Kiambu Road Wines & Spirits DEMO Ltd',
  displayName: 'Kiambu Road Wines & Spirits — DEMO',
  ownerEmail: 'demo-owner@kiambu-wines.example.com',
  ownerPassword: 'DemoNairobi2026',
  ownerName: 'Demo Owner',
  cashierEmail: 'demo-cashier@kiambu-wines.example.com',
  cashierPassword: 'CashierDemo2026',
  cashierName: 'Demo Cashier',
  managerEmail: 'demo-manager@kiambu-wines.example.com',
  managerPassword: 'ManagerDemo2026',
  managerName: 'Demo Manager'
};

// --------------------------------------------------------------------------
// API helper
// --------------------------------------------------------------------------

class DemoApi {
  private token = '';
  constructor(private readonly app: Express) {}

  setToken(token: string) {
    this.token = token;
  }

  async call<T = Record<string, unknown>>(method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, options: {
    body?: unknown;
    idem?: string;
    allowed?: number[];
  } = {}): Promise<{ status: number; data: T }> {
    const req = request(this.app)[method](`/api/v1${path}`);
    if (this.token) req.set('authorization', `Bearer ${this.token}`);
    if (options.idem) req.set('idempotency-key', options.idem.slice(0, 128));
    if (options.body !== undefined && options.body !== null) req.send(options.body);
    const response = await req;
    const allowed = options.allowed ?? [200, 201];
    if (!allowed.includes(response.status)) {
      throw new Error(`${method.toUpperCase()} ${path} → ${response.status}: ${JSON.stringify(response.body)}`);
    }
    return { status: response.status, data: response.body.data as T };
  }
}

function rows<T>(data: Record<string, unknown>, ...keys: string[]): T[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value as T[];
    if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items)) {
      return (value as Record<string, unknown>).items as T[];
    }
  }
  if (Array.isArray(data.items)) return data.items as T[];
  return [];
}

// --------------------------------------------------------------------------
// Demo catalogue (all values are illustrative fictional data, KES)
// --------------------------------------------------------------------------

interface DemoProduct {
  sku: string;
  name: string;
  brand: string;
  category: string;
  cost: string;
  price: string;
  stock: number;
  minStock: number;
  caseSize?: number;
  expiry?: boolean;
}

const CATEGORIES = [
  'Whisky', 'Vodka', 'Gin', 'Brandy', 'Rum', 'Tequila', 'Wine',
  'Beer', 'Cider', 'Ready-to-Drink', 'Soft Drinks & Mixers'
];

const PRODUCTS: DemoProduct[] = [
  { sku: 'DEMO-WHI-001', name: 'Johnnie Walker Red Label 750ml', brand: 'Johnnie Walker', category: 'Whisky', cost: '2400', price: '2950', stock: 12, minStock: 6, caseSize: 12 },
  { sku: 'DEMO-WHI-002', name: 'Johnnie Walker Black Label 750ml', brand: 'Johnnie Walker', category: 'Whisky', cost: '4500', price: '5450', stock: 8, minStock: 4, caseSize: 12 },
  { sku: 'DEMO-WHI-003', name: 'Jameson Irish Whiskey 750ml', brand: 'Jameson', category: 'Whisky', cost: '3100', price: '3750', stock: 10, minStock: 4, caseSize: 12 },
  { sku: 'DEMO-WHI-004', name: 'Glenfiddich 12 Year 750ml', brand: 'Glenfiddich', category: 'Whisky', cost: '6800', price: '8200', stock: 4, minStock: 3 },
  { sku: 'DEMO-WHI-005', name: "Grant's Triple Wood 750ml", brand: "Grant's", category: 'Whisky', cost: '1900', price: '2350', stock: 15, minStock: 6, caseSize: 12 },
  { sku: 'DEMO-VOD-001', name: 'Smirnoff Vodka Red 750ml', brand: 'Smirnoff', category: 'Vodka', cost: '1600', price: '1950', stock: 20, minStock: 8, caseSize: 12 },
  { sku: 'DEMO-VOD-002', name: 'Absolut Vodka 750ml', brand: 'Absolut', category: 'Vodka', cost: '2400', price: '2950', stock: 9, minStock: 4, caseSize: 12 },
  { sku: 'DEMO-VOD-003', name: "Gilbey's Vodka 750ml", brand: "Gilbey's", category: 'Vodka', cost: '1300', price: '1600', stock: 18, minStock: 8, caseSize: 12 },
  { sku: 'DEMO-GIN-001', name: "Gordon's London Dry Gin 750ml", brand: "Gordon's", category: 'Gin', cost: '1750', price: '2150', stock: 14, minStock: 6, caseSize: 12 },
  { sku: 'DEMO-GIN-002', name: 'Tanqueray London Dry 750ml', brand: 'Tanqueray', category: 'Gin', cost: '3300', price: '4000', stock: 5, minStock: 3 },
  { sku: 'DEMO-GIN-003', name: "Gilbey's Gin 750ml", brand: "Gilbey's", category: 'Gin', cost: '1400', price: '1750', stock: 12, minStock: 5, caseSize: 12 },
  { sku: 'DEMO-BRA-001', name: 'Viceroy Brandy 750ml', brand: 'Viceroy', category: 'Brandy', cost: '1650', price: '2050', stock: 16, minStock: 6, caseSize: 12 },
  { sku: 'DEMO-BRA-002', name: 'Hennessy VSOP 700ml', brand: 'Hennessy', category: 'Brandy', cost: '7500', price: '9200', stock: 3, minStock: 2 },
  { sku: 'DEMO-RUM-001', name: 'Bacardi Carta Blanca 750ml', brand: 'Bacardi', category: 'Rum', cost: '2100', price: '2600', stock: 10, minStock: 4, caseSize: 12 },
  { sku: 'DEMO-RUM-002', name: 'Captain Morgan Spiced Gold 750ml', brand: 'Captain Morgan', category: 'Rum', cost: '2300', price: '2800', stock: 7, minStock: 3, caseSize: 12 },
  { sku: 'DEMO-TEQ-001', name: 'Jose Cuervo Especial Silver 750ml', brand: 'Jose Cuervo', category: 'Tequila', cost: '2600', price: '3250', stock: 6, minStock: 3 },
  { sku: 'DEMO-WIN-001', name: '4th Street Red Sweet 750ml', brand: '4th Street', category: 'Wine', cost: '950', price: '1200', stock: 24, minStock: 12, caseSize: 12 },
  { sku: 'DEMO-WIN-002', name: '4th Street White Sweet 750ml', brand: '4th Street', category: 'Wine', cost: '950', price: '1200', stock: 18, minStock: 12, caseSize: 12 },
  { sku: 'DEMO-WIN-003', name: 'Nederburg Cabernet Sauvignon 750ml', brand: 'Nederburg', category: 'Wine', cost: '1400', price: '1800', stock: 9, minStock: 6, caseSize: 12 },
  { sku: 'DEMO-WIN-004', name: 'Robertson Winery Sweet Red 750ml', brand: 'Robertson', category: 'Wine', cost: '1100', price: '1400', stock: 0, minStock: 6, caseSize: 12, expiry: true },
  { sku: 'DEMO-WIN-005', name: 'Caprice Red Sweet 750ml', brand: 'Caprice', category: 'Wine', cost: '800', price: '1050', stock: 30, minStock: 12, caseSize: 12 },
  { sku: 'DEMO-BEE-001', name: 'Tusker Lager 500ml', brand: 'Tusker', category: 'Beer', cost: '180', price: '230', stock: 120, minStock: 48, caseSize: 24 },
  { sku: 'DEMO-BEE-002', name: 'Tusker Malt 500ml', brand: 'Tusker', category: 'Beer', cost: '200', price: '255', stock: 72, minStock: 48, caseSize: 24 },
  { sku: 'DEMO-BEE-003', name: 'White Cap Lager 500ml', brand: 'White Cap', category: 'Beer', cost: '170', price: '220', stock: 48, minStock: 48, caseSize: 24 },
  { sku: 'DEMO-BEE-004', name: 'Guinness Stout 330ml', brand: 'Guinness', category: 'Beer', cost: '220', price: '285', stock: 60, minStock: 24, caseSize: 24 },
  { sku: 'DEMO-BEE-005', name: 'Heineken Lager 330ml', brand: 'Heineken', category: 'Beer', cost: '230', price: '300', stock: 36, minStock: 24, caseSize: 24 },
  { sku: 'DEMO-BEE-006', name: 'Pilsner Lager 500ml', brand: 'Pilsner', category: 'Beer', cost: '160', price: '210', stock: 24, minStock: 48, caseSize: 24 },
  { sku: 'DEMO-CID-001', name: 'Savanna Dry Cider 330ml', brand: 'Savanna', category: 'Cider', cost: '250', price: '320', stock: 48, minStock: 24, caseSize: 24 },
  { sku: 'DEMO-CID-002', name: "Hunter's Gold Cider 330ml", brand: "Hunter's", category: 'Cider', cost: '240', price: '310', stock: 12, minStock: 24, caseSize: 24 },
  { sku: 'DEMO-RTD-001', name: 'Smirnoff Ice 330ml', brand: 'Smirnoff', category: 'Ready-to-Drink', cost: '230', price: '295', stock: 72, minStock: 36, caseSize: 24 },
  { sku: 'DEMO-RTD-002', name: 'Smirnoff Ice Black 330ml', brand: 'Smirnoff', category: 'Ready-to-Drink', cost: '240', price: '305', stock: 36, minStock: 24, caseSize: 24 },
  { sku: 'DEMO-RTD-003', name: 'Snapp Apple RTD 330ml', brand: 'Snapp', category: 'Ready-to-Drink', cost: '220', price: '285', stock: 0, minStock: 24, caseSize: 24 },
  { sku: 'DEMO-SOF-001', name: 'Schweppes Tonic Water 300ml', brand: 'Schweppes', category: 'Soft Drinks & Mixers', cost: '60', price: '80', stock: 100, minStock: 48, caseSize: 24 },
  { sku: 'DEMO-SOF-002', name: 'Coca-Cola 500ml', brand: 'Coca-Cola', category: 'Soft Drinks & Mixers', cost: '55', price: '70', stock: 96, minStock: 48, caseSize: 24 },
  { sku: 'DEMO-SOF-003', name: 'Red Bull Energy Drink 250ml', brand: 'Red Bull', category: 'Soft Drinks & Mixers', cost: '190', price: '250', stock: 48, minStock: 24 },
  { sku: 'DEMO-SOF-004', name: 'Minute Maid Orange Juice 1L', brand: 'Minute Maid', category: 'Soft Drinks & Mixers', cost: '140', price: '185', stock: 36, minStock: 24 },
  { sku: 'DEMO-SOF-005', name: 'Keringet Still Water 1L', brand: 'Keringet', category: 'Soft Drinks & Mixers', cost: '60', price: '85', stock: 60, minStock: 36 }
];

const SUPPLIERS = [
  { code: 'SUP-NBD', name: 'Nairobi Beverage Distributors — DEMO', phone: '+254700000001', email: 'orders@nbd-demo.example.com' },
  { code: 'SUP-CWT', name: 'Capital Wine Traders — DEMO', phone: '+254700000002', email: 'sales@cwt-demo.example.com' },
  { code: 'SUP-CWD', name: 'City Wholesale Drinks — DEMO', phone: '+254700000003', email: 'desk@cwd-demo.example.com' }
];

// --------------------------------------------------------------------------
// Seed driver
// --------------------------------------------------------------------------

export interface DemoSeedSummary {
  organizationId: string;
  branchId: string;
  created: Record<string, number>;
  reused: Record<string, number>;
  salesSeeded: number;
  backdatedSales: number;
}

export async function seedDemo(options: {
  databaseUrl: string;
  systemDatabaseUrl?: string | undefined;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
}): Promise<DemoSeedSummary> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const log = options.onLog ?? console.log;
  assertDemoSeedAllowed(options.databaseUrl, argv, env);

  const config = loadConfig({ DATABASE_URL: options.databaseUrl });
  const tenantPool = createTenantPool(config, options.databaseUrl);
  const systemPool = createSystemPool(config, options.systemDatabaseUrl ?? options.databaseUrl, roleFromUrl(options.databaseUrl));
  const app = createApp({ config, pool: tenantPool, systemPool });
  const api = new DemoApi(app);

  const created: Record<string, number> = {};
  const reused: Record<string, number> = {};
  const bump = (bucket: Record<string, number>, key: string) => { bucket[key] = (bucket[key] ?? 0) + 1; };

  try {
    // --- Organization -----------------------------------------------------
    let organizationId = '';
    const loginAttempt = await api.call<{ accessToken: string; membership: { organizationId: string } }>(
      'post', '/auth/login',
      { body: { organizationSlug: DEMO.slug, email: DEMO.ownerEmail, password: DEMO.ownerPassword }, allowed: [200, 401, 400] }
    );
    if (loginAttempt.status === 200) {
      api.setToken(loginAttempt.data.accessToken);
      organizationId = loginAttempt.data.membership.organizationId;
      bump(reused, 'organization');
      log(`Reusing existing demo organization ${DEMO.slug}`);
    } else {
      const registered = await api.call<{ accessToken: string; membership: { organizationId: string } }>(
        'post', '/auth/register-organization',
        {
          body: {
            organization: {
              slug: DEMO.slug, legalName: DEMO.legalName, displayName: DEMO.displayName,
              currencyCode: 'KES', timezone: 'Africa/Nairobi', taxPricingMode: 'inclusive',
              businessProfile: 'wines_spirits'
            },
            branch: { code: 'HQ', name: 'Kiambu Road Shop' },
            owner: { displayName: DEMO.ownerName, email: DEMO.ownerEmail, password: DEMO.ownerPassword }
          },
          allowed: [201, 409]
        }
      );
      if (registered.status === 409) {
        throw new Error(`Organization ${DEMO.slug} already exists but the demo owner could not sign in — refusing to continue`);
      }
      api.setToken(registered.data.accessToken);
      organizationId = registered.data.membership.organizationId;
      bump(created, 'organization');
      log(`Registered demo organization ${DEMO.slug}`);
    }

    // Clear only this org's demo-prefixed idempotency records so reruns after a
    // partial failure replay cleanly. Entity-level dedupe (slug, SKU, codes,
    // client transaction IDs) still prevents duplicate records.
    await systemPool.query(
      `DELETE FROM idempotency_records WHERE organization_id = $1 AND idempotency_key LIKE 'demo-%'`,
      [organizationId]
    );

    // --- Organization settings -------------------------------------------
    await api.call('patch', '/organizations/current', {
      body: {
        defaultTaxRatePct: '16',
        receiptPolicy: 'DEMO DATA — illustrative receipts only; not a fiscal document.'
      }
    });
    await api.call('patch', '/organizations/current/configuration', {
      body: {
        contactPhone: '+254700000000',
        contactEmail: 'demo@kiambu-wines.example.com',
        businessAddress: 'Kiambu Road, Nairobi — DEMO',
        taxPin: 'P000000000D',
        receiptHeader: 'KIAMBU ROAD WINES & SPIRITS — DEMO',
        receiptFooter: 'Demo data for evaluation only. Asante.',
        changeReason: 'Apply demo store profile details'
      }
    });
    log('Applied demo organization settings and configuration');

    // --- Reference data ----------------------------------------------------
    const { data: branchList } = await api.call('get', '/branches');
    const branchRows = rows<{ id: string; code: string }>(branchList as Record<string, unknown>, 'branches');
    const branchId = branchRows[0]!.id;

    const { data: unitData } = await api.call('get', '/catalog/units');
    const units = new Map(rows<{ id: string; code: string }>(unitData as Record<string, unknown>, 'units').map((u) => [u.code, u.id]));
    const unitEA = units.get('EA')!;
    const unitCASE = units.get('CASE')!;

    const { data: roleData } = await api.call('get', '/roles');
    const roleList = rows<{ id: string; code: string }>(roleData as Record<string, unknown>, 'roles');
    const cashierRole = roleList.find((r) => r.code === 'cashier')!;
    const managerRole = roleList.find((r) => r.code === 'manager')!;

    // --- Categories --------------------------------------------------------
    const { data: catData } = await api.call('get', '/catalog/categories?pageSize=100');
    const existingCats = new Map(rows<{ id: string; name: string }>(catData as Record<string, unknown>, 'categories').map((c) => [c.name, c.id]));
    const categoryIds = new Map<string, string>();
    for (const name of CATEGORIES) {
      if (existingCats.has(name)) {
        categoryIds.set(name, existingCats.get(name)!);
        bump(reused, 'categories');
      } else {
        const { data } = await api.call<{ category: { id: string } }>('post', '/catalog/categories', {
          body: { name }, idem: `demo-category-${name}`
        });
        categoryIds.set(name, data.category.id);
        bump(created, 'categories');
      }
    }
    log(`Categories ready: ${categoryIds.size}`);

    // --- Suppliers ---------------------------------------------------------
    const { data: supData } = await api.call('get', '/suppliers?pageSize=100');
    const existingSups = new Map(rows<{ id: string; code: string }>(supData as Record<string, unknown>, 'suppliers').map((s) => [s.code, s.id]));
    const supplierIds = new Map<string, string>();
    for (const supplier of SUPPLIERS) {
      if (existingSups.has(supplier.code)) {
        supplierIds.set(supplier.code, existingSups.get(supplier.code)!);
        bump(reused, 'suppliers');
      } else {
        const { data } = await api.call<{ supplier: { id: string } }>('post', '/suppliers', {
          body: { ...supplier, paymentTermsDays: 14, notes: 'Fictional demo supplier — not a real vendor.' },
          idem: `demo-supplier-${supplier.code}`
        });
        supplierIds.set(supplier.code, data.supplier.id);
        bump(created, 'suppliers');
      }
    }
    log(`Suppliers ready: ${supplierIds.size}`);

    // --- Customer (for the credit sale) ------------------------------------
    const { data: custData } = await api.call('get', '/customers?pageSize=100');
    const customers = rows<{ id: string; code: string }>(custData as Record<string, unknown>, 'customers');
    let demoCustomerId = customers.find((c) => c.code === 'DEMO-CUST-1')?.id;
    if (demoCustomerId) {
      bump(reused, 'customers');
    } else {
      const { data } = await api.call<{ customer: { id: string } }>('post', '/customers', {
        body: {
          code: 'DEMO-CUST-1', name: 'Demo Restaurant & Bar — DEMO',
          phone: '+254700000099', email: 'manager@demo-bar.example.com',
          address: 'Thika Road, Nairobi — DEMO', notes: 'Fictional demo customer for credit-sale testing.'
        },
        idem: 'demo-customer-1'
      });
      demoCustomerId = data.customer.id;
      bump(created, 'customers');
    }
    await api.call('patch', `/customers/${demoCustomerId}`, {
      body: { creditStatus: 'active', creditLimit: '80000', paymentTermsDays: 14, creditReason: 'Enable credit for demo credit-sale' }
    });

    // --- Cashier and manager users -------------------------------------------
    const { data: userData } = await api.call('get', '/users');
    const users = rows<{ email: string }>(userData as Record<string, unknown>, 'users');
    for (const demoUser of [
      { key: 'cashier', email: DEMO.cashierEmail, name: DEMO.cashierName, password: DEMO.cashierPassword, title: 'Cashier', role: cashierRole },
      { key: 'manager', email: DEMO.managerEmail, name: DEMO.managerName, password: DEMO.managerPassword, title: 'Branch Manager', role: managerRole }
    ]) {
      if (users.some((u) => u.email === demoUser.email)) {
        bump(reused, 'users');
      } else {
        await api.call('post', '/users', {
          body: {
            email: demoUser.email,
            displayName: demoUser.name,
            temporaryPassword: demoUser.password,
            title: demoUser.title,
            allBranches: false,
            roleIds: [demoUser.role.id],
            branchIds: [branchId]
          },
          idem: `demo-user-${demoUser.key}`
        });
        bump(created, 'users');
      }
    }

    // --- Register ------------------------------------------------------------
    const { data: regData } = await api.call('get', `/pos/registers?branchId=${branchId}`);
    const registers = rows<{ id: string; code: string }>(regData as Record<string, unknown>, 'registers');
    let registerId = registers.find((r) => r.code === 'TILL-1')?.id;
    if (registerId) {
      bump(reused, 'registers');
    } else {
      const { data } = await api.call<{ register: { id: string } }>('post', '/pos/registers', {
        body: {
          branchId, code: 'TILL-1', name: 'Front Counter Till',
          receiptPrefix: 'DEMO', receiptFooter: 'DEMO RECEIPT — illustrative data only'
        },
        idem: 'demo-register-till-1'
      });
      registerId = data.register.id;
      bump(created, 'registers');
    }

    // --- Products -------------------------------------------------------------
    const { data: prodData } = await api.call('get', '/catalog/products?pageSize=100');
    const existingProducts = new Map(rows<{ id: string; sku: string }>(prodData as Record<string, unknown>, 'items', 'products').map((p) => [p.sku, p.id]));
    const productIds = new Map<string, string>();
    let barcodeCounter = 1;
    for (const product of PRODUCTS) {
      if (existingProducts.has(product.sku)) {
        const id = existingProducts.get(product.sku)!;
        productIds.set(product.sku, id);
        await api.call('patch', `/catalog/products/${id}`, {
          body: { trackExpiry: product.expiry ?? false, minStockLevel: String(product.minStock) }
        });
        bump(reused, 'products');
        continue;
      }
      const barcode = `2540000000${String(100 + barcodeCounter).slice(-3)}`;
      barcodeCounter += 1;
      const { data } = await api.call<{ product: { id: string } }>('post', '/catalog/products', {
        body: {
          sku: product.sku,
          name: `${product.name} (DEMO)`,
          description: `Fictional demo catalogue item — illustrative KES pricing.`,
          brand: product.brand,
          categoryId: categoryIds.get(product.category),
          baseUnitId: unitEA,
          itemType: 'stocked',
          cost: product.cost,
          basePrice: product.price,
          minStockLevel: String(product.minStock),
          trackExpiry: product.expiry ?? false,
          barcodes: [barcode],
          conversions: product.caseSize ? [{ fromUnitId: unitCASE, toUnitId: unitEA, ratio: String(product.caseSize) }] : []
        },
        idem: `demo-product-${product.sku}`
      });
      productIds.set(product.sku, data.product.id);
      bump(created, 'products');
    }
    log(`Products ready: ${productIds.size} (${created.products ?? 0} created)`);

    // --- Stock: purchase orders + opening adjustments -------------------------
    const poPlan = [
      { supplier: 'SUP-NBD', skus: ['DEMO-BEE-001', 'DEMO-BEE-003', 'DEMO-BEE-004', 'DEMO-RTD-001', 'DEMO-SOF-002'], unit: 'CASE', qtyEach: 3 },
      { supplier: 'SUP-CWT', skus: ['DEMO-WIN-001', 'DEMO-WIN-005'], unit: 'CASE', qtyEach: 2 }
    ];
    const stockedByPo = new Set(poPlan.flatMap((p) => p.skus));

    type PoShape = { id: string; status: string; clientTransactionId?: string; lines: { id: string; productId: string; remainingQty: string }[] };
    const { data: poListData } = await api.call('get', '/purchase-orders?pageSize=100');
    const poByCtid = new Map(rows<PoShape>(poListData as Record<string, unknown>, 'items', 'purchaseOrders').map((po) => [po.clientTransactionId, po]));
    const getPo = async (id: string) => (await api.call<{ purchaseOrder: PoShape }>('get', `/purchase-orders/${id}`)).data.purchaseOrder;

    for (const [index, plan] of poPlan.entries()) {
      const poKey = `demo-po-${index + 1}`;
      let po: PoShape;
      if (poByCtid.has(demoUuid(poKey))) {
        po = await getPo(poByCtid.get(demoUuid(poKey))!.id);
        bump(reused, 'purchaseOrders');
      } else {
        const { data: poResult } = await api.call<{ purchaseOrder: PoShape }>('post', '/purchase-orders', {
          body: {
            clientTransactionId: demoUuid(poKey),
            branchId,
            supplierId: supplierIds.get(plan.supplier),
            expectedDeliveryDate: new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10),
            supplierReference: `DEMO-PO-${index + 1}`,
            notes: 'Fictional demo purchase order.',
            lines: plan.skus.map((sku) => ({
              productId: productIds.get(sku),
              unitId: unitCASE,
              quantity: String(plan.qtyEach),
              unitCost: String(Number(PRODUCTS.find((p) => p.sku === sku)!.cost) * (PRODUCTS.find((p) => p.sku === sku)!.caseSize ?? 1))
            }))
          },
          idem: poKey
        });
        po = poResult.purchaseOrder;
        bump(created, 'purchaseOrders');
      }
      if (po.status === 'draft') {
        await api.call('post', `/purchase-orders/${po.id}/submit`, { idem: `${poKey}-submit` });
        po = await getPo(po.id);
      }
      if (po.status === 'submitted') {
        await api.call('post', `/purchase-orders/${po.id}/approve`, { idem: `${poKey}-approve` });
        po = await getPo(po.id);
      }
      if (po.status === 'approved' || po.status === 'partially_received') {
        const receivable = po.lines.filter((line) => Number(line.remainingQty) > 0);
        if (receivable.length > 0) {
          await api.call('post', `/purchase-orders/${po.id}/receipts`, {
            body: {
              clientTransactionId: demoUuid(`${poKey}-receipt`),
              notes: 'Demo goods receipt',
              lines: receivable.map((line) => ({ purchaseOrderLineId: line.id, receivedQty: line.remainingQty }))
            },
            idem: `${poKey}-receive`
          });
        }
      }
      const invoiceTotal = po.lines.reduce((sum, line) => {
        const p = PRODUCTS.find((x) => productIds.get(x.sku) === line.productId)!;
        return sum + Number(p.cost) * (p.caseSize ?? 1) * plan.qtyEach;
      }, 0);
      const { data: invListData } = await api.call('get', '/supplier-invoices?pageSize=100');
      const existingInvoices = rows<{ invoiceNumber?: string }>(invListData as Record<string, unknown>, 'items', 'invoices');
      if (existingInvoices.some((inv) => inv.invoiceNumber === `DEMO-INV-${index + 1}`)) {
        bump(reused, 'supplierInvoices');
      } else {
      await api.call('post', '/supplier-invoices', {
        body: {
          clientTransactionId: demoUuid(`${poKey}-invoice`),
          branchId, supplierId: supplierIds.get(plan.supplier), purchaseOrderId: po.id,
          invoiceNumber: `DEMO-INV-${index + 1}`,
          amount: String(invoiceTotal),
          issueDate: new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10),
          dueDate: new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10),
          notes: 'Fictional demo supplier invoice.'
        },
        idem: `${poKey}-invoice`
      });
      bump(created, 'supplierInvoices');
      }
    }
    // A draft PO left open to show pipeline state
    if (poByCtid.has(demoUuid('demo-po-3'))) {
      bump(reused, 'purchaseOrders');
    } else {
    await api.call('post', '/purchase-orders', {
      body: {
        clientTransactionId: demoUuid('demo-po-3'),
        branchId,
        supplierId: supplierIds.get('SUP-CWD'),
        notes: 'Fictional draft demo purchase order.',
        lines: [
          { productId: productIds.get('DEMO-BEE-002'), unitId: unitCASE, quantity: '2', unitCost: String(200 * 24) },
          { productId: productIds.get('DEMO-SOF-003'), unitId: unitEA, quantity: '24', unitCost: '190' }
        ]
      },
      idem: 'demo-po-3'
    });
    bump(created, 'purchaseOrders');
    }
    log('Purchase orders, receipts and supplier invoices seeded');

    // --- Opening stock adjustments for non-PO products ------------------------
    // Adjustments have no natural key, so reuse is detected by DEMO reason text.
    const { data: adjListData } = await api.call('get', `/inventory/adjustments?branchId=${branchId}`);
    const existingAdjustmentReasons = new Set(
      rows<{ reason?: string }>(adjListData as Record<string, unknown>, 'items', 'adjustments').map((a) => a.reason)
    );
    const DEMO_OPENING_REASON = 'DEMO opening stock — illustrative quantities';
    const DEMO_DAMAGE_REASON = 'DEMO — two bottles broken in transit';
    const DEMO_EXPIRY = '2027-06-30';
    const openingLines = PRODUCTS.filter((p) => !stockedByPo.has(p.sku) && p.stock > 0).map((p) => ({
      productId: productIds.get(p.sku), quantity: String(p.stock), unitCost: p.cost,
      ...(p.expiry ? { expiryDate: DEMO_EXPIRY } : {})
    }));
    if (existingAdjustmentReasons.has(DEMO_OPENING_REASON)) {
      bump(reused, 'adjustments');
    } else if (openingLines.length > 0) {
      await api.call('post', '/inventory/adjustments', {
        body: { branchId, type: 'opening', reason: DEMO_OPENING_REASON, lines: openingLines },
        idem: 'demo-opening-stock'
      });
      bump(created, 'adjustments');
    }
    if (existingAdjustmentReasons.has(DEMO_DAMAGE_REASON)) {
      bump(reused, 'adjustments');
    } else {
      await api.call('post', '/inventory/adjustments', {
        body: {
          branchId,
          type: 'damage',
          reason: DEMO_DAMAGE_REASON,
          lines: [{ productId: productIds.get('DEMO-WIN-005'), quantity: '-2' }]
        },
        idem: 'demo-damage-1'
      });
      bump(created, 'adjustments');
    }

    // --- Expenses -------------------------------------------------------------
    const { data: expCatData } = await api.call('get', '/expense-categories');
    const expCats = new Map(rows<{ id: string; code: string }>(expCatData as Record<string, unknown>, 'categories').map((c) => [c.code, c.id]));
    const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const demoExpenses = [
      { key: 'rent', category: 'RENT', description: 'Shop rent — DEMO', amount: '45000', paymentMethod: 'bank_transfer', daysAgo: 6, lifecycle: 'paid', payee: 'Demo Landlord Ltd' },
      { key: 'power', category: 'UTILITIES', description: 'Electricity tokens — DEMO', amount: '6800', paymentMethod: 'mobile_money', daysAgo: 5, lifecycle: 'paid', payee: 'Demo Utility Payee' },
      { key: 'internet', category: 'UTILITIES', description: 'Business internet — DEMO', amount: '5500', paymentMethod: 'bank_transfer', daysAgo: 3, lifecycle: 'paid', payee: 'Demo ISP' },
      { key: 'transport', category: 'TRANSPORT', description: 'Stock collection transport — DEMO', amount: '2500', paymentMethod: 'cash', daysAgo: 2, lifecycle: 'submitted', payee: 'Demo Rider Services' },
      { key: 'cleaning', category: 'SUPPLIES', description: 'Cleaning supplies — DEMO', amount: '1800', paymentMethod: 'cash', daysAgo: 1, lifecycle: 'draft', payee: 'Demo Supplies Mart' }
    ] as const;
    const { data: expListData } = await api.call('get', '/expenses?pageSize=100');
    const expByCtid = new Map(
      rows<{ id: string; status: string; clientTransactionId?: string }>(expListData as Record<string, unknown>, 'items', 'expenses')
        .map((e) => [e.clientTransactionId, e])
    );
    for (const exp of demoExpenses) {
      const ctid = demoUuid(`demo-expense-${exp.key}`);
      let expense = expByCtid.get(ctid);
      if (!expense) {
        const { data } = await api.call<{ expense: { id: string; status: string } }>('post', '/expenses', {
          body: {
            clientTransactionId: ctid,
            branchId,
            categoryId: expCats.get(exp.category),
            description: exp.description,
            expenseDate: daysAgo(exp.daysAgo),
            amount: exp.amount,
            paymentMethod: exp.paymentMethod,
            payeeName: exp.payee,
            businessPurpose: 'Fictional demo operating expense'
          },
          idem: `demo-expense-${exp.key}`
        });
        expense = data.expense;
        bump(created, 'expenses');
      } else {
        bump(reused, 'expenses');
      }
      if (expense.status === 'draft' && exp.lifecycle !== 'draft') {
        await api.call('post', `/expenses/${expense.id}/submit`, { idem: `demo-expense-${exp.key}-submit` });
        expense = { ...expense, status: 'submitted' };
      }
      if ((expense.status === 'submitted') && exp.lifecycle === 'paid') {
        await api.call('post', `/expenses/${expense.id}/approve`, { body: { reason: 'Demo approval' }, idem: `demo-expense-${exp.key}-approve` });
        expense = { ...expense, status: 'approved' };
      }
      if (expense.status === 'approved' && exp.lifecycle === 'paid') {
        await api.call('post', `/expenses/${expense.id}/pay`, {
          body: {
            clientTransactionId: demoUuid(`demo-expense-${exp.key}-pay`),
            reason: 'Demo payment — fictional',
            paymentReference: `DEMO-${exp.key.toUpperCase()}`
          },
          idem: `demo-expense-${exp.key}-pay`
        });
      }
    }
    log('Demo expenses seeded');

    // --- Demo price list (permits discounts up to 15%) -------------------------
    const { data: plData } = await api.call('get', '/pricing/price-lists?pageSize=100');
    const priceLists = rows<{ id: string; code: string }>(plData as Record<string, unknown>, 'items', 'priceLists');
    let demoPriceListId = priceLists.find((pl) => pl.code === 'DEMO-RETAIL')?.id;
    if (demoPriceListId) {
      bump(reused, 'priceLists');
    } else {
      const { data } = await api.call<{ priceList: { id: string } }>('post', '/pricing/price-lists', {
        body: {
          code: 'DEMO-RETAIL', name: 'Demo Retail Prices', kind: 'retail',
          maxDiscountPct: '15', isDefault: false
        },
        idem: 'demo-price-list'
      });
      demoPriceListId = data.priceList.id;
      bump(created, 'priceLists');
    }
    await api.call('put', `/pricing/price-lists/${demoPriceListId}/lines`, {
      body: {
        lines: [
          { productId: productIds.get('DEMO-RTD-001'), price: '295' },
          { productId: productIds.get('DEMO-SOF-002'), price: '70' }
        ]
      },
      idem: 'demo-price-lines'
    });

    // --- Register sessions + sales --------------------------------------------
    // Sessions are replayed via deterministic idempotency keys; sales use
    // deterministic clientTransactionId values, so a rerun can never duplicate.
    interface DemoSale {
      key: string;
      dayOffset: number;
      items: { sku: string; qty: string; unit?: 'CASE'; discountPct?: string; expiry?: string }[];
      payment: { method: 'cash' | 'credit'; tendered?: string };
      priceList?: boolean;
      after?: 'void' | 'return';
    }
    const demoSales: DemoSale[] = [
      { key: 'sale-01', dayOffset: 4, items: [{ sku: 'DEMO-WHI-001', qty: '1' }, { sku: 'DEMO-SOF-001', qty: '4' }], payment: { method: 'cash', tendered: '3500' } },
      { key: 'sale-02', dayOffset: 4, items: [{ sku: 'DEMO-BEE-001', qty: '1', unit: 'CASE' }], payment: { method: 'cash', tendered: '5600' } },
      { key: 'sale-03', dayOffset: 4, priceList: true, items: [{ sku: 'DEMO-RTD-001', qty: '3', discountPct: '10' }, { sku: 'DEMO-SOF-002', qty: '2' }], payment: { method: 'cash', tendered: '1000' } },
      { key: 'sale-04', dayOffset: 2, items: [{ sku: 'DEMO-WIN-001', qty: '2' }], payment: { method: 'cash', tendered: '2500' } },
      { key: 'sale-05', dayOffset: 2, items: [{ sku: 'DEMO-WHI-003', qty: '1' }, { sku: 'DEMO-BEE-004', qty: '6' }], payment: { method: 'credit' } },
      { key: 'sale-06', dayOffset: 2, items: [{ sku: 'DEMO-BEE-003', qty: '4' }, { sku: 'DEMO-WHI-005', qty: '1' }], payment: { method: 'cash', tendered: '3500' } },
      { key: 'sale-07', dayOffset: 0, items: [{ sku: 'DEMO-VOD-003', qty: '1' }], payment: { method: 'cash', tendered: '2000' } },
      { key: 'sale-08', dayOffset: 0, items: [{ sku: 'DEMO-VOD-001', qty: '1' }, { sku: 'DEMO-SOF-003', qty: '2' }], payment: { method: 'cash', tendered: '2500' } },
      { key: 'sale-09', dayOffset: 0, items: [{ sku: 'DEMO-RUM-001', qty: '1' }], payment: { method: 'cash', tendered: '3000' }, after: 'void' },
      { key: 'sale-10', dayOffset: 0, items: [{ sku: 'DEMO-BEE-005', qty: '6' }], payment: { method: 'cash', tendered: '2000' }, after: 'return' }
    ];

    const { data: existingSalesData } = await api.call('get', '/pos/sales?pageSize=100');
    const existingCtids = new Set(
      rows<{ clientTransactionId?: string; client_transaction_id?: string }>(existingSalesData as Record<string, unknown>, 'items', 'sales')
        .map((s) => s.clientTransactionId ?? s.client_transaction_id)
    );
    const pendingSales = demoSales.filter((s) => !existingCtids.has(demoUuid(`demo-${s.key}`)));

    const { data: sessionData } = await api.call('get', `/pos/register-sessions?registerId=${registerId}&status=open&pageSize=10`);
    const openSessions = rows<{ id: string }>(sessionData as Record<string, unknown>, 'items', 'sessions');

    // A register/operator can only have ONE open session, so batches run
    // sequentially: open → sales → cash movement → close (today stays open).
    const salesByOffset = new Map<number, DemoSale[]>();
    for (const sale of pendingSales) {
      const list = salesByOffset.get(sale.dayOffset) ?? [];
      list.push(sale);
      salesByOffset.set(sale.dayOffset, list);
    }
    const offsetOrder = [...salesByOffset.keys()].sort((a, b) => b - a);
    let reusableSessionId = openSessions[0]?.id ?? null;
    const sessionByOffset = new Map<number, string>();

    let salesSeeded = 0;
    for (const offset of offsetOrder) {
      const batch = salesByOffset.get(offset)!;
      let sessionId = reusableSessionId;
      reusableSessionId = null;
      if (!sessionId) {
        const { data } = await api.call<{ session: { id: string } }>('post', '/pos/register-sessions/open', {
          body: { registerId, openingFloat: '5000', notes: `Demo session (day-${offset})` },
          idem: `demo-session-${offset}-${Date.now().toString(36)}`
        });
        sessionId = data.session.id;
      }
      sessionByOffset.set(offset, sessionId);
      for (const sale of batch) {
      const { data: created } = await api.call<{ sale: { id: string } }>('post', '/pos/sales', {
        body: {
          clientTransactionId: demoUuid(`demo-${sale.key}`),
          registerSessionId: sessionId,
          customerId: sale.payment.method === 'credit' ? demoCustomerId : undefined,
          priceListId: sale.priceList ? demoPriceListId : undefined,
          items: sale.items.map((item) => ({
            productId: productIds.get(item.sku),
            unitId: item.unit === 'CASE' ? unitCASE : unitEA,
            quantity: item.qty,
            discountPct: item.discountPct,
            expiryDate: item.expiry
          })),
          payment: { method: sale.payment.method, amountTendered: sale.payment.tendered }
        },
        idem: `demo-${sale.key}`
      });
      salesSeeded += 1;
      if (sale.after === 'void') {
        await api.call('post', `/pos/sales/${created.sale.id}/void`, {
          body: { reason: 'DEMO — cashier voided an incorrectly rung sale' },
          idem: `demo-${sale.key}-void`
        });
      }
      }

      // Close each batch's session before opening the next one — a register
      // allows only one open session at a time.
      const { data: session } = await api.call<{ session: { status: string; expectedCash?: string | null } }>('get', `/pos/register-sessions/${sessionId}`);
      if (session.session.status === 'open') {
        if (offset !== 0) {
          await api.call('post', `/pos/register-sessions/${sessionId}/cash-movements`, {
            body: { type: 'cash_out', amount: '1500', reason: 'DEMO — petty cash for change float' },
            idem: `demo-session-${offset}-cashout-${sessionId.slice(0, 8)}`
          });
        }
        await api.call('post', `/pos/register-sessions/${sessionId}/close`, {
          body: { countedCash: session.session.expectedCash ?? '5000', reason: 'DEMO end-of-day count (illustrative)' },
          idem: `demo-session-${offset}-close-${sessionId.slice(0, 8)}`
        });
      }
    }
    // Every seeded session is closed at the end: a register accepts only one
    // open session, and leaving the till open would block other demo users
    // (cashier/manager) from opening their own shift.
    const { data: leftoverData } = await api.call('get', `/pos/register-sessions?registerId=${registerId}&status=open&pageSize=10`);
    for (const leftover of rows<{ id: string }>(leftoverData as Record<string, unknown>, 'items', 'sessions')) {
      const { data: detail } = await api.call<{ session: { expectedCash?: string | null } }>('get', `/pos/register-sessions/${leftover.id}`);
      await api.call('post', `/pos/register-sessions/${leftover.id}/close`, {
        body: { countedCash: detail.session.expectedCash ?? '5000', reason: 'DEMO seed cleanup — closing leftover till' },
        idem: `demo-session-cleanup-close-${leftover.id.slice(0, 8)}`
      });
    }

    // Return follow-ups run against every demo sale, not just newly created
    // ones — a sale committed in an earlier partial run still gets its return
    // applied here. (Voids run inside the sale loop because a sale can only be
    // voided while its own register session is still open.)
    for (const sale of demoSales) {
      if (sale.after !== 'return') continue;
      const { rows: match } = await systemPool.query<{ id: string; status: string }>(
        'SELECT id, status FROM sales WHERE organization_id = $1 AND client_transaction_id = $2',
        [organizationId, demoUuid(`demo-${sale.key}`)]
      );
      const existing = match[0];
      if (!existing) continue;
      if (existing.status === 'completed') {
        const { data: detail } = await api.call<{ sale: { lines: { id: string }[]; returns: unknown[] } }>('get', `/pos/sales/${existing.id}`);
        if (detail.sale.returns.length === 0) {
          await api.call('post', `/pos/sales/${existing.id}/returns`, {
            body: { reason: 'DEMO — customer returned one bottle (restock)', lines: [{ saleLineId: detail.sale.lines[0]!.id, quantity: '2', disposition: 'restock' }] },
            idem: `demo-${sale.key}-return`
          });
        }
      }
    }

    // --- Backdate demo sale history -------------------------------------------
    // Sales are created through the real API (all invariants enforced), then the
    // business timestamps are shifted for the demo org only so report filters
    // show several days of activity. Audit events keep their true timestamps.
    const backdates = demoSales.map((s) => ({ ctid: demoUuid(`demo-${s.key}`), offset: s.dayOffset }));
    let backdated = 0;
    for (const { ctid, offset } of backdates) {
      const target = `now() - interval '${offset} days' - interval '3 hours'`;
      const saleRow = await systemPool.query<{ id: string; register_session_id: string }>(
        'SELECT id, register_session_id FROM sales WHERE organization_id = $1 AND client_transaction_id = $2',
        [organizationId, ctid]
      );
      const sale = saleRow.rows[0];
      if (!sale) continue;
      backdated += 1;
      const updates: [string, string][] = [
        ['sales', `sold_at = ${target}, created_at = ${target}, updated_at = ${target}`],
        ['sale_items', `created_at = ${target}`],
        ['sale_payments', `created_at = ${target}`],
        ['sale_voids', `created_at = ${target}`],
        ['sale_returns', `created_at = ${target}`],
        ['sale_return_lines', `created_at = ${target}`],
        ['sale_refunds', `created_at = ${target}`]
      ];
      for (const [table, set] of updates) {
        const fk = table === 'sale_return_lines'
          ? `sale_return_id IN (SELECT id FROM sale_returns WHERE sale_id = '${sale.id}' AND organization_id = '${organizationId}')`
          : table === 'sales'
            ? `id = '${sale.id}'`
            : `sale_id = '${sale.id}'`;
        await systemPool.query(
          `UPDATE ${table} SET ${set} WHERE organization_id = $1 AND ${fk}`,
          [organizationId]
        );
      }
      // stock_movements is intentionally append-only (trigger-protected), so
      // movement timestamps keep their real creation time by design.
      await systemPool.query(
        `UPDATE cash_movements SET created_at = ${target}
         WHERE organization_id = $1 AND register_session_id = $2 AND movement_type IN ('sale_refund', 'sale_void')`,
        [organizationId, sale.register_session_id]
      );
    }
    // Shift historical sessions and their cash movements.
    const offsets = [...new Set(demoSales.map((s) => s.dayOffset))].filter((o) => o > 0);
    for (const offset of offsets) {
      const target = `now() - interval '${offset} days'`;
      await systemPool.query(
        `UPDATE register_sessions rs SET opened_at = ${target} - interval '9 hours', closed_at = ${target}
         WHERE organization_id = $1 AND EXISTS (
           SELECT 1 FROM sales s WHERE s.register_session_id = rs.id
             AND s.organization_id = rs.organization_id
             AND s.client_transaction_id IN (${demoSales.filter((s) => s.dayOffset === offset).map((s) => `'${demoUuid(`demo-${s.key}`)}'`).join(',')})
         )`,
        [organizationId]
      );
      await systemPool.query(
        `UPDATE cash_movements cm SET created_at = ${target} - interval '1 hour'
         WHERE organization_id = $1 AND movement_type IN ('cash_in', 'cash_out', 'cash_adjustment')
           AND register_session_id IN (
             SELECT rs.id FROM register_sessions rs WHERE rs.organization_id = $1
               AND EXISTS (SELECT 1 FROM sales s WHERE s.register_session_id = rs.id AND s.organization_id = rs.organization_id
                 AND s.client_transaction_id IN (${demoSales.filter((s) => s.dayOffset === offset).map((s) => `'${demoUuid(`demo-${s.key}`)}'`).join(',')}))
           )`,
        [organizationId]
      );
    }
    // Backdate goods receipts so stock history precedes the historical sales.
    await systemPool.query(
      `UPDATE goods_receipts SET received_at = now() - interval '8 days' WHERE organization_id = $1`,
      [organizationId]
    );
    await systemPool.query(
      `UPDATE purchase_orders SET created_at = now() - interval '9 days' WHERE organization_id = $1 AND status IN ('received', 'approved')`,
      [organizationId]
    );

    log(`Backdated ${backdated} demo sales across ${offsets.length + 1} days`);

    const summary: DemoSeedSummary = {
      organizationId,
      branchId,
      created,
      reused,
      salesSeeded,
      backdatedSales: backdated
    };
    log(`DEMO SEED COMPLETE — org ${organizationId}`);
    return summary;
  } finally {
    await tenantPool.end();
    await systemPool.end();
  }
}

// --------------------------------------------------------------------------
// CLI entry
// --------------------------------------------------------------------------

const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('seed-demo.ts') || process.argv[1]?.replace(/\\/g, '/').endsWith('seed-demo.js');
if (isCli) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  seedDemo({ databaseUrl, systemDatabaseUrl: process.env.DATABASE_SYSTEM_URL ?? undefined })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      console.log(`\nDemo login → slug: ${DEMO.slug}  |  owner: ${DEMO.ownerEmail}  |  password: ${DEMO.ownerPassword}`);
      console.log(`               cashier: ${DEMO.cashierEmail}  |  password: ${DEMO.cashierPassword}`);
      console.log(`               manager: ${DEMO.managerEmail}  |  password: ${DEMO.managerPassword}`);
    })
    .catch((error) => {
      console.error(`Demo seed failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    });
}
