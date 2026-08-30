PRAGMA foreign_keys = ON;

CREATE TABLE chain_profile (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rpc_endpoints_json TEXT NOT NULL,
  confirmation_depth INTEGER NOT NULL CHECK (confirmation_depth >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE wallet_group (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE wallet (
  id TEXT PRIMARY KEY,
  chain_profile_id TEXT NOT NULL REFERENCES chain_profile(id),
  address TEXT NOT NULL COLLATE NOCASE,
  label TEXT,
  wallet_group_id TEXT REFERENCES wallet_group(id),
  key_reference TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(chain_profile_id, address)
);

CREATE TABLE wallet_balance (
  wallet_id TEXT PRIMARY KEY REFERENCES wallet(id),
  native_balance_wei TEXT NOT NULL CHECK (length(native_balance_wei) > 0 AND native_balance_wei NOT GLOB '*[^0-9]*'),
  token_balances_json TEXT NOT NULL DEFAULT '{}',
  source_block_number INTEGER,
  source_block_hash TEXT,
  observed_at TEXT NOT NULL
);

CREATE TABLE tracked_wallet (wallet_id TEXT PRIMARY KEY REFERENCES wallet(id), enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), created_at TEXT NOT NULL);
CREATE TABLE wallet_stats (wallet_id TEXT PRIMARY KEY REFERENCES wallet(id), stats_json TEXT NOT NULL, calculated_at TEXT NOT NULL, version TEXT NOT NULL);

CREATE TABLE contract (id TEXT PRIMARY KEY, chain_profile_id TEXT NOT NULL REFERENCES chain_profile(id), address TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', UNIQUE(chain_profile_id, address));
CREATE TABLE collection (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES contract(id), name TEXT, symbol TEXT, metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE "drop" (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collection(id), strategy TEXT NOT NULL, start_time TEXT, end_time TEXT, mint_price_wei TEXT NOT NULL CHECK (length(mint_price_wei) > 0 AND mint_price_wei NOT GLOB '*[^0-9]*'), max_supply TEXT, source_block_number INTEGER, source_block_hash TEXT, observed_at TEXT NOT NULL);
CREATE TABLE campaign (id TEXT PRIMARY KEY, drop_id TEXT NOT NULL REFERENCES "drop"(id), state TEXT NOT NULL, trigger_at TEXT, policy_snapshot_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE fire_lane (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaign(id), state TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE eligibility (id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallet(id), campaign_id TEXT NOT NULL REFERENCES campaign(id), evidence_source TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('eligible', 'ineligible', 'unknown')), reason TEXT, expires_at TEXT, evidence_json TEXT, UNIQUE(wallet_id, campaign_id, evidence_source));

CREATE TABLE opportunity (id TEXT PRIMARY KEY, chain_profile_id TEXT NOT NULL REFERENCES chain_profile(id), fingerprint TEXT NOT NULL UNIQUE, disposition TEXT NOT NULL, score REAL, score_version TEXT, freshness_at TEXT, evidence_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE signal (id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL REFERENCES opportunity(id), source TEXT NOT NULL, signal_type TEXT NOT NULL, value_json TEXT NOT NULL, observed_at TEXT NOT NULL);

CREATE TABLE transaction_intent (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaign(id), wallet_id TEXT NOT NULL REFERENCES wallet(id), intent_class TEXT NOT NULL, to_address TEXT NOT NULL, value_wei TEXT NOT NULL CHECK (length(value_wei) > 0 AND value_wei NOT GLOB '*[^0-9]*'), calldata TEXT NOT NULL, nonce INTEGER, policy_snapshot_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE simulation (id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallet(id), campaign_id TEXT NOT NULL REFERENCES campaign(id), transaction_intent_id TEXT REFERENCES transaction_intent(id), source_block_number INTEGER NOT NULL, source_block_hash TEXT, checked_at TEXT NOT NULL, freshness_seconds INTEGER NOT NULL CHECK (freshness_seconds >= 0), outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'unknown')), revert_taxonomy TEXT, tool_version TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE transaction_attempt (id TEXT PRIMARY KEY, transaction_intent_id TEXT NOT NULL REFERENCES transaction_intent(id), endpoint TEXT NOT NULL, response_class TEXT NOT NULL, latency_ms INTEGER CHECK (latency_ms >= 0), tx_hash TEXT, nonce INTEGER, replacement_of_id TEXT REFERENCES transaction_attempt(id), redacted_error TEXT, attempted_at TEXT NOT NULL);
CREATE TABLE transaction_receipt (id TEXT PRIMARY KEY, transaction_attempt_id TEXT NOT NULL REFERENCES transaction_attempt(id), tx_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'reverted', 'reorged', 'dropped')), block_number INTEGER, block_hash TEXT, confirmations INTEGER NOT NULL DEFAULT 0 CHECK (confirmations >= 0), gas_used TEXT, effective_gas_price TEXT, observed_at TEXT NOT NULL);
CREATE TABLE execution (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaign(id), wallet_id TEXT NOT NULL REFERENCES wallet(id), transaction_intent_id TEXT NOT NULL REFERENCES transaction_intent(id), state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(campaign_id, wallet_id));
CREATE TABLE state_transition (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, prior_state TEXT, new_state TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL, reason TEXT NOT NULL, policy_version TEXT, evidence_snapshot_json TEXT, occurred_at TEXT NOT NULL);

CREATE TABLE gas_strategy (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config_json TEXT NOT NULL, version TEXT NOT NULL);
CREATE TABLE spend_policy (id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallet(id), daily_cap_wei TEXT NOT NULL CHECK (length(daily_cap_wei) > 0 AND daily_cap_wei NOT GLOB '*[^0-9]*'), timezone TEXT NOT NULL DEFAULT 'UTC', version TEXT NOT NULL, active INTEGER NOT NULL CHECK (active IN (0, 1)));
CREATE TABLE spend_reservation (id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallet(id), execution_id TEXT REFERENCES execution(id), idempotency_key TEXT NOT NULL UNIQUE, policy_id TEXT NOT NULL REFERENCES spend_policy(id), amount_wei TEXT NOT NULL CHECK (length(amount_wei) > 0 AND amount_wei NOT GLOB '*[^0-9]*' AND amount_wei <> '0'), usage_date TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'expired')), created_at TEXT NOT NULL, settled_at TEXT);
CREATE TABLE spend_ledger_entry (id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallet(id), execution_id TEXT REFERENCES execution(id), reservation_id TEXT REFERENCES spend_reservation(id), entry_type TEXT NOT NULL CHECK (entry_type IN ('mint', 'gas', 'refund', 'funding')), amount_wei TEXT NOT NULL CHECK (length(amount_wei) > 0 AND amount_wei NOT GLOB '*[^0-9]*'), tx_hash TEXT, created_at TEXT NOT NULL);

CREATE TABLE notification (id TEXT PRIMARY KEY, event_key TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, delivery_state TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT);
CREATE TABLE portfolio_position (id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallet(id), collection_id TEXT NOT NULL REFERENCES collection(id), quantity TEXT NOT NULL CHECK (length(quantity) > 0 AND quantity NOT GLOB '*[^0-9]*'), cost_basis_wei TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(wallet_id, collection_id));
CREATE TABLE portfolio_event (id TEXT PRIMARY KEY, position_id TEXT NOT NULL REFERENCES portfolio_position(id), event_type TEXT NOT NULL, quantity TEXT NOT NULL, realized_value_wei TEXT, gas_wei TEXT, tx_hash TEXT, block_number INTEGER, occurred_at TEXT NOT NULL);
CREATE TABLE performance_metric (id TEXT PRIMARY KEY, dimension TEXT NOT NULL, dimension_key TEXT NOT NULL, metric_json TEXT NOT NULL, source_version TEXT NOT NULL, calculated_at TEXT NOT NULL, UNIQUE(dimension, dimension_key, source_version));
CREATE TABLE audit_event (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, prior_state TEXT, new_state TEXT, actor TEXT NOT NULL, reason TEXT NOT NULL, evidence_snapshot_json TEXT, policy_snapshot_json TEXT, occurred_at TEXT NOT NULL);

CREATE INDEX idx_wallet_group ON wallet(wallet_group_id);
CREATE INDEX idx_campaign_state_trigger ON campaign(state, trigger_at);
CREATE INDEX idx_campaign_drop ON campaign(drop_id);
CREATE INDEX idx_execution_campaign_state ON execution(campaign_id, state, created_at);
CREATE INDEX idx_execution_wallet ON execution(wallet_id, created_at);
CREATE INDEX idx_attempt_hash ON transaction_attempt(tx_hash);
CREATE INDEX idx_attempt_from_nonce ON transaction_intent(wallet_id, nonce);
CREATE INDEX idx_attempt_intent ON transaction_attempt(transaction_intent_id);
CREATE UNIQUE INDEX idx_intent_wallet_nonce ON transaction_intent(wallet_id, nonce) WHERE nonce IS NOT NULL;
CREATE INDEX idx_receipt_hash_status ON transaction_receipt(tx_hash, status);
CREATE INDEX idx_transition_entity_time ON state_transition(entity_type, entity_id, occurred_at);
CREATE INDEX idx_opportunity_queue ON opportunity(disposition, chain_profile_id, score, freshness_at);
CREATE INDEX idx_signal_opportunity_time ON signal(opportunity_id, observed_at);
CREATE INDEX idx_eligibility_campaign_wallet ON eligibility(campaign_id, wallet_id, status, expires_at);
CREATE INDEX idx_notification_delivery ON notification(delivery_state, created_at);
CREATE INDEX idx_portfolio_event_position_time ON portfolio_event(position_id, occurred_at);
CREATE INDEX idx_audit_entity_time ON audit_event(entity_type, entity_id, occurred_at);

CREATE TRIGGER spend_reservation_status_transition
BEFORE UPDATE OF status ON spend_reservation
WHEN NOT ((OLD.status = NEW.status) OR
  (OLD.status = 'reserved' AND NEW.status IN ('settled', 'released', 'expired')))
BEGIN SELECT RAISE(ABORT, 'invalid spend reservation status transition'); END;

CREATE TRIGGER transaction_intent_immutable_update
BEFORE UPDATE ON transaction_intent
BEGIN SELECT RAISE(ABORT, 'transaction intents are immutable'); END;

CREATE TRIGGER transaction_intent_immutable_delete
BEFORE DELETE ON transaction_intent
BEGIN SELECT RAISE(ABORT, 'transaction intents are immutable'); END;
