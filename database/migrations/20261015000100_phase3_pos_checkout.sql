-- Phase 3: POS checkout, cash sales, registers, receipts, returns and refunds.
-- Money remains integer minor units (bigint, scale 2). Quantities remain
-- numeric(20,6). Stock effects are posted through the append-only ledger.

ALTER TABLE organizations
  ADD COLUMN default_tax_rate_bps bigint NOT NULL DEFAULT 1600
    CHECK (default_tax_rate_bps >= 0 AND default_tax_rate_bps <= 10000),
  ADD COLUMN receipt_policy text NOT NULL DEFAULT 'Returns and refunds require authorization. Goods must be accompanied by the original receipt.';

ALTER TABLE products
  ADD COLUMN tax_rate_bps bigint
    CHECK (tax_rate_bps IS NULL OR (tax_rate_bps >= 0 AND tax_rate_bps <= 10000));

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN (
    'opening', 'adjustment', 'damage', 'loss', 'write_off',
    'transfer_out', 'transfer_in', 'transfer_return', 'count_adjustment',
    'sale', 'sale_void', 'sale_return'
  ));

CREATE TABLE pos_registers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9-]{1,32}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  receipt_prefix text NOT NULL CHECK (receipt_prefix ~ '^[A-Z0-9-]{1,16}$'),
  receipt_footer text,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  UNIQUE (organization_id, branch_id, code),
  UNIQUE (id, branch_id, organization_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_pos_registers_branch ON pos_registers(organization_id, branch_id, status);

CREATE TABLE register_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  register_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opening_float_minor bigint NOT NULL DEFAULT 0 CHECK (opening_float_minor >= 0),
  next_receipt_seq integer NOT NULL DEFAULT 1 CHECK (next_receipt_seq > 0),
  opened_by_membership_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by_membership_id uuid,
  closed_at timestamptz,
  counted_cash_minor bigint CHECK (counted_cash_minor IS NULL OR counted_cash_minor >= 0),
  expected_cash_minor bigint,
  cash_variance_minor bigint,
  close_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (register_id, branch_id, organization_id) REFERENCES pos_registers(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (opened_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (closed_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id),
  UNIQUE (id, branch_id, organization_id)
);
CREATE UNIQUE INDEX uq_register_sessions_open_register
  ON register_sessions(organization_id, register_id) WHERE status = 'open';
CREATE UNIQUE INDEX uq_register_sessions_open_operator
  ON register_sessions(organization_id, opened_by_membership_id) WHERE status = 'open';
CREATE INDEX idx_register_sessions_branch ON register_sessions(organization_id, branch_id, opened_at DESC);

CREATE TABLE cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  register_session_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('cash_in', 'cash_out', 'cash_adjustment', 'sale_refund', 'sale_void')),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL,
  reference_type text,
  reference_id uuid,
  actor_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (register_session_id, branch_id, organization_id) REFERENCES register_sessions(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_cash_movements_session ON cash_movements(organization_id, register_session_id, created_at);

CREATE TABLE sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  register_id uuid NOT NULL,
  register_session_id uuid NOT NULL,
  cashier_membership_id uuid NOT NULL,
  customer_id uuid,
  client_transaction_id uuid NOT NULL,
  receipt_number text NOT NULL,
  receipt_seq integer NOT NULL CHECK (receipt_seq > 0),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'partially_returned', 'returned', 'voided')),
  currency_code char(3) NOT NULL DEFAULT 'KES',
  tax_pricing_mode text NOT NULL CHECK (tax_pricing_mode IN ('inclusive', 'exclusive')),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_total_minor bigint NOT NULL DEFAULT 0 CHECK (discount_total_minor >= 0),
  tax_total_minor bigint NOT NULL DEFAULT 0 CHECK (tax_total_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  total_cost_minor bigint NOT NULL DEFAULT 0 CHECK (total_cost_minor >= 0),
  device_id uuid,
  sold_at timestamptz NOT NULL DEFAULT now(),
  voided_by_membership_id uuid,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_id, branch_id, organization_id) REFERENCES pos_registers(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_session_id, branch_id, organization_id) REFERENCES register_sessions(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (cashier_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, organization_id) REFERENCES customers(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (device_id, organization_id) REFERENCES registered_devices(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, client_transaction_id),
  UNIQUE (organization_id, receipt_number),
  UNIQUE (id, organization_id),
  UNIQUE (id, branch_id, organization_id)
);
CREATE INDEX idx_sales_branch_time ON sales(organization_id, branch_id, sold_at DESC);
CREATE INDEX idx_sales_session ON sales(organization_id, register_session_id);
CREATE INDEX idx_sales_cashier ON sales(organization_id, cashier_membership_id, sold_at DESC);

CREATE TABLE sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_sku text NOT NULL,
  product_name text NOT NULL,
  unit_id uuid NOT NULL,
  unit_code text NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  base_quantity numeric(20,6) NOT NULL CHECK (base_quantity > 0),
  list_price_minor bigint NOT NULL CHECK (list_price_minor >= 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  discount_pct numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_rate_bps bigint NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  cost_total_minor bigint NOT NULL DEFAULT 0 CHECK (cost_total_minor >= 0),
  price_list_id uuid,
  price_line_id uuid,
  batch_no text,
  serial_no text,
  expiry_date date,
  returned_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0 AND returned_qty <= quantity),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_id, organization_id) REFERENCES sales(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (price_list_id, organization_id) REFERENCES price_lists(id, organization_id) ON DELETE SET NULL,
  UNIQUE (id, organization_id),
  UNIQUE (id, sale_id, organization_id)
);

