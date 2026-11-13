-- Preserve the exact normalized checkout payload for client transaction replay
-- checks. Legacy Phase 3 rows receive a sentinel hash, so a different-key retry
-- cannot accidentally replay an unverifiable historical payload.

ALTER TABLE sales
  ADD COLUMN client_payload_hash char(64);

UPDATE sales
SET client_payload_hash = repeat('0', 64)
WHERE client_payload_hash IS NULL;

ALTER TABLE sales
  ALTER COLUMN client_payload_hash SET NOT NULL;
