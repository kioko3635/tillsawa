import type {
  CreateAdjustmentInput,
  CreateBranchInput,
  CreateCategoryInput,
  CreateCustomerCreditAdjustmentInput,
  CreateCustomerInput,
  CreateExpenseCategoryInput,
  CreateExpenseInput,
  CreatePriceListInput,
  CreatePurchaseOrderInput,
  CreateSupplierInput,
  CreateSupplierInvoiceInput,
  CreateProductInput,
  CreateStockCountInput,
  CreateTransferInput,
  CreateUnitInput,
  CreateUserInput,
  DecideStockCountInput,
  DispatchTransferInput,
  LoginInput,
  PriceResolveInput,
  ReceivePurchaseOrderInput,
  ReceiveTransferInput,
  RecordCountLinesInput,
  RecordCustomerPaymentInput,
  RecordSupplierPaymentInput,
  ResolveSyncTransactionInput,
  SyncBatchInput,
  UpdateSupplierInput,
  UpdateCustomerCreditInput,
  CancelTransferInput,
  CashMovementInput,
  CloseRegisterSessionInput,
  CompleteSaleInput,
  CreateRegisterInput,
  CreateSaleRefundInput,
  CreateSaleReturnInput,
  OpenRegisterSessionInput,
  PayExpenseInput,
  RegisterOrganizationInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  RoleInput,
  UpdateBranchInput,
  UpdateCategoryInput,
  UpdateCustomerInput,
  UpdateDeviceInput,
  UpdateExpenseCategoryInput,
  UpdateExpenseInput,
  UpdateMembershipInput,
  UpdateOrganizationConfigurationInput,
  UpdateOrganizationInput,
  UpdatePriceListInput,
  UpdateProductInput,
  UpdateUnitInput,
  UpsertPriceLinesInput
} from '@pos/contracts';
import type {
  AuditEvent,
  AuthBundle,
  Bootstrap,
  Branch,
  CashMovementRecord,
  CreditAccount,
  CreditTransaction,
  CustomerPayment,
  Device,
  Expense,
  ExpenseCategory,
  GoodsReceipt,
  Membership,
  Customer,
  OperationsReport,
  Organization,
  OrganizationConfiguration,
  OutstandingSale,
  Paged,
  PosProduct,
  PurchaseOrder,
  PriceList,
  Receipt,
  RegisterSession,
  Sale,
  PosRegister,
  Product,
  ProductCategory,
  ResolvedPrice,
  Role,
  SessionRecord,
  StockAdjustment,
  StockCount,
  StockLevel,
  StockMovement,
  StockTransfer,
  Supplier,
  SupplierInvoice,
  SupplierPayment,
  SyncBatchResult,
  SyncBootstrap,
  SyncState,
  SyncTransactionResult,
  UnitOfMeasure
} from './types';
import { getDeviceIdentity } from '../offline/db';
import type { OnlineCatalogProduct, OnlineCatalogImport } from './types';
import type { LoyaltySettings } from './types';

const API_BASE = '/api/v1';
const CSRF_STORAGE_KEY = 'kenya-pos.csrf-token';
let accessToken: string | null = null;
/** Only the trusted desktop bridge uses this; never write it to disk or logs. */
export function desktopAccessToken(): string | null { return accessToken; }
let refreshPromise: Promise<AuthBundle> | null = null;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

interface ApiEnvelope<T> {
  data: T;
}

interface ApiErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

function getCookie(name: string): string | null {
  const entry = document.cookie.split('; ').find((item) => item.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function csrfToken(): string | null {
  return localStorage.getItem(CSRF_STORAGE_KEY) ?? getCookie('pos_csrf');
}

function saveCsrfToken(token: string): void {
  localStorage.setItem(CSRF_STORAGE_KEY, token);
}

export function clearSession(): void {
  accessToken = null;
  localStorage.removeItem(CSRF_STORAGE_KEY);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as (ApiEnvelope<T> & ApiErrorEnvelope) | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'INTERNAL_ERROR',
      body?.error?.message ?? 'Request failed',
      body?.error?.details
    );
  }
  if (!body || !('data' in body)) throw new ApiError(response.status, 'INVALID_RESPONSE', 'The API returned an invalid response');
  return body.data;
}

