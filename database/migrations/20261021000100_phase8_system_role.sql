-- Phase 8 follow-up: bind the system exemption to database role identity.
--
-- The previous revision keyed pos_is_system() on the custom session GUC
-- pos.system_access. Custom GUCs can be SET by any role, so the ordinary
-- application role could escalate itself to full cross-tenant access
-- (verified: SET pos.system_access='on' as kenya_pos_app exposed every
-- organization and allowed cross-tenant UPDATE).
--
-- The exemption is now bound to session_user: only connections authenticated
-- as pos_system (or a role granted pos_system membership) satisfy
-- pos_is_system(). session_user cannot be forged by SET, set_config or
-- parameterized SQL, and kenya_pos_app holds no membership in pos_system so
-- SET ROLE / SET SESSION AUTHORIZATION into it is rejected.
--
-- pos_system is provisioned outside the migration runner by a database
-- administrator (database/provisioning/system-role.sql) because the runtime
-- role intentionally lacks CREATEROLE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_system') THEN
    RAISE EXCEPTION 'pos_system role is missing; run database/provisioning/system-role.sql as a database administrator before applying this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_system' AND (rolsuper OR rolbypassrls OR rolcreaterole)) THEN
    RAISE EXCEPTION 'pos_system must not be superuser, BYPASSRLS or CREATEROLE';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pos_is_system()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT pg_has_role(session_user, 'pos_system', 'member')
$$;

COMMENT ON FUNCTION public.pos_is_system() IS 'True only when the authenticated login (session_user) holds the pos_system role: the dedicated DATABASE_SYSTEM_URL identity used for pre-auth/system operations. Not forgeable through SET or SQL parameters.';
