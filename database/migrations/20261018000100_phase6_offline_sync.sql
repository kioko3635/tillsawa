UPDATE sync_contract_versions
SET status = 'deprecated'
WHERE version = '1';

INSERT INTO sync_contract_versions (version, status)
VALUES ('2', 'active')
ON CONFLICT (version) DO UPDATE SET status = 'active';

UPDATE registered_devices
SET contract_version = '2'
WHERE contract_version = '1';

ALTER TABLE registered_devices
  ALTER COLUMN contract_version SET DEFAULT '2';

ALTER TABLE sales
  ADD COLUMN client_created_at timestamptz;

CREATE TABLE sync_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES registered_devices(id),
  branch_id uuid NOT NULL,
  client_transaction_id uuid NOT NULL,
  entity_type text NOT NULL,
  payload_hash char(64) NOT NULL,
  payload jsonb NOT NULL,
  client_occurred_at timestamptz NOT NULL,
  cashier_membership_id uuid,
  submitted_by_membership_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'accepted', 'duplicate', 'retryable', 'rejected', 'conflict', 'resolved'
  )),
  sale_id uuid,
  server_entity_type text,
  server_entity_id uuid,
  receipt_number text,
  error_code text,
  error_message text,
  error_details jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  processed_at timestamptz,
  resolution_action text CHECK (resolution_action IN (
    'retry', 'accept-current-price', 'override-negative-stock', 'cancel-local'
  )),
  resolution_reason text,
  resolved_by_membership_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id),
  FOREIGN KEY (cashier_membership_id, organization_id) REFERENCES memberships(id, organization_id),
  FOREIGN KEY (submitted_by_membership_id, organization_id) REFERENCES memberships(id, organization_id),
  FOREIGN KEY (resolved_by_membership_id, organization_id) REFERENCES memberships(id, organization_id),
  FOREIGN KEY (sale_id, organization_id) REFERENCES sales(id, organization_id),
  UNIQUE (organization_id, client_transaction_id)
);

CREATE INDEX sync_transactions_device_idx
  ON sync_transactions (organization_id, device_id, created_at);
CREATE INDEX sync_transactions_status_idx
  ON sync_transactions (organization_id, status, updated_at);
CREATE INDEX sync_transactions_actor_idx
  ON sync_transactions (organization_id, cashier_membership_id, created_at);

CREATE TABLE sync_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  sync_transaction_id uuid NOT NULL REFERENCES sync_transactions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES registered_devices(id),
  client_transaction_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'duplicate', 'retryable', 'rejected', 'conflict', 'resolved')),
  error_code text,
  error_message text,
  server_entity_id uuid,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sync_transaction_id, attempt_number),
  FOREIGN KEY (client_transaction_id, organization_id) REFERENCES sync_transactions(client_transaction_id, organization_id)
);

CREATE INDEX sync_attempts_transaction_idx
  ON sync_attempts (organization_id, sync_transaction_id, created_at);

CREATE OR REPLACE FUNCTION ensure_sync_transaction_tenant()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM registered_devices d
    WHERE d.id = NEW.device_id
      AND d.organization_id = NEW.organization_id
      AND d.branch_id = NEW.branch_id
  ) THEN
    RAISE EXCEPTION 'Sync transaction device must belong to the transaction organization and branch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_transactions_tenant_integrity
  BEFORE INSERT OR UPDATE ON sync_transactions
  FOR EACH ROW EXECUTE FUNCTION ensure_sync_transaction_tenant();

INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, 'sync.resolve-conflict'
FROM roles r
WHERE r.code = 'manager' AND r.is_system = true
ON CONFLICT DO NOTHING;

COMMENT ON TABLE sync_transactions IS 'Durable server-side result journal for versioned offline client transactions. Rows are retained after acceptance so network retries replay the authoritative result rather than duplicating business effects.';
COMMENT ON TABLE sync_attempts IS 'Append-only attempt history for offline synchronization; business transaction and outcome remain committed together or not at all.';
COMMENT ON COLUMN sales.client_created_at IS 'Original device timestamp retained for troubleshooting; sold_at remains the authoritative server timestamp.';
