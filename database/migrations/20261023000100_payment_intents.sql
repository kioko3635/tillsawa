CREATE TABLE payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  register_session_id uuid NOT NULL,
  client_transaction_id uuid NOT NULL,
  cart_hash text NOT NULL,
  method text NOT NULL CHECK (method IN ('mpesa','card')),
  provider text NOT NULL CHECK (provider IN ('manual','simulator','daraja_sandbox')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled','unknown')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reference text,
  external_request_id text,
  result_message text,
  sale_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, client_transaction_id),
  UNIQUE (id, organization_id),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id),
  FOREIGN KEY (membership_id, organization_id) REFERENCES memberships(id, organization_id),
  FOREIGN KEY (register_session_id, organization_id) REFERENCES register_sessions(id, organization_id),
  FOREIGN KEY (sale_id, organization_id) REFERENCES sales(id, organization_id)
);
CREATE UNIQUE INDEX payment_reference_once ON payment_intents(organization_id,method,provider,upper(reference)) WHERE reference IS NOT NULL AND status='paid';
CREATE UNIQUE INDEX payment_provider_request_once ON payment_intents(provider,external_request_id) WHERE external_request_id IS NOT NULL;
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_intents FOR ALL USING (public.pos_is_system() OR organization_id=public.pos_organization_id()) WITH CHECK (public.pos_is_system() OR organization_id=public.pos_organization_id());
CREATE TRIGGER payment_intents_updated BEFORE UPDATE ON payment_intents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE sale_payments DROP CONSTRAINT sale_payments_method_check;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_method_check CHECK (method IN ('cash','credit','mpesa','card'));
ALTER TABLE sale_payments DROP CONSTRAINT sale_payments_check;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_check CHECK (
 (method='cash' AND amount_tendered_minor>=amount_minor) OR
 (method='credit' AND amount_tendered_minor=0 AND change_minor=0) OR
 (method IN ('mpesa','card') AND amount_tendered_minor=amount_minor AND change_minor=0)
);
ALTER TABLE sale_payments ADD COLUMN payment_intent_id uuid;
ALTER TABLE sale_payments ADD COLUMN reference text;
ALTER TABLE sale_payments ADD COLUMN verification text NOT NULL DEFAULT 'legacy';
ALTER TABLE sale_payments ADD CONSTRAINT sale_payment_intent_fk FOREIGN KEY(payment_intent_id,organization_id) REFERENCES payment_intents(id,organization_id);
CREATE UNIQUE INDEX payment_intent_single_sale ON sale_payments(payment_intent_id) WHERE payment_intent_id IS NOT NULL;
