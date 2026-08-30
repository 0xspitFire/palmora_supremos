ALTER TABLE chain_profile ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'characterization_pending', 'verified', 'execution_blocked'));
ALTER TABLE chain_profile ADD COLUMN execution_enabled INTEGER NOT NULL DEFAULT 0 CHECK (execution_enabled IN (0, 1));
ALTER TABLE chain_profile ADD COLUMN verification_evidence_json TEXT;

ALTER TABLE transaction_attempt ADD COLUMN from_address TEXT COLLATE NOCASE;
CREATE INDEX idx_attempt_hash_reconciliation ON transaction_attempt(tx_hash, attempted_at);
CREATE INDEX idx_attempt_from_nonce_reconciliation ON transaction_attempt(from_address, nonce, attempted_at);

ALTER TABLE transaction_receipt ADD COLUMN finality_stage TEXT NOT NULL DEFAULT 'unknown' CHECK (finality_stage IN ('unknown', 'soft', 'posted', 'ethereum_final'));
ALTER TABLE transaction_receipt ADD COLUMN finality_source TEXT;
CREATE INDEX idx_receipt_finality_stage ON transaction_receipt(finality_stage, observed_at);

CREATE TABLE chain_verification (
  id TEXT PRIMARY KEY,
  chain_profile_id TEXT NOT NULL REFERENCES chain_profile(id),
  status TEXT NOT NULL CHECK (status IN ('unverified', 'characterization_pending', 'verified', 'execution_blocked')),
  chain_id INTEGER NOT NULL,
  sequencer_endpoint_reference TEXT,
  archive_endpoint_reference TEXT,
  feed_endpoint_reference TEXT,
  sea_drop_test_tx_hash TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
);
CREATE UNIQUE INDEX idx_chain_verification_current ON chain_verification(chain_profile_id) WHERE status IN ('unverified', 'characterization_pending', 'verified', 'execution_blocked');

CREATE TABLE fee_policy (
  id TEXT PRIMARY KEY,
  chain_profile_id TEXT NOT NULL REFERENCES chain_profile(id),
  version TEXT NOT NULL,
  priority_fee_semantics TEXT NOT NULL CHECK (priority_fee_semantics IN ('ordering', 'fee_only')),
  max_total_fee_wei TEXT NOT NULL CHECK (length(max_total_fee_wei) > 0 AND max_total_fee_wei NOT GLOB '*[^0-9]*'),
  free_mint_total_fee_cap_wei TEXT NOT NULL CHECK (length(free_mint_total_fee_cap_wei) > 0 AND free_mint_total_fee_cap_wei NOT GLOB '*[^0-9]*'),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(chain_profile_id, version)
);

CREATE TABLE reorg_event (
  id TEXT PRIMARY KEY,
  chain_profile_id TEXT NOT NULL REFERENCES chain_profile(id),
  transaction_attempt_id TEXT REFERENCES transaction_attempt(id),
  old_block_hash TEXT,
  new_block_hash TEXT,
  previous_finality_stage TEXT NOT NULL,
  new_finality_stage TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_reorg_chain_time ON reorg_event(chain_profile_id, detected_at);
CREATE INDEX idx_reorg_attempt ON reorg_event(transaction_attempt_id, detected_at);

CREATE TABLE reconciliation_record (
  id TEXT PRIMARY KEY,
  chain_profile_id TEXT NOT NULL REFERENCES chain_profile(id),
  transaction_attempt_id TEXT REFERENCES transaction_attempt(id),
  tx_hash TEXT,
  from_address TEXT COLLATE NOCASE,
  nonce INTEGER,
  state TEXT NOT NULL CHECK (state IN ('unresolved', 'matched', 'ambiguous', 'reorged', 'final')),
  checked_at TEXT NOT NULL,
  source TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_reconciliation_hash ON reconciliation_record(tx_hash, checked_at);
CREATE INDEX idx_reconciliation_from_nonce ON reconciliation_record(from_address, nonce, checked_at);
