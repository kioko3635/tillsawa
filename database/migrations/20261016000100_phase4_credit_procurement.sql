-- Phase 4: customer credit, supplier procurement and AP/AR foundations.
-- Financial rows remain tenant-scoped and monetary values remain integer minor
-- units. Receipts post stock through the existing append-only inventory ledger.

ALTER TABLE customers
  ADD COLUMN contact_person text,
  ADD COLUMN address text,
  ADD COLUMN tax_pin text CHECK (tax_pin IS NULL OR tax_pin ~ '^[A-Z0-9]{5,20}$'),
  ADD COLUMN notes text,
  ADD COLUMN credit_status text NOT NULL DEFAULT 'disabled'
    CHECK (credit_status IN ('disabled', 'active', 'hold')),
  ADD COLUMN credit_limit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_limit_minor >= 0),
  ADD COLUMN payment_terms_days integer NOT NULL DEFAULT 0
    CHECK (payment_terms_days >= 0 AND payment_terms_days <= 365),
  ADD COLUMN credit_reason text,
  ADD COLUMN credit_updated_by_membership_id uuid,
  ADD COLUMN credit_updated_at timestamptz,
  ADD FOREIGN KEY (credit_updated_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE SET NULL;

ALTER TABLE sales
  ADD COLUMN credit_due_date date;

ALTER TABLE sale_payments DROP CONSTRAINT sale_payments_method_check;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_method_check
  CHECK (method IN ('cash', 'credit'));
ALTER TABLE sale_payments DROP CONSTRAINT sale_payments_status_check;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_status_check
  CHECK (status IN ('completed', 'voided', 'partially_refunded', 'refunded', 'outstanding', 'partially_paid', 'paid'));
ALTER TABLE sale_payments DROP CONSTRAINT sale_payments_check;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_check
  CHECK (
    (method = 'cash' AND amount_tendered_minor >= amount_minor) OR
    (method = 'credit' AND amount_tendered_minor = 0 AND change_minor = 0)
  );

ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_movement_type_check;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_movement_type_check
  CHECK (movement_type IN (
    'cash_in', 'cash_out', 'cash_adjustment', 'sale_refund', 'sale_void',
    'customer_payment', 'supplier_payment'
  ));

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN (
    'opening', 'adjustment', 'damage', 'loss', 'write_off',
    'transfer_out', 'transfer_in', 'transfer_return', 'count_adjustment',
    'sale', 'sale_void', 'sale_return', 'purchase_receipt'
  ));

CREATE TABLE document_sequences (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sequence_key text NOT NULL CHECK (sequence_key ~ '^[A-Z-]{2,32}$'),
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, sequence_key)
);

CREATE TABLE customer_credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  customer_id uuid NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN (
    'sale_charge', 'payment', 'return_credit', 'sale_void',
    'debit_adjustment', 'credit_adjustment', 'write_off'
  )),
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  sale_id uuid,
  reference_type text,
  reference_id uuid,
  due_date date,
  reason text,
  actor_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, organization_id) REFERENCES customers(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_id, organization_id) REFERENCES sales(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  CHECK (
    (transaction_type = 'sale_charge' AND direction = 'debit' AND sale_id IS NOT NULL) OR
    (transaction_type <> 'sale_charge' AND direction = 'credit' OR transaction_type = 'debit_adjustment' AND direction = 'debit')
  ),
  UNIQUE (id, organization_id),
  UNIQUE (id, customer_id, organization_id)
);
CREATE UNIQUE INDEX uq_credit_sale_charge ON customer_credit_transactions(organization_id, sale_id)
  WHERE transaction_type = 'sale_charge';
CREATE INDEX idx_credit_transactions_customer ON customer_credit_transactions(organization_id, customer_id, created_at);
CREATE INDEX idx_credit_transactions_sale ON customer_credit_transactions(organization_id, sale_id);

CREATE TABLE customer_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  register_session_id uuid NOT NULL,
  payment_number text NOT NULL,
  client_transaction_id uuid NOT NULL,
  method text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  reason text NOT NULL,
  received_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, organization_id) REFERENCES customers(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_session_id, branch_id, organization_id)
    REFERENCES register_sessions(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (received_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, client_transaction_id),
  UNIQUE (organization_id, payment_number),
  UNIQUE (id, organization_id),
  UNIQUE (id, branch_id, organization_id)
);
CREATE INDEX idx_customer_payments_customer ON customer_payments(organization_id, customer_id, created_at DESC);

