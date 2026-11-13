ALTER TABLE organization_profiles DROP CONSTRAINT organization_profiles_receipt_logo_url_check;
ALTER TABLE organization_profiles ADD CONSTRAINT organization_profiles_receipt_logo_url_check
CHECK (receipt_logo_url IS NULL OR (length(receipt_logo_url)<=150000 AND (receipt_logo_url ~ '^https://\S+$' OR receipt_logo_url ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$')));

CREATE TABLE loyalty_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  enabled boolean NOT NULL DEFAULT false,
  earn_spend_minor bigint NOT NULL DEFAULT 10000 CHECK (earn_spend_minor>0),
  redeem_value_minor bigint NOT NULL DEFAULT 100 CHECK (redeem_value_minor>0),
  minimum_redeem_points bigint NOT NULL DEFAULT 1 CHECK (minimum_redeem_points>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE loyalty_sale_summaries (
  sale_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  customer_id uuid NOT NULL,
  earned bigint NOT NULL DEFAULT 0 CHECK (earned>=0),
  redeemed bigint NOT NULL DEFAULT 0 CHECK (redeemed>=0),
  redeemed_minor bigint NOT NULL DEFAULT 0 CHECK (redeemed_minor>=0),
  reversed_earned bigint NOT NULL DEFAULT 0,
  restored_redeemed bigint NOT NULL DEFAULT 0,
  balance_after bigint NOT NULL,
  FOREIGN KEY (sale_id,organization_id) REFERENCES sales(id,organization_id),
  FOREIGN KEY (customer_id,organization_id) REFERENCES customers(id,organization_id)
);
CREATE TABLE loyalty_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  customer_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  points_delta bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('earn','redeem','reverse_earn','restore_redeem')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id,organization_id) REFERENCES customers(id,organization_id),
  FOREIGN KEY (sale_id,organization_id) REFERENCES sales(id,organization_id)
);
CREATE INDEX loyalty_customer_ledger ON loyalty_entries(organization_id,customer_id,created_at);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['loyalty_settings','loyalty_sale_summaries','loyalty_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL USING (public.pos_is_system() OR organization_id=public.pos_organization_id()) WITH CHECK (public.pos_is_system() OR organization_id=public.pos_organization_id())',t);
  END LOOP;
END $$;
