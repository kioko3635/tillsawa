import { unitLabel } from '@pos/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, CheckboxField, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { OnlineCatalogProduct, ProductCategory, UnitOfMeasure } from '../../lib/api/types';

export function OnlineProductSearch({ onClose, onAdded }: { onClose: () => void; onAdded: (message: string) => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OnlineCatalogProduct[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<OnlineCatalogProduct | null>(null);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [form, setForm] = useState({ name: '', brand: '', size: '', barcode: '', baseUnitId: '', categoryId: '', cost: '', price: '', photo: true });
  useEffect(() => {
    dialogRef.current?.showModal();
    let disposed = false;
    Promise.all([api.units(), api.categories()]).then(([unitResult, categoryResult]) => {
      if (disposed) return;
      const active = unitResult.units.filter(unit => unit.status === 'active');
      setUnits(active); setCategories(categoryResult.categories.filter(category => category.status === 'active'));
      setForm(current => ({ ...current, baseUnitId: active.find(unit => unit.code === 'EA')?.id ?? active[0]?.id ?? '' }));
    }).catch(() => { if (!disposed) setError('Unable to load your shop units and categories. Close this window and try again.'); });
    return () => { disposed = true; };
  }, []);
  async function search(event: FormEvent) {
    event.preventDefault(); if (searching) return;
    setError(''); setResults([]); setSearched(false);
    if (!navigator.onLine) { setError('You are offline. Connect to the internet to search. Your local catalogue is still available.'); return; }
    setSearching(true);
    try { const result = await api.searchOnlineCatalog(query.trim()); setResults(result.products); setSearched(true); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Online search is unavailable. Your local catalogue is still available.'); }
    finally { setSearching(false); }
  }
  function choose(product: OnlineCatalogProduct) {
    setSelected(product); setConfirmed(false); setError('');
    setForm(current => ({ ...current, name: `${product.name}${product.size && !product.name.toLowerCase().includes(product.size.toLowerCase()) ? ` ${product.size}` : ''}`.slice(0, 160), brand: product.brand, size: product.size, barcode: product.code, categoryId: '', cost: '', price: '', photo: Boolean(product.imageUrl) }));
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!selected || !confirmed || saving) return;
    setSaving(true); setError('');
    try {
      const result = await api.importOnlineCatalog({ code: selected.code, name: form.name, brand: form.brand || null, size: form.size, barcode: form.barcode, categoryId: form.categoryId || null, baseUnitId: form.baseUnitId, cost: form.cost || '0', basePrice: form.price, includePhoto: form.photo, confirmed: true });
      await onAdded(result.created ? `Online product added. Its details${form.photo && selected.imageUrl ? ' and saved photo are' : ' are'} available offline. Record opening stock in Inventory → Adjustments before selling.` : 'This product or barcode is already in your shop. Existing prices and stock were preserved.');
      onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Unable to add the product. Please try again.'); }
    finally { setSaving(false); }
  }
  return <dialog ref={dialogRef} className="library-price-dialog online-product-dialog" aria-labelledby="online-product-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="library-dialog-heading"><div><small>EXPAND YOUR CATALOGUE</small><h2 id="online-product-title">{selected ? 'Review online product' : 'Search products online'}</h2></div><Button variant="secondary" aria-label="Close online search" disabled={saving} onClick={onClose}>×</Button></div>
    {!selected ? <>
      <p>Search packaged food and drinks by name or scan a barcode. Online coverage varies; confirm the exact product and pack before adding it.</p>
      <form className="inline-form" onSubmit={event => void search(event)}><TextField label="Product name or barcode" autoFocus value={query} minLength={2} maxLength={100} required placeholder="e.g. Tusker 500 ml, or a barcode" onChange={event => setQuery(event.target.value)} /><Button type="submit" loading={searching}>Search online</Button></form>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {searching ? <Spinner label="Searching online product source" /> : null}
      {searched && !results.length ? <Alert>No matching products were found in this source. Try the barcode or a simpler name, or create a custom product in your catalogue.</Alert> : null}
      <div className="library-grid online-results">{results.map(product => <article className="library-product" key={product.code}>
        {product.imageUrl ? <img src={product.imageUrl} alt={product.name} referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} /> : <div className="online-photo-placeholder">Photo unavailable</div>}
        <strong>{product.name}</strong><small>{product.brand || 'Brand not supplied'}</small><Badge>{product.size || 'Confirm pack size'}</Badge><small>Barcode: {product.code}</small>
        <a href={product.sourceUrl} target="_blank" rel="noreferrer">View source details</a><Button variant="secondary" onClick={() => choose(product)}>Review product</Button>
      </article>)}</div>
    </> : <form className="form-stack" onSubmit={event => void save(event)}>
      <div className="library-dialog-product">{selected.imageUrl ? <img src={selected.imageUrl} alt={selected.name} referrerPolicy="no-referrer" /> : null}<div><strong>{selected.name}</strong><p>{selected.category || 'Category not supplied'}</p><a href={selected.sourceUrl} target="_blank" rel="noreferrer">Check original product</a></div></div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <fieldset disabled={saving} className="online-review-fields"><div className="form-grid">
        <TextField label="Product name" value={form.name} required maxLength={160} onChange={event => setForm({ ...form, name: event.target.value })} />
        <TextField label="Brand" value={form.brand} maxLength={120} onChange={event => setForm({ ...form, brand: event.target.value })} />
        <TextField label="Size / pack" value={form.size} maxLength={100} onChange={event => setForm({ ...form, size: event.target.value })} hint="A 250 ml bottle and a 750 ml bottle are separate products." />
        <TextField label="Physical product barcode" value={form.barcode} maxLength={64} onChange={event => setForm({ ...form, barcode: event.target.value })} hint="Check against the pack. Clear this field if you cannot confirm it." />
        <SelectField label="Selling unit" required value={form.baseUnitId} onChange={event => setForm({ ...form, baseUnitId: event.target.value })}><option value="">Choose unit</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unitLabel(unit.code, unit.name)}</option>)}</SelectField>
        <SelectField label="Shop category" value={form.categoryId} onChange={event => setForm({ ...form, categoryId: event.target.value })}><option value="">Uncategorised</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</SelectField>
        <TextField label="Buying price (KSh)" inputMode="decimal" value={form.cost} onChange={event => setForm({ ...form, cost: event.target.value })} />
        <TextField label="Selling price (KSh)" inputMode="decimal" value={form.price} required onChange={event => setForm({ ...form, price: event.target.value })} />
      </div>
      {selected.imageUrl ? <CheckboxField label="Save product photo for offline use" checked={form.photo} onChange={photo => setForm({ ...form, photo })} /> : <p>No photo is available from this source.</p>}
      <CheckboxField label="I have checked the product, size, barcode and selling unit against my stock" checked={confirmed} onChange={setConfirmed} />
      </fieldset>
      <p className="library-stock-note">Adding a product does not add stock. Record your opening quantity before selling.</p>
      <div className="table-actions"><Button type="submit" loading={saving} disabled={!confirmed || !form.baseUnitId}>Add reviewed product</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => { setSelected(null); setError(''); }}>Back to results</Button></div>
    </form>}
    <p className="online-attribution">Source: <a href="https://world.openfoodfacts.org" target="_blank" rel="noreferrer">Open Food Facts</a> contributors. Data: <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">ODbL</a>. Photos: <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noreferrer">CC BY-SA 3.0</a>. Availability in Kenya and product details are not guaranteed.</p>
  </dialog>;
}
