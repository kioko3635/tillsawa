import type { ReceiptDesign } from '@pos/contracts';

export interface LibraryProduct {
  id: string;
  sku: string;
  name: string;
  family: string;
  size: string;
  category: string;
  imageUrl: string;
  sourceUrl: string | null;
  photoKind: 'product_photo' | 'style_photo' | 'illustration';
  template: boolean;
  itemType: 'stocked' | 'non_stock' | 'service';
  productId: string | null;
}

export interface Organization {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  currencyCode: string;
  timezone: string;
  taxPricingMode: 'inclusive' | 'exclusive';
  defaultTaxRatePct?: string;
  receiptPolicy?: string;
  status: string;
  businessProfile?: string;
  defaultBranchId?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  businessAddress?: string | null;
  taxPin?: string | null;
  receiptHeader?: string | null;
  receiptFooter?: string | null;
  receiptLogoUrl?: string | null;
  receiptDesign?: ReceiptDesign;
  cashDrawerPolicy?: 'cash' | 'paid';
  createdAt: string;
  updatedAt: string;
}

export interface ModuleCatalogEntry {
  code: string;
  name: string;
  description: string;
  kind: 'module' | 'capability';
  availability: 'implemented' | 'planned';
  core: boolean;
  dependsOn: string[];
  enabled: boolean;
  configurable: boolean;
}

export interface OrganizationConfiguration {
  organization: Organization;
  profiles: Array<{
    code: string;
    label: string;
    summary: string;
    recommendedModules: readonly string[];
    recommendedCapabilities: readonly string[];
    plannedCapabilities: readonly string[];
    implementedHighlights: readonly string[];
    deferredCapabilities: readonly string[];
  }>;
  modules: ModuleCatalogEntry[];
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  timezone?: string | null;
  currencyCode?: string | null;
  status: 'active' | 'inactive';
  createdAt?: string;
  updatedAt?: string;
}

export interface Membership {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  title?: string | null;
  status: 'active' | 'suspended';
  allBranches: boolean;
  createdAt: string;
  roles: Array<Pick<Role, 'id' | 'code' | 'name'>>;
  branchIds: string[];
}

export interface Role {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  isSystem: boolean;
  permissionCodes: string[];
}

