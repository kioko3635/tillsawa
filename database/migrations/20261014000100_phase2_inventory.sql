-- Phase 2: product catalogue, advanced pricing and multi-branch inventory.
-- All tables carry organization_id and tenant-safe composite foreign keys,
-- matching the Phase 1 convention. Money is stored as integer minor units
-- (bigint, scale 2). Quantities use numeric(20,6).

CREATE TABLE product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (parent_id, organization_id) REFERENCES product_categories(id, organization_id) ON DELETE RESTRICT,
  CHECK (parent_id IS NULL OR parent_id <> id),
  UNIQUE (id, organization_id)
);
-- One level of subcategories is supported; uniqueness treats NULL parents alike.
CREATE UNIQUE INDEX uq_categories_name
  ON product_categories (organization_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE units_of_measure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9]{1,20}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sku text NOT NULL,
  name text NOT NULL,
  description text,
  brand text,
  image_url text,
  category_id uuid,
  base_unit_id uuid NOT NULL,
  item_type text NOT NULL DEFAULT 'stocked' CHECK (item_type IN ('stocked', 'non_stock', 'service')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  cost_minor bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  base_price_minor bigint NOT NULL DEFAULT 0 CHECK (base_price_minor >= 0),
  min_price_minor bigint,
  costing_method text NOT NULL DEFAULT 'average' CHECK (costing_method IN ('average', 'latest')),
  min_stock_level numeric(20,6) NOT NULL DEFAULT 0 CHECK (min_stock_level >= 0),
  reorder_qty numeric(20,6) CHECK (reorder_qty IS NULL OR reorder_qty > 0),
  track_batch boolean NOT NULL DEFAULT false,
  track_expiry boolean NOT NULL DEFAULT false,
  track_serial boolean NOT NULL DEFAULT false,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (category_id, organization_id) REFERENCES product_categories(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (base_unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  UNIQUE (organization_id, sku),
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_products_org_name ON products(organization_id, name);
CREATE INDEX idx_products_category ON products(organization_id, category_id);
CREATE INDEX idx_products_status ON products(organization_id, status);

CREATE TABLE product_barcodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  barcode text NOT NULL CHECK (barcode ~ '^[A-Za-z0-9-]{3,64}$'),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE CASCADE,
  UNIQUE (organization_id, barcode),
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_barcodes_product ON product_barcodes(organization_id, product_id);
-- At most one primary barcode per product.
CREATE UNIQUE INDEX uq_barcodes_primary ON product_barcodes(product_id) WHERE is_primary;

CREATE TABLE product_unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  from_unit_id uuid NOT NULL,
  to_unit_id uuid NOT NULL,
  -- 1 from_unit = ratio to_unit, e.g. 1 CASE = 24 EACH -> ratio 24
  ratio numeric(20,8) NOT NULL CHECK (ratio > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (from_unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  CHECK (from_unit_id <> to_unit_id),
  UNIQUE (product_id, from_unit_id, to_unit_id)
);

-- Minimal customer register required by customer-specific price lists.
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,40}$'),
  name text NOT NULL,
  phone text,
  email citext,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);

CREATE TABLE price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,40}$'),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('retail', 'wholesale', 'customer', 'branch')),
  branch_id uuid,
  customer_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  valid_from timestamptz,
  valid_to timestamptz,
  max_discount_pct numeric(7,4) CHECK (max_discount_pct IS NULL OR (max_discount_pct >= 0 AND max_discount_pct <= 100)),
  min_price_minor bigint CHECK (min_price_minor IS NULL OR min_price_minor >= 0),
  is_default boolean NOT NULL DEFAULT false,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, organization_id) REFERENCES customers(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  CHECK (kind = 'branch' OR branch_id IS NULL OR kind = 'customer'),
  CHECK (kind <> 'branch' OR branch_id IS NOT NULL),
  CHECK (kind <> 'customer' OR customer_id IS NOT NULL),
  CHECK (kind NOT IN ('retail', 'wholesale') OR (branch_id IS NULL AND customer_id IS NULL)),
  CHECK (kind <> 'branch' OR customer_id IS NULL),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);
-- Only one default price list per organization.
CREATE UNIQUE INDEX uq_price_lists_default ON price_lists(organization_id) WHERE is_default;
CREATE INDEX idx_price_lists_scope ON price_lists(organization_id, kind, status);

