CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'KES',
  timezone text NOT NULL DEFAULT 'Africa/Nairobi',
  tax_pricing_mode text NOT NULL DEFAULT 'inclusive' CHECK (tax_pricing_mode IN ('inclusive', 'exclusive')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9-]+$'),
  name text NOT NULL,
  timezone text,
  currency_code char(3),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  category text NOT NULL,
  description text NOT NULL
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9-]+$'),
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_code),
  FOREIGN KEY (role_id, organization_id) REFERENCES roles(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text,
  all_branches boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (id, organization_id)
);

CREATE TABLE membership_roles (
  membership_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, role_id),
  FOREIGN KEY (membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id, organization_id) REFERENCES roles(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE membership_branches (
  membership_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, branch_id),
  FOREIGN KEY (membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  FOREIGN KEY (membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE CASCADE,
  UNIQUE (id, organization_id)
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  session_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  rotated_at timestamptz,
  replaced_by_token_id uuid,
  revoked_at timestamptz,
  FOREIGN KEY (session_id, organization_id) REFERENCES auth_sessions(id, organization_id) ON DELETE CASCADE,
  CHECK (replaced_by_token_id IS NULL OR replaced_by_token_id <> id)
);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  requested_by_ip inet,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE registered_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  name text NOT NULL,
  platform text,
  device_key_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  contract_version text NOT NULL DEFAULT '1',
  created_by_membership_id uuid,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, name),
  UNIQUE (id, organization_id)
);

CREATE TABLE sync_contract_versions (
  version text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('active', 'deprecated', 'retired')),
  released_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_cursors (
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL,
  entity_type text NOT NULL,
  branch_id uuid,
  cursor_value bigint NOT NULL DEFAULT 0 CHECK (cursor_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, device_id, entity_type),
  FOREIGN KEY (device_id, organization_id) REFERENCES registered_devices(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE idempotency_records (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_membership_id uuid,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (organization_id, scope, idempotency_key),
  FOREIGN KEY (actor_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id uuid,
  actor_membership_id uuid,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_membership_id, organization_id) REFERENCES memberships(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (device_id, organization_id) REFERENCES registered_devices(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX idx_branches_org ON branches(organization_id);
CREATE INDEX idx_memberships_org_user ON memberships(organization_id, user_id);
CREATE INDEX idx_membership_branches_branch ON membership_branches(organization_id, branch_id);
CREATE INDEX idx_auth_sessions_membership ON auth_sessions(organization_id, membership_id);
CREATE INDEX idx_refresh_tokens_session ON refresh_tokens(session_id);
CREATE INDEX idx_password_reset_membership ON password_reset_tokens(organization_id, membership_id);
CREATE INDEX idx_devices_org_branch ON registered_devices(organization_id, branch_id);
CREATE INDEX idx_audit_org_created ON audit_events(organization_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_events(organization_id, entity_type, entity_id);
CREATE INDEX idx_idempotency_actor ON idempotency_records(organization_id, actor_membership_id);

CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER branches_set_updated_at BEFORE UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER registered_devices_set_updated_at BEFORE UPDATE ON registered_devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sync_cursors_set_updated_at BEFORE UPDATE ON sync_cursors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions (code, category, description) VALUES
  ('organization.read', 'tenancy', 'View organization settings'),
  ('organization.update', 'tenancy', 'Update organization settings'),
  ('branch.read', 'tenancy', 'View branches'),
  ('branch.create', 'tenancy', 'Create branches'),
  ('branch.update', 'tenancy', 'Update branches'),
  ('user.read', 'identity', 'View organization users'),
  ('user.invite', 'identity', 'Create or invite users'),
  ('user.update', 'identity', 'Update membership access'),
  ('user.deactivate', 'identity', 'Suspend organization memberships'),
  ('role.read', 'identity', 'View roles and permissions'),
  ('role.manage', 'identity', 'Manage roles and permissions'),
  ('device.read', 'sync', 'View registered devices'),
  ('device.register', 'sync', 'Register POS devices'),
  ('device.revoke', 'sync', 'Suspend or revoke devices'),
  ('settings.manage', 'tenancy', 'Manage organization settings'),
  ('session.manage', 'identity', 'Manage authentication sessions'),
  ('audit.view', 'security', 'View audit events'),
  ('sync.read', 'sync', 'Read synchronization state'),
  ('sync.write', 'sync', 'Submit synchronization state'),
  ('sync.resolve-conflict', 'sync', 'Resolve synchronization conflicts'),
  ('catalog.read', 'catalog', 'View product catalog'),
  ('price-list.read', 'pricing', 'View price lists'),
  ('pos.sell', 'sales', 'Create POS sales'),
  ('sale.read', 'sales', 'View sales'),
  ('inventory.read', 'inventory', 'View inventory'),
  ('reports.view', 'reporting', 'View reports'),
  ('reports.export', 'reporting', 'Export reports')
ON CONFLICT (code) DO NOTHING;

INSERT INTO sync_contract_versions (version, status) VALUES ('1', 'active')
ON CONFLICT (version) DO NOTHING;
