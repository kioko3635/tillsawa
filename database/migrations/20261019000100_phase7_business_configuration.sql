-- Phase 7: tenant business profiles, industry presets and module capabilities.
-- Existing organizations receive the general-retail profile and retain every
-- implemented Phase 1-6 capability so the migration is behavior-preserving.

CREATE TABLE organization_profiles (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  business_profile text NOT NULL DEFAULT 'general_retail'
    CHECK (business_profile IN (
      'general_retail', 'wines_spirits', 'wholesale_distribution',
      'fashion_footwear', 'electronics_hardware', 'restaurant_cafe', 'services'
    )),
  default_branch_id uuid,
  contact_phone text,
  contact_email citext,
  business_address text,
  tax_pin text CHECK (tax_pin IS NULL OR tax_pin ~ '^[A-Z0-9]{5,20}$'),
  receipt_header text,
  receipt_footer text,
  receipt_logo_url text CHECK (receipt_logo_url IS NULL OR receipt_logo_url ~ '^https://\S+$'),
  configured_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (default_branch_id, organization_id)
    REFERENCES branches(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (configured_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE SET NULL
);

CREATE TABLE module_catalog (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]+$'),
  name text NOT NULL,
  description text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('module', 'capability')),
  availability text NOT NULL CHECK (availability IN ('implemented', 'planned')),
  core boolean NOT NULL DEFAULT false,
  depends_on text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 100
);

CREATE TABLE organization_module_states (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  module_code text NOT NULL REFERENCES module_catalog(code) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  configured_by_membership_id uuid,
  configured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, module_code),
  FOREIGN KEY (configured_by_membership_id, organization_id)
    REFERENCES memberships(id, organization_id) ON DELETE SET NULL
);

INSERT INTO module_catalog (code, name, description, kind, availability, core, depends_on, sort_order) VALUES
  ('catalog', 'Catalogue', 'Products, categories, units, barcodes and service/non-stock items.', 'module', 'implemented', true, '{}', 10),
  ('pricing', 'Pricing', 'Retail, wholesale, branch, customer and quantity-tiered price lists.', 'module', 'implemented', true, '{}', 20),
  ('pos', 'Point of sale', 'Registers, checkout, receipts, returns, refunds and drawer reconciliation.', 'module', 'implemented', true, '{}', 30),
  ('inventory', 'Inventory operations', 'Stock levels, adjustments, counts, transfers and inventory valuation.', 'module', 'implemented', false, '{}', 40),
  ('credit', 'Credit and receivables', 'Customer credit sales, collections, allocations, adjustments and statements.', 'module', 'implemented', false, '{}', 50),
  ('procurement', 'Procurement and payables', 'Suppliers, purchase orders, goods receipts, invoices and supplier payments.', 'module', 'implemented', false, ARRAY['inventory'], 60),
  ('expenses', 'Expenses', 'Expense categories, approval workflow, payments and expense exports.', 'module', 'implemented', false, '{}', 70),
  ('reports', 'Operational reports', 'Sales, inventory, debt, expense, trend and CSV reporting.', 'module', 'implemented', false, '{}', 80),
  ('offline_sync', 'Offline POS synchronization', 'Registered-device bootstrap, durable cash-sale replay and conflict resolution.', 'module', 'implemented', false, ARRAY['pos'], 90),
  ('service_items', 'Service items', 'Sell products marked as services without stock-level requirements.', 'capability', 'implemented', false, '{}', 100),
  ('batch_expiry_tracking', 'Batch and expiry tracking', 'Batch and expiry metadata on tracked products and stock movements.', 'capability', 'implemented', false, '{}', 110),
  ('serial_tracking', 'Serial tracking metadata', 'Serial metadata on tracked products and stock movements; not a serial lifecycle ledger.', 'capability', 'implemented', false, '{}', 120),
  ('product_variants', 'Product variants', 'Planned size, colour and related product-variant workflows.', 'capability', 'planned', false, '{}', 200),
  ('warranty_tracking', 'Warranty tracking', 'Planned warranty registration and lifecycle tracking.', 'capability', 'planned', false, '{}', 210),
  ('table_service', 'Table service', 'Planned restaurant table, seat and order-state workflows.', 'capability', 'planned', false, '{}', 220),
  ('kitchen_orders', 'Kitchen orders', 'Planned modifiers, kitchen routing and preparation status.', 'capability', 'planned', false, '{}', 230),
  ('payment_integrations', 'Payment integrations', 'Planned M-Pesa/card provider adapters, settlement and reconciliation.', 'capability', 'planned', false, '{}', 240),
  ('fiscal_etims', 'KRA eTIMS fiscal integration', 'Planned fiscal adapter pending approved KRA route, credentials and verification.', 'capability', 'planned', false, '{}', 250);

INSERT INTO organization_profiles (organization_id, business_profile, default_branch_id)
SELECT
  organization.id,
  'general_retail',
  branch.id
FROM organizations organization
LEFT JOIN LATERAL (
  SELECT id
  FROM branches
  WHERE branches.organization_id = organization.id
  ORDER BY created_at, code
  LIMIT 1
) branch ON true;

INSERT INTO organization_module_states (organization_id, module_code, enabled)
SELECT
  organization.id,
  catalog.code,
  catalog.availability = 'implemented'
FROM organizations organization
CROSS JOIN module_catalog catalog;

CREATE TRIGGER trg_organization_profiles_updated_at
  BEFORE UPDATE ON organization_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_organization_module_states_updated_at
  BEFORE UPDATE ON organization_module_states
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_organization_module_states_org_kind
  ON organization_module_states(organization_id, enabled);
