INSERT INTO permissions(code,category,description) VALUES
 ('stores.view','reports','View linked-store reporting'),
 ('stores.manage','reports','Manage linked stores and outbound reporting connections')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM roles r
CROSS JOIN (VALUES ('stores.view'),('stores.manage')) p(code)
WHERE r.code='owner' AND r.is_system ON CONFLICT DO NOTHING;

CREATE TABLE network_stores (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 code text NOT NULL, name text NOT NULL,
 token_hash char(64) NOT NULL,
 pairing_expires_at timestamptz,
 revoked_at timestamptz,
 source_organization_id uuid, source_branch_id uuid,
 last_sequence bigint NOT NULL DEFAULT 0,
 last_snapshot_id uuid,
 last_received_at timestamptz,
 snapshot jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,code), UNIQUE(id,organization_id)
);
CREATE UNIQUE INDEX network_one_source ON network_stores(organization_id,source_organization_id,source_branch_id)
 WHERE source_organization_id IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE network_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 branch_id uuid NOT NULL,
 hub_url text NOT NULL, hub_store_id uuid NOT NULL,
 encrypted_token text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 next_sequence bigint NOT NULL DEFAULT 0,
 pending_snapshot jsonb,
 last_success_at timestamptz,
 last_attempt_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(branch_id,organization_id) REFERENCES branches(id,organization_id),
 UNIQUE(organization_id,branch_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['network_stores','network_links'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL USING (public.pos_is_system() OR organization_id=public.pos_organization_id()) WITH CHECK (public.pos_is_system() OR organization_id=public.pos_organization_id())',t);
 END LOOP;
END $$;
