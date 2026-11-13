CREATE TABLE installation_licenses (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  envelope jsonb,
  high_water_ms bigint NOT NULL,
  state_mac text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE installation_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE installation_licenses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON installation_licenses FOR ALL
USING (public.pos_is_system() OR organization_id=public.pos_organization_id())
WITH CHECK (public.pos_is_system() OR organization_id=public.pos_organization_id());
