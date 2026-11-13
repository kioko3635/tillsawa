-- Public provider photos only: no shop uploads, prices, stock or identity data.
-- Keeping bytes in PostgreSQL includes them in the existing local database backup.
CREATE TABLE online_catalog_photos (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL CHECK (octet_length(content) <= 2000000),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
  source_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE online_catalog_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_catalog_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY public_provider_photo_read ON online_catalog_photos FOR SELECT USING (true);
CREATE POLICY authenticated_provider_photo_insert ON online_catalog_photos FOR INSERT
WITH CHECK (public.pos_is_system() OR public.pos_organization_id() IS NOT NULL);
