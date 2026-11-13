-- Phase 8: tenant isolation via PostgreSQL row-level security.
--
-- Design: docs/tenant-isolation.md
--
-- Tenant context is transported through two session GUCs:
--   pos.organization_id  - authenticated organization UUID, bound per checkout
--   pos.system_access    - 'on' only on the dedicated system pool connections
--
-- FORCE ROW LEVEL SECURITY is required because the application role owns the
-- tables: ENABLE alone would silently exempt the owner (the app itself).
-- Missing/empty tenant context fails closed: pos_organization_id() is NULL and
-- no policy can match.

CREATE OR REPLACE FUNCTION public.pos_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('pos.organization_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION public.pos_is_system()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('pos.system_access', true) = 'on'
$$;

COMMENT ON FUNCTION public.pos_organization_id() IS 'Authenticated organization bound to this connection; NULL when no tenant context exists (fails closed).';
COMMENT ON FUNCTION public.pos_is_system() IS 'True only on the dedicated system pool used for registration/login/migrations/test setup.';

-- Every tenant-owned table already carries organization_id. Enumerate them at
-- apply time and attach a uniform all-operations policy. The expected count is
-- asserted so silent schema drift cannot leave a table uncovered.
DO $$
DECLARE
  table_row record;
  table_count integer := 0;
BEGIN
  FOR table_row IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    table_count := table_count + 1;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_row.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_row.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL USING (public.pos_is_system() OR organization_id = public.pos_organization_id()) WITH CHECK (public.pos_is_system() OR organization_id = public.pos_organization_id())',
      table_row.relname
    );
  END LOOP;
  IF table_count <> 61 THEN
    RAISE EXCEPTION 'tenant RLS inventory mismatch: expected 61 organization-scoped tables, found %', table_count;
  END IF;
END $$;

-- organizations: the tenant key is the row itself.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.organizations FOR ALL
  USING (public.pos_is_system() OR id = public.pos_organization_id())
  WITH CHECK (public.pos_is_system() OR id = public.pos_organization_id());

-- users: global identity table. A user may hold memberships in multiple
-- organizations, so rows are visible to a tenant only while the user is one of
-- its members. Inserts carry no tenant data (invite/registration create users);
-- updates and deletes stay on the system path.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_select ON public.users FOR SELECT
  USING (
    public.pos_is_system()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = users.id AND m.organization_id = public.pos_organization_id()
    )
  );
CREATE POLICY users_insert ON public.users FOR INSERT WITH CHECK (true);
CREATE POLICY users_update ON public.users FOR UPDATE
  USING (public.pos_is_system())
  WITH CHECK (public.pos_is_system());
CREATE POLICY users_delete ON public.users FOR DELETE
  USING (public.pos_is_system());

-- Global read-only catalogs: selectable by every context, writable only on the
-- system path (migrations/seed maintenance).
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON public.permissions FOR SELECT USING (true);
CREATE POLICY catalog_system_write ON public.permissions FOR ALL
  USING (public.pos_is_system()) WITH CHECK (public.pos_is_system());

ALTER TABLE public.module_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON public.module_catalog FOR SELECT USING (true);
CREATE POLICY catalog_system_write ON public.module_catalog FOR ALL
  USING (public.pos_is_system()) WITH CHECK (public.pos_is_system());

ALTER TABLE public.sync_contract_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_contract_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON public.sync_contract_versions FOR SELECT USING (true);
CREATE POLICY catalog_system_write ON public.sync_contract_versions FOR ALL
  USING (public.pos_is_system()) WITH CHECK (public.pos_is_system());

ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schema_migrations FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON public.schema_migrations FOR SELECT USING (true);
CREATE POLICY catalog_system_write ON public.schema_migrations FOR ALL
  USING (public.pos_is_system()) WITH CHECK (public.pos_is_system());