CREATE TABLE product_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  price_list_id uuid NOT NULL,
  product_id uuid NOT NULL,
  -- Quantity tiers: the applicable line is the one with the largest min_qty <= quantity.
  min_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  valid_from timestamptz,
  valid_to timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (price_list_id, organization_id) REFERENCES price_lists(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE CASCADE,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  UNIQUE (price_list_id, product_id, min_qty),
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_product_prices_product ON product_prices(organization_id, product_id);

CREATE TABLE price_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  price_list_id uuid NOT NULL,
  product_id uuid NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('created', 'updated', 'deactivated')),
  old_price_minor bigint,
  new_price_minor bigint,
  actor_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (price_list_id, organization_id) REFERENCES price_lists(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL
);
CREATE INDEX idx_price_events_product ON price_change_events(organization_id, product_id, created_at DESC);

-- Current on-hand quantity per branch/product. All writes happen inside the
-- inventory service transaction which takes the row FOR UPDATE; negative stock
-- is rejected unless the caller holds inventory.negative-override.
CREATE TABLE stock_levels (
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  on_hand_qty numeric(20,6) NOT NULL DEFAULT 0,
  -- Average unit cost in integer minor units. The application maintains this
  -- transactionally for valuation; outbound movements preserve the average.
  avg_cost_minor bigint NOT NULL DEFAULT 0 CHECK (avg_cost_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, branch_id, product_id),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX idx_stock_levels_branch ON stock_levels(organization_id, branch_id);

-- Append-only movement ledger. Corrections are compensating movements with
-- reversal_of_movement_id referencing the movement being corrected.
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN (
    'opening', 'adjustment', 'damage', 'loss', 'write_off',
    'transfer_out', 'transfer_in', 'transfer_return', 'count_adjustment'
  )),
  -- Signed quantity in the submitted unit, plus the normalized base-unit
  -- quantity used for balances and reconciliation.
  unit_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity <> 0),
  base_quantity numeric(20,6) NOT NULL CHECK (base_quantity <> 0),
  unit_cost_minor bigint CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  reference_type text,
  reference_id uuid,
  actor_membership_id uuid,
  reason text,
  batch_no text,
  serial_no text,
  expiry_date date,
  negative_override boolean NOT NULL DEFAULT false,
  override_reason text,
  reversal_of_movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (reversal_of_movement_id, organization_id) REFERENCES stock_movements(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_movements_ledger ON stock_movements(organization_id, branch_id, product_id, seq);
CREATE INDEX idx_movements_reference ON stock_movements(organization_id, reference_type, reference_id);

CREATE TABLE stock_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('opening', 'correction', 'damage', 'loss', 'write_off')),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
  negative_override boolean NOT NULL DEFAULT false,
  override_reason text,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  UNIQUE (id, organization_id)
);

CREATE TABLE stock_adjustment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  adjustment_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity <> 0),
  base_quantity numeric(20,6) NOT NULL CHECK (base_quantity <> 0),
  unit_cost_minor bigint CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  batch_no text,
  serial_no text,
  expiry_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (adjustment_id, organization_id) REFERENCES stock_adjustments(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (adjustment_id, product_id)
);

