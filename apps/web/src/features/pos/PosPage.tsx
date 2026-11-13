import { ReceiptPaper } from './ReceiptPaper';
import { desktopAvailable, desktopRequest } from '../../lib/desktop-bridge';
import { unitLabel } from '@pos/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { LoyaltyCheckout } from './LoyaltyCheckout';
import type { CompleteSaleInput, OfflineSaleLineSnapshot, SyncTransactionItem } from '@pos/contracts';
import { Alert, Badge, Button, Card, CheckboxField, ConfirmDialog, EmptyState, SelectField, Spinner, TextField } from '../../design-system/components';
import { useAuth } from '../../app/useAuth';
import { api, ApiError } from '../../lib/api/client';
import type { Customer, OfflineReferenceSnapshot, Paged, PosProduct, PosRegister, Receipt, RegisterSession, ResolvedPrice, Sale, SaleLine } from '../../lib/api/types';
import { getDeviceIdentity, listOutboxTransactions, queueOfflineTransaction, updateOfflineTransaction, type DeviceIdentityRecord, type OfflineTransaction } from '../../lib/offline/db';
import { currentReferenceSnapshot, decrementSnapshotStock, initializeOfflineStore, refreshReferenceSnapshot, resolveOutboxConflict, subscribeOutbox, synchronizeOutbox } from '../../lib/offline/sync';
import { useDeploymentMode, useOnlineStatus } from '../../lib/offline/connection';
import { ElectronicPayment, paymentCartSignature, type PaymentIntent } from './ElectronicPayment';
import { useSubscription } from '../licensing/subscription-context';
import { Icon } from '../../design-system/Icon';

interface CartLine {
  product: DisplayProduct;
  quantity: string;
  discountPct: string;
  price: ResolvedPrice | null;
  loading: boolean;
}

interface ReturnLineForm {
  enabled: boolean;
  quantity: string;
  disposition: 'restock' | 'damaged' | 'write_off';
}

type DisplayProduct = PosProduct & Partial<Pick<OfflineReferenceSnapshot['products'][number], 'barcode' | 'price'>>;

function minorUnits(value: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return 0n;
  const [, sign, whole, fraction = ''] = match;
  const minor = BigInt(`${whole}${fraction.padEnd(2, '0').slice(0, 2)}`);
  return sign === '-' ? -minor : minor;
}

function money(value: string | number | bigint | null | undefined): string {
  if (value === null || value === undefined) return '0.00';
  const minor = typeof value === 'bigint' ? value : minorUnits(String(value));
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  return `${negative ? '-' : ''}${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function scaledUnits(value: string, scale: number): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[3]?.length ?? 0) > scale) return 0n;
  const [, sign, whole, fraction = ''] = match;
  const scaled = BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  return sign === '-' ? -scaled : scaled;
}

function scaledDecimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const fraction = (absolute % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${(absolute / divisor).toString()}${fraction ? `.${fraction}` : ''}`;
}

function quantityIsPositive(value: string): boolean {
  return scaledUnits(value, 6) > 0n;
}

function formatQuantity(value: string): string {
  return scaledDecimal(scaledUnits(value, 6), 6);
}

function incrementQuantity(value: string): string {
  return scaledDecimal(scaledUnits(value, 6) + 1_000_000n, 6);
}

function discountedPrice(listPrice: string, discountPct: string): string {
  const list = minorUnits(listPrice);
  const discount = scaledUnits(discountPct || '0', 2);
  const final = (list * (10_000n - discount) + 5_000n) / 10_000n;
  return money(final);
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'completed' || status === 'open' || status === 'posted' || status === 'synced' || status === 'accepted') return 'success';
  if (status === 'partially_returned' || status === 'pending_sync' || status === 'failed_retryable' || status === 'syncing') return 'info';
  if (status === 'conflict') return 'warning';
  if (status === 'voided' || status === 'closed' || status === 'failed_permanent' || status === 'resolved_local') return 'danger';
  return 'warning';
}

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

