CREATE TABLE execution_run (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) > 0),
  campaign_id TEXT REFERENCES campaign(id),
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'active', 'recovering', 'completed', 'failed', 'aborted', 'cancelled')),
  actor TEXT NOT NULL DEFAULT 'system',
  source TEXT NOT NULL DEFAULT 'database',
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE execution ADD COLUMN run_id TEXT REFERENCES execution_run(id);
ALTER TABLE execution ADD COLUMN request_id TEXT;
ALTER TABLE execution ADD COLUMN request_fingerprint TEXT;
ALTER TABLE execution ADD COLUMN reservation_id TEXT REFERENCES spend_reservation(id);
ALTER TABLE execution ADD COLUMN error_code TEXT;
ALTER TABLE execution ADD COLUMN error_reason TEXT;

ALTER TABLE transaction_intent ADD COLUMN chain_profile_id TEXT REFERENCES chain_profile(id);
ALTER TABLE transaction_intent ADD COLUMN from_address TEXT COLLATE NOCASE;
ALTER TABLE transaction_intent ADD COLUMN gas_limit_wei TEXT NOT NULL DEFAULT '0' CHECK (length(gas_limit_wei) > 0 AND gas_limit_wei NOT GLOB '*[^0-9]*');
ALTER TABLE transaction_intent ADD COLUMN max_fee_per_gas_wei TEXT NOT NULL DEFAULT '0' CHECK (length(max_fee_per_gas_wei) > 0 AND max_fee_per_gas_wei NOT GLOB '*[^0-9]*');
ALTER TABLE transaction_intent ADD COLUMN max_priority_fee_per_gas_wei TEXT NOT NULL DEFAULT '0' CHECK (length(max_priority_fee_per_gas_wei) > 0 AND max_priority_fee_per_gas_wei NOT GLOB '*[^0-9]*');
ALTER TABLE transaction_intent ADD COLUMN idempotency_key TEXT;
ALTER TABLE transaction_intent ADD COLUMN request_id TEXT;
ALTER TABLE transaction_intent ADD COLUMN request_fingerprint TEXT;
ALTER TABLE transaction_intent ADD COLUMN run_id TEXT REFERENCES execution_run(id);

ALTER TABLE transaction_attempt ADD COLUMN execution_id TEXT REFERENCES execution(id);
ALTER TABLE transaction_receipt ADD COLUMN execution_id TEXT REFERENCES execution(id);
ALTER TABLE reconciliation_record ADD COLUMN execution_id TEXT REFERENCES execution(id);
ALTER TABLE eligibility ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'unknown' CHECK (lifecycle_state IN ('unknown', 'unfunded', 'funded', 'eligible', 'ready', 'executing', 'minted', 'failed', 'skipped'));

UPDATE eligibility SET lifecycle_state = CASE status WHEN 'eligible' THEN 'eligible' WHEN 'ineligible' THEN 'failed' ELSE 'unknown' END;

CREATE INDEX idx_execution_run_campaign_state ON execution_run(campaign_id, state, updated_at);
CREATE INDEX idx_execution_run_fingerprint ON execution_run(request_fingerprint);
CREATE UNIQUE INDEX idx_intent_idempotency ON transaction_intent(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_intent_request_id ON transaction_intent(request_id);
CREATE INDEX idx_intent_fingerprint ON transaction_intent(request_fingerprint);
CREATE INDEX idx_intent_run ON transaction_intent(run_id);
CREATE INDEX idx_execution_run_id ON execution(run_id, state, updated_at);
CREATE INDEX idx_attempt_execution ON transaction_attempt(execution_id, attempted_at);
CREATE INDEX idx_receipt_execution ON transaction_receipt(execution_id, observed_at);
CREATE INDEX idx_reconciliation_execution ON reconciliation_record(execution_id, checked_at);
