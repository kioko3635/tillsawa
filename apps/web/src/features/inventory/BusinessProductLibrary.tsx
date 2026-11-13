import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, SelectField, Spinner, TextField } from '../../design-system/components';
import { api, ApiError } from '../../lib/api/client';
import type { LibraryProduct } from '../../lib/api/types';
import { useAuth } from '../../app/useAuth';
import { OnlineProductSearch } from './OnlineProductSearch';

export function BusinessProductLibrary({ onAdded }: { onAdded: () => Promise<void> }) {
  const { bootstrap } = useAuth();
  const [label, setLabel] = useState('Business');
  const [profile, setProfile] = useState('');
  const [entries, setEntries] = useState<LibraryProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [family, setFamily] = useState('');
  const [size, setSize] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<LibraryProduct | null>(null);
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAdded, setShowAdded] = useState(false);
  const [showOnline, setShowOnline] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (selected && dialog && !dialog.open) dialog.showModal();
    if (!selected && dialog?.open) dialog.close();
  }, [selected]);

  useEffect(() => {
    let disposed = false;
    setLoading(true); setEntries([]); setSelected(null); setError(''); setMessage('');
    setFamily(''); setSize(''); setCategory(''); setSearch(''); setPage(1);
    api.businessLibrary().then((result) => { if (!disposed) { setEntries(result.entries); setLabel(result.label); setProfile(result.profile); } })
      .catch((err: unknown) => { if (!disposed) setError(err instanceof ApiError ? err.message : 'Unable to load the product library.'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [bootstrap?.organization.businessProfile]);
  const categories = useMemo(() => [...new Set(entries.map((entry) => entry.category))].sort(), [entries]);
  const filtered = useMemo(() => entries.filter((entry) => (showAdded || !entry.productId)
    && (!category || entry.category === category)
    && (!family || entry.family === family) && (!size || entry.size === size)
    && entry.name.toLowerCase().includes(search.trim().toLowerCase())), [entries, search, category, family, size, showAdded]);
  const sizes = useMemo(() => family ? [...new Set(entries.filter((entry) => entry.family === family).map((entry) => entry.size))].sort() : [], [entries, family]);
  const pages = Math.max(1, Math.ceil(filtered.length / 24));

  async function add() {
    if (!selected || saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const result = await api.selectBusinessLibraryProducts([{ id: selected.id, sellingPrice: price, cost: cost || '0' }]);
      const refreshed = await api.businessLibrary();
      setEntries(refreshed.entries);
      setSelected(null); setPrice(''); setCost('');
      setMessage(result.created ? (selected.itemType === 'stocked' ? 'Product added. Record opening stock in Inventory before selling, and scan its barcode in the product editor.' : 'Item added. Confirm the portion or service details before selling. Ingredient and parts stock are managed separately.') : 'This product is already in your shop. Its price and stock were preserved.');
      await onAdded();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Unable to add this product.'); }
    finally { setSaving(false); }
  }

  return <section className="library-browser"><Card title={profile === 'wines_spirits' ? 'Liquor store product library' : `${label} product library`} subtitle="Browse your business catalogue, choose a product, then set your shop prices. Each size or pack is a separate item." actions={<Button variant="secondary" onClick={() => setShowOnline(true)}>Search products online</Button>}>
    {showOnline ? <OnlineProductSearch onClose={() => setShowOnline(false)} onAdded={async text => { setMessage(text); await onAdded(); }} /> : null}
    {loading ? <Spinner label="Loading product library" /> : <>
      <div className="library-summary"><span><strong>{entries.length.toLocaleString()}</strong> catalogue items & variants</span><span><strong>{entries.filter((entry) => entry.productId).length.toLocaleString()}</strong> added to your shop</span><span>Choose product → Set prices → Add stock</span></div>
      {entries.some((entry) => entry.template) ? <p>Editable templates use illustrations. Set portions and service details to match your business; prepared items and services do not deduct ingredient or parts stock automatically.</p> : null}
      {error && !selected ? <Alert tone="danger">{error}</Alert> : null}
      {message ? <Alert tone="success">{message} {bootstrap?.modules.includes('inventory') ? <Link to="/inventory">Open inventory</Link> : null}</Alert> : null}
      <div className="inline-form">
        <TextField label="Search product library" value={search} placeholder="Search name, model, pack, size or service" onChange={(event) => { setSearch(event.target.value); setFamily(''); setSize(''); setPage(1); }} />
        <SelectField label="Library category" value={category} onChange={(event) => { setCategory(event.target.value); setFamily(''); setSize(''); setPage(1); }}><option value="">All categories</option>{categories.map((name) => <option key={name}>{name}</option>)}</SelectField>
        <Button variant="secondary" onClick={() => { setShowAdded(!showAdded); setPage(1); }}>{showAdded ? 'Show products to add' : 'Include added products'}</Button>
      </div>
      {family ? <div className="inline-form"><strong>{family}</strong><SelectField label="Size or option" value={size} onChange={(event) => { setSize(event.target.value); setPage(1); }}><option value="">All listed options</option>{sizes.map((option) => <option key={option}>{option}</option>)}</SelectField><Button variant="secondary" onClick={() => { setFamily(''); setSize(''); setPage(1); }}>All product families</Button></div> : null}
      <dialog ref={dialogRef} className="library-price-dialog" aria-labelledby="library-price-title" onCancel={(event) => { event.preventDefault(); if (!saving) setSelected(null); }}>
      {selected ? <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <div className="library-dialog-heading"><div><small>ADD TO YOUR SHOP</small><h2 id="library-price-title">Set your prices</h2></div><Button type="button" variant="secondary" disabled={saving} aria-label="Close product pricing" onClick={() => setSelected(null)}>×</Button></div>
        <div className="library-dialog-product"><img src={selected.imageUrl} alt={selected.name} /><div><Badge tone="info">{selected.size}</Badge><h3>{selected.name}</h3><p>{selected.category}</p><small>Prices are for one catalogue item in this size or pack.</small></div></div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="form-grid">
          <TextField label="Buying price (KSh)" inputMode="decimal" autoFocus disabled={saving} value={cost} onChange={(event) => setCost(event.target.value)} hint="Cost of one item. Optional; used for profit reports." />
          <TextField label="Selling price (KSh)" inputMode="decimal" disabled={saving} value={price} onChange={(event) => setPrice(event.target.value)} hint="What your customer pays for one item." required />
        </div>
        {selected.itemType === 'stocked' ? <p className="library-stock-note">After adding this product, record its opening quantity in Inventory → Adjustments before selling.</p> : null}
        <div className="table-actions"><Button type="submit" loading={saving}>Add to my shop</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => setSelected(null)}>Cancel</Button></div>
      </form> : null}
      </dialog>
      <div className="library-grid">
        {filtered.slice((Math.min(page, pages) - 1) * 24, Math.min(page, pages) * 24).map((entry) => <article className="library-product" key={entry.id}>
          <img src={entry.imageUrl} alt={entry.name} loading="lazy" />
          <small>{entry.category} · {entry.size}</small><strong>{entry.name}</strong>
          {entry.template ? <small>Editable template · illustration</small> : entry.photoKind === 'style_photo' ? <small>Style photo · confirm colour and size</small> : null}
          <Button variant="secondary" onClick={() => { setFamily(entry.family); setSize(''); setPage(1); }}>View sizes / options</Button>
          {entry.productId ? <Badge tone="success">Added to shop</Badge> : <Button variant="secondary" disabled={saving} onClick={() => { setSelected(entry); setPrice(''); setCost(''); setError(''); }}>Choose product</Button>}
        </article>)}
      </div>
      {!filtered.length ? <p>No matching products. You can still create a custom product below.</p> : null}
      <div className="pagination-bar"><span>{filtered.length} matches · Page {Math.min(page, pages)} of {pages}</span><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous products</Button><Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>More products</Button></div>
    </>}
  </Card></section>;
}
