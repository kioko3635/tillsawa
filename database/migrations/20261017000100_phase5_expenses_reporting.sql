-- Phase 5: expense management and operational reporting.
-- Expense financial effects reuse the append-only register cash ledger. Cash
-- payments, payment rows, workflow history and audit events commit atomically.

ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_movement_type_check;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_movement_type_check
  CHECK (movement_type IN (
    'cash_in', 'cash_out', 'cash_adjustment', 'sale_refund', 'sale_void',
    'customer_payment', 'supplier_payment', 'expense_payment'
  ));

CREATE TABLE expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9-]{1,40}$'),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (created_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE SET NULL,
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX uq_expense_categories_name
  ON expense_categories(organization_id, lower(name));

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  category_id uuid NOT NULL,
  category_code text NOT NULL,
  category_name text NOT NULL,
  expense_number text NOT NULL,
  client_transaction_id uuid NOT NULL,
  client_payload_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'paid', 'cancelled')),
  payment_status text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'pending', 'paid')),
  description text NOT NULL,
  business_purpose text,
  expense_date date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code char(3) NOT NULL DEFAULT 'KES',
  payment_method text NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'other')),
  payee_name text,
  supplier_id uuid,
  supporting_document_ref text,
  supporting_document_name text,
  created_by_membership_id uuid NOT NULL,
  submitted_by_membership_id uuid,
  submitted_at timestamptz,
  approved_by_membership_id uuid,
  approved_at timestamptz,
  rejected_by_membership_id uuid,
  rejected_at timestamptz,
  rejection_reason text,
  paid_by_membership_id uuid,
  paid_at timestamptz,
  cancelled_by_membership_id uuid,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (category_id, organization_id) REFERENCES expense_categories(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (supplier_id, organization_id) REFERENCES suppliers(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (submitted_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (rejected_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (paid_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (cancelled_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancellation_reason IS NOT NULL),
  CHECK (status <> 'paid' OR (payment_status = 'paid' AND paid_by_membership_id IS NOT NULL AND paid_at IS NOT NULL)),
  CHECK (status = 'paid' OR payment_status <> 'paid'),
  UNIQUE (organization_id, expense_number),
  UNIQUE (organization_id, client_transaction_id),
  UNIQUE (id, organization_id),
  UNIQUE (id, branch_id, organization_id)
);
CREATE INDEX idx_expenses_branch_date ON expenses(organization_id, branch_id, expense_date DESC);
CREATE INDEX idx_expenses_category ON expenses(organization_id, category_id, expense_date DESC);
CREATE INDEX idx_expenses_status ON expenses(organization_id, status, expense_date DESC);
CREATE INDEX idx_expenses_supplier ON expenses(organization_id, supplier_id);

CREATE TABLE expense_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'updated', 'submitted', 'approved', 'rejected', 'cancelled', 'payment_recorded'
  )),
  from_status text,
  to_status text,
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  reason text,
  actor_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (expense_id, branch_id, organization_id)
    REFERENCES expenses(id, branch_id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_expense_events_expense ON expense_events(organization_id, expense_id, created_at);

CREATE TABLE expense_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  register_session_id uuid,
  cash_movement_id uuid,
  payment_number text NOT NULL,
  client_transaction_id uuid NOT NULL,
  client_payload_hash char(64) NOT NULL,
  method text NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'mobile_money', 'other')),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL,
  payment_reference text,
  paid_by_membership_id uuid NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (expense_id, branch_id, organization_id)
    REFERENCES expenses(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_session_id, branch_id, organization_id)
    REFERENCES register_sessions(id, branch_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (cash_movement_id, organization_id)
    REFERENCES cash_movements(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (paid_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  CHECK (
    (method = 'cash' AND status = 'completed' AND register_session_id IS NOT NULL AND cash_movement_id IS NOT NULL AND completed_at IS NOT NULL) OR
    (method <> 'cash' AND status = 'pending' AND register_session_id IS NULL AND cash_movement_id IS NULL AND completed_at IS NULL) OR
    (status = 'cancelled')
  ),
  UNIQUE (organization_id, payment_number),
  UNIQUE (organization_id, client_transaction_id),
  UNIQUE (organization_id, expense_id),
  UNIQUE (id, organization_id),
  UNIQUE (id, branch_id, organization_id)
);
CREATE INDEX idx_expense_payments_expense ON expense_payments(organization_id, expense_id, created_at DESC);
CREATE INDEX idx_expense_payments_session ON expense_payments(organization_id, register_session_id);

CREATE TRIGGER expense_categories_set_updated_at BEFORE UPDATE ON expense_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions (code, category, description) VALUES
  ('expense.view', 'operations', 'View expense records and history'),
  ('expense.create', 'operations', 'Create and edit draft expenses'),
  ('expense.submit', 'operations', 'Submit draft expenses for approval'),
  ('expense.approve', 'operations', 'Approve submitted expenses'),
  ('expense.reject', 'operations', 'Reject submitted expenses'),
  ('expense.pay', 'operations', 'Record approved expense payments'),
  ('expense.cancel', 'operations', 'Cancel unpaid expenses'),
  ('expense.adjust', 'operations', 'Adjust submitted expenses before approval'),
  ('expense-category.manage', 'operations', 'Manage expense categories')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, permission.code
FROM roles r
JOIN (VALUES
  ('expense.view'), ('expense.create'), ('expense.submit'), ('expense.approve'),
  ('expense.reject'), ('expense.pay'), ('expense.cancel'), ('expense.adjust'),
  ('expense-category.manage')
) AS permission(code) ON true
WHERE r.code = 'owner'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, permission.code
FROM roles r
JOIN (VALUES
  ('expense.view'), ('expense.create'), ('expense.submit'), ('expense.approve'),
  ('expense.reject'), ('expense.pay'), ('expense.cancel'), ('expense.adjust'),
  ('expense-category.manage'), ('reports.view'), ('reports.export')
) AS permission(code) ON true
WHERE r.code = 'manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, permission.code
FROM roles r
JOIN (VALUES ('expense.view'), ('expense.create'), ('expense.submit'))
  AS permission(code) ON true
WHERE r.code = 'cashier'
ON CONFLICT DO NOTHING;

INSERT INTO expense_categories (organization_id, code, name, description)
SELECT o.id, category.code, category.name, category.description
FROM organizations o
JOIN (VALUES
  ('OPERATIONS', 'Operations', 'General operating and administrative costs'),
  ('RENT', 'Rent and premises', 'Rent, service charge and premises costs'),
  ('UTILITIES', 'Utilities', 'Electricity, water, internet and communication costs'),
  ('TRANSPORT', 'Transport', 'Delivery, logistics and travel costs'),
  ('SUPPLIES', 'Supplies', 'Packaging, cleaning and office supplies'),
  ('SALARIES', 'Salaries and wages', 'Approved staff salary and wage payments')
) AS category(code, name, description) ON true
ON CONFLICT (organization_id, code) DO NOTHING;