async function rawRefresh(): Promise<AuthBundle> {
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'x-csrf-token': csrfToken() ?? ''
    }
  });
  const data = await parseResponse<AuthBundle & { csrfToken: string }>(response);
  accessToken = data.accessToken;
  saveCsrfToken(data.csrfToken);
  return data;
}

export async function refreshSession(): Promise<AuthBundle> {
  refreshPromise ??= rawRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include'
  });
  if (response.status === 401 && retry && path !== '/auth/refresh') {
    await refreshSession();
    return request<T>(path, init, false);
  }
  return parseResponse<T>(response);
}

async function mutate<T>(path: string, method: string, body?: unknown, idempotent = false, extraHeaders: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (idempotent) headers['idempotency-key'] = crypto.randomUUID();
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return request<T>(path, init);
}

async function deviceHeaders(deviceId: string): Promise<Record<string, string>> {
  const identity = await getDeviceIdentity();
  return identity?.deviceId === deviceId && identity.deviceKey ? { 'x-device-key': identity.deviceKey } : { 'x-device-key': '' };
}

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

async function requestText(path: string, retry = true): Promise<string> {
  const headers = new Headers();
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${API_BASE}${path}`, { headers, credentials: 'include' });
  if (response.status === 401 && retry) {
    await refreshSession();
    return requestText(path, false);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiErrorEnvelope | null;
    throw new ApiError(response.status, body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? 'Request failed', body?.error?.details);
  }
  return response.text();
}

export const api = {
  get accessToken() {
    return accessToken;
  },
  async registerOrganization(input: RegisterOrganizationInput, setupKey?: string): Promise<AuthBundle> {
    const data = await mutate<AuthBundle>('/auth/register-organization', 'POST', input, false, setupKey ? { 'x-pos-setup-key': setupKey } : {});
    accessToken = data.accessToken;
    saveCsrfToken(data.csrfToken);
    return data;
  },
  async login(input: LoginInput): Promise<AuthBundle> {
    const data = await mutate<AuthBundle>('/auth/login', 'POST', input);
    accessToken = data.accessToken;
    saveCsrfToken(data.csrfToken);
    return data;
  },
  async logout(): Promise<void> {
    await request('/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken() ?? '' }
    }).catch(() => undefined);
    clearSession();
  },
  async requestPasswordReset(input: RequestPasswordResetInput): Promise<{ accepted: boolean; resetToken?: string }> {
    return mutate('/auth/password-reset/request', 'POST', input);
  },
  recoveryStatus: () => request<{ remaining: number; generatedAt: string | null }>('/auth/recovery/status'),
  generateRecoveryCodes: (currentPassword: string) => mutate<{ codes: string[] }>('/auth/recovery/codes', 'POST', { currentPassword }),
  recoverAccount: (input: { email: string; code: string; password: string }) => mutate('/auth/recovery/confirm', 'POST', input),
  resetStaffPassword: (input: { membershipId: string; currentPassword: string; password: string }) => mutate('/auth/recovery/staff-reset', 'POST', input),
  async resetPassword(input: ResetPasswordInput): Promise<{ passwordReset: boolean }> {
    return mutate('/auth/password-reset/confirm', 'POST', input);
  },
  bootstrap: () => request<Bootstrap>('/meta/bootstrap'),
  subscriptionStatus: () => request<import('./types').SubscriptionStatus>('/licensing/status'),
  activationRequest: () => request<Record<string, unknown>>('/licensing/request'),
  importLicense: (input: unknown) => mutate<import('./types').SubscriptionStatus>('/licensing/import', 'POST', input),
  organization: () => request<{ organization: Organization }>('/organizations/current'),
  updateOrganization: (input: UpdateOrganizationInput) => mutate<{ organization: Organization }>('/organizations/current', 'PATCH', input),
  organizationConfiguration: () => request<{ configuration: OrganizationConfiguration }>('/organizations/current/configuration'),
  updateOrganizationConfiguration: (input: UpdateOrganizationConfigurationInput) => mutate<{ configuration: OrganizationConfiguration }>('/organizations/current/configuration', 'PATCH', input),
  branches: () => request<{ branches: Branch[] }>('/branches'),
  createBranch: (input: CreateBranchInput) => mutate<{ branch: Branch }>('/branches', 'POST', input, true),
  updateBranch: (branchId: string, input: UpdateBranchInput) => mutate<{ branch: Branch }>(`/branches/${branchId}`, 'PATCH', input),
  users: () => request<{ users: Membership[] }>('/users'),
  createUser: (input: CreateUserInput) => mutate<{ membership: Membership }>('/users', 'POST', input, true),
  updateMembership: (membershipId: string, input: UpdateMembershipInput) => mutate<{ membership: Membership }>(`/memberships/${membershipId}`, 'PATCH', input),
  roles: () => request<{ roles: Role[] }>('/roles'),
  createRole: (input: RoleInput) => mutate<{ role: Role }>('/roles', 'POST', input, true),
  updateRole: (roleId: string, input: { name?: string; description?: string | null; permissionCodes?: string[] }) => mutate<{ role: Role }>(`/roles/${roleId}`, 'PATCH', input),
  permissions: () => request<{ permissions: string[] }>('/permissions'),
  sessions: () => request<{ sessions: SessionRecord[] }>('/auth/sessions'),
  revokeSession: (sessionId: string) => mutate(`/auth/sessions/${sessionId}`, 'DELETE'),
  devices: () => request<{ devices: Device[] }>('/devices'),
  registerDevice: (input: { name: string; branchId: string; platform?: string }) => mutate<{ device: Device; deviceKey: string }>('/devices/register', 'POST', input, true),
  updateDevice: (deviceId: string, input: UpdateDeviceInput) => mutate<{ device: Device }>(`/devices/${deviceId}`, 'PATCH', input),
  syncState: async (deviceId: string) => request<{ sync: SyncState }>(`/sync/state?deviceId=${encodeURIComponent(deviceId)}`, { headers: await deviceHeaders(deviceId) }),
  syncBootstrap: async (deviceId: string) => request<{ bootstrap: SyncBootstrap }>(`/sync/bootstrap?deviceId=${encodeURIComponent(deviceId)}`, { headers: await deviceHeaders(deviceId) }),
  syncTransactions: async (input: SyncBatchInput) => mutate<SyncBatchResult>('/sync/transactions', 'POST', input, false, {
    ...(await deviceHeaders(input.deviceId)),
    'idempotency-key': input.batchId
  }),
  listSyncTransactions: async (deviceId: string, status?: string) => request<{ transactions: SyncTransactionResult[] }>(
    `/sync/transactions${queryString({ deviceId, status })}`,
    { headers: await deviceHeaders(deviceId) }
  ),
  syncTransaction: async (deviceId: string, clientTransactionId: string) => request<{ transaction: SyncTransactionResult }>(
    `/sync/transactions/${encodeURIComponent(clientTransactionId)}?deviceId=${encodeURIComponent(deviceId)}`,
    { headers: await deviceHeaders(deviceId) }
  ),
  resolveSyncTransaction: async (deviceId: string, syncTransactionId: string, input: ResolveSyncTransactionInput) => mutate<{ transaction: SyncTransactionResult }>(
    `/sync/transactions/${syncTransactionId}/resolve`,
    'POST',
    input,
    true,
    await deviceHeaders(deviceId)
  ),
  auditEvents: () => request<{ events: AuditEvent[] }>('/audit-events'),

  categories: () => request<{ categories: ProductCategory[] }>('/catalog/categories'),
  liquorLibrary: () => request<{ version: string; entries: LibraryProduct[] }>('/catalog/library/liquor'),
  businessLibrary: () => request<{ version: string; profile: string; label: string; entries: LibraryProduct[] }>('/catalog/library'),
  searchOnlineCatalog: (query: string) => request<{ products: OnlineCatalogProduct[]; source: string }>(`/catalog/online/search?query=${encodeURIComponent(query)}`),
  loyaltySettings: () => request<{ settings: LoyaltySettings }>('/loyalty/settings'),
  updateLoyaltySettings: (input: LoyaltySettings) => mutate<{ settings: LoyaltySettings }>('/loyalty/settings','PATCH',input),
  customerLoyalty: (id: string) => request<{ customerName: string; balance: string; entries: { id: string; saleId: string; points: string; kind: string; createdAt: string }[] }>(`/loyalty/customers/${id}`),
  importOnlineCatalog: (input: OnlineCatalogImport) => mutate<{ product: Product; created: boolean }>('/catalog/online/import', 'POST', input, true),
  selectBusinessLibraryProducts: (entries: Array<{ id: string; sellingPrice: string; cost: string }>) => mutate<{ created: number; skipped: number }>('/catalog/library/select', 'POST', { entries }, true),
  selectLibraryProducts: (entries: Array<{ id: string; sellingPrice: string; cost: string }>) => mutate<{ created: number; skipped: number }>('/catalog/library/liquor/select', 'POST', { entries }, true),
  createCategory: (input: CreateCategoryInput) => mutate<{ category: ProductCategory }>('/catalog/categories', 'POST', input, true),
  updateCategory: (categoryId: string, input: UpdateCategoryInput) => mutate<{ category: ProductCategory }>(`/catalog/categories/${categoryId}`, 'PATCH', input),
  units: () => request<{ units: UnitOfMeasure[] }>('/catalog/units'),
  createUnit: (input: CreateUnitInput) => mutate<{ unit: UnitOfMeasure }>('/catalog/units', 'POST', input, true),
  updateUnit: (unitId: string, input: UpdateUnitInput) => mutate<{ unit: UnitOfMeasure }>(`/catalog/units/${unitId}`, 'PATCH', input),
  products: (params: Record<string, string | number | boolean | undefined> = {}) => request<Paged<Product>>(`/catalog/products${queryString(params)}`),
  product: (productId: string) => request<{ product: Product }>(`/catalog/products/${productId}`),
  createProduct: (input: CreateProductInput) => mutate<{ product: Product }>('/catalog/products', 'POST', input, true),
  updateProduct: (productId: string, input: UpdateProductInput) => mutate<{ product: Product }>(`/catalog/products/${productId}`, 'PATCH', input),
  lookupBarcode: (barcode: string) => request<{ product: Product }>(`/catalog/products/barcode/${encodeURIComponent(barcode)}`),
  addBarcode: (productId: string, barcode: string, isPrimary = false) => mutate<{ product: Product }>(`/catalog/products/${productId}/barcodes`, 'POST', { barcode, isPrimary }, true),
  removeBarcode: (productId: string, barcodeId: string) => mutate<{ product: Product }>(`/catalog/products/${productId}/barcodes/${barcodeId}`, 'DELETE'),
  exportProducts: () => requestText('/catalog/products/export.csv'),
  importProducts: (csv: string) => mutate<{ import: { created: number; errors: Array<{ row: number; message: string }> } }>('/catalog/products/import', 'POST', { csv }, true),

  customers: (params: Record<string, string | number | boolean | undefined> = {}) => request<{ customers: Customer[] }>(`/customers${queryString(params)}`),
  createCustomer: (input: CreateCustomerInput) => mutate<{ customer: Customer }>('/customers', 'POST', input, true),
  updateCustomer: (customerId: string, input: UpdateCustomerInput) => mutate<{ customer: Customer }>(`/customers/${customerId}`, 'PATCH', input),
  creditAccount: (customerId: string) => request<{ account: CreditAccount; transactions: CreditTransaction[]; outstandingSales: OutstandingSale[] }>(`/customers/${customerId}/credit-account`),
  updateCreditAccount: (customerId: string, input: UpdateCustomerCreditInput) => mutate<{ account: CreditAccount }>(`/customers/${customerId}/credit-account`, 'PATCH', input),
  recordCustomerPayment: (customerId: string, input: RecordCustomerPaymentInput) => mutate<{ payment: CustomerPayment; replayed?: boolean }>(`/customers/${customerId}/payments`, 'POST', input, true),
  createCreditAdjustment: (customerId: string, input: CreateCustomerCreditAdjustmentInput) => mutate<{ transaction?: CreditTransaction; replayed?: boolean }>(`/customers/${customerId}/adjustments`, 'POST', input, true),

  suppliers: (params: Record<string, string | number | boolean | undefined> = {}) => request<Paged<Supplier>>(`/suppliers${queryString(params)}`),
  supplier: (supplierId: string) => request<{ supplier: Supplier }>(`/suppliers/${supplierId}`),
  createSupplier: (input: CreateSupplierInput) => mutate<{ supplier: Supplier }>('/suppliers', 'POST', input, true),
  updateSupplier: (supplierId: string, input: UpdateSupplierInput) => mutate<{ supplier: Supplier }>(`/suppliers/${supplierId}`, 'PATCH', input),
  recordSupplierPayment: (supplierId: string, input: RecordSupplierPaymentInput) => mutate<{ payment: SupplierPayment; replayed?: boolean }>(`/suppliers/${supplierId}/payments`, 'POST', input, true),
  purchaseOrders: (params: Record<string, string | number | boolean | undefined> = {}) => request<Paged<PurchaseOrder>>(`/purchase-orders${queryString(params)}`),
  purchaseOrder: (purchaseOrderId: string) => request<{ purchaseOrder: PurchaseOrder; receipts: GoodsReceipt[] }>(`/purchase-orders/${purchaseOrderId}`),
  createPurchaseOrder: (input: CreatePurchaseOrderInput) => mutate<{ purchaseOrder: PurchaseOrder; receipts: GoodsReceipt[]; replayed?: boolean }>('/purchase-orders', 'POST', input, true),
  submitPurchaseOrder: (purchaseOrderId: string) => mutate<{ purchaseOrder: PurchaseOrder; receipts: GoodsReceipt[] }>(`/purchase-orders/${purchaseOrderId}/submit`, 'POST', {}, true),
  approvePurchaseOrder: (purchaseOrderId: string) => mutate<{ purchaseOrder: PurchaseOrder; receipts: GoodsReceipt[] }>(`/purchase-orders/${purchaseOrderId}/approve`, 'POST', {}, true),
  cancelPurchaseOrder: (purchaseOrderId: string, reason: string) => mutate<{ purchaseOrder: PurchaseOrder; receipts: GoodsReceipt[] }>(`/purchase-orders/${purchaseOrderId}/cancel`, 'POST', { reason }, true),
  receivePurchaseOrder: (purchaseOrderId: string, input: ReceivePurchaseOrderInput) => mutate<{ purchaseOrder: PurchaseOrder; receipts: GoodsReceipt[]; replayed?: boolean }>(`/purchase-orders/${purchaseOrderId}/receipts`, 'POST', input, true),
  supplierInvoices: (params: Record<string, string | number | boolean | undefined> = {}) => request<Paged<SupplierInvoice>>(`/supplier-invoices${queryString(params)}`),
  supplierInvoice: (invoiceId: string) => request<{ invoice: SupplierInvoice }>(`/supplier-invoices/${invoiceId}`),
  createSupplierInvoice: (input: CreateSupplierInvoiceInput) => mutate<{ invoice: SupplierInvoice; replayed?: boolean }>('/supplier-invoices', 'POST', input, true),

  priceLists: (params: Record<string, string | number | boolean | undefined> = {}) => request<Paged<PriceList>>(`/pricing/price-lists${queryString(params)}`),
  priceList: (priceListId: string) => request<{ priceList: PriceList }>(`/pricing/price-lists/${priceListId}`),
  createPriceList: (input: CreatePriceListInput) => mutate<{ priceList: PriceList }>('/pricing/price-lists', 'POST', input, true),
  updatePriceList: (priceListId: string, input: UpdatePriceListInput) => mutate<{ priceList: PriceList }>(`/pricing/price-lists/${priceListId}`, 'PATCH', input),
  upsertPriceLines: (priceListId: string, input: UpsertPriceLinesInput) => mutate<{ priceList: PriceList }>(`/pricing/price-lists/${priceListId}/lines`, 'PUT', input, true),
  priceHistory: (priceListId: string) => request<{ history: Array<Record<string, unknown>> }>(`/pricing/price-lists/${priceListId}/history`),
  resolvePrice: (input: PriceResolveInput) => mutate<{ price: ResolvedPrice }>('/pricing/resolve', 'POST', input),

  posProducts: (branchId: string, search = '') => request<{ products: PosProduct[] }>(`/pos/products/search${queryString({ branchId, search, pageSize: 100 })}`),
  posRegisters: (branchId?: string) => request<{ registers: PosRegister[] }>(`/pos/registers${queryString({ branchId })}`),
  createRegister: (input: CreateRegisterInput) => mutate<{ register: PosRegister }>('/pos/registers', 'POST', input, true),
  updateRegister: (registerId: string, input: { name?: string; status?: 'active' | 'inactive'; receiptPrefix?: string; receiptFooter?: string | null }) => mutate<{ register: PosRegister }>(`/pos/registers/${registerId}`, 'PATCH', input),
  registerSessions: (params: Record<string, string | number | undefined> = {}) => request<{ sessions: RegisterSession[] }>(`/pos/register-sessions${queryString(params)}`),
  registerSession: (sessionId: string) => request<{ session: RegisterSession }>(`/pos/register-sessions/${sessionId}`),
  openRegisterSession: (input: OpenRegisterSessionInput) => mutate<{ session: RegisterSession }>('/pos/register-sessions/open', 'POST', input, true),
  cashMovement: (sessionId: string, input: CashMovementInput) => mutate<{ movement: CashMovementRecord; session: RegisterSession }>(`/pos/register-sessions/${sessionId}/cash-movements`, 'POST', input, true),
  closeRegisterSession: (sessionId: string, input: CloseRegisterSessionInput) => mutate<{ session: RegisterSession }>(`/pos/register-sessions/${sessionId}/close`, 'POST', input, true),
  posSales: (params: Record<string, string | number | undefined> = {}) => request<Paged<Sale>>(`/pos/sales${queryString(params)}`),
  completeSale: (input: CompleteSaleInput) => mutate<{ sale: Sale; replayed?: boolean }>('/pos/sales', 'POST', input, true),
  paymentConfiguration: () => request<{ testMode: boolean; simulator: boolean; darajaSandbox: boolean; pesapalTerminal?: boolean }>('/payments/configuration'),
  networkConfiguration:()=>request<{hub:boolean;intervalSeconds:number}>('/network/configuration'),
  networkStores:()=>request<{stores:import('../../features/network/types').NetworkStore[]}>('/network/stores'),
  createNetworkStore:(input:{code:string;name:string})=>mutate<{store:{id:string;name:string};pairingCode:string}>('/network/stores','POST',input),
  rotateNetworkStore:(id:string)=>mutate<{pairingCode:string}>(`/network/stores/${id}/rotate`,'POST',{}),
  revokeNetworkStore:(id:string)=>mutate(`/network/stores/${id}/revoke`,'POST',{}),
  networkLinks:()=>request<{links:import('../../features/network/types').NetworkLink[]}>('/network/links'),
  connectNetworkStore:(input:{branchId:string;hubUrl:string;pairingCode:string})=>mutate<{id:string;storeName:string}>('/network/links','POST',input),
  enableNetworkLink:(id:string,enabled:boolean)=>mutate(`/network/links/${id}`,'PATCH',{enabled}),
  syncNetworkLink:(id:string)=>mutate<{synced?:boolean;busy?:boolean;error?:string}>(`/network/links/${id}/sync`,'POST',{}),
  paymentIntents: () => request<{ intents: import('../../features/pos/ElectronicPayment').PaymentIntent[] }>('/payments/intents'),
  createPaymentIntent: (input: { sale: CompleteSaleInput; provider: string; phone: string | undefined }) => mutate<{ intent: import('../../features/pos/ElectronicPayment').PaymentIntent }>('/payments/intents', 'POST', input),
  cancelUnpaidManualPayment: (id: string) => mutate<{ intent: import('../../features/pos/ElectronicPayment').PaymentIntent }>(`/payments/intents/${id}/manual-cancel`, 'POST', { noPaymentReceived: true }),
  confirmManualPayment: (id: string, input: { reference: string; amount: string; confirmed: true }) => mutate<{ intent: import('../../features/pos/ElectronicPayment').PaymentIntent }>(`/payments/intents/${id}/manual-confirm`, 'POST', input),
  simulatePayment: (id: string, outcome: string) => mutate<{ intent: import('../../features/pos/ElectronicPayment').PaymentIntent }>(`/payments/intents/${id}/simulate`, 'POST', { outcome }),
  verifyPesapalPayment: (id: string, reference: string) => mutate<{ intent: import('../../features/pos/ElectronicPayment').PaymentIntent }>(`/payments/intents/${id}/pesapal-verify`, 'POST', { reference }),
  checkDarajaPayment: (id: string) => mutate<{ intent: import('../../features/pos/ElectronicPayment').PaymentIntent }>(`/payments/intents/${id}/check`, 'POST', {}),
  sale: (saleId: string) => request<{ sale: Sale }>(`/pos/sales/${saleId}`),
  receipt: (saleId: string) => request<{ receipt: Receipt }>(`/pos/sales/${saleId}/receipt`),
  reprintReceipt: (saleId: string, reason?: string) => mutate<{ receipt: Receipt }>(`/pos/sales/${saleId}/receipt/reprint`, 'POST', { reason: reason || null }, true),
  voidSale: (saleId: string, reason: string) => mutate<{ sale: Sale }>(`/pos/sales/${saleId}/void`, 'POST', { reason }, true),
  createSaleReturn: (saleId: string, input: CreateSaleReturnInput) => mutate<{ sale: Sale; saleReturn: Sale['returns'][number] }>(`/pos/sales/${saleId}/returns`, 'POST', input, true),
  createSaleRefund: (saleId: string, input: CreateSaleRefundInput) => mutate<{ sale: Sale; refund: Sale['refunds'][number] }>(`/pos/sales/${saleId}/refunds`, 'POST', input, true),

  stockLevels: (params: Record<string, string | number | boolean | undefined>) => request<Paged<StockLevel>>(`/inventory/stock-levels${queryString(params)}`),
  stockMovements: (params: Record<string, string | number | boolean | undefined>) => request<Paged<StockMovement>>(`/inventory/movements${queryString(params)}`),
  inventoryValuation: (branchId: string) => request<{ valuation: { items: StockLevel[]; total: string; currency: string } }>(`/inventory/valuation${queryString({ branchId })}`),
  inventoryReconciliation: (branchId: string) => request<{ reconciliation: Array<Record<string, unknown>> }>(`/inventory/reconciliation${queryString({ branchId })}`),
  inTransit: (branchId: string) => request<{ inTransit: Array<Record<string, unknown>> }>(`/inventory/in-transit${queryString({ branchId })}`),
  adjustments: (branchId: string) => request<{ adjustments: StockAdjustment[] }>(`/inventory/adjustments${queryString({ branchId })}`),
  createAdjustment: (input: CreateAdjustmentInput) => mutate<{ adjustment: StockAdjustment }>('/inventory/adjustments', 'POST', input, true),
  adjustment: (adjustmentId: string) => request<{ adjustment: StockAdjustment }>(`/inventory/adjustments/${adjustmentId}`),
  stockCounts: (branchId: string) => request<{ counts: StockCount[] }>(`/inventory/counts${queryString({ branchId })}`),
  createStockCount: (input: CreateStockCountInput) => mutate<{ count: StockCount }>('/inventory/counts', 'POST', input, true),
  stockCount: (countId: string) => request<{ count: StockCount }>(`/inventory/counts/${countId}`),
  recordStockCountLines: (countId: string, input: RecordCountLinesInput) => mutate<{ count: StockCount }>(`/inventory/counts/${countId}/lines`, 'POST', input, true),
  submitStockCount: (countId: string) => mutate<{ count: StockCount }>(`/inventory/counts/${countId}/submit`, 'POST', {}, true),
  decideStockCount: (countId: string, input: DecideStockCountInput) => mutate<{ count: StockCount }>(`/inventory/counts/${countId}/decision`, 'POST', input, true),
  transfers: (branchId: string) => request<{ transfers: StockTransfer[] }>(`/inventory/transfers${queryString({ branchId })}`),
  createTransfer: (input: CreateTransferInput) => mutate<{ transfer: StockTransfer }>('/inventory/transfers', 'POST', input, true),
  transfer: (transferId: string) => request<{ transfer: StockTransfer }>(`/inventory/transfers/${transferId}`),
  dispatchTransfer: (transferId: string, input: DispatchTransferInput) => mutate<{ transfer: StockTransfer }>(`/inventory/transfers/${transferId}/dispatch`, 'POST', input, true),
  receiveTransfer: (transferId: string, input: ReceiveTransferInput) => mutate<{ transfer: StockTransfer }>(`/inventory/transfers/${transferId}/receive`, 'POST', input, true),
  cancelTransfer: (transferId: string, input: CancelTransferInput) => mutate<{ transfer: StockTransfer }>(`/inventory/transfers/${transferId}/cancel`, 'POST', input, true),

  expenseCategories: () => request<{ categories: ExpenseCategory[] }>('/expense-categories'),
  createExpenseCategory: (input: CreateExpenseCategoryInput) => mutate<{ category: ExpenseCategory }>('/expense-categories', 'POST', input, true),
  updateExpenseCategory: (categoryId: string, input: UpdateExpenseCategoryInput) => mutate<{ category: ExpenseCategory }>(`/expense-categories/${categoryId}`, 'PATCH', input),
  expenses: (params: Record<string, string | number | boolean | undefined> = {}) => request<Paged<Expense>>(`/expenses${queryString(params)}`),
  expense: (expenseId: string) => request<{ expense: Expense }>(`/expenses/${expenseId}`),
  createExpense: (input: CreateExpenseInput) => mutate<{ expense: Expense; replayed?: boolean }>('/expenses', 'POST', input, true),
  updateExpense: (expenseId: string, input: UpdateExpenseInput) => mutate<{ expense: Expense }>(`/expenses/${expenseId}`, 'PATCH', input),
  submitExpense: (expenseId: string) => mutate<{ expense: Expense }>(`/expenses/${expenseId}/submit`, 'POST', {}, true),
  approveExpense: (expenseId: string, reason: string) => mutate<{ expense: Expense }>(`/expenses/${expenseId}/approve`, 'POST', { reason }, true),
  rejectExpense: (expenseId: string, reason: string) => mutate<{ expense: Expense }>(`/expenses/${expenseId}/reject`, 'POST', { reason }, true),
  cancelExpense: (expenseId: string, reason: string) => mutate<{ expense: Expense }>(`/expenses/${expenseId}/cancel`, 'POST', { reason }, true),
  payExpense: (expenseId: string, input: PayExpenseInput) => mutate<{ expense: Expense; replayed?: boolean }>(`/expenses/${expenseId}/pay`, 'POST', input, true),
  exportExpenses: (params: Record<string, string | number | boolean | undefined> = {}) => requestText(`/expenses/export.csv${queryString(params)}`),

  operationsReport: (params: Record<string, string | number | boolean | undefined> = {}) => request<{ report: OperationsReport }>(`/reports/operations${queryString(params)}`),
  exportOperationsReport: (params: Record<string, string | number | boolean | undefined> = {}) => requestText(`/reports/operations/export.csv${queryString(params)}`)
};
import type { LibraryProduct } from './types';
