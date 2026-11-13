import { NavLink } from 'react-router-dom';

const items = [
  { to: '/inventory', label: 'Stock', end: true },
  { to: '/inventory/catalogue', label: 'Catalogue' },
  { to: '/inventory/pricing', label: 'Pricing' },
  { to: '/inventory/adjustments', label: 'Adjustments' },
  { to: '/inventory/counts', label: 'Counts' },
  { to: '/inventory/transfers', label: 'Transfers' }
];

export function InventoryNav() {
  return (
    <nav className="module-tabs" aria-label="Inventory modules">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end ?? false}>{item.label}</NavLink>
      ))}
    </nav>
  );
}
