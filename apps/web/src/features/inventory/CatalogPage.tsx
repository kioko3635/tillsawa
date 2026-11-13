import { unitLabel } from '@pos/contracts';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CheckboxField, ConfirmDialog, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { Customer, Paged, Product, ProductCategory, UnitOfMeasure } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { InventoryNav } from './InventoryNav';
import { BusinessProductLibrary } from './BusinessProductLibrary';

const emptyProductForm = {
  sku: '',
  name: '',
  description: '',
  brand: '',
  imageUrl: '',
  barcode: '',
  categoryId: '',
  baseUnitId: '',
  itemType: 'stocked',
  cost: '0',
  basePrice: '0',
  minPrice: '',
  minStockLevel: '0',
  reorderQty: '',
  costingMethod: 'average',
  trackBatch: false,
  trackExpiry: false,
  trackSerial: false,
  conversionUnitId: '',
  conversionRatio: ''
};

export function CatalogPage() {
  const { hasPermission, bootstrap } = useAuth();
  const canManage = hasPermission('catalog.manage');
  const canManageCustomers = hasPermission('customer.manage');
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [products, setProducts] = useState<Paged<Product> | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [form, setForm] = useState(emptyProductForm);
  const [categoryName, setCategoryName] = useState('');
  const [categoryParentId, setCategoryParentId] = useState('');
  const [statusChange, setStatusChange] = useState<Product | null>(null);
  const [unitCode, setUnitCode] = useState('');
  const [unitName, setUnitName] = useState('');
  const [customerCode, setCustomerCode] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [scanValue, setScanValue] = useState('');
  const [newBarcode, setNewBarcode] = useState('');
  const [makePrimary, setMakePrimary] = useState(false);
  const [filters, setFilters] = useState({ search: '', categoryId: '', status: '', page: 1 });
  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadProducts = useCallback(async (nextFilters = filters) => {
    const result = await api.products({
      page: nextFilters.page,
      pageSize: 10,
      search: nextFilters.search || undefined,
      categoryId: nextFilters.categoryId || undefined,
      status: nextFilters.status || undefined
    });
    setProducts(result);
  }, [filters]);

  const loadReference = useCallback(async () => {
    const [categoryResult, unitResult, customerResult] = await Promise.all([
      api.categories(),
      api.units(),
      api.customers()
    ]);
    setCategories(categoryResult.categories);
    setUnits(unitResult.units);
    setCustomers(customerResult.customers);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadReference(), loadProducts()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load catalogue.');
    } finally {
      setLoading(false);
    }
  }, [loadProducts, loadReference]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateForm(key: keyof typeof emptyProductForm, value: string | boolean) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startEdit(product: Product) {
    setEditingProduct(product);
    setForm({
      sku: product.sku,
      name: product.name,
      description: product.description ?? '',
      brand: product.brand ?? '',
      imageUrl: product.imageUrl ?? '',
      barcode: '',
      categoryId: product.categoryId ?? '',
      baseUnitId: product.baseUnitId,
      itemType: product.itemType,
      cost: product.cost,
      basePrice: product.basePrice,
      minPrice: product.minPrice ?? '',
      minStockLevel: product.minStockLevel,
      reorderQty: product.reorderQty ?? '',
      costingMethod: product.costingMethod,
      trackBatch: product.trackBatch,
      trackExpiry: product.trackExpiry,
      trackSerial: product.trackSerial,
      conversionUnitId: '',
      conversionRatio: ''
    });
  }

  async function submitProduct(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const conversions = form.conversionUnitId && form.conversionRatio && form.baseUnitId
        ? [{ fromUnitId: form.conversionUnitId, toUnitId: form.baseUnitId, ratio: form.conversionRatio }]
        : [];
      if (editingProduct) {
        const result = await api.updateProduct(editingProduct.id, {
          sku: form.sku,
          name: form.name,
          description: form.description || null,
          brand: form.brand || null,
          imageUrl: form.imageUrl || null,
          categoryId: form.categoryId || null,
          baseUnitId: form.baseUnitId,
          itemType: form.itemType as Product['itemType'],
          cost: form.cost,
          basePrice: form.basePrice,
          minPrice: form.minPrice || null,
          costingMethod: form.costingMethod as Product['costingMethod'],
          minStockLevel: form.minStockLevel,
          reorderQty: form.reorderQty || null,
          trackBatch: form.trackBatch,
          trackExpiry: form.trackExpiry,
          trackSerial: form.trackSerial
        });
        setEditingProduct(result.product);
        setMessage('Product updated.');
      } else {
        const result = await api.createProduct({
          sku: form.sku,
          name: form.name,
          description: form.description || null,
          brand: form.brand || null,
          imageUrl: form.imageUrl || null,
          categoryId: form.categoryId || null,
          baseUnitId: form.baseUnitId,
          itemType: form.itemType as Product['itemType'],
          cost: form.cost,
          basePrice: form.basePrice,
          minPrice: form.minPrice || null,
          costingMethod: form.costingMethod as Product['costingMethod'],
          minStockLevel: form.minStockLevel,
          reorderQty: form.reorderQty || null,
          trackBatch: form.trackBatch,
          trackExpiry: form.trackExpiry,
          trackSerial: form.trackSerial,
          status: 'active',
          barcodes: form.barcode ? [form.barcode] : [],
          conversions
        });
        setEditingProduct(result.product);
        setMessage('Product created.');
      }
      setForm(emptyProductForm);
      await Promise.all([loadProducts(), loadReference()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to save product.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmStatusChange() {
    if (!statusChange) return;
    setError('');
    setMessage('');
    try {
      const status = statusChange.status === 'active' ? 'archived' : 'active';
      await api.updateProduct(statusChange.id, { status });
      setMessage(`Product ${status === 'active' ? 'reactivated' : 'archived'}.`);
      setStatusChange(null);
      await loadProducts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update product status.');
      setStatusChange(null);
    }
  }

  async function submitCategory(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api.createCategory({ name: categoryName, parentId: categoryParentId || null, status: 'active' });
      setCategoryName('');
      setCategoryParentId('');
      await loadReference();
      setMessage('Category created.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create category.');
    }
  }

  async function toggleCategory(category: ProductCategory) {
    setError('');
    try {
      await api.updateCategory(category.id, { status: category.status === 'active' ? 'inactive' : 'active' });
      await loadReference();
      setMessage(`Category ${category.status === 'active' ? 'deactivated' : 'reactivated'}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update category.');
    }
  }

  async function submitUnit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api.createUnit({ code: unitCode, name: unitName, status: 'active' });
      setUnitCode('');
      setUnitName('');
      await loadReference();
      setMessage('Unit created.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create unit.');
    }
  }

  async function submitCustomer(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api.createCustomer({ code: customerCode, name: customerName, phone: customerPhone || null, status: 'active' });
      setCustomerCode('');
      setCustomerName('');
      setCustomerPhone('');
      await loadReference();
      setMessage('Customer created.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create customer.');
    }
  }

  async function scanBarcode(event: FormEvent) {
    event.preventDefault();
    if (!scanValue) return;
    setError('');
    setMessage('');
    try {
      const result = await api.lookupBarcode(scanValue.trim());
      startEdit(result.product);
      setScanValue('');
      setMessage(`Loaded ${result.product.name} from barcode.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `No product found for ${scanValue}.`);
    }
  }

  async function submitBarcode(event: FormEvent) {
    event.preventDefault();
    if (!editingProduct || !newBarcode) return;
    setError('');
    try {
      const result = await api.addBarcode(editingProduct.id, newBarcode.trim(), makePrimary);
      setEditingProduct(result.product);
      setNewBarcode('');
      setMakePrimary(false);
      setMessage('Barcode added.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to add barcode.');
    }
  }

  async function exportCsv() {
    setError('');
    try {
      const csv = await api.exportProducts();
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'products.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to export products.');
    }
  }

  async function importCsv(file: File | undefined) {
    if (!file) return;
    setError('');
    try {
      const result = await api.importProducts(await file.text());
      await Promise.all([loadProducts(), loadReference()]);
      setMessage(`Imported ${result.import.created} products${result.import.errors.length ? ` with ${result.import.errors.length} row errors` : ''}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to import products.');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  if (loading) return <Spinner label="Loading catalogue" />;

  return (
    <div className="page-stack">
      <PageHeader
        title="Product catalogue"
        description="Manage products, units, categories, barcodes, customers and CSV catalogue imports."
        actions={canManage ? <Button variant="secondary" onClick={() => void exportCsv()}>Export CSV</Button> : null}
      />
      {bootstrap?.modules.includes('inventory') ? <InventoryNav /> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {canManage ? <BusinessProductLibrary onAdded={async () => { await Promise.all([loadProducts(), loadReference()]); }} /> : null}

      <Card title="Barcode lookup" subtitle="USB scanners that send keyboard input can scan directly into this field.">
        <form className="inline-form" onSubmit={(event) => void scanBarcode(event)}>
          <TextField label="Scan or type barcode" value={scanValue} onChange={(event) => setScanValue(event.target.value)} placeholder="Scan barcode" />
          <Button type="submit" variant="secondary">Find product</Button>
        </form>
      </Card>

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Products" subtitle={`${products?.total ?? 0} products`}>
          <form className="inline-form" onSubmit={(event) => {
            event.preventDefault();
            const next = { ...filters, page: 1 };
            setFilters(next);
            void loadProducts(next);
          }}>
            <TextField label="Search" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="Name, SKU or barcode" />
            <SelectField label="Category" value={filters.categoryId} onChange={(event) => setFilters({ ...filters, categoryId: event.target.value })}>
              <option value="">All categories</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </SelectField>
            <SelectField label="Status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </SelectField>
            <Button type="submit" variant="secondary">Filter</Button>
          </form>
          {products?.items.length ? (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Cost</th><th>Price</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {products.items.map((product) => (
                      <tr key={product.id} className={editingProduct?.id === product.id ? 'row-selected' : ''}>
                        <td><strong>{product.sku}</strong><small className="table-subtext">{product.barcode ?? 'No barcode'}</small></td>
                        <td>{product.name}<small className="table-subtext">{product.itemType} · {unitLabel(product.baseUnitCode)}</small></td>
                        <td>{product.categoryName ?? '—'}</td>
                        <td>{product.cost}</td>
                        <td>{product.basePrice}</td>
                        <td><Badge tone={product.status === 'active' ? 'success' : 'warning'}>{product.status}</Badge></td>
                        <td className="table-actions">
                          <Button variant="secondary" onClick={() => startEdit(product)}>Edit</Button>
                          {canManage ? <Button variant="secondary" onClick={() => setStatusChange(product)}>{product.status === 'active' ? 'Archive' : 'Reactivate'}</Button> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pagination-bar">
                <span>Page {products.page} of {products.totalPages}</span>
                <Button variant="secondary" disabled={products.page <= 1} onClick={() => {
                  const next = { ...filters, page: filters.page - 1 };
                  setFilters(next);
                  void loadProducts(next);
                }}>Previous</Button>
                <Button variant="secondary" disabled={products.page >= products.totalPages} onClick={() => {
                  const next = { ...filters, page: filters.page + 1 };
                  setFilters(next);
                  void loadProducts(next);
                }}>Next</Button>
              </div>
            </>
          ) : <EmptyState title="No products" description="Create the first product or import a CSV catalogue." />}
        </Card>

        <div className="page-stack">
          {canManage ? (
            <Card title={editingProduct ? `Edit ${editingProduct.sku}` : 'New product'} subtitle="Money is entered in KES and stored by the API as exact minor units.">
              <form className="form-stack" onSubmit={(event) => void submitProduct(event)}>
                <div className="form-grid">
                  <TextField label="SKU" value={form.sku} onChange={(event) => updateForm('sku', event.target.value.toUpperCase())} required />
                  <TextField label="Name" value={form.name} onChange={(event) => updateForm('name', event.target.value)} required />
                  <SelectField label="Category" value={form.categoryId} onChange={(event) => updateForm('categoryId', event.target.value)}>
                    <option value="">Uncategorized</option>
                    {categories.filter((category) => category.status === 'active').map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </SelectField>
                  <SelectField label="Base unit" value={form.baseUnitId} onChange={(event) => updateForm('baseUnitId', event.target.value)} required>
                    <option value="">Select unit</option>
                    {units.filter((unit) => unit.status === 'active').map((unit) => <option key={unit.id} value={unit.id}>{unitLabel(unit.code, unit.name)}</option>)}
                  </SelectField>
                  <SelectField label="Item type" value={form.itemType} onChange={(event) => updateForm('itemType', event.target.value)}>
                    <option value="stocked">Stocked</option>
                    <option value="non_stock">Non-stock</option>
                    <option value="service">Service</option>
                  </SelectField>
                  <TextField label="Brand" value={form.brand} onChange={(event) => updateForm('brand', event.target.value)} />
                  <TextField label="Image URL" value={form.imageUrl} onChange={(event) => updateForm('imageUrl', event.target.value)} />
                  {!editingProduct ? <TextField label="Initial barcode" value={form.barcode} onChange={(event) => updateForm('barcode', event.target.value)} /> : null}
                  <TextField label="Cost" inputMode="decimal" value={form.cost} onChange={(event) => updateForm('cost', event.target.value)} required />
                  <TextField label="Base price" inputMode="decimal" value={form.basePrice} onChange={(event) => updateForm('basePrice', event.target.value)} required />
                  <TextField label="Minimum price" inputMode="decimal" value={form.minPrice} onChange={(event) => updateForm('minPrice', event.target.value)} />
                  <TextField label="Minimum stock" inputMode="decimal" value={form.minStockLevel} onChange={(event) => updateForm('minStockLevel', event.target.value)} />
                  <TextField label="Reorder quantity" inputMode="decimal" value={form.reorderQty} onChange={(event) => updateForm('reorderQty', event.target.value)} />
                  <SelectField label="Costing method" value={form.costingMethod} onChange={(event) => updateForm('costingMethod', event.target.value)}>
                    <option value="average">Weighted average</option>
                    <option value="latest">Latest cost</option>
                  </SelectField>
                </div>
                <TextField label="Description" value={form.description} onChange={(event) => updateForm('description', event.target.value)} />
                <div className="permission-grid">
                  <CheckboxField label="Track batches" checked={form.trackBatch} onChange={(checked) => updateForm('trackBatch', checked)} />
                  <CheckboxField label="Track expiry" checked={form.trackExpiry} onChange={(checked) => updateForm('trackExpiry', checked)} />
                  <CheckboxField label="Track serial numbers" checked={form.trackSerial} onChange={(checked) => updateForm('trackSerial', checked)} />
                </div>
                {!editingProduct ? (
                  <fieldset>
                    <legend>Optional unit conversion</legend>
                    <div className="form-grid">
                      <SelectField label="Sell/receive unit" value={form.conversionUnitId} onChange={(event) => updateForm('conversionUnitId', event.target.value)}>
                        <option value="">No conversion</option>
                        {units.filter((unit) => unit.status === 'active' && unit.id !== form.baseUnitId).map((unit) => <option key={unit.id} value={unit.id}>{unitLabel(unit.code, unit.name)}</option>)}
                      </SelectField>
                      <TextField label="Base units per unit" inputMode="decimal" value={form.conversionRatio} onChange={(event) => updateForm('conversionRatio', event.target.value)} hint="Example: 1 Case = 24 Each" />
                    </div>
                  </fieldset>
                ) : null}
                <div className="table-actions">
                  <Button type="submit" loading={saving}>{editingProduct ? 'Save product' : 'Create product'}</Button>
                  {editingProduct ? <Button type="button" variant="secondary" onClick={() => { setEditingProduct(null); setForm(emptyProductForm); }}>New product</Button> : null}
                </div>
              </form>
            </Card>
          ) : null}

          {editingProduct?.barcodes?.length || editingProduct ? (
            <Card title="Barcodes" subtitle="Barcodes are unique across the organization.">
              {editingProduct?.barcodes?.length ? (
                <div className="list-stack">
                  {editingProduct.barcodes.map((barcode) => (
                    <div className="list-row" key={barcode.id}>
                      <div><strong>{barcode.barcode}</strong>{barcode.isPrimary ? <span>Primary barcode</span> : null}</div>
                      {canManage ? <Button variant="secondary" onClick={() => void api.removeBarcode(editingProduct.id, barcode.id).then(async (result) => {
                        setEditingProduct(result.product);
                        await loadProducts();
                      }).catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Unable to remove barcode.'))}>Remove</Button> : null}
                    </div>
                  ))}
                </div>
              ) : <EmptyState title="No barcodes" description="Scan or type a barcode below." />}
              {canManage ? (
                <form className="inline-form" onSubmit={(event) => void submitBarcode(event)}>
                  <TextField label="Barcode" value={newBarcode} onChange={(event) => setNewBarcode(event.target.value)} required />
                  <CheckboxField label="Primary" checked={makePrimary} onChange={setMakePrimary} />
                  <Button type="submit" variant="secondary">Add</Button>
                </form>
              ) : null}
            </Card>
          ) : null}

          {canManage ? (
            <Card title="Import products" subtitle="CSV headers: sku,name,description,brand,barcode,category,baseUnit,itemType,cost,basePrice,minStockLevel">
              <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={(event) => void importCsv(event.target.files?.[0])} />
            </Card>
          ) : null}
        </div>
      </div>

      <div className="dashboard-grid">
        <Card title="Categories" subtitle="One level of subcategories is supported by the API.">
          {canManage ? (
            <form className="inline-form" onSubmit={(event) => void submitCategory(event)}>
              <TextField label="Category name" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} required />
              <SelectField label="Parent category" value={categoryParentId} onChange={(event) => setCategoryParentId(event.target.value)}>
                <option value="">Top-level</option>
                {categories.filter((category) => !category.parentId && category.status === 'active').map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </SelectField>
              <Button type="submit" variant="secondary">Add</Button>
            </form>
          ) : null}
          <div className="list-stack">
            {categories.map((category) => (
              <div className="list-row" key={category.id}>
                <div><strong>{category.name}</strong><span>{category.parentName ?? 'Top-level category'}</span></div>
                <div className="table-actions">
                  <Badge tone={category.status === 'active' ? 'success' : 'warning'}>{category.status}</Badge>
                  {canManage ? <Button variant="secondary" onClick={() => void toggleCategory(category)}>{category.status === 'active' ? 'Deactivate' : 'Activate'}</Button> : null}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Units and customers" subtitle="Default units are seeded during onboarding; additional units can be added here.">
          {canManage ? (
            <form className="inline-form" onSubmit={(event) => void submitUnit(event)}>
              <TextField label="Short code (internal)" value={unitCode} onChange={(event) => setUnitCode(event.target.value.toUpperCase())} required />
              <TextField label="Unit name" value={unitName} onChange={(event) => setUnitName(event.target.value)} required />
              <Button type="submit" variant="secondary">Add unit</Button>
            </form>
          ) : null}
          <div className="unit-list">
            {units.map((unit) => <Badge key={unit.id} tone={unit.status === 'active' ? 'info' : 'warning'}>{unitLabel(unit.code, unit.name)}</Badge>)}
          </div>
          {canManageCustomers ? (
            <form className="inline-form customer-form" onSubmit={(event) => void submitCustomer(event)}>
              <TextField label="Customer code" value={customerCode} onChange={(event) => setCustomerCode(event.target.value.toUpperCase())} required />
              <TextField label="Customer name" value={customerName} onChange={(event) => setCustomerName(event.target.value)} required />
              <TextField label="Phone" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} />
              <Button type="submit" variant="secondary">Add customer</Button>
            </form>
          ) : null}
          <div className="list-stack">
            {customers.slice(0, 8).map((customer) => <div className="list-row" key={customer.id}><div><strong>{customer.name}</strong><span>{customer.code} · {customer.phone ?? 'No phone'}</span></div><Badge tone={customer.status === 'active' ? 'success' : 'warning'}>{customer.status}</Badge></div>)}
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={Boolean(statusChange)}
        title={statusChange?.status === 'active' ? `Archive ${statusChange.name}?` : `Reactivate ${statusChange?.name}?`}
        description={statusChange?.status === 'active'
          ? 'Archived products cannot be used in new inventory operations, but their history is preserved.'
          : 'Reactivated products can be used in new inventory operations.'}
        confirmLabel={statusChange?.status === 'active' ? 'Archive product' : 'Reactivate product'}
        danger={statusChange?.status === 'active'}
        onConfirm={() => void confirmStatusChange()}
        onCancel={() => setStatusChange(null)}
      />
    </div>
  );
}
