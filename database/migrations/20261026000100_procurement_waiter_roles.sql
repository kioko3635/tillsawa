-- Existing shops receive the same defaults as new registrations. Do not
-- overwrite a shop's existing role with the same code or its custom permissions.
WITH inserted AS (
  INSERT INTO roles (organization_id, code, name, description, is_system)
  SELECT o.id, v.code, v.name, v.description, true
  FROM organizations o
  CROSS JOIN (VALUES
    ('procurement', 'Procurement', 'Manage suppliers, prepare purchases and receive approved goods; no purchase approval or supplier payments'),
    ('waiter', 'Waiter', 'Complete own sales and payments; no refunds, voids or administration')
  ) AS v(code, name, description)
  ON CONFLICT (organization_id, code) DO NOTHING
  RETURNING id, organization_id, code
)
INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, p.permission_code
FROM inserted r
CROSS JOIN LATERAL unnest(CASE r.code
  WHEN 'procurement' THEN ARRAY[
    'organization.read', 'branch.read', 'catalog.read', 'inventory.read',
    'supplier.read', 'supplier.manage', 'purchase.read', 'purchase.create',
    'purchase.receive', 'supplier-invoice.manage'
  ]
  ELSE ARRAY[
    'organization.read', 'branch.read', 'device.read', 'sync.read', 'sync.write',
    'catalog.read', 'price-list.read', 'inventory.read', 'customer.read',
    'pos.sell', 'sale.read', 'sales.create', 'sales.view',
    'registers.open', 'registers.close', 'receipts.reprint'
  ] END) AS p(permission_code)
ON CONFLICT DO NOTHING;
