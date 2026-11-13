import { unitLabel } from '@pos/contracts';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { useAuth } from '../../app/useAuth';
import { api, ApiError } from '../../lib/api/client';
import type { GoodsReceipt, Paged, Product, PurchaseOrder, RegisterSession, Supplier, SupplierInvoice } from '../../lib/api/types';

interface ReceiptFormLine {
  receivedQty: string;
  damagedQty: string;
  rejectedQty: string;
  discrepancyReason: string;
}

function shortDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString('en-KE', { dateStyle: 'medium' }) : '—';
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (['active', 'approved', 'received', 'paid', 'posted', 'completed'].includes(status)) return 'success';
  if (['draft', 'outstanding', 'partially_received', 'partially_paid'].includes(status)) return 'warning';
  if (['cancelled', 'inactive', 'voided'].includes(status)) return 'danger';
  return 'info';
}

export function ProcurementPage() {
  const { bootstrap, hasPermission } = useAuth();
  const canManageSuppliers = hasPermission('supplier.manage');
  const canCreatePo = hasPermission('purchase.create');
  const canApprove = hasPermission('purchase.approve');
  const canReceive = hasPermission('purchase.receive');
  const canCancel = hasPermission('purchase.cancel');
  const canInvoice = hasPermission('supplier-invoice.manage');
  const canPay = hasPermission('supplier-payment.record');
  const branches = useMemo(() => bootstrap?.branches ?? [], [bootstrap?.branches]);
  const [branchId, setBranchId] = useState('');
  const [suppliers, setSuppliers] = useState<Paged<Supplier> | null>(null);
  const [orders, setOrders] = useState<Paged<PurchaseOrder> | null>(null);
  const [invoices, setInvoices] = useState<Paged<SupplierInvoice> | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [sessions, setSessions] = useState<RegisterSession[]>([]);
  const [selectedPo, setSelectedPo] = useState<PurchaseOrder | null>(null);
  const [receipts, setReceipts] = useState<GoodsReceipt[]>([]);
  const [supplierForm, setSupplierForm] = useState({ code: '', name: '', contactPerson: '', phone: '', email: '', paymentTermsDays: '0', supplierReference: '', notes: '' });
  const [orderForm, setOrderForm] = useState({ supplierId: '', expectedDeliveryDate: '', supplierReference: '', notes: '', productId: '', quantity: '1', unitCost: '' });
  const [orderLines, setOrderLines] = useState<Array<{ productId: string; quantity: string; unitCost: string }>>([]);
  const [receiptForms, setReceiptForms] = useState<Record<string, ReceiptFormLine>>({});
  const [receiptNotes, setReceiptNotes] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [invoiceForm, setInvoiceForm] = useState({ supplierId: '', purchaseOrderId: '', invoiceNumber: '', amount: '', dueDate: '', notes: '' });
  const [paymentForm, setPaymentForm] = useState({ supplierId: '', registerSessionId: '', amount: '', reason: '' });
  const [invoiceAllocations, setInvoiceAllocations] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const openSessions = useMemo(() => sessions.filter((session) => session.status === 'open' && session.branchId === branchId), [sessions, branchId]);
  const payableInvoices = useMemo(() => (invoices?.items ?? []).filter((invoice) => invoice.status !== 'paid' && invoice.status !== 'voided' && (!paymentForm.supplierId || invoice.supplierId === paymentForm.supplierId)), [invoices, paymentForm.supplierId]);

  const load = useCallback(async (nextBranch = branchId) => {
    const effectiveBranch = nextBranch || branches[0]?.id || '';
    if (!effectiveBranch) return;
    setBranchId(effectiveBranch);
    setError('');
    try {
      const [supplierResult, orderResult, invoiceResult, productResult, sessionResult] = await Promise.all([
        api.suppliers({ pageSize: 50 }),
        api.purchaseOrders({ branchId: effectiveBranch, pageSize: 30 }),
        api.supplierInvoices({ branchId: effectiveBranch, pageSize: 50 }),
        api.products({ pageSize: 100 }),
        canPay ? api.registerSessions({ branchId: effectiveBranch, pageSize: 20 }) : Promise.resolve({ sessions: [] as RegisterSession[] })
      ]);
      setSuppliers(supplierResult);
      setOrders(orderResult);
      setInvoices(invoiceResult);
      setProducts(productResult.items);
      setSessions(sessionResult.sessions);
      setPaymentForm((form) => ({ ...form, registerSessionId: form.registerSessionId || sessionResult.sessions.find((session) => session.status === 'open')?.id || '' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load procurement workspace.');
    } finally {
      setLoading(false);
    }
  }, [branchId, branches, canPay]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function selectPurchaseOrder(orderId: string) {
    try {
      const result = await api.purchaseOrder(orderId);
      setSelectedPo(result.purchaseOrder);
      setReceipts(result.receipts);
      setReceiptForms(Object.fromEntries(result.purchaseOrder.lines.map((line) => [line.id, { receivedQty: '', damagedQty: '', rejectedQty: '', discrepancyReason: '' }])));
      setInvoiceForm((form) => ({ ...form, supplierId: result.purchaseOrder.supplierId, purchaseOrderId: result.purchaseOrder.id, amount: result.purchaseOrder.total }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load purchase order.');
    }
  }

  async function createSupplier(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.createSupplier({
        code: supplierForm.code,
        name: supplierForm.name,
        contactPerson: supplierForm.contactPerson || null,
        phone: supplierForm.phone || null,
        email: supplierForm.email || null,
        supplierReference: supplierForm.supplierReference || null,
        paymentTermsDays: Number(supplierForm.paymentTermsDays || '0'),
        status: 'active',
        notes: supplierForm.notes || null
      });
      setSupplierForm({ code: '', name: '', contactPerson: '', phone: '', email: '', paymentTermsDays: '0', supplierReference: '', notes: '' });
      setMessage('Supplier created.');
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create supplier.');
    } finally {
      setSubmitting(false);
    }
  }

  function addOrderLine() {
    const product = products.find((item) => item.id === orderForm.productId);
    if (!product || orderLines.some((line) => line.productId === product.id)) return;
    setOrderLines((lines) => [...lines, { productId: product.id, quantity: orderForm.quantity, unitCost: orderForm.unitCost || product.cost }]);
    setOrderForm((form) => ({ ...form, productId: '', quantity: '1', unitCost: '' }));
  }

  async function createOrder(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await api.createPurchaseOrder({
        clientTransactionId: crypto.randomUUID(),
        branchId,
        supplierId: orderForm.supplierId,
        expectedDeliveryDate: orderForm.expectedDeliveryDate || null,
        supplierReference: orderForm.supplierReference || null,
        notes: orderForm.notes || null,
        lines: orderLines
      });
      setOrderLines([]);
      setMessage(`Purchase order ${result.purchaseOrder.poNumber} created as draft.`);
      await load(branchId);
      await selectPurchaseOrder(result.purchaseOrder.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create purchase order.');
    } finally {
      setSubmitting(false);
    }
  }

  async function transition(action: 'submit' | 'approve' | 'cancel') {
    if (!selectedPo) return;
    setSubmitting(true);
    setError('');
    try {
      const result = action === 'submit'
        ? await api.submitPurchaseOrder(selectedPo.id)
        : action === 'approve'
          ? await api.approvePurchaseOrder(selectedPo.id)
          : await api.cancelPurchaseOrder(selectedPo.id, cancelReason);
      setSelectedPo(result.purchaseOrder);
      setCancelReason('');
      setMessage(`Purchase order ${result.purchaseOrder.poNumber} ${action === 'submit' ? 'submitted' : action === 'approve' ? 'approved' : 'cancelled'}.`);
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Purchase-order transition failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function postReceipt(event: FormEvent) {
    event.preventDefault();
    if (!selectedPo) return;
    const lines = selectedPo.lines
      .map((line) => {
        const form = receiptForms[line.id] ?? { receivedQty: '', damagedQty: '', rejectedQty: '', discrepancyReason: '' };
        return {
          purchaseOrderLineId: line.id,
          receivedQty: form.receivedQty || '0',
          damagedQty: form.damagedQty || '0',
          rejectedQty: form.rejectedQty || '0',
          discrepancyReason: form.discrepancyReason || null
        };
      })
      .filter((line) => Number(line.receivedQty) > 0 || Number(line.damagedQty) > 0 || Number(line.rejectedQty) > 0);
    if (!lines.length) {
      setError('Enter at least one received, damaged or rejected quantity.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await api.receivePurchaseOrder(selectedPo.id, { clientTransactionId: crypto.randomUUID(), notes: receiptNotes || null, lines });
      setSelectedPo(result.purchaseOrder);
      setReceipts(result.receipts);
      setReceiptNotes('');
      setMessage(`Goods receipt posted; stock was increased transactionally.`);
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to post goods receipt.');
    } finally {
      setSubmitting(false);
    }
  }

  async function createInvoice(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await api.createSupplierInvoice({
        clientTransactionId: crypto.randomUUID(),
        branchId,
        supplierId: invoiceForm.supplierId,
        purchaseOrderId: invoiceForm.purchaseOrderId || null,
        invoiceNumber: invoiceForm.invoiceNumber,
        amount: invoiceForm.amount,
        dueDate: invoiceForm.dueDate || null,
        notes: invoiceForm.notes || null
      });
      setInvoiceForm({ supplierId: '', purchaseOrderId: '', invoiceNumber: '', amount: '', dueDate: '', notes: '' });
      setMessage(`Supplier invoice ${result.invoice.invoiceNumber} recorded.`);
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to record supplier invoice.');
    } finally {
      setSubmitting(false);
    }
  }

  async function paySupplier(event: FormEvent) {
    event.preventDefault();
    if (!paymentForm.supplierId) return;
    const allocations = payableInvoices
      .map((invoice) => ({ supplierInvoiceId: invoice.id, amount: invoiceAllocations[invoice.id] ?? '' }))
      .filter((line) => Number(line.amount) > 0);
    setSubmitting(true);
    setError('');
    try {
      const result = await api.recordSupplierPayment(paymentForm.supplierId, {
        clientTransactionId: crypto.randomUUID(),
        registerSessionId: paymentForm.registerSessionId,
        amount: paymentForm.amount,
        allocations,
        reason: paymentForm.reason
      });
      setInvoiceAllocations({});
      setPaymentForm((form) => ({ ...form, amount: '', reason: '' }));
      setMessage(`Supplier payment ${result.payment.paymentNumber} recorded.`);
      await load(branchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to record supplier payment.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Spinner label="Loading procurement" />;

  return (
    <div className="page-stack">
      <PageHeader title="Procurement" description="Suppliers, purchase orders, receiving, supplier invoices and cash disbursements." />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card title="Workspace" subtitle="Purchase and receipt records are scoped to the selected accessible branch.">
        <SelectField label="Branch" value={branchId} onChange={(event) => { setLoading(true); void load(event.target.value); }} required>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </SelectField>
      </Card>

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Suppliers" subtitle="Directory, payment terms and outstanding supplier balances.">
          {suppliers?.items.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Supplier</th><th>Contact</th><th>Terms</th><th>Outstanding</th><th>Status</th></tr></thead>
                <tbody>
                  {suppliers.items.map((supplier) => (
                    <tr key={supplier.id}>
                      <td><strong>{supplier.name}</strong><small className="table-subtext">{supplier.code} · {supplier.supplierReference ?? 'No reference'}</small></td>
                      <td>{supplier.contactPerson ?? '—'}<small className="table-subtext">{supplier.phone ?? supplier.email ?? ''}</small></td>
                      <td>{supplier.paymentTermsDays} days</td>
                      <td>{supplier.outstandingBalance}</td>
                      <td><Badge tone={statusTone(supplier.status)}>{supplier.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="No suppliers" description="Create the first supplier below." />}
          <form className="form-stack" onSubmit={(event) => void createSupplier(event)}>
            <div className="form-grid">
              <TextField label="Code" value={supplierForm.code} onChange={(event) => setSupplierForm({ ...supplierForm, code: event.target.value.toUpperCase() })} required />
              <TextField label="Name" value={supplierForm.name} onChange={(event) => setSupplierForm({ ...supplierForm, name: event.target.value })} required />
              <TextField label="Contact" value={supplierForm.contactPerson} onChange={(event) => setSupplierForm({ ...supplierForm, contactPerson: event.target.value })} />
              <TextField label="Phone" value={supplierForm.phone} onChange={(event) => setSupplierForm({ ...supplierForm, phone: event.target.value })} />
              <TextField label="Terms days" inputMode="numeric" value={supplierForm.paymentTermsDays} onChange={(event) => setSupplierForm({ ...supplierForm, paymentTermsDays: event.target.value })} />
              <TextField label="Supplier reference" value={supplierForm.supplierReference} onChange={(event) => setSupplierForm({ ...supplierForm, supplierReference: event.target.value })} />
            </div>
            <Button type="submit" variant="secondary" disabled={!canManageSuppliers} loading={submitting}>Create supplier</Button>
          </form>
        </Card>

        <Card title="Create purchase order" subtitle="Draft orders do not affect stock until approved goods are received.">
          <form className="form-stack" onSubmit={(event) => void createOrder(event)}>
            <div className="form-grid">
              <SelectField label="Supplier" value={orderForm.supplierId} onChange={(event) => setOrderForm({ ...orderForm, supplierId: event.target.value })} required>
                <option value="">Select supplier</option>
                {suppliers?.items.filter((supplier) => supplier.status === 'active').map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </SelectField>
              <TextField label="Expected delivery" type="date" value={orderForm.expectedDeliveryDate} onChange={(event) => setOrderForm({ ...orderForm, expectedDeliveryDate: event.target.value })} />
              <TextField label="Supplier reference" value={orderForm.supplierReference} onChange={(event) => setOrderForm({ ...orderForm, supplierReference: event.target.value })} />
              <SelectField label="Product" value={orderForm.productId} onChange={(event) => setOrderForm({ ...orderForm, productId: event.target.value })}>
                <option value="">Select product</option>
                {products.filter((product) => product.itemType === 'stocked').map((product) => <option key={product.id} value={product.id}>{product.name} ({product.sku})</option>)}
              </SelectField>
              <TextField label="Qty" inputMode="decimal" value={orderForm.quantity} onChange={(event) => setOrderForm({ ...orderForm, quantity: event.target.value })} />
              <TextField label="Unit cost" inputMode="decimal" value={orderForm.unitCost} onChange={(event) => setOrderForm({ ...orderForm, unitCost: event.target.value })} placeholder={products.find((item) => item.id === orderForm.productId)?.cost ?? '0.00'} />
            </div>
            <Button type="button" variant="secondary" onClick={addOrderLine} disabled={!orderForm.productId}>Add line</Button>
            {orderLines.length ? (
              <div className="list-stack">
                {orderLines.map((line) => {
                  const product = products.find((item) => item.id === line.productId);
                  return <div className="list-row" key={line.productId}><div><strong>{product?.name}</strong><span>{line.quantity} × {line.unitCost}</span></div><Button variant="ghost" onClick={() => setOrderLines((items) => items.filter((item) => item.productId !== line.productId))}>Remove</Button></div>;
                })}
              </div>
            ) : <EmptyState title="No order lines" description="Add stocked products and purchase costs." />}
            <TextField label="Notes" value={orderForm.notes} onChange={(event) => setOrderForm({ ...orderForm, notes: event.target.value })} />
            <Button type="submit" disabled={!canCreatePo || !orderLines.length} loading={submitting}>Create draft PO</Button>
          </form>
        </Card>
      </div>

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Purchase orders" subtitle="Select an order to submit, approve, cancel or receive.">
          {orders?.items.length ? (
            <div className="list-stack">
              {orders.items.map((order) => (
                <button className={`role-row ${selectedPo?.id === order.id ? 'role-row-selected' : ''}`} key={order.id} onClick={() => void selectPurchaseOrder(order.id)}>
                  <span><strong>{order.poNumber}</strong><small>{order.supplierName} · {order.total} KES · {shortDate(order.expectedDeliveryDate)}</small></span>
                  <Badge tone={statusTone(order.status)}>{order.status.replaceAll('_', ' ')}</Badge>
                </button>
              ))}
            </div>
          ) : <EmptyState title="No purchase orders" description="Draft and approved orders will appear here." />}
        </Card>

        <Card title={selectedPo ? `PO ${selectedPo.poNumber}` : 'Purchase order detail'} subtitle={selectedPo ? `${selectedPo.supplierName} · ${selectedPo.branchName}` : 'Select an order'} actions={selectedPo ? <Badge tone={statusTone(selectedPo.status)}>{selectedPo.status.replaceAll('_', ' ')}</Badge> : undefined}>
          {selectedPo ? (
            <div className="page-stack">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Product</th><th>Ordered</th><th>Received</th><th>Damaged</th><th>Rejected</th><th>Remaining</th><th>Cost</th></tr></thead>
                  <tbody>
                    {selectedPo.lines.map((line) => <tr key={line.id}><td>{line.productName}<small className="table-subtext">{line.productSku}</small></td><td>{line.orderedQty} {unitLabel(line.unitCode)}</td><td>{line.receivedQty}</td><td>{line.damagedQty}</td><td>{line.rejectedQty}</td><td>{line.remainingQty}</td><td>{line.unitCost}</td></tr>)}
                  </tbody>
                </table>
              </div>
              <div className="button-row">
                <Button variant="secondary" disabled={!canCreatePo || selectedPo.status !== 'draft'} loading={submitting} onClick={() => void transition('submit')}>Submit</Button>
                <Button disabled={!canApprove || selectedPo.status !== 'submitted'} loading={submitting} onClick={() => void transition('approve')}>Approve</Button>
                {canCancel ? <div className="inline-form"><TextField label="Cancel reason" value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} /><Button variant="danger" disabled={!cancelReason.trim() || !['draft', 'submitted', 'approved'].includes(selectedPo.status)} onClick={() => void transition('cancel')}>Cancel</Button></div> : null}
              </div>
              {['approved', 'partially_received'].includes(selectedPo.status) ? (
                <form className="form-stack" onSubmit={(event) => void postReceipt(event)}>
                  <h3>Goods receipt</h3>
                  {selectedPo.lines.map((line) => {
                    const form = receiptForms[line.id] ?? { receivedQty: '', damagedQty: '', rejectedQty: '', discrepancyReason: '' };
                    const update = (next: Partial<ReceiptFormLine>) => setReceiptForms({ ...receiptForms, [line.id]: { ...form, ...next } });
                    return (
                      <div className="cart-line" key={line.id}>
                        <div><strong>{line.productName}</strong><span>Remaining {line.remainingQty} {unitLabel(line.unitCode)}</span></div>
                        <div className="cart-controls">
                          <TextField label="Received" inputMode="decimal" value={form.receivedQty} onChange={(event) => update({ receivedQty: event.target.value })} />
                          <TextField label="Damaged" inputMode="decimal" value={form.damagedQty} onChange={(event) => update({ damagedQty: event.target.value })} />
                          <TextField label="Rejected" inputMode="decimal" value={form.rejectedQty} onChange={(event) => update({ rejectedQty: event.target.value })} />
                          <TextField label="Discrepancy reason" value={form.discrepancyReason} onChange={(event) => update({ discrepancyReason: event.target.value })} />
                        </div>
                      </div>
                    );
                  })}
                  <TextField label="Receipt notes" value={receiptNotes} onChange={(event) => setReceiptNotes(event.target.value)} />
                  <Button type="submit" disabled={!canReceive} loading={submitting}>Post goods receipt</Button>
                </form>
              ) : null}
              {receipts.length ? <div className="list-stack">{receipts.map((receipt) => <div className="list-row" key={receipt.id}><div><strong>{receipt.receiptNumber}</strong><span>{receipt.receivedByName ?? 'Receiver'} · {shortDate(receipt.receivedAt)}</span></div><Badge tone="success">{receipt.lines.length} lines</Badge></div>)}</div> : null}
            </div>
          ) : <EmptyState title="No order selected" description="Purchase-order lines and receipts will appear here." />}
        </Card>
      </div>

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Supplier invoices" subtitle="Accounts payable balances and payment status.">
          <form className="form-stack" onSubmit={(event) => void createInvoice(event)}>
            <div className="form-grid">
              <SelectField label="Supplier" value={invoiceForm.supplierId} onChange={(event) => setInvoiceForm({ ...invoiceForm, supplierId: event.target.value })} required>
                <option value="">Select supplier</option>
                {suppliers?.items.filter((supplier) => supplier.status === 'active').map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </SelectField>
              <SelectField label="Purchase order" value={invoiceForm.purchaseOrderId} onChange={(event) => setInvoiceForm({ ...invoiceForm, purchaseOrderId: event.target.value, supplierId: orders?.items.find((order) => order.id === event.target.value)?.supplierId ?? invoiceForm.supplierId })}>
                <option value="">No linked PO</option>
                {orders?.items.filter((order) => order.status !== 'cancelled').map((order) => <option key={order.id} value={order.id}>{order.poNumber}</option>)}
              </SelectField>
              <TextField label="Invoice number" value={invoiceForm.invoiceNumber} onChange={(event) => setInvoiceForm({ ...invoiceForm, invoiceNumber: event.target.value })} required />
              <TextField label="Amount" inputMode="decimal" value={invoiceForm.amount} onChange={(event) => setInvoiceForm({ ...invoiceForm, amount: event.target.value })} required />
              <TextField label="Due date" type="date" value={invoiceForm.dueDate} onChange={(event) => setInvoiceForm({ ...invoiceForm, dueDate: event.target.value })} />
            </div>
            <Button type="submit" variant="secondary" disabled={!canInvoice} loading={submitting}>Record invoice</Button>
          </form>
          {invoices?.items.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Invoice</th><th>Supplier</th><th>PO</th><th>Due</th><th>Total</th><th>Outstanding</th><th>Status</th></tr></thead>
                <tbody>{invoices.items.map((invoice) => <tr key={invoice.id}><td>{invoice.invoiceNumber}</td><td>{invoice.supplierName}</td><td>{invoice.poNumber ?? '—'}</td><td>{shortDate(invoice.dueDate)}</td><td>{invoice.amount}</td><td>{invoice.outstanding}</td><td><Badge tone={statusTone(invoice.status)}>{invoice.status.replaceAll('_', ' ')}</Badge></td></tr>)}</tbody>
              </table>
            </div>
          ) : <EmptyState title="No supplier invoices" description="Approved supplier bills will appear here." />}
        </Card>

        <Card title="Pay supplier" subtitle="Cash payments leave the selected open drawer and allocate to outstanding invoices.">
          <form className="form-stack" onSubmit={(event) => void paySupplier(event)}>
            <SelectField label="Supplier" value={paymentForm.supplierId} onChange={(event) => setPaymentForm({ ...paymentForm, supplierId: event.target.value })} required>
              <option value="">Select supplier</option>
              {suppliers?.items.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} · {supplier.outstandingBalance}</option>)}
            </SelectField>
            <SelectField label="Open drawer" value={paymentForm.registerSessionId} onChange={(event) => setPaymentForm({ ...paymentForm, registerSessionId: event.target.value })} required>
              <option value="">Select session</option>
              {openSessions.map((session) => <option key={session.id} value={session.id}>{session.registerName ?? session.registerCode} · expected {session.expectedCash}</option>)}
            </SelectField>
            <div className="form-grid">
              <TextField label="Cash paid" inputMode="decimal" value={paymentForm.amount} onChange={(event) => setPaymentForm({ ...paymentForm, amount: event.target.value })} required />
              <TextField label="Reason / reference" value={paymentForm.reason} onChange={(event) => setPaymentForm({ ...paymentForm, reason: event.target.value })} required />
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Invoice</th><th>Outstanding</th><th>Allocate</th></tr></thead>
                <tbody>{payableInvoices.map((invoice) => <tr key={invoice.id}><td>{invoice.invoiceNumber}<small className="table-subtext">{invoice.poNumber ?? 'No PO'}</small></td><td>{invoice.outstanding}</td><td><input aria-label={`Allocate ${invoice.invoiceNumber}`} inputMode="decimal" value={invoiceAllocations[invoice.id] ?? ''} onChange={(event) => setInvoiceAllocations({ ...invoiceAllocations, [invoice.id]: event.target.value })} /></td></tr>)}</tbody>
              </table>
            </div>
            <Button type="submit" disabled={!canPay || !paymentForm.supplierId || !payableInvoices.length} loading={submitting}>Record supplier payment</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