CREATE TABLE stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  name text,
  notes text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  created_by_membership_id uuid,
  submitted_by_membership_id uuid,
  submitted_at timestamptz,
  decided_by_membership_id uuid,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (submitted_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (decided_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  UNIQUE (id, organization_id)
);

CREATE TABLE stock_count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  count_id uuid NOT NULL,
  product_id uuid NOT NULL,
  -- Snapshot of on-hand quantity when the count was created.
  expected_qty numeric(20,6) NOT NULL,
  counted_qty numeric(20,6),
  variance_qty numeric(20,6) GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
  counted_by_membership_id uuid,
  counted_at timestamptz,
  FOREIGN KEY (count_id, organization_id) REFERENCES stock_counts(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (counted_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  UNIQUE (count_id, product_id)
);

CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  source_branch_id uuid NOT NULL,
  destination_branch_id uuid NOT NULL,
  reference_code text NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'dispatched', 'partially_received', 'received', 'cancelled')),
  created_by_membership_id uuid,
  dispatched_by_membership_id uuid,
  dispatched_at timestamptz,
  completed_at timestamptz,
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (destination_branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (dispatched_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  CHECK (source_branch_id <> destination_branch_id),
  UNIQUE (organization_id, reference_code),
  UNIQUE (id, organization_id)
);

-- In-transit stock is represented by qty_dispatched > qty_received (base unit) on a line of
-- a dispatched transfer: it has left the source branch (stock_levels debited)
-- and is not yet credited to the destination. The outstanding in-transit
-- quantity per line is (qty_dispatched - qty_received - qty_cancelled).
CREATE TABLE stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  base_quantity numeric(20,6) NOT NULL CHECK (base_quantity > 0),
  qty_dispatched numeric(20,6) NOT NULL DEFAULT 0,
  qty_received numeric(20,6) NOT NULL DEFAULT 0,
  qty_cancelled numeric(20,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (transfer_id, organization_id) REFERENCES stock_transfers(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  CHECK (qty_dispatched >= 0 AND qty_dispatched <= base_quantity),
  CHECK (qty_received >= 0 AND qty_received <= qty_dispatched),
  CHECK (qty_cancelled >= 0 AND qty_cancelled <= qty_dispatched - qty_received),
  UNIQUE (transfer_id, product_id),
  UNIQUE (id, organization_id)
);

CREATE OR REPLACE FUNCTION reject_stock_movement_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only; insert a compensating movement instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements FOR EACH ROW EXECUTE FUNCTION reject_stock_movement_mutation();
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION reject_stock_movement_mutation();

CREATE TRIGGER product_categories_set_updated_at BEFORE UPDATE ON product_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER units_of_measure_set_updated_at BEFORE UPDATE ON units_of_measure FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_levels_set_updated_at BEFORE UPDATE ON stock_levels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER price_lists_set_updated_at BEFORE UPDATE ON price_lists FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER product_prices_set_updated_at BEFORE UPDATE ON product_prices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_counts_set_updated_at BEFORE UPDATE ON stock_counts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_transfers_set_updated_at BEFORE UPDATE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed common units for organizations that existed before Phase 2. New
-- organizations call the same default-unit creation logic during onboarding.
INSERT INTO units_of_measure (organization_id, code, name)
SELECT o.id, unit.code, unit.name
FROM organizations o
CROSS JOIN (VALUES
  ('EA', 'Each'),
  ('KG', 'Kilogram'),
  ('L', 'Litre'),
  ('PACK', 'Pack'),
  ('CASE', 'Case')
) AS unit(code, name)
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO permissions (code, category, description) VALUES
  ('catalog.manage', 'catalog', 'Create, update and archive products, categories, units and barcodes'),
  ('customer.read', 'sales', 'View customers'),
  ('customer.manage', 'sales', 'Create and update customers'),
  ('price-list.manage', 'pricing', 'Manage price lists and product prices'),
  ('inventory.adjust', 'inventory', 'Post opening stock and stock adjustments'),
  ('inventory.count', 'inventory', 'Create stock counts and record counted quantities'),
  ('inventory.count-approve', 'inventory', 'Approve or reject stock count variances'),
  ('inventory.transfer', 'inventory', 'Create, dispatch, receive and cancel stock transfers'),
  ('inventory.negative-override', 'inventory', 'Authorize stock operations that take balances below zero')
ON CONFLICT (code) DO NOTHING;

-- Backfill new permissions onto existing system roles so Phase 1 organizations
-- keep working after migration. Owner gets everything; the manager role gets
-- catalogue/pricing/inventory management except the negative-stock override;
-- the cashier role keeps read access plus customer.read.
INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, p.code
FROM roles r CROSS JOIN unnest(ARRAY[
  'catalog.manage', 'customer.read', 'customer.manage', 'price-list.manage',
  'inventory.adjust', 'inventory.count', 'inventory.count-approve',
  'inventory.transfer', 'inventory.negative-override'
]) AS p(code)
WHERE r.code = 'owner' AND r.is_system
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, p.code
FROM roles r CROSS JOIN unnest(ARRAY[
  'catalog.manage', 'customer.read', 'customer.manage', 'price-list.manage',
  'inventory.adjust', 'inventory.count', 'inventory.count-approve', 'inventory.transfer'
]) AS p(code)
WHERE r.code = 'manager' AND r.is_system
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, 'customer.read'
FROM roles r
WHERE r.code = 'cashier' AND r.is_system
ON CONFLICT DO NOTHING;