export interface Device {
  id: string;
  name: string;
  platform?: string | null;
  branchId: string;
  branchName: string;
  status: 'active' | 'suspended' | 'revoked';
  contractVersion: string;
  lastSyncAt?: string | null;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  status: string;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at?: string | null;
  user_email: string;
  display_name: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata: Record<string, unknown>;
  branchId?: string | null;
  actorMembershipId?: string | null;
  actorUserId?: string | null;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export interface AuthMembership {
  id: string;
  organizationId: string;
  userId: string;
  displayName: string;
  email: string;
  allBranches: boolean;
  permissions: string[];
}

export interface AuthBundle {
  accessToken: string;
  accessTokenExpiresIn: number;
  csrfToken: string;
  session: {
    id: string;
    expiresAt: string;
  };
  membership: AuthMembership;
}

export interface Bootstrap {
  organization: Organization;
  branches: Branch[];
  permissions: string[];
  modules: string[];
  capabilities: string[];
  syncContractVersion: string;
  featureFlags: Record<string, boolean>;
}

export interface SyncState {
  contractVersion: string;
  device: {
    id: string;
    branchId: string;
    status: string;
    contractVersion: string;
  };
  serverTime: string;
  cursors: Array<{ entityType: string; cursor: string; updatedAt: string }>;
}

export interface OfflineReferenceProduct extends PosProduct {
  barcode?: string | null;
  price: ResolvedPrice;
}

export interface OfflineReferenceSnapshot {
  schemaVersion: 1;
  revision: string;
  capturedAt: string;
  expiresAt: string;
  staleAfter: string;
  device: { id: string; branchId: string };
  branch: Branch;
  organization: Organization;
  registers: PosRegister[];
  currentSession: RegisterSession | null;
  products: OfflineReferenceProduct[];
  cashierMembershipId: string;
  cashierName: string;
  permissions: string[];
}

export interface SyncBootstrap {
  contractVersion: string;
  serverTime: string;
  device: { id: string; branchId: string; status: string; contractVersion: string };
  policy: {
    cashSales: boolean;
    creditSales: boolean;
    returnsAndRefunds: boolean;
    expenses: boolean;
    stockIsSnapshot: boolean;
    maxReferenceAgeSeconds: number;
    staleAfterSeconds: number;
  };
  snapshot: OfflineReferenceSnapshot;
}

export type SyncTransactionStatus = 'pending' | 'processing' | 'accepted' | 'duplicate' | 'retryable' | 'rejected' | 'conflict' | 'resolved';

export interface SyncTransactionResult {
  syncTransactionId: string;
  clientTransactionId: string;
  entityType: string;
  deviceId: string;
  branchId: string;
  cashierMembershipId?: string | null;
  status: SyncTransactionStatus;
  outcome: SyncTransactionStatus;
  saleId?: string | null;
  serverEntityType?: string | null;
  serverEntityId?: string | null;
  receiptNumber?: string | null;
  error?: { code: string; message: string; details?: unknown } | null;
  attempts: number;
  clientOccurredAt: string;
  firstAttemptAt?: string | null;
  lastAttemptAt?: string | null;
  processedAt?: string | null;
  resolutionAction?: 'retry' | 'accept-current-price' | 'override-negative-stock' | 'cancel-local' | null;
  resolutionReason?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncBatchResult {
  batchId: string;
  deviceId: string;
  contractVersion: string;
  serverTime: string;
  results: SyncTransactionResult[];
}

export interface ProductCategory {
  id: string;
  parentId?: string | null;
  parentName?: string | null;
  name: string;
  status: 'active' | 'inactive';
}

export interface UnitOfMeasure {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description?: string | null;
  brand?: string | null;
  imageUrl?: string | null;
  barcode?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  baseUnitId: string;
  baseUnitCode?: string | null;
  itemType: 'stocked' | 'non_stock' | 'service';
  status: 'active' | 'archived';
  cost: string;
  basePrice: string;
  minPrice?: string | null;
  costingMethod: 'average' | 'latest';
  minStockLevel: string;
  reorderQty?: string | null;
  trackBatch: boolean;
  trackExpiry: boolean;
  trackSerial: boolean;
  barcodes?: Array<{ id: string; barcode: string; isPrimary: boolean }>;
  conversions?: Array<{ id: string; fromUnitId: string; fromUnitCode: string; toUnitId: string; toUnitCode: string; ratio: string }>;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxPin?: string | null;
  notes?: string | null;
  status: 'active' | 'inactive';
  creditStatus: 'disabled' | 'active' | 'hold';
  creditLimit: string;
  paymentTermsDays: number;
  creditReason?: string | null;
  outstandingBalance: string;
  availableCredit?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreditAccount {
  customerId: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  creditStatus: 'disabled' | 'active' | 'hold';
  creditLimit: string;
  paymentTermsDays: number;
  creditReason?: string | null;
  outstandingBalance: string;
  availableCredit: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreditTransaction {
  id: string;
  branchId?: string | null;
  transactionType: 'sale_charge' | 'payment' | 'return_credit' | 'sale_void' | 'debit_adjustment' | 'credit_adjustment' | 'write_off';
  direction: 'debit' | 'credit';
  amount: string;
  saleId?: string | null;
  receiptNumber?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  dueDate?: string | null;
  reason?: string | null;
  actorName?: string | null;
  createdAt: string;
}

export interface OutstandingSale {
  saleId: string;
  branchId: string;
  branchName: string;
  receiptNumber: string;
  soldAt: string;
  dueDate?: string | null;
  total: string;
  allocated: string;
  outstanding: string;
  overdue: boolean;
}

export interface CustomerPayment {
  id: string;
  customerId: string;
  branchId: string;
  registerSessionId: string;
  paymentNumber: string;
  clientTransactionId: string;
  method: 'cash';
  amount: string;
  status: 'completed';
  reason: string;
  receivedByName?: string | null;
  createdAt: string;
  allocations: Array<{ id: string; saleId: string; receiptNumber: string; amount: string; createdAt: string }>;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxPin?: string | null;
  supplierReference?: string | null;
  paymentTermsDays: number;
  status: 'active' | 'inactive';
  notes?: string | null;
  outstandingBalance: string;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  unitId: string;
  unitCode: string;
  orderedQty: string;
  baseOrderedQty: string;
  unitCost: string;
  lineTotal: string;
  receivedQty: string;
  damagedQty: string;
  rejectedQty: string;
  remainingQty: string;
}

export interface PurchaseOrder {
  id: string;
  branchId: string;
  branchName?: string | null;
  supplierId: string;
  supplierCode?: string | null;
  supplierName?: string | null;
  poNumber: string;
  clientTransactionId: string;
  status: 'draft' | 'submitted' | 'approved' | 'partially_received' | 'received' | 'cancelled';
  expectedDeliveryDate?: string | null;
  supplierReference?: string | null;
  notes?: string | null;
  total: string;
  createdByName?: string | null;
  submittedAt?: string | null;
  approvedAt?: string | null;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PurchaseOrderLine[];
}

export interface GoodsReceipt {
  id: string;
  purchaseOrderId: string;
  receiptNumber: string;
  status: 'posted';
  notes?: string | null;
  receivedByName?: string | null;
  receivedAt: string;
  lines: Array<{
    id: string;
    purchaseOrderLineId: string;
    productId: string;
    productSku: string;
    productName: string;
    unitCode: string;
    orderedQty: string;
    receivedQty: string;
    damagedQty: string;
    rejectedQty: string;
    discrepancyReason?: string | null;
  }>;
}

export interface SupplierInvoice {
  id: string;
  branchId: string;
  branchName?: string | null;
  supplierId: string;
  supplierCode?: string | null;
  supplierName?: string | null;
  purchaseOrderId?: string | null;
  poNumber?: string | null;
  invoiceNumber: string;
  amount: string;
  allocated: string;
  outstanding: string;
  status: 'outstanding' | 'partially_paid' | 'paid' | 'voided';
  issueDate: string;
  dueDate?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierPayment {
  id: string;
  supplierId: string;
  branchId: string;
  registerSessionId: string;
  paymentNumber: string;
  clientTransactionId: string;
  method: 'cash';
  amount: string;
  allocated: string;
  unallocated: string;
  status: 'completed';
  reason: string;
  paidByName?: string | null;
  createdAt: string;
  allocations: Array<{ id: string; supplierInvoiceId: string; invoiceNumber: string; amount: string; createdAt: string }>;
}

export interface PriceLine {
  id: string;
  productId: string;
  productSku?: string | null;
  productName?: string | null;
  minQty: string;
  price: string;
  status: 'active' | 'inactive';
}

export interface PriceList {
  id: string;
  code: string;
  name: string;
  kind: 'retail' | 'wholesale' | 'customer' | 'branch';
  branchId?: string | null;
  branchName?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  status: 'active' | 'inactive';
  validFrom?: string | null;
  validTo?: string | null;
  maxDiscountPct?: string | null;
  minPrice?: string | null;
  isDefault: boolean;
  lines?: PriceLine[];
}

export interface ResolvedPrice {
  productId: string;
  productSku: string;
  productName: string;
  source: 'customer' | 'branch' | 'selected' | 'default' | 'base';
  priceListId?: string | null;
  priceLineId?: string | null;
  listPrice: string;
  discountPct?: string | null;
  price: string;
  currency: string;
}

export interface StockLevel {
  productId: string;
  sku: string;
  name: string;
  unitCode: string;
  onHandQty: string;
  minStockLevel: string;
  reorderQty?: string | null;
  averageCost: string;
  valuation: string;
  updatedAt: string;
}

export interface StockMovement {
  id: string;
  seq: number;
  productId: string;
  productSku: string;
  productName: string;
  movementType: string;
  unitCode: string;
  quantity: string;
  baseQuantity: string;
  unitCost?: string | null;
  referenceType?: string | null;
  reason?: string | null;
  negativeOverride: boolean;
  overrideReason?: string | null;
  createdAt: string;
  actorName?: string | null;
}

export interface StockAdjustment {
  id: string;
  branchId: string;
  branchName: string;
  type: string;
  reason: string;
  status: string;
  negativeOverride: boolean;
  createdAt: string;
  lineCount?: number;
  lines?: Array<{ productId: string; productSku: string; productName: string; quantity: string; baseQuantity: string }>;
}

export interface StockCount {
  id: string;
  branchId: string;
  branchName: string;
  name?: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
  createdAt: string;
  lineCount?: number;
  lines?: Array<{ id: string; productId: string; productSku: string; productName: string; expectedQty: string; countedQty?: string | null; varianceQty?: string | null }>;
}

export interface StockTransfer {
  id: string;
  sourceBranchId: string;
  sourceBranchName: string;
  destinationBranchId: string;
  destinationBranchName: string;
  referenceCode: string;
  status: 'draft' | 'dispatched' | 'partially_received' | 'received' | 'cancelled';
  createdAt: string;
  lines?: Array<{
    id: string;
    productId: string;
    productSku: string;
    productName: string;
    quantity: string;
    baseQuantity: string;
    qtyDispatched: string;
    qtyReceived: string;
    qtyCancelled: string;
    inTransitQty: string;
  }>;
}

export interface PosProduct {
  id: string;
  sku: string;
  name: string;
  brand?: string | null;
  imageUrl?: string | null;
  itemType: 'stocked' | 'non_stock' | 'service';
  baseUnitId: string;
  unitCode: string;
  categoryId?: string | null;
  categoryName?: string | null;
  minStockLevel?: string;
  barcode?: string | null;
  cost: string;
  basePrice: string;
  taxRatePct?: string | null;
  onHandQty: string;
  averageCost: string;
}

export interface PosRegister {
  id: string;
  branchId: string;
  branchName?: string | null;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  receiptPrefix: string;
  receiptFooter?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CashMovementRecord {
  id: string;
  registerSessionId: string;
  type: 'cash_in' | 'cash_out' | 'cash_adjustment' | 'sale_refund' | 'sale_void' | 'customer_payment' | 'supplier_payment' | 'expense_payment';
  direction: 'in' | 'out';
  amount: string;
  reason: string;
  referenceType?: string | null;
  referenceId?: string | null;
  actorName?: string | null;
  createdAt: string;
}

export interface RegisterSession {
  id: string;
  branchId: string;
  branchName?: string | null;
  registerId: string;
  registerCode?: string | null;
  registerName?: string | null;
  status: 'open' | 'closed';
  openingFloat: string;
  expectedCash?: string | null;
  countedCash?: string | null;
  cashVariance?: string | null;
  openedByMembershipId: string;
  openedByName?: string | null;
  openedAt: string;
  closedByName?: string | null;
  closedAt?: string | null;
  closeReason?: string | null;
  createdAt: string;
  updatedAt: string;
  sales?: Sale[];
  cashMovements?: CashMovementRecord[];
}

export interface SaleLine {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  unitId: string;
  unitCode: string;
  quantity: string;
  baseQuantity: string;
  listPrice: string;
  unitPrice: string;
  discountPct: string;
  discount: string;
  subtotal: string;
  taxRatePct: string;
  tax: string;
  total: string;
  costTotal: string;
  returnedQty: string;
  returnableQty: string;
  batchNo?: string | null;
  serialNo?: string | null;
  expiryDate?: string | null;
}

export interface SalePayment {
  id: string;
  method: 'cash' | 'credit' | 'mpesa' | 'card';
  reference?: string | null;
  verification?: string;
  amount: string;
  amountTendered: string;
  change: string;
  status: 'completed' | 'voided' | 'partially_refunded' | 'refunded' | 'outstanding' | 'partially_paid' | 'paid';
  createdAt: string;
}

export interface SaleReturnLine {
  id: string;
  saleLineId: string;
  productId: string;
  productSku?: string | null;
  productName?: string | null;
  unitCode: string;
  quantity: string;
  baseQuantity: string;
  disposition: 'restock' | 'damaged' | 'write_off';
  refundAmount: string;
}

export interface SaleReturn {
  id: string;
  saleId: string;
  returnNumber: string;
  status: 'posted';
  reason: string;
  refundableTotal: string;
  createdByName?: string | null;
  createdAt: string;
  lines: SaleReturnLine[];
}

export interface SaleRefund {
  id: string;
  saleId: string;
  saleReturnId?: string | null;
  registerSessionId: string;
  method: 'cash';
  amount: string;
  status: 'completed';
  reason: string;
  authorizedByName?: string | null;
  createdAt: string;
}

export interface Sale {
  id: string;
  branchId: string;
  branchName?: string | null;
  registerId: string;
  registerCode?: string | null;
  registerName?: string | null;
  registerSessionId: string;
  cashierMembershipId: string;
  cashierName?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  clientTransactionId: string;
  receiptNumber: string;
  status: 'completed' | 'partially_returned' | 'returned' | 'voided';
  currency: string;
  taxPricingMode: 'inclusive' | 'exclusive';
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  totalCost: string;
  soldAt: string;
  creditDueDate?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  createdAt: string;
  lines: SaleLine[];
  payments: SalePayment[];
  returns: SaleReturn[];
  refunds: SaleRefund[];
}

export interface Receipt {
  sale: Sale;
  loyalty?: { earned: string; redeemed: string; redeemedValue: string; balanceAfter: string; reversedEarned: string; restoredRedeemed: string } | null;
  organization: {
    legalName: string;
    displayName: string;
    receiptPolicy: string;
    branchName: string;
    branchCode: string;
    registerName: string;
    registerCode: string;
    receiptFooter?: string | null;
    receiptHeader?: string | null;
    receiptLogoUrl?: string | null;
    receiptDesign?: ReceiptDesign;
    contactPhone?: string | null;
    contactEmail?: string | null;
    businessAddress?: string | null;
    taxPin?: string | null;
  };
  complianceNotice: string;
}

export interface ExpenseCategory {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseEvent {
  id: string;
  eventType: string;
  fromStatus?: string | null;
  toStatus: string;
  amount?: string | null;
  reason?: string | null;
  actorName?: string | null;
  createdAt: string;
}

export interface ExpensePayment {
  id: string;
  paymentNumber: string;
  method: 'cash' | 'bank_transfer' | 'mobile_money' | 'other';
  status: 'pending' | 'completed' | 'cancelled';
  amount: string;
  reason: string;
  paymentReference?: string | null;
  paidByName?: string | null;
  registerSessionId?: string | null;
  cashMovementId?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

export interface Expense {
  id: string;
  branchId: string;
  branchName?: string | null;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  expenseNumber: string;
  clientTransactionId: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid' | 'cancelled';
  paymentStatus: 'unpaid' | 'pending' | 'paid';
  description: string;
  businessPurpose?: string | null;
  expenseDate: string;
  amount: string;
  currencyCode: string;
  paymentMethod: 'cash' | 'bank_transfer' | 'mobile_money' | 'other';
  payeeName?: string | null;
  supplierId?: string | null;
  supplierName?: string | null;
  supportingDocumentRef?: string | null;
  supportingDocumentName?: string | null;
  createdByMembershipId: string;
  createdByName?: string | null;
  submittedByName?: string | null;
  submittedAt?: string | null;
  approvedByName?: string | null;
  approvedAt?: string | null;
  rejectedByName?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  paidByName?: string | null;
  paidAt?: string | null;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  createdAt: string;
  updatedAt: string;
  events?: ExpenseEvent[];
  payments?: ExpensePayment[];
}

export interface OperationsReport {
  topProducts: Array<{ productId: string; sku: string; name: string; unitCode: string; quantity: string; sales: string; grossProfit: string }>;
  cashiers: Array<{ membershipId: string; name: string; saleCount: number; sales: string }>;
  generatedAt: string;
  organizationName: string;
  currencyCode: string;
  timezone: string;
  range: { from?: string | null; to?: string | null; branchId?: string | null };
  sales: {
    count: number;
    grossSales: string;
    discounts: string;
    tax: string;
    costOfGoodsSold: string;
    grossProfit: string;
    cashSales: string;
    creditSales: string;
    mpesaSales: string;
    cardSales: string;
    testSales: string;
    returned: string;
    refunded: string;
  };
  expenses: {
    count: number;
    draft: string;
    submitted: string;
    approved: string;
    pendingPayment: string;
    paid: string;
    authorized: string;
    categories: Array<{ id: string; name: string; count: number; submitted: string; approved: string; paid: string; total: string }>;
    branches: Array<{ id: string; name: string; count: number; submitted: string; approved: string; paid: string; total: string }>;
  };
  inventory: { stockValue: string; onHandQty: string; lowStockCount: number };
  debt: { receivablesOutstanding: string; payablesOutstanding: string };
  drawer: {
    cashSales: string;
    customerCollections: string;
    supplierPayments: string;
    expensePayments: string;
    cashIn: string;
    cashOut: string;
    refundsAndVoids: string;
    netCashMovement: string;
  };
  daily: Array<{ date: string; sales: string; saleCount: number; authorizedExpenses: string; paidExpenses: string }>;
  branches: Array<{ branchId: string; name: string; sales: string; authorizedExpenses: string; paidExpenses: string; stockValue: string }>;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SubscriptionStatus {
  state: string;
  canWrite: boolean;
  message: string;
  installationCode: string | null;
  graceEndsAt: string | null;
  activeUsers?: number;
  license: { shopName: string; plan: string; expiresAt: string | null; licenseId: string; lifetime?: boolean; maxUsers?: number | null } | null;
}
export interface OnlineCatalogProduct {
  code: string; name: string; brand: string; size: string; category: string;
  imageUrl: string | null; sourceUrl: string;
}
export interface OnlineCatalogImport {
  code: string; name: string; brand: string | null; size: string; barcode: string;
  categoryId: string | null; baseUnitId: string; cost: string; basePrice: string;
  includePhoto: boolean; confirmed: true;
}
export interface LoyaltySettings { enabled: boolean; earnSpend: string; redeemValue: string; minimumRedeemPoints: number }
