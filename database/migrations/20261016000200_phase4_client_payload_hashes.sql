-- Phase 4: payload hashes and client transaction identifiers for durable
-- replay/conflict detection on financial and procurement postings.

ALTER TABLE customer_credit_transactions
  ADD COLUMN client_transaction_id uuid,
  ADD COLUMN client_payload_hash char(64);
CREATE UNIQUE INDEX uq_credit_transaction_client
  ON customer_credit_transactions(organization_id, client_transaction_id)
  WHERE client_transaction_id IS NOT NULL;

ALTER TABLE customer_payments
  ADD COLUMN client_payload_hash char(64);
ALTER TABLE purchase_orders
  ADD COLUMN client_payload_hash char(64);
ALTER TABLE goods_receipts
  ADD COLUMN client_payload_hash char(64);
ALTER TABLE supplier_invoices
  ADD COLUMN client_payload_hash char(64);
ALTER TABLE supplier_payments
  ADD COLUMN client_payload_hash char(64);