function shortDate(value?: string | null): string {
  return value ? new Date(value).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

const moneyFormat = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fm(value: string | number | bigint | null | undefined): string {
  return moneyFormat.format(Number(money(value)));
}

export function PosPage() {
  const { status: subscription } = useSubscription();
  const { bootstrap, membership, hasPermission } = useAuth();
  const branches = useMemo(() => bootstrap?.branches ?? [], [bootstrap?.branches]);
  const organization = bootstrap?.organization;
  const scannerEnabled = bootstrap?.capabilities.includes('barcode_scanner') ?? false;
  const [hardwareNotice, setHardwareNotice] = useState('');
  const canDiscount = hasPermission('sales.discount');
  const canVoid = hasPermission('sales.void');
  const canReturn = hasPermission('sales.return');
  const canRefund = hasPermission('sales.refund');
  const canManageRegisters = hasPermission('registers.manage');
  const canCashMovement = hasPermission('registers.cash-movement');
  const canClose = hasPermission('registers.close');
  const canReprint = hasPermission('receipts.reprint');
  const canCredit = hasPermission('sales.credit');
  const canOverrideCredit = hasPermission('credit.override');
  const canResolveSync = hasPermission('sync.resolve-conflict');
  const online = useOnlineStatus();
  const deploymentMode=useDeploymentMode();

  const focusScanner = useCallback(() => document.getElementById('pos-scan')?.focus(), []);
  const [branchId, setBranchId] = useState('');
  const [registers, setRegisters] = useState<PosRegister[]>([]);
  const [sessions, setSessions] = useState<RegisterSession[]>([]);
  const [session, setSession] = useState<RegisterSession | null>(null);
  const [products, setProducts] = useState<DisplayProduct[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<Paged<Sale> | null>(null);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [deviceIdentity, setDeviceIdentity] = useState<DeviceIdentityRecord | null>(null);
  const [referenceSnapshot, setReferenceSnapshot] = useState<OfflineReferenceSnapshot | null>(null);
  const [outbox, setOutbox] = useState<OfflineTransaction[]>([]);
  const [selectedOutboxId, setSelectedOutboxId] = useState('');
  const [resolutionForm, setResolutionForm] = useState({ action: 'retry' as 'retry' | 'accept-current-price' | 'override-negative-stock' | 'cancel-local', reason: '' });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [loyalty,setLoyalty]=useState({points:0,value:0n,valid:true});
  const changeLoyalty=useCallback((points:number,value:bigint,valid:boolean)=>setLoyalty(current=>current.points===points && current.value===value && current.valid===valid?current:{points,value,valid}),[]);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'credit' | 'mpesa' | 'card'>('cash');
  const [electronicId, setElectronicId] = useState(() => crypto.randomUUID());
  const [electronic, setElectronic] = useState<PaymentIntent | null>(null);
  const [electronicSignature, setElectronicSignature] = useState('');
  const [paymentBusy, setPaymentBusy] = useState(false);
  const handlePaymentUpdate = useCallback((intent: PaymentIntent | null, signature: string) => {
    setElectronic(intent);
    setElectronicSignature(signature);
    if (!intent) setElectronicId(crypto.randomUUID());
  }, []);

  const [creditOverride, setCreditOverride] = useState(false);
  const [creditOverrideReason, setCreditOverrideReason] = useState('');
  const [tendered, setTendered] = useState('');
  const [openForm, setOpenForm] = useState({ registerId: '', openingFloat: '', notes: '' });
  const [registerForm, setRegisterForm] = useState({ code: '', name: '', receiptPrefix: '', receiptFooter: '' });
  const [registerEditId, setRegisterEditId] = useState('');
  const [registerEditForm, setRegisterEditForm] = useState({ name: '', status: 'active' as 'active' | 'inactive', receiptPrefix: '', receiptFooter: '' });
  const [cashForm, setCashForm] = useState({ type: 'cash_in' as 'cash_in' | 'cash_out' | 'cash_adjustment', direction: 'in' as 'in' | 'out', amount: '', reason: '' });
  const [closeForm, setCloseForm] = useState({ countedCash: '', reason: '' });
  const [voidReason, setVoidReason] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [returnLines, setReturnLines] = useState<Record<string, ReturnLineForm>>({});
  const [refundForm, setRefundForm] = useState({ saleReturnId: '', amount: '', reason: '' });
  const [view, setView] = useState<'checkout' | 'history' | 'register' | 'sync'>('checkout');
  const [submitting, setSubmitting] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  useEffect(() => {
    document.body.classList.toggle('checkout-focused', focusMode);
    const exit = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog[open], [role="dialog"]')) setFocusMode(false); };
    window.addEventListener('keydown', exit);
    return () => { document.body.classList.remove('checkout-focused'); window.removeEventListener('keydown', exit); };
  }, [focusMode]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || submitting || view !== 'checkout' || session?.status !== 'open' || document.querySelector('dialog[open], [role="dialog"]')) return;
      if (event.key === 'F8' && document.getElementById('pos-payment-station')) {
        event.preventDefault();
        const target = document.getElementById('pos-payment-station');
        target?.scrollIntoView({ block: 'start' });
        target?.focus({ preventScroll: true });
      }
      if (event.key === 'F2') { event.preventDefault(); focusScanner(); }
      if (event.key === 'F4' && document.getElementById('pos-tendered')) { event.preventDefault(); document.getElementById('pos-tendered')?.focus(); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [view, session?.status, submitting, focusScanner]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const priceRequests = useRef(new Map<string, number>());
  const checkoutLock = useRef(false);
  const pendingCheckout = useRef<{ signature: string; id: string } | null>(null);
  const searchRequest = useRef(0);
  const cartReady = cart.length > 0 && cart.every((line) => !line.loading && line.price && quantityIsPositive(line.quantity));

  const taxRateFor = useCallback((product: PosProduct) => product.taxRatePct ?? organization?.defaultTaxRatePct ?? '0', [organization?.defaultTaxRatePct]);

  const cartTotals = useMemo(() => {
    let subtotal = 0n;
    let tax = 0n;
    let total = 0n;
    for (const line of cart) {
      const unit = line.price ? minorUnits(line.price.price) : minorUnits(line.product.basePrice);
      const quantity = scaledUnits(line.quantity, 6);
      const lineTotal = (unit * quantity + 500_000n) / 1_000_000n;
      const rate = scaledUnits(taxRateFor(line.product), 2);
      const lineTax = organization?.taxPricingMode === 'exclusive'
        ? (lineTotal * rate + 5_000n) / 10_000n
        : (lineTotal * rate + (10_000n + rate) / 2n) / (10_000n + rate);
      tax += lineTax;
      total += organization?.taxPricingMode === 'exclusive' ? lineTotal + lineTax : lineTotal;
      subtotal += organization?.taxPricingMode === 'exclusive' ? lineTotal : lineTotal - lineTax;
    }
    return { subtotal, tax, total };
  }, [cart, organization?.taxPricingMode, taxRateFor]);

  const cashDue=cartTotals.total-(paymentMethod==='cash' && customerId && online?loyalty.value:0n);
  const changeDue = useMemo(() => minorUnits(tendered || '0') - cashDue, [tendered, cashDue]);
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const product of products) {
      if (product.categoryId && product.categoryName) seen.set(product.categoryId, product.categoryName);
    }
    return [...seen.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [products]);
  const visibleProducts = useMemo(
    () => (activeCategory ? products.filter((product) => product.categoryId === activeCategory) : products),
    [products, activeCategory]
  );
  const selectedCustomer = useMemo(() => customers.find((customer) => customer.id === customerId) ?? null, [customers, customerId]);
  const staleReference = useMemo(() => !referenceSnapshot || Date.parse(referenceSnapshot.staleAfter) <= Date.now(), [referenceSnapshot]);
  const expiredReference = useMemo(() => !referenceSnapshot || Date.parse(referenceSnapshot.expiresAt) <= Date.now(), [referenceSnapshot]);
  const offlineSaleAllowed = Boolean(
    deploymentMode==='standalone'
    && deviceIdentity
    && organization
    && deviceIdentity.organizationId === organization.id
    && referenceSnapshot?.currentSession
    && deviceIdentity.branchId === referenceSnapshot.currentSession.branchId
    && !expiredReference
  );
  const selectedOutbox = useMemo(() => outbox.find((record) => record.clientTransactionId === selectedOutboxId) ?? outbox.find((record) => record.state === 'conflict') ?? null, [outbox, selectedOutboxId]);
  const unresolvedOutbox = useMemo(() => outbox.filter((record) => ['pending_sync', 'syncing', 'failed_retryable', 'conflict'].includes(record.state)), [outbox]);
  const lastSyncedAt = useMemo(() => outbox.map((record) => record.syncedAt).filter(Boolean).sort().at(-1), [outbox]);

  const refreshOutbox = useCallback(async () => {
    const identity = await getDeviceIdentity();
    setOutbox(await listOutboxTransactions(identity ? { deviceId: identity.deviceId } : {}));
  }, []);

  const loadOfflineWorkspace = useCallback(async () => {
    const identity = await getDeviceIdentity();
    setDeviceIdentity(identity ?? null);
    const snapshot = identity && membership && identity.organizationId === organization?.id
      ? await currentReferenceSnapshot(identity.organizationId, identity.branchId, membership.id)
      : undefined;
    setReferenceSnapshot(snapshot ?? null);
    if (identity && snapshot) {
      setBranchId(identity.branchId);
      setRegisters(snapshot.registers);
      setSession(snapshot.currentSession);
      setProducts(snapshot.products);
      setSales({ items: [], page: 1, pageSize: 12, total: 0, totalPages: 0 });
      setCustomers([]);
    }
    await refreshOutbox();
  }, [membership, organization?.id, refreshOutbox]);

  const load = useCallback(async (nextBranch = branchId) => {
    setLoading(true);
    setError('');
    try {
      const identity = await getDeviceIdentity();
      setDeviceIdentity(identity ?? null);
      if (!online) {
        await loadOfflineWorkspace();
        return;
      }
      const effectiveBranch = nextBranch || identity?.branchId || branches[0]?.id || '';
      if (!effectiveBranch) return;
      setBranchId(effectiveBranch);
      const [registerResult, sessionResult, productResult, saleResult, customerResult] = await Promise.all([
        api.posRegisters(effectiveBranch),
        api.registerSessions({ branchId: effectiveBranch, pageSize: 20 }),
        api.posProducts(effectiveBranch, ''),
        api.posSales({ branchId: effectiveBranch, pageSize: 12 }),
        api.customers()
      ]);
      setRegisters(registerResult.registers);
      setSessions(sessionResult.sessions);
      const open = sessionResult.sessions.find((item) => item.status === 'open' && item.openedByMembershipId === membership?.id)
        ?? sessionResult.sessions.find((item) => item.status === 'open')
        ?? null;
      setSession(open);
      setOpenForm((form) => ({ ...form, registerId: form.registerId || registerResult.registers.find((item) => item.status === 'active')?.id || '' }));
      setProducts(productResult.products);
      setSales(saleResult);
      setCustomers(customerResult.customers);
      if (identity && membership && identity.branchId === effectiveBranch) {
        try {
          setReferenceSnapshot(await refreshReferenceSnapshot(identity));
        } catch {
          setReferenceSnapshot(await currentReferenceSnapshot(identity.organizationId, identity.branchId, membership.id) ?? null);
        }
      }
      await refreshOutbox();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load the POS workspace.');
    } finally {
      setLoading(false);
    }
  }, [branchId, branches, loadOfflineWorkspace, membership, online, refreshOutbox]);

  useEffect(() => {
    void initializeOfflineStore().then(refreshOutbox);
    return subscribeOutbox(() => void refreshOutbox());
  }, [refreshOutbox]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!online) return;
    void synchronizeOutbox(canResolveSync ? undefined : membership?.id).catch((err) => setError(err instanceof ApiError ? err.message : 'Synchronization failed. Queued sales remain on this device.'));
  }, [canResolveSync, membership?.id, online]);

  useEffect(() => {
    if (session?.status === 'open' && view === 'checkout') focusScanner();
  }, [session?.status, view, focusScanner]);

  const searchTerm = search.trim();
  useEffect(()=>{
    if(!online || !branchId || view!=='checkout' || submitting || !['server','terminal','cloud'].includes(deploymentMode)) return;
    let disposed=false,busy=false;
    const refresh=async()=>{
      if(busy || document.hidden) return;
      busy=true;const version=searchRequest.current;
      try {const result=await api.posProducts(branchId,searchTerm);if(!disposed && version===searchRequest.current)setProducts(result.products);} catch {/* Connection status handles outages without interrupting the cart. */} finally {busy=false;}
    };
    const timer=window.setInterval(()=>void refresh(),5000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[online,branchId,view,submitting,deploymentMode,searchTerm]);
  useEffect(() => {
    const handle = setTimeout(() => {
      if (branchId && !loading) void searchProducts(searchTerm);
    }, 260);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, branchId]);

  async function refreshSession(sessionId: string) {
    const result = await api.registerSession(sessionId);
    setSession(result.session);
    setSessions((items) => items.map((item) => item.id === result.session.id ? result.session : item));
    return result.session;
  }

  async function searchProducts(term: string) {
    if (!branchId) return;
    const request = ++searchRequest.current;
    setSearching(true);
    try {
      if (!online && referenceSnapshot) {
        const lowered = term.toLowerCase();
        const matches = referenceSnapshot.products.filter((product) =>
          product.name.toLowerCase().includes(lowered) || product.sku.toLowerCase().includes(lowered) || product.barcode?.toLowerCase() === lowered
        );
        setProducts(matches);
        if (!matches.length) setError('No cached product matched that barcode, SKU or name.');
        return;
      }
      const result = await api.posProducts(branchId, term);
      if (request !== searchRequest.current) return;
      setProducts(result.products);
      if (!result.products.length) setError('No active product matched that barcode, SKU or name.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Product search failed.');
    } finally {
      if (request === searchRequest.current) setSearching(false);
    }
  }

  async function updateLinePrice(productId: string, quantity: string, discountPct: string, nextCustomer = customerId) {
    const version = (priceRequests.current.get(productId) ?? 0) + 1;
    priceRequests.current.set(productId, version);
    setCart((lines) => lines.map((line) => line.product.id === productId ? { ...line, loading: true } : line));
    try {
      if (!online) {
        const product = products.find((item) => item.id === productId) ?? cart.find((item) => item.product.id === productId)?.product;
        const cached = product?.price;
        if (!product || !cached) throw new Error('This product is unavailable in the cached offline catalogue.');
        setCart((lines) => lines.map((line) => line.product.id === productId ? {
          ...line,
          loading: false,
          price: {
            ...cached,
            discountPct: discountPct || null,
            price: discountedPrice(cached.listPrice, discountPct)
          }
        } : line));
        return;
      }
      const result = await api.resolvePrice({
        productId,
        branchId,
        quantity,
        customerId: nextCustomer || null,
        discountPct: discountPct || undefined
      });
      if (priceRequests.current.get(productId) !== version) return;
      setCart((lines) => lines.map((line) => line.product.id === productId ? { ...line, price: result.price, loading: false } : line));
    } catch (err) {
      if (priceRequests.current.get(productId) !== version) return;
      setCart((lines) => lines.map((line) => line.product.id === productId ? { ...line, price: null, loading: false } : line));
      setError(err instanceof ApiError ? err.message : 'Unable to resolve the current server price.');
    }
  }

  async function addProduct(product: DisplayProduct) {
    if (submitting || checkoutLock.current) return;
    setError('');
    const existingQuantity = cart.find((line) => line.product.id === product.id)?.quantity ?? '0';
    let nextQuantity = incrementQuantity(existingQuantity);
    // Measured goods can have less than one base unit left (e.g. 0.5 L milk).
    // Add the remaining positive quantity so it can still be sold and edited.
    if (product.itemType === 'stocked' && scaledUnits(product.onHandQty, 6) > scaledUnits(existingQuantity, 6) && scaledUnits(nextQuantity, 6) > scaledUnits(product.onHandQty, 6)) {
      nextQuantity = scaledDecimal(scaledUnits(product.onHandQty, 6), 6);
    }
    if (product.itemType === 'stocked' && scaledUnits(nextQuantity, 6) > scaledUnits(product.onHandQty, 6)) {
      setError(`Only ${formatQuantity(product.onHandQty)} ${unitLabel(product.unitCode)} of ${product.name} available.`);
      return;
    }
    if (!online && expiredReference) {
      setError('The cached product catalogue has expired. Reconnect and synchronize before selling offline.');
      return;
    }
    setReceipt(null);
    setMessage('');
    if (cart.some((line) => line.product.id === product.id)) {
      const existing = cart.find((line) => line.product.id === product.id)!;
      setCart((lines) => lines.map((line) => line.product.id === product.id ? { ...line, quantity: nextQuantity } : line));
      await updateLinePrice(product.id, nextQuantity, existing.discountPct);
    } else {
      setCart((lines) => [...lines, { product, quantity: nextQuantity, discountPct: '', price: null, loading: true }]);
      await updateLinePrice(product.id, nextQuantity, '');
    }
    setSearch('');
    focusScanner();
  }

  async function submitScan(event: FormEvent) {
    event.preventDefault();
    const term = search.trim();
    if (!term) return;
    setError('');
    const exact = products.find((product) =>
      product.sku.toLowerCase() === term.toLowerCase()
      || product.barcode?.toLowerCase() === term.toLowerCase()
    );
    if (exact) {
      await addProduct(exact);
      return;
    }
    if (!online) {
      const matches = (referenceSnapshot?.products ?? []).filter((product) => product.name.toLowerCase() === term.toLowerCase());
      if (matches.length === 1) await addProduct(matches[0]!);
      else setError(matches.length ? 'Several cached products match. Tap the correct product.' : 'Unknown cached barcode, SKU or product name.');
      return;
    }
    setSearching(true);
    try {
      const result = await api.posProducts(branchId, term);
      setProducts(result.products);
      const match = result.products.find((product) => product.sku.toLowerCase() === term.toLowerCase() || product.barcode?.toLowerCase() === term.toLowerCase())
        ?? (result.products.length === 1 ? result.products[0] : undefined);
      if (match) await addProduct(match);
      else setError(result.products.length ? 'Several products match. Tap the correct product to add it.' : 'Unknown barcode, SKU or product name.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Barcode lookup failed.');
    } finally {
      setSearching(false);
    }
  }

  function updateQuantity(productId: string, quantity: string) {
    if (submitting || checkoutLock.current) return;
    const product = cart.find((line) => line.product.id === productId)?.product;
    if (product?.itemType === 'stocked' && scaledUnits(quantity, 6) > scaledUnits(product.onHandQty, 6)) {
      setError(`Only ${formatQuantity(product.onHandQty)} ${unitLabel(product.unitCode)} available.`);
      return;
    }
    priceRequests.current.set(productId, (priceRequests.current.get(productId) ?? 0) + 1);
    setCart((lines) => lines.map((line) => line.product.id === productId ? { ...line, quantity } : line));
    if (quantityIsPositive(quantity)) void updateLinePrice(productId, quantity, cart.find((line) => line.product.id === productId)?.discountPct ?? '');
  }

  function updateDiscount(productId: string, discountPct: string) {
    setCart((lines) => lines.map((line) => line.product.id === productId ? { ...line, discountPct } : line));
    const line = cart.find((item) => item.product.id === productId);
    if (line) void updateLinePrice(productId, line.quantity, discountPct);
  }

  async function openSession(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await api.openRegisterSession({
        registerId: openForm.registerId,
        openingFloat: openForm.openingFloat || '0',
        notes: openForm.notes || null
      });
      setSession(result.session);
      setMessage(`Register ${result.session.registerCode ?? ''} opened.`);
      setView('checkout');
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to open register.');
    } finally {
      setSubmitting(false);
    }
  }

  async function createRegister(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.createRegister({
        branchId,
        code: registerForm.code,
        status: 'active',
        name: registerForm.name,
        receiptPrefix: registerForm.receiptPrefix || undefined,
        receiptFooter: registerForm.receiptFooter || null
      });
      setRegisterForm({ code: '', name: '', receiptPrefix: '', receiptFooter: '' });
      setMessage('Register created.');
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create register.');
    } finally {
      setSubmitting(false);
    }
  }

  async function updateRegister(event: FormEvent) {
    event.preventDefault();
    if (!registerEditId) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.updateRegister(registerEditId, {
        name: registerEditForm.name,
        status: registerEditForm.status,
        receiptPrefix: registerEditForm.receiptPrefix,
        receiptFooter: registerEditForm.receiptFooter || null
      });
      setRegisters((items) => items.map((item) => item.id === result.register.id ? result.register : item));
      setMessage(`Register ${result.register.code} updated.`);
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update register.');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCashMovement(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.cashMovement(session.id, {
        type: cashForm.type,
        direction: cashForm.type === 'cash_adjustment' ? cashForm.direction : undefined,
        amount: cashForm.amount,
        reason: cashForm.reason
      });
      setSession(result.session);
      setCashForm({ type: 'cash_in', direction: 'in', amount: '', reason: '' });
      setMessage('Cash movement recorded.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to record cash movement.');
    } finally {
      setSubmitting(false);
    }
  }

  async function closeSession(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.closeRegisterSession(session.id, { countedCash: closeForm.countedCash, reason: closeForm.reason || null });
      setSession(result.session);
      setMessage(`Session closed. Variance ${money(result.session.cashVariance)} ${organization?.currencyCode ?? 'KES'}.`);
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to close register.');
    } finally {
      setSubmitting(false);
    }
  }

  async function queueOfflineCheckout(sale: CompleteSaleInput) {
    if (!subscription || !subscription.canWrite || (subscription.graceEndsAt && Date.now() >= Date.parse(subscription.graceEndsAt))) {
      throw new Error('An active locally verified subscription is required for offline checkout. Open Subscription to activate or renew.');
    }
    if (!deviceIdentity || !referenceSnapshot || !session) {
      throw new Error('This browser does not have the registered device and cached register session required for offline checkout.');
    }
    const occurredAt = new Date().toISOString();
    let subtotal = 0n;
    let discountTotal = 0n;
    let tax = 0n;
    let total = 0n;
    const lines: OfflineSaleLineSnapshot[] = cart.map((line) => {
      const price = line.price;
      if (!price) throw new Error(`The cached price for ${line.product.name} is unavailable.`);
      const quantity = scaledUnits(line.quantity, 6);
      const listLine = (minorUnits(price.listPrice) * quantity + 500_000n) / 1_000_000n;
      const net = (minorUnits(price.price) * quantity + 500_000n) / 1_000_000n;
      const rate = scaledUnits(taxRateFor(line.product), 2);
      const lineTax = organization?.taxPricingMode === 'exclusive'
        ? (net * rate + 5_000n) / 10_000n
        : (net * rate + (10_000n + rate) / 2n) / (10_000n + rate);
      const lineSubtotal = organization?.taxPricingMode === 'exclusive' ? net : net - lineTax;
      const lineTotal = organization?.taxPricingMode === 'exclusive' ? net + lineTax : net;
      subtotal += lineSubtotal;
      discountTotal += listLine - net;
      tax += lineTax;
      total += lineTotal;
      return {
        productId: line.product.id,
        productSku: line.product.sku,
        productName: line.product.name,
        unitId: line.product.baseUnitId,
        unitCode: line.product.unitCode,
        quantity: line.quantity,
        baseQuantity: line.quantity,
        listPrice: price.listPrice,
        unitPrice: price.price,
        discountPct: line.discountPct || '0',
        discount: money(listLine - net),
        subtotal: money(lineSubtotal),
        taxRatePct: taxRateFor(line.product),
        tax: money(lineTax),
        total: money(lineTotal),
        onHandQty: line.product.onHandQty,
        priceSource: price.source,
        priceListId: price.priceListId ?? null,
        priceLineId: price.priceLineId ?? null
      };
    });
    const tenderedMinor = minorUnits(sale.payment.amountTendered ?? '0');
    const item: SyncTransactionItem = {
      clientTransactionId: sale.clientTransactionId,
      entityType: 'pos.sale',
      occurredAt,
      branchId,
      deviceId: deviceIdentity.deviceId,
      registerSessionId: session.id,
      cashierMembershipId: membership!.id,
      payload: {
        sale,
        snapshot: {
          schemaVersion: 1,
          capturedAt: occurredAt,
          referenceRevision: referenceSnapshot.revision,
          currencyCode: organization?.currencyCode ?? 'KES',
          taxPricingMode: organization?.taxPricingMode ?? 'inclusive',
          lines,
          totals: {
            subtotal: money(subtotal),
            discountTotal: money(discountTotal),
            taxTotal: money(tax),
            total: money(total),
            amountTendered: money(tenderedMinor),
            change: money(tenderedMinor - total)
          }
        }
      }
    };
    const record = await queueOfflineTransaction({
      schemaVersion: 2,
      clientTransactionId: sale.clientTransactionId,
      entityType: 'pos.sale',
      payload: item,
      state: 'pending_sync',
      localDisplay: {
        localReference: `LOCAL-${sale.clientTransactionId.slice(0, 8).toUpperCase()}`,
        branchName: referenceSnapshot.branch.name,
        registerCode: session.registerCode ?? 'REGISTER',
        registerName: session.registerName ?? 'Register',
        cashierName: membership?.displayName ?? referenceSnapshot.cashierName,
        currencyCode: organization?.currencyCode ?? 'KES',
        subtotal: money(subtotal),
        discountTotal: money(discountTotal),
        taxTotal: money(tax),
        total: money(total),
        amountTendered: money(tenderedMinor),
        change: money(tenderedMinor - total),
        lines
      },
      createdAt: occurredAt,
      updatedAt: occurredAt,
      queuedAt: occurredAt,
      attempts: 0
    });
    const nextSnapshot = await decrementSnapshotStock(referenceSnapshot, cart.map((line) => ({ productId: line.product.id, quantity: Number(line.quantity) })));
    setReferenceSnapshot(nextSnapshot);
    if (nextSnapshot) setProducts(nextSnapshot.products);
    setCart([]);
    setTendered('');
    await refreshOutbox();
    return record;
  }

  const electronicSale: CompleteSaleInput | null = session && (paymentMethod === 'mpesa' || paymentMethod === 'card') ? {
    clientTransactionId: electronicId, registerSessionId: session.id, customerId: customerId || null,
    priceListId: null, deviceId: deviceIdentity && deviceIdentity.organizationId === organization?.id && deviceIdentity.branchId === session.branchId ? deviceIdentity.deviceId : null,
    allowNegative: false, negativeReason: null, allowCreditOverride: false, creditOverrideReason: null,
    items: cart.map(line => ({ productId: line.product.id, quantity: line.quantity, discountPct: line.discountPct || undefined })),
    payment: { method: paymentMethod, intentId: electronicId }
  } : null;
  const electronicReady = Boolean(online && electronicSale && electronic?.status === 'paid' && electronic.method === paymentMethod
    && !electronic.saleId && electronicSignature === paymentCartSignature(electronicSale));

  async function checkout() {
    if (!session || !cartReady || checkoutLock.current || paymentBusy || (electronicSale && !electronicReady)) return;
    if (!online && (paymentMethod !== 'cash' || !offlineSaleAllowed)) {
      setError(!offlineSaleAllowed
        ? 'Offline sales require a registered device, an open cached register session and unexpired reference data.'
        : 'Customer credit is online-only because credit limits require authoritative server validation.');
      return;
    }
    checkoutLock.current = true;
    setSubmitting(true);
    setError('');
    setMessage('');
    const signature = JSON.stringify({ session: session.id, customerId, loyaltyPoints:loyalty.points, paymentMethod, tendered, creditOverride, creditOverrideReason, items: cart.map((line) => [line.product.id, line.quantity, line.discountPct]) });
    if (pendingCheckout.current && pendingCheckout.current.signature !== signature) {
      checkoutLock.current = false;
      setSubmitting(false);
      setError('A previous checkout has an uncertain result. Restore its cart and payment details and retry, or check sales history before starting another sale.');
      return;
    }
    pendingCheckout.current ??= { signature, id: crypto.randomUUID() };
    const clientTransactionId = paymentMethod === 'mpesa' || paymentMethod === 'card' ? electronicId : pendingCheckout.current.id;
    let committed = false;
    const saleInput: CompleteSaleInput = {
      clientTransactionId,
      registerSessionId: session.id,
      customerId: online ? customerId || null : null,
      loyaltyPointsToRedeem: online && paymentMethod==='cash' && customerId ? loyalty.points : 0,
      priceListId: null,
      deviceId: deviceIdentity && deviceIdentity.organizationId === organization?.id && deviceIdentity.branchId === session.branchId ? deviceIdentity.deviceId : null,
      allowNegative: false,
      negativeReason: null,
      allowCreditOverride: paymentMethod === 'credit' ? creditOverride : false,
      creditOverrideReason: paymentMethod === 'credit' && creditOverride ? creditOverrideReason : null,
      items: cart.map((line) => ({
        productId: line.product.id,
        quantity: line.quantity,
        discountPct: line.discountPct || undefined
      })),
      payment: paymentMethod === 'cash'
        ? { method: 'cash', amountTendered: tendered || money(cashDue) }
        : paymentMethod === 'credit' ? { method: 'credit' } : { method: paymentMethod, intentId: electronic?.id }
    };
    try {
      if (!online) {
        const record = await queueOfflineCheckout(saleInput);
        pendingCheckout.current = null;
        setSelectedOutboxId(record.clientTransactionId);
        setMessage(`Saved on this device — pending sync. Local reference ${record.localDisplay?.localReference ?? record.clientTransactionId}.`);
        setView('sync');
        return;
      }
      const result = await api.completeSale(saleInput);
      committed = true;
      setHardwareNotice('');
      const paid = result.sale.payments[0];
      const drawerEligible = paid?.status === 'completed' && Number(paid.amount) > 0 && (paid.method === 'cash' || (organization?.cashDrawerPolicy === 'paid' && ['mpesa', 'card'].includes(paid.method) && paid.verification === 'manual'));
      if (bootstrap?.capabilities.includes('cash_drawer') && drawerEligible) {
        if (!desktopAvailable()) setHardwareNotice('Sale recorded. Automatic cash drawer requires the installed TillSawa Windows app and this till\'s printer setup. Do not repeat payment.');
        else void desktopRequest('afterSale', { saleId: result.sale.id }).catch(error => setHardwareNotice(`Sale recorded. ${error instanceof Error ? error.message : 'The drawer could not be confirmed.'} Ask the owner to check the drawer; do not repeat the sale or payment.`));
      }
      pendingCheckout.current = null;
      setSelectedSale(result.sale);
      setReceipt(null);
      setCart([]);
      setTendered('');
      setCustomerId('');
      setLoyalty({points:0,value:0n,valid:true});
      setPaymentMethod('cash');
      setElectronic(null);
      setElectronicSignature('');
      setElectronicId(crypto.randomUUID());
      setCreditOverride(false);
      setCreditOverrideReason('');
      setMessage(paymentMethod === 'cash'
        ? `Sale ${result.sale.receiptNumber} completed. Change due ${money(result.sale.payments[0]?.change)} ${result.sale.currency}.`
        : paymentMethod === 'credit' ? `Credit sale ${result.sale.receiptNumber} posted to ${result.sale.customerName ?? 'the customer account'}.` : `Sale ${result.sale.receiptNumber} completed with confirmed ${paymentMethod} payment.`);
      await Promise.all([refreshSession(session.id), api.posProducts(branchId, '').then((result) => setProducts(result.products)), api.posSales({ branchId, pageSize: 12 }).then(setSales)]);
      await selectSale(result.sale);
    } catch (err) {
      if (committed) {
        setError('Sale completed. Receipt or stock refresh failed; check sales history before retrying.');
        return;
      }
      const transportFailure = !(err instanceof ApiError) || err.status === 408 || err.status === 429 || err.status >= 500;
      if (transportFailure && saleInput.payment.method === 'cash' && !saleInput.loyaltyPointsToRedeem && offlineSaleAllowed) {
        try {
          const record = await queueOfflineCheckout(saleInput);
          pendingCheckout.current = null;
          setSelectedOutboxId(record.clientTransactionId);
          setMessage(`Connection failed. The sale was saved on this device — pending sync (${record.localDisplay?.localReference ?? record.clientTransactionId}).`);
          setView('sync');
          return;
        } catch (queueError) {
          setError(queueError instanceof Error ? `Checkout failed and the sale could not be saved locally: ${queueError.message}` : 'Checkout failed and the sale could not be saved locally.');
          return;
        }
      }
      if (!transportFailure) pendingCheckout.current = null;
      setError(err instanceof ApiError ? err.message : 'The checkout result could not be confirmed. Retry the same sale to safely check its result.');
    } finally {
      checkoutLock.current = false;
      setSubmitting(false);
      focusScanner();
    }
  }

  async function syncNow() {
    setSubmitting(true);
    setError('');
    try {
      const summary = await synchronizeOutbox(canResolveSync ? undefined : membership?.id);
      setMessage(`Synchronization checked ${summary.synced + summary.unresolved} queued records. ${summary.unresolved} still need attention.`);
      await refreshOutbox();
      if (online) await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Synchronization failed. Queued sales remain stored on this device.');
      await refreshOutbox();
    } finally {
      setSubmitting(false);
    }
  }

  async function retryLocalTransaction(record: OfflineTransaction) {
    setSubmitting(true);
    setError('');
    try {
      await updateOfflineTransaction(record.clientTransactionId, (current) => ({
        ...current,
        state: 'pending_sync',
        nextAttemptAt: new Date().toISOString(),
        syncingStartedAt: undefined
      }));
      setMessage('The transaction was requeued for synchronization.');
      await refreshOutbox();
      if (online) await syncNow();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSyncResolution(event: FormEvent) {
    event.preventDefault();
    if (!selectedOutbox || !resolutionForm.reason.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await resolveOutboxConflict(selectedOutbox, resolutionForm);
      setResolutionForm({ action: 'retry', reason: '' });
      setMessage(result.status === 'resolved'
        ? 'The local transaction was resolved without posting a server sale.'
        : 'The transaction was authorized for synchronization retry.');
      await refreshOutbox();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to resolve the synchronization transaction.');
    } finally {
      setSubmitting(false);
    }
  }

  async function selectSale(sale: Sale) {
    try {
      const [saleResult, receiptResult] = await Promise.all([api.sale(sale.id), api.receipt(sale.id)]);
      setSelectedSale(saleResult.sale);
      setReceipt(receiptResult.receipt);
      setReturnReason('');
      setVoidReason('');
      setRefundForm({ saleReturnId: saleResult.sale.returns.at(-1)?.id ?? '', amount: saleResult.sale.returns.at(-1)?.refundableTotal ?? '', reason: '' });
      setReturnLines(Object.fromEntries(saleResult.sale.lines.map((line) => [line.id, { enabled: false, quantity: line.returnableQty, disposition: 'restock' as const }])));
      setView('history');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load sale detail.');
    }
  }

  async function reprint() {
    if (!selectedSale) return;
    try {
      const result = await api.reprintReceipt(selectedSale.id, 'Authorized customer copy');
      setReceipt(result.receipt);
      setMessage('Reprint authorized. Opening browser print dialog.');
      window.print();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to authorize receipt reprint.');
    }
  }

  async function submitVoid() {
    if (!selectedSale || !voidReason.trim()) return;
    setSubmitting(true);
    try {
      const result = await api.voidSale(selectedSale.id, voidReason);
      setSelectedSale(result.sale);
      setMessage(`Sale ${result.sale.receiptNumber} voided.`);
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to void sale.');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReturn() {
    if (!selectedSale || !returnReason.trim()) return;
    const lines = selectedSale.lines
      .map((line) => ({ line, form: returnLines[line.id] }))
      .filter((item): item is { line: SaleLine; form: ReturnLineForm } => Boolean(item.form?.enabled))
      .map((item) => ({ saleLineId: item.line.id, quantity: item.form.quantity, disposition: item.form.disposition }));
    if (!lines.length) {
      setError('Select at least one sale line to return.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.createSaleReturn(selectedSale.id, { reason: returnReason, lines });
      setSelectedSale(result.sale);
      setRefundForm({ saleReturnId: result.saleReturn.id, amount: result.saleReturn.refundableTotal, reason: returnReason });
      setMessage(`Return ${result.saleReturn.returnNumber} posted.`);
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message: 'Unable to post return.');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRefund() {
    if (!selectedSale || !session || !refundForm.amount || !refundForm.reason.trim()) return;
    setSubmitting(true);
    try {
      const result = await api.createSaleRefund(selectedSale.id, {
        registerSessionId: session.id,
        saleReturnId: refundForm.saleReturnId || null,
        amount: refundForm.amount,
        reason: refundForm.reason
      });
      setSelectedSale(result.sale);
      setSession(await refreshSession(result.refund.registerSessionId));
      setMessage(`Cash refund ${result.refund.amount} ${selectedSale.currency} recorded.`);
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to issue refund.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Spinner label="Loading POS workspace" />;

  return (
    <div className="page-stack pos-page">
      <div className="pos-workspace-heading"><div><span className="workspace-eyebrow">SALES WORKSPACE</span><h1 className="pos-page-heading">Point of sale</h1></div><div className="pos-heading-actions"><span className="pos-currency-label">{organization?.currencyCode ?? 'KES'} <span>· {organization?.taxPricingMode ?? 'inclusive'} tax</span></span><Button variant="secondary" aria-pressed={focusMode} onClick={() => setFocusMode(!focusMode)}>{focusMode ? 'Exit focus' : 'Focus checkout'}</Button></div></div>
      <div className="pos-statusbar">
        <div className="pos-status-context">
          <strong>{session?.branchName ?? branches.find((branch) => branch.id === branchId)?.name ?? organization?.displayName ?? '—'}</strong>
          <span>{session?.registerName ?? 'No open register'}</span>
          <span>{membership?.displayName ?? '—'}</span>
          <span>{deploymentMode==='terminal'?'Connected till':deploymentMode==='server'?'Shared server':deploymentMode==='standalone'?'Standalone':deploymentMode==='cloud'?'Cloud workspace':'Checking connection'}</span>
          <span>Last sync {shortDate(lastSyncedAt)}</span>
        </div>
        <div className="pos-status-badges">
          <span className="pos-status-item"><i className={`status-dot ${session?.status === 'open' ? '' : 'warning'}`} aria-hidden="true" />{session?.status === 'open' ? `${session.registerCode ?? 'Till'} open` : 'Register closed'}</span>
          <span className="pos-status-item"><i className={`status-dot ${unresolvedOutbox.length ? 'warning' : ''}`} aria-hidden="true" />{unresolvedOutbox.length ? `${unresolvedOutbox.length} pending sync` : 'Synced'}</span>
        </div>
      </div>
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {hardwareNotice ? <Alert tone="warning">{hardwareNotice}</Alert> : null}
      {!online ? (
        <Alert tone="warning">
          {deploymentMode==='standalone'?'Offline mode: cash sales can be saved on this registered device when cached reference data is valid. Credit, returns, refunds, expenses and register changes remain online-only. Stock and prices are a snapshot and may be rejected or sent to conflict review when synchronization resumes.':deploymentMode==='cloud'?'Cloud checkout is paused. Reconnect to the internet before retrying the same sale.':'Main server unavailable. Checkout is paused to keep shared stock accurate. Check the server and local network, then retry the same sale.'}
        </Alert>
      ) : null}
      {referenceSnapshot && staleReference ? <Alert tone="warning">Cached products and prices were captured at {shortDate(referenceSnapshot.capturedAt)} and are stale. Synchronize before relying on them.</Alert> : null}
      {deploymentMode === 'standalone' && bootstrap?.featureFlags.offlineSales === false ? <Alert tone="info">Offline sale queueing is controlled by the organization feature policy; the local outbox remains durable.</Alert> : null}

      <div className="pos-tabs" role="tablist" aria-label="POS sections">
        <button className={view === 'checkout' ? 'active' : ''} onClick={() => { setReceipt(null); setMessage(''); setView('checkout'); }}>Checkout</button>
        <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>Sales history</button>
        <button className={view === 'sync' ? 'active' : ''} onClick={() => setView('sync')}>Sync queue {unresolvedOutbox.length ? `(${unresolvedOutbox.length})` : ''}</button>
        <button className={view === 'register' ? 'active' : ''} onClick={() => setView('register')}>Register</button>
      </div>

      {view === 'checkout' ? (
        session?.status === 'open' ? (
          <fieldset className="pos-workspace" disabled={submitting || paymentBusy}>
            {cart.length > 0 ? <button type="button" className="btn btn-primary pos-mobile-cart" onClick={() => {
              const target = document.getElementById('pos-current-sale');
              target?.scrollIntoView({ block: 'start' });
              target?.focus({ preventScroll: true });
            }}>View sale · {organization?.currencyCode ?? 'KES'} {fm(cartTotals.total)}</button> : null}
            <section className="pos-browse">
              <div className="pos-browse-heading"><div><Icon name="catalogue" /><strong>Product selection</strong></div><span>{visibleProducts.length} products shown</span></div>
              <form className="pos-scanbar" onSubmit={(event) => void submitScan(event)}>
                <span className="pos-scan-symbol"><Icon name={scannerEnabled ? 'scan' : 'catalogue'} /></span>
                <input
                  id="pos-scan"
                  className="pos-scan-input"
                  type="text"
                  value={search}
                  onChange={(event) => { setSearch(event.target.value); setError(''); }}
                  placeholder={scannerEnabled ? 'Scan barcode or type product name, brand or SKU' : 'Search product name, brand or SKU'}
                  autoComplete="off"
                  aria-label="Barcode, SKU or product search"
                />
                <Button type="submit" variant="secondary" loading={searching}>Add</Button>
              </form>
              <div className="pos-keyboard-hints"><button type="button" onClick={focusScanner}><kbd>F2</kbd> {scannerEnabled ? 'Scan / search' : 'Product search'}</button><button type="button" disabled={paymentMethod !== 'cash'} onClick={() => document.getElementById('pos-tendered')?.focus()}><kbd>F4</kbd> Cash received</button><button type="button" onClick={() => { const target = document.getElementById('pos-payment-station'); target?.scrollIntoView({ block: 'start' }); target?.focus({ preventScroll: true }); }}><kbd>F8</kbd> Payment</button><span>{scannerEnabled ? 'Barcode scanner enabled · keyboard / HID input' : 'Manual product selection · no scanner required'}</span></div>
              {categories.length > 1 ? (
                <div className="pos-categories" role="group" aria-label="Category filters">
                  <button type="button" className={!activeCategory ? 'active' : ''} onClick={() => setActiveCategory('')}>All</button>
                  {categories.map(([id, name]) => (
                    <button type="button" key={id} className={activeCategory === id ? 'active' : ''} onClick={() => setActiveCategory(activeCategory === id ? '' : id)}>{name}</button>
                  ))}
                </div>
              ) : null}
              {searching ? <Spinner label="Searching products" /> : visibleProducts.length ? (
                <div className="pos-product-grid">
                  {visibleProducts.map((product) => {
                    const out = product.itemType === 'stocked' && !quantityIsPositive(product.onHandQty);
                    const lowStock = !out && product.itemType === 'stocked' && product.minStockLevel !== undefined
                      && scaledUnits(product.minStockLevel ?? '0', 6) > 0n && scaledUnits(product.onHandQty, 6) <= scaledUnits(product.minStockLevel ?? '0', 6);
                    const inCart = cart.find((line) => line.product.id === product.id);
                    return (
                      <button
                        type="button"
                        className={`pos-product ${inCart ? 'pos-product-incart' : ''} ${out ? 'pos-product-out' : ''}`}
                        key={product.id}
                        onClick={() => void addProduct(product)}
                        disabled={out || submitting || Boolean(inCart?.loading)}
                      >
                        {product.imageUrl ? <img className="pos-product-image" src={product.imageUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <span className="pos-product-category">{product.categoryName ?? (product.itemType === 'service' ? 'Service' : 'Product')}</span>}
                        <span className="pos-product-name">{product.name}</span>
                        <span className="pos-product-meta">{product.sku} · {unitLabel(product.unitCode)}{product.brand ? ` · ${product.brand}` : ''}</span>
                        <span className="pos-product-footer">
                          <strong>{organization?.currencyCode ?? 'KES'} {fm(product.basePrice)}</strong>
                          <span className={`pos-product-stock ${out ? 'out' : lowStock ? 'low' : ''}`}>
                            {product.itemType !== 'stocked' ? product.itemType : out ? 'Out of stock' : lowStock ? `Low · ${formatQuantity(product.onHandQty)}` : `${formatQuantity(product.onHandQty)} in stock`}
                          </span>
                        </span>
                        {inCart ? <span className="pos-product-qty">{inCart.quantity} in cart</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : <EmptyState title="No products found" description={scannerEnabled ? 'Scan a barcode or search by name, brand or SKU.' : 'Search by product name, brand or SKU.'} />}
            </section>

            <aside id="pos-current-sale" tabIndex={-1} className="pos-cart-panel" aria-label="Current sale">
              <div className="pos-cart-header">
                <div>
                  <h2><Icon name="bag" /> Current sale</h2>
                  <span>{cart.length ? `${cart.length} item${cart.length === 1 ? '' : 's'}` : 'No items yet'}</span>
                </div>
                {cart.length ? <Button variant="ghost" onClick={() => setConfirmClear(true)}>Clear</Button> : null}
              </div>
              <SelectField label="Customer" value={customerId} disabled={!online} onChange={(event) => {
                setCustomerId(event.target.value);
                setLoyalty({points:0,value:0n,valid:true});
                for (const line of cart) void updateLinePrice(line.product.id, line.quantity, line.discountPct, event.target.value);
              }}>
                <option value="">Walk-in customer</option>
                {customers.filter((customer) => customer.status === 'active').map((customer) => <option key={customer.id} value={customer.id}>{customer.code} — {customer.name}</option>)}
              </SelectField>
                <LoyaltyCheckout customerId={customerId} available={online} cash={paymentMethod==='cash'} total={cartTotals.total} onChange={changeLoyalty}/>
              <div className="pos-cart-lines">
                {cart.length ? cart.map((line) => {
                  const unit = line.price ? minorUnits(line.price.price) : minorUnits(line.product.basePrice);
                  const lineTotal = (unit * scaledUnits(line.quantity, 6) + 500_000n) / 1_000_000n;
                  return (
                    <div className="pos-cart-line" key={line.product.id}>
                      <div className="pos-cart-line-info">
                        <strong>{line.product.name}</strong>
                        <span>{line.price ? `${fm(line.price.price)} ${organization?.currencyCode ?? 'KES'}` : 'Resolving price…'}{line.price?.discountPct ? ` · ${line.price.discountPct}% off` : ''}</span>
                        {canDiscount ? (
                          <label className="pos-line-discount">
                            Disc %
                            <input inputMode="decimal" value={line.discountPct} onChange={(event) => updateDiscount(line.product.id, event.target.value)} aria-label={`Discount percent for ${line.product.name}`} />
                          </label>
                        ) : null}
                      </div>
                      <div className="pos-cart-line-actions">
                        <div className="pos-qty-stepper">
                          <button type="button" aria-label="Decrease quantity" disabled={!(scaledUnits(line.quantity, 6) > 1_000_000n)} onClick={() => updateQuantity(line.product.id, scaledDecimal(scaledUnits(line.quantity, 6) - 1_000_000n, 6))}>−</button>
                          <input inputMode="decimal" value={line.quantity} onChange={(event) => updateQuantity(line.product.id, event.target.value)} aria-label={`Quantity for ${line.product.name}`} />
                          <button type="button" aria-label="Increase quantity" onClick={() => updateQuantity(line.product.id, incrementQuantity(line.quantity))}>+</button>
                        </div>
                        <strong className="pos-line-total">{line.price ? fm(lineTotal) : '…'}</strong>
                        <button type="button" className="pos-line-remove" aria-label={`Remove ${line.product.name}`} onClick={() => setCart((lines) => lines.filter((item) => item.product.id !== line.product.id))}>×</button>
                      </div>
                    </div>
                  );
                }) : (
                  <div className="pos-cart-empty">
                    <strong>Cart is empty</strong>
                    <p>{scannerEnabled ? 'Scan a barcode or tap a product to start the sale.' : 'Search or tap a product to start the sale.'}</p>
                  </div>
                )}
              </div>
              <div className="pos-cart-footer">
                <dl className="pos-totals">
                  <div><dt>Subtotal</dt><dd>{organization?.currencyCode ?? 'KES'} {fm(cartTotals.subtotal)}</dd></div>
                  <div><dt>Tax ({organization?.taxPricingMode ?? 'inclusive'})</dt><dd>{organization?.currencyCode ?? 'KES'} {fm(cartTotals.tax)}</dd></div>
                  <div className="pos-total-payable"><dt>Total payable</dt><dd>{organization?.currencyCode ?? 'KES'} {fm(cartTotals.total)}</dd></div>
                  {paymentMethod==='cash' && loyalty.value>0n && customerId?<><div><dt>Paid with points</dt><dd>{fm(loyalty.value)}</dd></div><div><dt>Cash to collect</dt><dd>{fm(cashDue)}</dd></div></>:null}
                </dl>
                <section className="pos-payment-station" id="pos-payment-station" tabIndex={-1} aria-labelledby="pos-payment-title">
                <div className="pos-payment-heading"><h3 id="pos-payment-title">Take payment</h3><span>F8</span></div>
                <div className="pos-pay-methods pos-payment-tiles" role="group" aria-label="Payment method">
                  {([
                    ['cash', 'Cash', 'Enter amount received', 'cash'],
                    ['mpesa', 'M-Pesa', 'Mobile money', 'mobile-payment'],
                    ['card', 'Card', 'Bank terminal', 'subscription'],
                    ['credit', 'Credit', 'Customer account', 'credit']
                  ] as const).filter(([method]) => method === 'cash' || (online && (method !== 'credit' || canCredit))).map(([method, label, hint, icon]) => (
                    <button key={method} type="button" aria-label={label} aria-pressed={paymentMethod === method} disabled={Boolean(electronic) || paymentBusy} className={paymentMethod === method ? 'active' : ''} onClick={() => setPaymentMethod(method)}>
                      <Icon name={icon} /><span><strong>{label}</strong><small>{hint}</small></span>
                    </button>
                  ))}
                </div>
                {paymentMethod === 'cash' ? (
                  <div className="pos-tender">
                    <label className="field-label" htmlFor="pos-tendered">Cash tendered</label>
                    <input
                      id="pos-tendered"
                      className="pos-tendered-input"
                      inputMode="decimal"
                      value={tendered}
                      onChange={(event) => setTendered(event.target.value)}
                      placeholder={fm(cashDue)}
                    />
                    <div className="pos-tender-chips">
                      <button type="button" onClick={() => setTendered(money(cashDue))}>Exact</button>
                      {[500, 1000, 2000, 5000].filter((amount) => minorUnits(String(amount)) >= cartTotals.total && money(cartTotals.total) !== money(minorUnits(String(amount)))).slice(0, 3).map((amount) => (
                        <button type="button" key={amount} onClick={() => setTendered(String(amount))}>{amount}</button>
                      ))}
                    </div>
                    {tendered.trim() !== '' ? (
                      <div className={`pos-change ${changeDue < 0n ? 'short' : ''}`}>
                        {changeDue < 0n ? 'Short by' : 'Change due'} <strong>{organization?.currencyCode ?? 'KES'} {fm(changeDue < 0n ? -changeDue : changeDue)}</strong>
                      </div>
                    ) : null}
                  </div>
                ) : paymentMethod === 'credit' ? (
                  <div className="pos-credit-block">
                    {selectedCustomer ? (
                      <Alert tone={selectedCustomer.creditStatus === 'active' ? 'info' : 'warning'}>
                        {selectedCustomer.name}: {selectedCustomer.creditStatus} credit · limit {selectedCustomer.creditLimit} · outstanding {selectedCustomer.outstandingBalance}
                      </Alert>
                    ) : <Alert tone="warning">Select an active customer before posting a credit sale.</Alert>}
                    {canOverrideCredit ? (
                      <>
                        <CheckboxField label="Authorize limit override" checked={creditOverride} onChange={setCreditOverride} />
                        {creditOverride ? <TextField label="Override reason" value={creditOverrideReason} onChange={(event) => setCreditOverrideReason(event.target.value)} required /> : null}
                      </>
                    ) : null}
                  </div>
                ) : electronicSale ? <ElectronicPayment key={electronicId + paymentMethod} sale={electronicSale} intent={electronic} bound={electronicSignature} currency={organization?.currencyCode ?? 'KES'} ready={cartReady && online} online={online} onBusy={setPaymentBusy} onReady={handlePaymentUpdate} /> : null}
                </section>
                {!online ? <Alert tone="info">Offline cash is collected locally now, but the sale and drawer movement are provisional until accepted by the server.</Alert> : null}
                <Button
                  className="checkout-button"
                  loading={submitting}
                  disabled={!cartReady || (!online && !offlineSaleAllowed) || (paymentMethod === 'cash' ? !loyalty.valid || cashDue<0n || minorUnits(tendered || money(cashDue)) < cashDue : paymentMethod === 'credit' ? !selectedCustomer || selectedCustomer.creditStatus !== 'active' || (creditOverride && !creditOverrideReason.trim()) : !electronicReady)}
                  onClick={() => void checkout()}
                >
                  {!online
                    ? deploymentMode==='standalone'?`Save offline sale · ${organization?.currencyCode ?? 'KES'} ${fm(cartTotals.total)}`:'Waiting for connection'
                    : paymentMethod === 'cash'
                      ? `Charge ${organization?.currencyCode ?? 'KES'} ${fm(cashDue)}`
                      : paymentMethod === 'credit' ? `Post credit · ${organization?.currencyCode ?? 'KES'} ${fm(cartTotals.total)}` : `Complete ${paymentMethod === 'mpesa' ? 'M-Pesa' : 'card'} sale`}
                </Button>
              </div>
            </aside>
          </fieldset>
        ) : !online ? (
          <Card title="Register unavailable offline" subtitle="Register sessions can only be opened while online.">
            <Alert tone="warning">Open the register before losing connectivity. Offline checkout can only use the cached open session captured for this device and cashier.</Alert>
          </Card>
        ) : (
          <div className="dashboard-grid dashboard-grid-wide">
            <Card title="Open register" subtitle="A sale cannot be completed until an authorized session is open.">
              {registers.some((register) => register.status === 'active') ? (
                <form className="form-stack" onSubmit={(event) => void openSession(event)}>
                  <SelectField label="Register" value={openForm.registerId} onChange={(event) => setOpenForm({ ...openForm, registerId: event.target.value })} required>
                    <option value="">Select register</option>
                    {registers.filter((register) => register.status === 'active').map((register) => <option key={register.id} value={register.id}>{register.code} — {register.name}</option>)}
                  </SelectField>
                  <TextField label="Opening float" inputMode="decimal" value={openForm.openingFloat} onChange={(event) => setOpenForm({ ...openForm, openingFloat: event.target.value })} required />
                  <TextField label="Opening notes" value={openForm.notes} onChange={(event) => setOpenForm({ ...openForm, notes: event.target.value })} />
                  <Button type="submit" loading={submitting}>Open register</Button>
                </form>
              ) : <EmptyState title="No active register" description="A manager must create a register before checkout can start." />}
            </Card>
            {canManageRegisters ? (
              <Card title="Create register" subtitle="Registers are scoped to the selected branch.">
                <form className="form-stack" onSubmit={(event) => void createRegister(event)}>
                  <TextField label="Code" value={registerForm.code} onChange={(event) => setRegisterForm({ ...registerForm, code: event.target.value.toUpperCase() })} required />
                  <TextField label="Name" value={registerForm.name} onChange={(event) => setRegisterForm({ ...registerForm, name: event.target.value })} required />
                  <TextField label="Receipt prefix" value={registerForm.receiptPrefix} onChange={(event) => setRegisterForm({ ...registerForm, receiptPrefix: event.target.value.toUpperCase() })} hint="Defaults to the register code." />
                  <TextField label="Receipt footer" value={registerForm.receiptFooter} onChange={(event) => setRegisterForm({ ...registerForm, receiptFooter: event.target.value })} />
                  <Button type="submit" variant="secondary" loading={submitting}>Create register</Button>
                </form>
              </Card>
            ) : null}
          </div>
        )
      ) : null}

      {view === 'history' ? (
        <div className="dashboard-grid dashboard-grid-wide">
          <Card title="Sales history" subtitle="Receipts are reconstructed from immutable line snapshots.">
            {sales?.items.length ? (
              <div className="list-stack">
                {sales.items.map((sale) => (
                  <button className={`role-row ${selectedSale?.id === sale.id ? 'role-row-selected' : ''}`} key={sale.id} onClick={() => void selectSale(sale)}>
                    <span><strong>{sale.receiptNumber}</strong><small>{shortDate(sale.soldAt)} · {sale.cashierName ?? 'Cashier'} · {sale.total} {sale.currency}</small></span>
                    <Badge tone={statusTone(sale.status)}>{sale.status.replaceAll('_', ' ')}</Badge>
                  </button>
                ))}
              </div>
            ) : <EmptyState title="No sales" description="Completed sales will appear here." />}
          </Card>

          <div className="page-stack">
            {selectedSale ? (
              <>
                <Card title={`Sale ${selectedSale.receiptNumber}`} subtitle={`${selectedSale.branchName ?? ''} · ${selectedSale.registerName ?? ''} · ${shortDate(selectedSale.soldAt)}`} actions={<Badge tone={statusTone(selectedSale.status)}>{selectedSale.status.replaceAll('_', ' ')}</Badge>}>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Discount</th><th>Tax</th><th>Total</th><th>Returnable</th></tr></thead>
                      <tbody>
                        {selectedSale.lines.map((line: SaleLine) => (
                          <tr key={line.id}>
                            <td>{line.productName}<small className="table-subtext">{line.productSku}</small></td>
                            <td>{line.quantity}</td>
                            <td>{line.unitPrice}</td>
                            <td>{line.discount}</td>
                            <td>{line.tax}</td>
                            <td>{line.total}</td>
                            <td>{line.returnableQty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <dl className="detail-list">
                    <div><dt>Subtotal</dt><dd>{selectedSale.subtotal}</dd></div>
                    <div><dt>Tax</dt><dd>{selectedSale.taxTotal}</dd></div>
                    <div><dt>Total</dt><dd>{selectedSale.total} {selectedSale.currency}</dd></div>
                    <div><dt>Payment</dt><dd>{selectedSale.payments[0]?.method ?? '—'} · {selectedSale.payments[0]?.status ?? '—'}</dd></div>
                    <div><dt>Tendered / change</dt><dd>{selectedSale.payments[0]?.method === 'cash' ? `${selectedSale.payments[0]?.amountTendered ?? '—'} / ${selectedSale.payments[0]?.change ?? '—'}` : 'Not applicable'}</dd></div>
                    {selectedSale.creditDueDate ? <div><dt>Credit due</dt><dd>{selectedSale.creditDueDate}</dd></div> : null}
                  </dl>
                  <div className="button-row">
                    <Button variant="secondary" onClick={() => window.print()}>Print receipt</Button>
                    {canReprint ? <Button variant="ghost" onClick={() => void reprint()}>Authorized reprint</Button> : null}
                  </div>
                </Card>

                {selectedSale.payments.some(payment => payment.method === 'mpesa' || payment.method === 'card') ? <Alert tone="info">Electronic payments require reconciliation with the merchant account or terminal. Automatic electronic refunds and voids are unavailable in this test edition.</Alert> : null}
                {canVoid && !selectedSale.payments.some(payment => payment.method === 'mpesa' || payment.method === 'card') && selectedSale.status === 'completed' && session?.status === 'open' ? (
                  <Card title="Void sale" subtitle="Reverses the original payment effect and stock through auditable compensating records.">
                    <div className="inline-form">
                      <TextField label="Void reason" value={voidReason} onChange={(event) => setVoidReason(event.target.value)} required />
                      <Button variant="danger" loading={submitting} onClick={() => void submitVoid()}>Void sale</Button>
                    </div>
                  </Card>
                ) : null}

                {canReturn && selectedSale.status !== 'voided' ? (
                  <Card title="Return items" subtitle="Returned quantity cannot exceed each line's remaining returnable quantity.">
                    <div className="cart-list">
                      {selectedSale.lines.map((line) => {
                        const form = returnLines[line.id];
                        return (
                          <div className="cart-line" key={line.id}>
                            <CheckboxField label={`${line.productName} (${line.returnableQty} returnable)`} checked={Boolean(form?.enabled)} onChange={(checked) => setReturnLines({ ...returnLines, [line.id]: { ...form, enabled: checked, quantity: form?.quantity ?? line.returnableQty, disposition: form?.disposition ?? 'restock' } })} />
                            {form?.enabled ? (
                              <div className="cart-controls">
                                <TextField label="Return qty" inputMode="decimal" value={form.quantity} onChange={(event) => setReturnLines({ ...returnLines, [line.id]: { ...form, quantity: event.target.value } })} />
                                <SelectField label="Disposition" value={form.disposition} onChange={(event) => setReturnLines({ ...returnLines, [line.id]: { ...form, disposition: event.target.value as ReturnLineForm['disposition'] } })}>
                                  <option value="restock">Restock</option>
                                  <option value="damaged">Damaged</option>
                                  <option value="write_off">Write-off</option>
                                </SelectField>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    <TextField label="Return reason" value={returnReason} onChange={(event) => setReturnReason(event.target.value)} required />
                    <Button variant="secondary" loading={submitting} onClick={() => void submitReturn()}>Post return</Button>
                  </Card>
                ) : null}

                {canRefund && selectedSale.payments[0]?.method === 'cash' && selectedSale.status !== 'voided' && session?.status === 'open' ? (
                  <Card title="Cash refund" subtitle="The API enforces the refundable limit and records a separate refund transaction.">
                    <div className="form-grid">
                      <SelectField label="Linked return" value={refundForm.saleReturnId} onChange={(event) => setRefundForm({ ...refundForm, saleReturnId: event.target.value })}>
                        <option value="">Refund against original payment</option>
                        {selectedSale.returns.map((item) => <option key={item.id} value={item.id}>{item.returnNumber} — {item.refundableTotal}</option>)}
                      </SelectField>
                      <TextField label="Refund amount" inputMode="decimal" value={refundForm.amount} onChange={(event) => setRefundForm({ ...refundForm, amount: event.target.value })} required />
                    </div>
                    <TextField label="Refund reason" value={refundForm.reason} onChange={(event) => setRefundForm({ ...refundForm, reason: event.target.value })} required />
                    <Button variant="secondary" loading={submitting} onClick={() => void submitRefund()}>Issue cash refund</Button>
                  </Card>
                ) : null}
              </>
            ) : <Card><EmptyState title="Select a sale" description="Choose a receipt from history to inspect, print, void, return or refund." /></Card>}
          </div>
        </div>
      ) : null}

      {view === 'sync' ? (
        <div className="dashboard-grid dashboard-grid-wide">
          <Card
            title="Synchronization queue"
            subtitle={`Device ${deviceIdentity?.deviceName ?? deviceIdentity?.deviceId?.slice(0, 8) ?? 'not registered'} · Branch ${referenceSnapshot?.branch.name ?? session?.branchName ?? '—'} · Last confirmed ${shortDate(lastSyncedAt)}`}
            actions={<Button variant="secondary" loading={submitting} disabled={!online || !unresolvedOutbox.length} onClick={() => void syncNow()}>Sync now</Button>}
          >
            {outbox.length ? (
              <div className="list-stack">
                {outbox.map((record) => (
                  <button className={`role-row ${selectedOutbox?.clientTransactionId === record.clientTransactionId ? 'role-row-selected' : ''}`} key={record.clientTransactionId} onClick={() => setSelectedOutboxId(record.clientTransactionId)}>
                    <span>
                      <strong>{record.localDisplay?.localReference ?? record.clientTransactionId.slice(0, 8)}</strong>
                      <small>
                        {shortDate(record.createdAt)} · {record.localDisplay?.total ?? '—'} {record.localDisplay?.currencyCode ?? organization?.currencyCode ?? 'KES'}
                        {record.serverReceiptNumber ? ` · Receipt ${record.serverReceiptNumber}` : ''}
                      </small>
                    </span>
                    <Badge tone={statusTone(record.state)}>{statusLabel(record.state)}</Badge>
                  </button>
                ))}
              </div>
            ) : <EmptyState title="Queue is empty" description="Offline transactions saved on this device will remain visible here until they reach a final state." />}
          </Card>

          <div className="page-stack">
            {selectedOutbox ? (
              <>
                <Card
                  title={`Local transaction ${selectedOutbox.localDisplay?.localReference ?? selectedOutbox.clientTransactionId.slice(0, 8)}`}
                  subtitle={`${selectedOutbox.localDisplay?.branchName ?? selectedOutbox.payload.branchId} · ${selectedOutbox.localDisplay?.registerName ?? selectedOutbox.payload.registerSessionId} · ${shortDate(selectedOutbox.createdAt)}`}
                  actions={<Badge tone={statusTone(selectedOutbox.state)}>{statusLabel(selectedOutbox.state)}</Badge>}
                >
                  {selectedOutbox.state !== 'synced' ? <Alert tone="info">Provisional local record — not a server-confirmed receipt.</Alert> : null}
                  {selectedOutbox.lastError ? <Alert tone={selectedOutbox.state === 'conflict' ? 'warning' : 'danger'}>{selectedOutbox.lastError.code}: {selectedOutbox.lastError.message}</Alert> : null}
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Discount</th><th>Tax</th><th>Total</th><th>Saved stock</th></tr></thead>
                      <tbody>
                        {(selectedOutbox.localDisplay?.lines ?? []).map((line) => (
                          <tr key={line.productId}>
                            <td>{line.productName}<small className="table-subtext">{line.productSku}</small></td>
                            <td>{line.quantity}</td>
                            <td>{line.unitPrice}</td>
                            <td>{line.discount}</td>
                            <td>{line.tax}</td>
                            <td>{line.total}</td>
                            <td>{line.onHandQty ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <dl className="detail-list">
                    <div><dt>Client transaction</dt><dd>{selectedOutbox.clientTransactionId}</dd></div>
                    <div><dt>Subtotal</dt><dd>{selectedOutbox.localDisplay?.subtotal ?? '—'}</dd></div>
                    <div><dt>Tax</dt><dd>{selectedOutbox.localDisplay?.taxTotal ?? '—'}</dd></div>
                    <div><dt>Total</dt><dd>{selectedOutbox.localDisplay?.total ?? '—'} {selectedOutbox.localDisplay?.currencyCode ?? organization?.currencyCode ?? 'KES'}</dd></div>
                    <div><dt>Tendered / change</dt><dd>{selectedOutbox.localDisplay?.amountTendered ?? '—'} / {selectedOutbox.localDisplay?.change ?? '—'}</dd></div>
                    <div><dt>Attempts</dt><dd>{selectedOutbox.attempts}</dd></div>
                    {selectedOutbox.nextAttemptAt ? <div><dt>Next retry</dt><dd>{shortDate(selectedOutbox.nextAttemptAt)}</dd></div> : null}
                    {selectedOutbox.serverReceiptNumber ? <div><dt>Authoritative receipt</dt><dd>{selectedOutbox.serverReceiptNumber}</dd></div> : null}
                    {selectedOutbox.resolutionAction ? <div><dt>Resolution</dt><dd>{statusLabel(selectedOutbox.resolutionAction)}</dd></div> : null}
                  </dl>
                  <div className="button-row">
                    <Button variant="secondary" onClick={() => window.print()}>Print provisional record</Button>
                    {selectedOutbox.serverSaleId ? <Button variant="ghost" onClick={() => void api.sale(selectedOutbox.serverSaleId!).then((result) => selectSale(result.sale))}>Open server sale</Button> : null}
                    {canResolveSync && ['failed_retryable', 'failed_permanent'].includes(selectedOutbox.state) ? (
                      <Button variant="ghost" disabled={!online || submitting} onClick={() => void retryLocalTransaction(selectedOutbox)}>Requeue after device/session fix</Button>
                    ) : null}
                    {canResolveSync && selectedOutbox.state === 'conflict' && !selectedOutbox.syncTransactionId ? (
                      <Button variant="ghost" disabled={!online || submitting} onClick={() => void retryLocalTransaction(selectedOutbox)}>Retry after device/session fix</Button>
                    ) : null}
                  </div>
                </Card>

                {selectedOutbox.state === 'conflict' ? (
                  <Card title="Resolve synchronization conflict" subtitle={canResolveSync ? 'A manager can approve a retry under an explicit policy action or resolve it locally.' : 'A user with sync conflict permission must resolve this transaction.'}>
                    {canResolveSync ? (
                      <form className="form-stack" onSubmit={(event) => void submitSyncResolution(event)}>
                        <SelectField label="Resolution action" value={resolutionForm.action} onChange={(event) => setResolutionForm({ ...resolutionForm, action: event.target.value as typeof resolutionForm.action })}>
                          <option value="retry">Retry unchanged</option>
                          <option value="accept-current-price">Accept current server price and retry</option>
                          <option value="override-negative-stock">Authorize negative stock and retry</option>
                          <option value="cancel-local">Resolve locally without posting sale</option>
                        </SelectField>
                        <TextField label="Resolution reason" value={resolutionForm.reason} onChange={(event) => setResolutionForm({ ...resolutionForm, reason: event.target.value })} required />
                        <Button type="submit" variant="secondary" loading={submitting}>Apply authorized resolution</Button>
                      </form>
                    ) : <EmptyState title="Manager review required" description={selectedOutbox.lastError?.message ?? 'This transaction needs authorized resolution before it can synchronize.'} />}
                  </Card>
                ) : null}
              </>
            ) : <Card><EmptyState title="Select a transaction" description="Choose a queued transaction to inspect what was saved locally and why it needs attention." /></Card>}
          </div>
        </div>
      ) : null}

      {view === 'register' ? (
        <div className="dashboard-grid dashboard-grid-wide">
          <Card title="Sessions" subtitle="Expected cash combines opening float, cash sales, refunds and drawer movements.">
            <SelectField label="Branch" value={branchId} onChange={(event) => void load(event.target.value)}>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </SelectField>
            {sessions.length ? (
              <div className="list-stack">
                {sessions.map((item) => (
                  <button className={`role-row ${session?.id === item.id ? 'role-row-selected' : ''}`} key={item.id} onClick={() => void refreshSession(item.id)}>
                    <span><strong>{item.registerCode} · {shortDate(item.openedAt)}</strong><small>{item.openedByName ?? 'Operator'} · Expected {item.expectedCash ?? '—'} · Variance {item.cashVariance ?? '—'}</small></span>
                    <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                  </button>
                ))}
              </div>
            ) : <EmptyState title="No sessions" description="Open a register to start a shift." />}
          </Card>

          {canManageRegisters ? (
            <Card title="Register configuration" subtitle="Update the selected branch register without changing historical sales.">
              <form className="form-stack" onSubmit={(event) => void updateRegister(event)}>
                <SelectField label="Register to edit" value={registerEditId} onChange={(event) => {
                  const selected = registers.find((register) => register.id === event.target.value);
                  setRegisterEditId(event.target.value);
                  setRegisterEditForm({
                    name: selected?.name ?? '',
                    status: selected?.status ?? 'active',
                    receiptPrefix: selected?.receiptPrefix ?? '',
                    receiptFooter: selected?.receiptFooter ?? ''
                  });
                }} required>
                  <option value="">Select register</option>
                  {registers.map((register) => <option key={register.id} value={register.id}>{register.code} — {register.name}</option>)}
                </SelectField>
                <TextField label="Display name" value={registerEditForm.name} onChange={(event) => setRegisterEditForm({ ...registerEditForm, name: event.target.value })} required />
                <SelectField label="Status" value={registerEditForm.status} onChange={(event) => setRegisterEditForm({ ...registerEditForm, status: event.target.value as 'active' | 'inactive' })}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </SelectField>
                <TextField label="Receipt prefix" value={registerEditForm.receiptPrefix} onChange={(event) => setRegisterEditForm({ ...registerEditForm, receiptPrefix: event.target.value.toUpperCase() })} required />
                <TextField label="Receipt footer" value={registerEditForm.receiptFooter} onChange={(event) => setRegisterEditForm({ ...registerEditForm, receiptFooter: event.target.value })} />
                <Button type="submit" variant="secondary" loading={submitting} disabled={!registerEditId}>Save register</Button>
              </form>
            </Card>
          ) : null}

          <div className="page-stack">
            {session ? (
              <Card title={`${session.registerName ?? 'Register'} session`} subtitle={`Opened ${shortDate(session.openedAt)} by ${session.openedByName ?? 'operator'}`} actions={<Badge tone={statusTone(session.status)}>{session.status}</Badge>}>
                <dl className="detail-list">
                  <div><dt>Opening float</dt><dd>{session.openingFloat}</dd></div>
                  <div><dt>Expected cash</dt><dd>{session.expectedCash ?? '—'}</dd></div>
                  <div><dt>Counted cash</dt><dd>{session.countedCash ?? '—'}</dd></div>
                  <div><dt>Variance</dt><dd>{session.cashVariance ?? '—'}</dd></div>
                </dl>
                {session.cashMovements?.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Time</th><th>Type</th><th>Direction</th><th>Amount</th><th>Reason</th></tr></thead>
                      <tbody>{session.cashMovements.map((movement) => <tr key={movement.id}><td>{shortDate(movement.createdAt)}</td><td>{movement.type}</td><td>{movement.direction}</td><td>{movement.amount}</td><td>{movement.reason}</td></tr>)}</tbody>
                    </table>
                  </div>
                ) : <EmptyState title="No drawer movements" description="Cash-in, cash-out, refunds and void adjustments appear here." />}
              </Card>
            ) : null}

            {session?.status === 'open' && canCashMovement ? (
              <Card title="Cash movement" subtitle="Record drawer cash-in, cash-out or an authorized cash adjustment with a mandatory reason.">
                <form className="inline-form" onSubmit={(event) => void submitCashMovement(event)}>
                  <SelectField label="Type" value={cashForm.type} onChange={(event) => setCashForm({ ...cashForm, type: event.target.value as typeof cashForm.type })}>
                    <option value="cash_in">Cash in</option>
                    <option value="cash_out">Cash out</option>
                    <option value="cash_adjustment">Cash adjustment</option>
                  </SelectField>
                  {cashForm.type === 'cash_adjustment' ? (
                    <SelectField label="Direction" value={cashForm.direction} onChange={(event) => setCashForm({ ...cashForm, direction: event.target.value as 'in' | 'out' })}>
                      <option value="in">Increase drawer cash</option>
                      <option value="out">Decrease drawer cash</option>
                    </SelectField>
                  ) : null}
                  <TextField label="Amount" inputMode="decimal" value={cashForm.amount} onChange={(event) => setCashForm({ ...cashForm, amount: event.target.value })} required />
                  <TextField label="Reason" value={cashForm.reason} onChange={(event) => setCashForm({ ...cashForm, reason: event.target.value })} required />
                  <Button type="submit" variant="secondary" loading={submitting}>Record</Button>
                </form>
              </Card>
            ) : null}

            {session?.status === 'open' && canClose ? (
              <Card title="Close and reconcile" subtitle="Count physical cash and record the variance against expected cash.">
                <form className="form-stack" onSubmit={(event) => void closeSession(event)}>
                  <TextField label="Counted cash" inputMode="decimal" value={closeForm.countedCash} onChange={(event) => setCloseForm({ ...closeForm, countedCash: event.target.value })} placeholder={session.expectedCash ?? '0.00'} required />
                  <TextField label="Close reason" value={closeForm.reason} onChange={(event) => setCloseForm({ ...closeForm, reason: event.target.value })} />
                  <Button type="submit" variant="danger" loading={submitting}>Close session</Button>
                </form>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}

      {receipt && (view !== 'checkout' || cart.length === 0) ? (
        <section className="receipt-panel" aria-label="Receipt preview">
          <div className="button-row no-print">
            <Button variant="secondary" onClick={() => window.print()}>Print receipt</Button>
            <Button variant="secondary" onClick={() => { setReceipt(null); setMessage(''); setView('checkout'); focusScanner(); }}>Next customer</Button>
          </div>
          <ReceiptPaper receipt={receipt} />
        </section>
      ) : null}

      <ConfirmDialog
        open={confirmClear}
        title="Clear cart?"
        description="This removes all selected products before checkout. Completed sales are not affected."
        confirmLabel="Clear cart"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setCart([]);
          setTendered('');
          setConfirmClear(false);
          focusScanner();
        }}
      />
    </div>
  );
}
