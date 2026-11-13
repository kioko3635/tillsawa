ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_provider_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_provider_check
  CHECK (provider IN ('manual', 'simulator', 'daraja_sandbox', 'pesapal_terminal'));

-- A real reference manually recorded cannot also be consumed through the provider.
CREATE UNIQUE INDEX payment_real_reference_once
  ON payment_intents(organization_id, method, upper(reference))
  WHERE reference IS NOT NULL AND status = 'paid' AND provider IN ('manual', 'pesapal_terminal');