CREATE TABLE sale_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  method text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  amount_tendered_minor bigint NOT NULL CHECK (amount_tendered_minor >= 0),
  change_minor bigint NOT NULL DEFAULT 0 CHECK (change_minor >= 0),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided', 'partially_refunded', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_id, organization_id) REFERENCES sales(id, organization_id) ON DELETE RESTRICT,
  CHECK (amount_tendered_minor >= amount_minor),
  UNIQUE (id, organization_id),
  UNIQUE (id, sale_id, organization_id)
);
CREATE INDEX idx_sale_payments_sale ON sale_payments(organization_id, sale_id);

CREATE TABLE sale_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  reason text NOT NULL,
  voided_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_id, organization_id) REFERENCES sales(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (voided_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (sale_id),
  UNIQUE (id, organization_id)
);

CREATE TABLE sale_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  return_number text NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
  reason text NOT NULL,
  refundable_total_minor bigint NOT NULL DEFAULT 0 CHECK (refundable_total_minor >= 0),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_id, branch_id, organization_id) REFERENCES sales(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, return_number),
  UNIQUE (id, organization_id),
  UNIQUE (id, sale_id, organization_id)
);
CREATE INDEX idx_sale_returns_sale ON sale_returns(organization_id, sale_id);

CREATE TABLE sale_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  sale_return_id uuid NOT NULL,
  sale_line_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  base_quantity numeric(20,6) NOT NULL CHECK (base_quantity > 0),
  disposition text NOT NULL CHECK (disposition IN ('restock', 'damaged', 'write_off')),
  refund_amount_minor bigint NOT NULL DEFAULT 0 CHECK (refund_amount_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_return_id, organization_id) REFERENCES sale_returns(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (sale_line_id, organization_id) REFERENCES sale_items(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (sale_return_id, sale_line_id),
  UNIQUE (id, organization_id)
);

CREATE TABLE sale_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  sale_return_id uuid,
  register_session_id uuid NOT NULL,
  sale_payment_id uuid NOT NULL,
  method text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  reason text NOT NULL,
  authorized_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_id, branch_id, organization_id) REFERENCES sales(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_return_id, organization_id) REFERENCES sale_returns(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_session_id, branch_id, organization_id) REFERENCES register_sessions(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_payment_id, sale_id, organization_id) REFERENCES sale_payments(id, sale_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (authorized_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_sale_refunds_sale ON sale_refunds(organization_id, sale_id);
CREATE INDEX idx_sale_refunds_session ON sale_refunds(organization_id, register_session_id);

CREATE TABLE receipt_reprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_id, organization_id) REFERENCES sales(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX idx_receipt_reprints_sale ON receipt_reprints(organization_id, sale_id, created_at DESC);

CREATE TRIGGER pos_registers_set_updated_at BEFORE UPDATE ON pos_registers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER register_sessions_set_updated_at BEFORE UPDATE ON register_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sales_set_updated_at BEFORE UPDATE ON sales FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions (code, category, description) VALUES
  ('sales.create', 'sales', 'Create and complete POS sales'),
  ('sales.view', 'sales', 'View own POS sales'),
  ('sales.view_all', 'sales', 'View all organization sales'),
  ('sales.discount', 'sales', 'Apply authorized checkout discounts'),
  ('sales.void', 'sales', 'Void authorized completed sales'),
  ('sales.return', 'sales', 'Process authorized sale returns'),
  ('sales.refund', 'sales', 'Issue authorized cash refunds'),
  ('registers.manage', 'registers', 'Create and configure POS registers'),
  ('registers.open', 'registers', 'Open a register session'),
  ('registers.close', 'registers', 'Close and reconcile a register session'),
  ('registers.cash-movement', 'registers', 'Record cash-in and cash-out movements'),
  ('receipts.reprint', 'sales', 'Reprint historical receipts')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, permission.code
FROM roles r
JOIN (VALUES
  ('sales.create'),
  ('sales.view'),
  ('sales.view_all'),
  ('sales.discount'),
  ('sales.void'),
  ('sales.return'),
  ('sales.refund'),
  ('registers.manage'),
  ('registers.open'),
  ('registers.close'),
  ('registers.cash-movement'),
  ('receipts.reprint')
) AS permission(code) ON true
WHERE r.code = 'owner'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, permission.code
FROM roles r
JOIN (VALUES
  ('sales.create'),
  ('sales.view'),
  ('sales.view_all'),
  ('sales.discount'),
  ('sales.void'),
  ('sales.return'),
  ('sales.refund'),
  ('registers.manage'),
  ('registers.open'),
  ('registers.close'),
  ('registers.cash-movement'),
  ('receipts.reprint')
) AS permission(code) ON true
WHERE r.code = 'manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, permission.code
FROM roles r
JOIN (VALUES
  ('sales.create'),
  ('sales.view'),
  ('registers.open'),
  ('registers.close'),
  ('registers.cash-movement'),
  ('receipts.reprint')
) AS permission(code) ON true
WHERE r.code = 'cashier'
ON CONFLICT DO NOTHING;