CREATE TABLE customer_credit_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  source_transaction_id uuid NOT NULL,
  customer_payment_id uuid,
  sale_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_transaction_id, organization_id)
    REFERENCES customer_credit_transactions(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_payment_id, organization_id)
    REFERENCES customer_payments(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_id, branch_id, organization_id)
    REFERENCES sales(id, branch_id, organization_id) ON DELETE RESTRICT,
  UNIQUE (customer_payment_id, sale_id),
  UNIQUE (source_transaction_id, sale_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_credit_allocations_sale ON customer_credit_allocations(organization_id, sale_id);

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,40}$'),
  name text NOT NULL,
  contact_person text,
  phone text,
  email citext,
  address text,
  tax_pin text CHECK (tax_pin IS NULL OR tax_pin ~ '^[A-Z0-9]{5,20}$'),
  supplier_reference text,
  payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0 AND payment_terms_days <= 365),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes text,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (created_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  po_number text NOT NULL,
  client_transaction_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'submitted', 'approved', 'partially_received', 'received', 'cancelled'
  )),
  expected_delivery_date date,
  supplier_reference text,
  notes text,
  total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  created_by_membership_id uuid NOT NULL,
  submitted_by_membership_id uuid,
  submitted_at timestamptz,
  approved_by_membership_id uuid,
  approved_at timestamptz,
  cancelled_by_membership_id uuid,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (supplier_id, organization_id) REFERENCES suppliers(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (submitted_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (cancelled_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, po_number),
  UNIQUE (organization_id, client_transaction_id),
  UNIQUE (id, organization_id),
  UNIQUE (id, branch_id, organization_id)
);
CREATE INDEX idx_purchase_orders_branch ON purchase_orders(organization_id, branch_id, created_at DESC);
CREATE INDEX idx_purchase_orders_supplier ON purchase_orders(organization_id, supplier_id, created_at DESC);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_sku text NOT NULL,
  product_name text NOT NULL,
  unit_id uuid NOT NULL,
  unit_code text NOT NULL,
  ordered_qty numeric(20,6) NOT NULL CHECK (ordered_qty > 0),
  base_ordered_qty numeric(20,6) NOT NULL CHECK (base_ordered_qty > 0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  received_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  damaged_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  rejected_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purchase_order_id, organization_id)
    REFERENCES purchase_orders(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  CHECK (received_qty + damaged_qty + rejected_qty <= ordered_qty),
  UNIQUE (purchase_order_id, product_id),
  UNIQUE (id, organization_id),
  UNIQUE (id, purchase_order_id, organization_id)
);

CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  receipt_number text NOT NULL,
  client_transaction_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
  notes text,
  received_by_membership_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (purchase_order_id, branch_id, organization_id)
    REFERENCES purchase_orders(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (received_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, receipt_number),
  UNIQUE (organization_id, client_transaction_id),
  UNIQUE (id, organization_id),
  UNIQUE (id, purchase_order_id, organization_id)
);
CREATE INDEX idx_goods_receipts_po ON goods_receipts(organization_id, purchase_order_id, received_at DESC);

CREATE TABLE goods_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  goods_receipt_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  purchase_order_line_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  ordered_qty numeric(20,6) NOT NULL CHECK (ordered_qty > 0),
  received_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  damaged_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  rejected_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  base_received_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (base_received_qty >= 0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  discrepancy_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (goods_receipt_id, organization_id)
    REFERENCES goods_receipts(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (purchase_order_line_id, purchase_order_id, organization_id)
    REFERENCES purchase_order_lines(id, purchase_order_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, organization_id) REFERENCES units_of_measure(id, organization_id) ON DELETE RESTRICT,
  CHECK (received_qty + damaged_qty + rejected_qty > 0),
  UNIQUE (goods_receipt_id, purchase_order_line_id),
  UNIQUE (id, organization_id)
);

CREATE TABLE supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  purchase_order_id uuid,
  invoice_number text NOT NULL,
  client_transaction_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'outstanding'
    CHECK (status IN ('outstanding', 'partially_paid', 'paid', 'voided')),
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  notes text,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (supplier_id, organization_id) REFERENCES suppliers(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (purchase_order_id, branch_id, organization_id)
    REFERENCES purchase_orders(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, supplier_id, invoice_number),
  UNIQUE (organization_id, client_transaction_id),
  UNIQUE (id, organization_id),
  UNIQUE (id, branch_id, organization_id)
);
CREATE INDEX idx_supplier_invoices_supplier ON supplier_invoices(organization_id, supplier_id, created_at DESC);

CREATE TABLE supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  register_session_id uuid NOT NULL,
  payment_number text NOT NULL,
  client_transaction_id uuid NOT NULL,
  method text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  reason text NOT NULL,
  paid_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (supplier_id, organization_id) REFERENCES suppliers(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_session_id, branch_id, organization_id)
    REFERENCES register_sessions(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (paid_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, client_transaction_id),
  UNIQUE (organization_id, payment_number),
  UNIQUE (id, organization_id),
  UNIQUE (id, branch_id, organization_id)
);
CREATE INDEX idx_supplier_payments_supplier ON supplier_payments(organization_id, supplier_id, created_at DESC);

CREATE TABLE supplier_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_payment_id uuid NOT NULL,
  supplier_invoice_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (supplier_payment_id, organization_id)
    REFERENCES supplier_payments(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (supplier_invoice_id, branch_id, organization_id)
    REFERENCES supplier_invoices(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (supplier_id, organization_id) REFERENCES suppliers(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (supplier_payment_id, supplier_invoice_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_supplier_payment_allocations_invoice
  ON supplier_payment_allocations(organization_id, supplier_invoice_id);

CREATE TRIGGER suppliers_set_updated_at BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER purchase_orders_set_updated_at BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER supplier_invoices_set_updated_at BEFORE UPDATE ON supplier_invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions (code, category, description) VALUES
  ('sales.credit', 'sales', 'Complete a customer credit sale'),
  ('credit.override', 'sales', 'Authorize a credit sale above the customer limit'),
  ('credit.view', 'sales', 'View customer credit balances and statements'),
  ('credit.manage', 'sales', 'Configure customer credit status, limits and terms'),
  ('credit.collect', 'sales', 'Collect and allocate customer payments'),
  ('credit.adjust', 'sales', 'Post authorized customer credit adjustments'),
  ('credit.write-off', 'sales', 'Write off customer credit balances'),
  ('supplier.read', 'procurement', 'View suppliers and balances'),
  ('supplier.manage', 'procurement', 'Create and update suppliers'),
  ('purchase.read', 'procurement', 'View purchase orders and receipts'),
  ('purchase.create', 'procurement', 'Create and submit purchase orders'),
  ('purchase.approve', 'procurement', 'Approve purchase orders'),
  ('purchase.receive', 'procurement', 'Receive goods against purchase orders'),
  ('purchase.cancel', 'procurement', 'Cancel purchase orders'),
  ('supplier-invoice.manage', 'procurement', 'Record supplier invoices'),
  ('supplier-payment.record', 'procurement', 'Record and allocate supplier payments')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, permission.code
FROM roles r
JOIN (VALUES
  ('sales.credit'), ('credit.override'), ('credit.view'), ('credit.manage'),
  ('credit.collect'), ('credit.adjust'), ('credit.write-off'),
  ('supplier.read'), ('supplier.manage'), ('purchase.read'), ('purchase.create'),
  ('purchase.approve'), ('purchase.receive'), ('purchase.cancel'),
  ('supplier-invoice.manage'), ('supplier-payment.record')
) AS permission(code) ON true
WHERE r.code = 'owner'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, permission.code
FROM roles r
JOIN (VALUES
  ('sales.credit'), ('credit.view'), ('credit.manage'), ('credit.collect'),
  ('credit.adjust'), ('supplier.read'), ('supplier.manage'), ('purchase.read'),
  ('purchase.create'), ('purchase.approve'), ('purchase.receive'),
  ('purchase.cancel'), ('supplier-invoice.manage'), ('supplier-payment.record')
) AS permission(code) ON true
WHERE r.code = 'manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, permission.code
FROM roles r
JOIN (VALUES ('credit.view'), ('credit.collect'), ('supplier.read'), ('purchase.read'))
  AS permission(code) ON true
WHERE r.code = 'cashier'
ON CONFLICT DO NOTHING;
