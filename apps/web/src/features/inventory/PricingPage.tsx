import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CheckboxField, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Customer, Paged, PriceList, Product, ResolvedPrice } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { InventoryNav } from './InventoryNav';

const initialListForm = {
  code: '',
  name: '',
  kind: 'retail',
  branchId: '',
  customerId: '',
  maxDiscountPct: '',
  minPrice: '',
  isDefault: false
};

export function PricingPage() {
  const { bootstrap, hasPermission } = useAuth();
  const canManage = hasPermission('price-list.manage');
  const branches = useMemo(() => bootstrap?.branches ?? [], [bootstrap?.branches]);
  const [lists, setLists] = useState<Paged<PriceList> | null>(null);
  const [selected, setSelected] = useState<PriceList | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  const [resolved, setResolved] = useState<ResolvedPrice | null>(null);
  const [listForm, setListForm] = useState(initialListForm);
  const [lineForm, setLineForm] = useState({ productId: '', minQty: '0', price: '' });
  const [resolveForm, setResolveForm] = useState({ productId: '', branchId: '', customerId: '', priceListId: '', quantity: '1', discountPct: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadLists = useCallback(async () => {
    const result = await api.priceLists({ pageSize: 50 });
    setLists(result);
    if (!selected && result.items[0]) {
      const detail = await api.priceList(result.items[0].id);
      setSelected(detail.priceList);
      const historyResult = await api.priceHistory(result.items[0].id).catch(() => ({ history: [] }));
      setHistory(historyResult.history);
    }
  }, [selected]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [productResult, customerResult] = await Promise.all([
        api.products({ pageSize: 100, status: 'active' }),
        api.customers()
      ]);
      setProducts(productResult.items);
      setCustomers(customerResult.customers);
      await loadLists();
      setResolveForm((current) => ({
        ...current,
        productId: current.productId || productResult.items[0]?.id || '',
        branchId: current.branchId || branches[0]?.id || ''
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load pricing.');
    } finally {
      setLoading(false);
    }
  }, [branches, loadLists]);

  useEffect(() => {
    void load();
  }, [load]);

  async function selectList(list: PriceList) {
    setError('');
    try {
      const [detail, historyResult] = await Promise.all([api.priceList(list.id), api.priceHistory(list.id)]);
      setSelected(detail.priceList);
      setHistory(historyResult.history);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load price list.');
    }
  }

  async function submitList(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await api.createPriceList({
        code: listForm.code,
        name: listForm.name,
        kind: listForm.kind as PriceList['kind'],
        status: 'active',
        branchId: listForm.branchId || null,
        customerId: listForm.customerId || null,
        maxDiscountPct: listForm.maxDiscountPct || null,
        minPrice: listForm.minPrice || null,
        isDefault: listForm.isDefault
      });
      setListForm(initialListForm);
      await loadLists();
      setSelected(result.priceList);
      setMessage('Price list created.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create price list.');
    } finally {
      setSaving(false);
    }
  }

  async function submitLine(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.upsertPriceLines(selected.id, {
        lines: [{ productId: lineForm.productId, minQty: lineForm.minQty, price: lineForm.price, status: 'active' }]
      });
      setSelected(result.priceList);
      setLineForm({ productId: '', minQty: '0', price: '' });
      const historyResult = await api.priceHistory(selected.id);
      setHistory(historyResult.history);
      setMessage('Price line saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to save price line.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleList(list: PriceList) {
    setError('');
    try {
      const status = list.status === 'active' ? 'inactive' : 'active';
      await api.updatePriceList(list.id, { status });
      await loadLists();
      if (selected?.id === list.id) await selectList(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update price list.');
    }
  }

  async function resolve(event: FormEvent) {
    event.preventDefault();
    setError('');
    setResolved(null);
    try {
      const result = await api.resolvePrice({
        productId: resolveForm.productId,
        branchId: resolveForm.branchId,
        quantity: resolveForm.quantity,
        customerId: resolveForm.customerId || null,
        priceListId: resolveForm.priceListId || null,
        discountPct: resolveForm.discountPct || undefined
      });
      setResolved(result.price);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to resolve price.');
    }
  }

  if (loading) return <Spinner label="Loading pricing" />;

  return (
    <div className="page-stack">
      <PageHeader title="Advanced pricing" description="Configure retail, wholesale, branch and customer price lists with server-side precedence." />
      <InventoryNav />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Price lists" subtitle="Precedence: customer-specific, branch-specific, explicitly selected list, default list, product base price.">
          {lists?.items.length ? (
            <div className="list-stack">
              {lists.items.map((list) => (
                <button className={`role-row ${selected?.id === list.id ? 'role-row-selected' : ''}`} key={list.id} onClick={() => void selectList(list)}>
                  <span><strong>{list.code} — {list.name}</strong><small>{list.kind}{list.branchName ? ` · ${list.branchName}` : ''}{list.customerName ? ` · ${list.customerName}` : ''}{list.isDefault ? ' · Default' : ''}</small></span>
                  <Badge tone={list.status === 'active' ? 'success' : 'warning'}>{list.status}</Badge>
                </button>
              ))}
            </div>
          ) : <EmptyState title="No price lists" description="Create a retail or wholesale list, then add product prices." />}
          {canManage ? (
            <form className="form-stack price-list-form" onSubmit={(event) => void submitList(event)}>
              <h3>Create price list</h3>
              <div className="form-grid">
                <TextField label="Code" value={listForm.code} onChange={(event) => setListForm({ ...listForm, code: event.target.value.toUpperCase() })} required />
                <TextField label="Name" value={listForm.name} onChange={(event) => setListForm({ ...listForm, name: event.target.value })} required />
                <SelectField label="Kind" value={listForm.kind} onChange={(event) => setListForm({ ...listForm, kind: event.target.value })}>
                  <option value="retail">Retail</option>
                  <option value="wholesale">Wholesale</option>
                  <option value="branch">Branch</option>
                  <option value="customer">Customer</option>
                </SelectField>
                <SelectField label="Branch" value={listForm.branchId} onChange={(event) => setListForm({ ...listForm, branchId: event.target.value })} disabled={!['branch', 'customer'].includes(listForm.kind)} required={listForm.kind === 'branch'}>
                  <option value="">Organization-wide</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </SelectField>
                <SelectField label="Customer" value={listForm.customerId} onChange={(event) => setListForm({ ...listForm, customerId: event.target.value })} disabled={listForm.kind !== 'customer'} required={listForm.kind === 'customer'}>
                  <option value="">Select customer</option>
                  {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                </SelectField>
                <TextField label="Max discount %" inputMode="decimal" value={listForm.maxDiscountPct} onChange={(event) => setListForm({ ...listForm, maxDiscountPct: event.target.value })} />
                <TextField label="Minimum price" inputMode="decimal" value={listForm.minPrice} onChange={(event) => setListForm({ ...listForm, minPrice: event.target.value })} />
              </div>
              <CheckboxField label="Default organization price list" checked={listForm.isDefault} onChange={(checked) => setListForm({ ...listForm, isDefault: checked })} />
              <Button type="submit" loading={saving}>Create list</Button>
            </form>
          ) : null}
        </Card>

        <div className="page-stack">
          <Card title={selected ? `${selected.code} lines` : 'Price lines'} subtitle="Quantity tiers choose the largest minimum quantity at or below the sale quantity.">
            {selected ? (
              <>
                <div className="list-row">
                  <div><strong>{selected.name}</strong><span>{selected.kind} · max discount {selected.maxDiscountPct ?? '0'}%</span></div>
                  {canManage ? <Button variant="secondary" onClick={() => void toggleList(selected)}>{selected.status === 'active' ? 'Deactivate' : 'Activate'}</Button> : null}
                </div>
                {selected.lines?.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Product</th><th>Min qty</th><th>Price</th><th>Status</th></tr></thead>
                      <tbody>
                        {selected.lines.map((line) => <tr key={line.id}><td>{line.productName}<small className="table-subtext">{line.productSku}</small></td><td>{line.minQty}</td><td>{line.price}</td><td><Badge tone={line.status === 'active' ? 'success' : 'warning'}>{line.status}</Badge></td></tr>)}
                      </tbody>
                    </table>
                  </div>
                ) : <EmptyState title="No product prices" description="Add a product price below." />}
                {canManage ? (
                  <form className="inline-form" onSubmit={(event) => void submitLine(event)}>
                    <SelectField label="Product" value={lineForm.productId} onChange={(event) => setLineForm({ ...lineForm, productId: event.target.value })} required>
                      <option value="">Select product</option>
                      {products.map((product) => <option key={product.id} value={product.id}>{product.sku} — {product.name}</option>)}
                    </SelectField>
                    <TextField label="Min quantity" inputMode="decimal" value={lineForm.minQty} onChange={(event) => setLineForm({ ...lineForm, minQty: event.target.value })} required />
                    <TextField label="Price" inputMode="decimal" value={lineForm.price} onChange={(event) => setLineForm({ ...lineForm, price: event.target.value })} required />
                    <Button type="submit" loading={saving}>Save line</Button>
                  </form>
                ) : null}
              </>
            ) : <EmptyState title="Select a price list" description="Price lines and history will appear here." />}
          </Card>

          <Card title="Resolve price" subtitle="The API calculates price; the client never submits a sale amount.">
            <form className="form-stack" onSubmit={(event) => void resolve(event)}>
              <div className="form-grid">
                <SelectField label="Product" value={resolveForm.productId} onChange={(event) => setResolveForm({ ...resolveForm, productId: event.target.value })} required>
                  <option value="">Select product</option>
                  {products.map((product) => <option key={product.id} value={product.id}>{product.sku} — {product.name}</option>)}
                </SelectField>
                <SelectField label="Branch" value={resolveForm.branchId} onChange={(event) => setResolveForm({ ...resolveForm, branchId: event.target.value })} required>
                  <option value="">Select branch</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </SelectField>
                <SelectField label="Customer" value={resolveForm.customerId} onChange={(event) => setResolveForm({ ...resolveForm, customerId: event.target.value })}>
                  <option value="">No customer</option>
                  {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                </SelectField>
                <SelectField label="Selected list" value={resolveForm.priceListId} onChange={(event) => setResolveForm({ ...resolveForm, priceListId: event.target.value })}>
                  <option value="">Automatic</option>
                  {lists?.items.map((list) => <option key={list.id} value={list.id}>{list.code}</option>)}
                </SelectField>
                <TextField label="Quantity" inputMode="decimal" value={resolveForm.quantity} onChange={(event) => setResolveForm({ ...resolveForm, quantity: event.target.value })} required />
                <TextField label="Discount %" inputMode="decimal" value={resolveForm.discountPct} onChange={(event) => setResolveForm({ ...resolveForm, discountPct: event.target.value })} />
              </div>
              <Button type="submit" variant="secondary">Resolve</Button>
            </form>
            {resolved ? (
              <Alert tone="success" title={`Resolved ${resolved.price} ${resolved.currency}`}>
                {resolved.productName} via {resolved.source} pricing. List price {resolved.listPrice}.
              </Alert>
            ) : null}
          </Card>
        </div>
      </div>

      <Card title="Price history" subtitle="Append-only change events for the selected list.">
        {history.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Product</th><th>Change</th><th>Old</th><th>New</th><th>Actor</th></tr></thead>
              <tbody>
                {history.map((event) => <tr key={String(event.id)}><td>{new Date(String(event.createdAt)).toLocaleString()}</td><td>{String(event.productName)}</td><td>{String(event.changeType)}</td><td>{String(event.oldPrice ?? '—')}</td><td>{String(event.newPrice ?? '—')}</td><td>{String(event.actorName ?? '—')}</td></tr>)}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No price changes" description="Price line changes will appear here." />}
      </Card>
    </div>
  );
}
