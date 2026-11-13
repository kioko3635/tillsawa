ALTER TABLE organization_profiles
  ADD COLUMN receipt_design jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE organization_profiles
  ADD CONSTRAINT organization_profiles_receipt_design_object CHECK (jsonb_typeof(receipt_design) = 'object');
