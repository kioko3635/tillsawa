INSERT INTO module_catalog(code,name,description,kind,availability,core,depends_on,sort_order) VALUES
 ('barcode_scanner','Barcode scanner','Optional USB/Bluetooth keyboard-mode barcode input at checkout. Manual search stays available.','capability','implemented',false,'{}',180),
 ('cash_drawer','Printer-linked cash drawer','Optional ESC/POS printer drawer pulse after a confirmed paid sale; configure each physical till.','capability','implemented',false,'{}',181);
INSERT INTO organization_module_states(organization_id,module_code,enabled)
 SELECT id,code,false FROM organizations CROSS JOIN (VALUES ('barcode_scanner'),('cash_drawer')) AS hardware(code);
ALTER TABLE organization_profiles ADD COLUMN cash_drawer_policy text NOT NULL DEFAULT 'cash' CHECK(cash_drawer_policy IN ('cash','paid'));
CREATE TABLE drawer_sale_claims (
 sale_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 terminal_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(sale_id,organization_id) REFERENCES sales(id,organization_id),
 FOREIGN KEY(membership_id,organization_id) REFERENCES memberships(id,organization_id)
);
ALTER TABLE drawer_sale_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE drawer_sale_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON drawer_sale_claims FOR ALL
 USING(public.pos_is_system() OR organization_id=public.pos_organization_id())
 WITH CHECK(public.pos_is_system() OR organization_id=public.pos_organization_id());
CREATE TABLE account_recovery_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 token_hash char(64) NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 used_at timestamptz
);
CREATE INDEX account_recovery_codes_user ON account_recovery_codes(user_id);
-- Global user credentials are handled only through the system account, like login.
ALTER TABLE account_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON account_recovery_codes FOR ALL USING(public.pos_is_system()) WITH CHECK(public.pos_is_system());
