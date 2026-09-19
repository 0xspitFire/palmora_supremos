-- Phase 2 durable operating/read-model foundation.
-- Current-state tables remain authoritative; the records below are snapshots,
-- queue state, or append-only evidence linked back to those facts.

CREATE TABLE freshness_policy (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  version TEXT NOT NULL,
  max_age_seconds INTEGER NOT NULL CHECK (max_age_seconds >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(subject_type, version)
);

CREATE TABLE provenance (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_name TEXT,
  observed_at TEXT NOT NULL,
  source_block_number TEXT CHECK (source_block_number IS NULL OR (length(source_block_number) > 0 AND source_block_number NOT GLOB '*[^0-9]*')),
  source_block_hash TEXT,
  evidence_id TEXT,
  model_version TEXT,
  policy_version TEXT,
  source_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE freshness_observation (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  field_name TEXT,
  policy_id TEXT REFERENCES freshness_policy(id),
  provenance_id TEXT REFERENCES provenance(id),
  status TEXT NOT NULL CHECK (status IN ('fresh', 'stale', 'unknown')),
  observed_at TEXT,
  expires_at TEXT,
  checked_at TEXT NOT NULL,
  UNIQUE(subject_type, subject_id, field_name, checked_at, id)
);

ALTER TABLE wallet ADD COLUMN updated_at TEXT;
ALTER TABLE wallet ADD COLUMN metadata_source TEXT;
ALTER TABLE wallet ADD COLUMN metadata_observed_at TEXT;
ALTER TABLE wallet ADD COLUMN metadata_provenance_id TEXT REFERENCES provenance(id);
ALTER TABLE wallet_balance ADD COLUMN freshness_policy_id TEXT REFERENCES freshness_policy(id);
ALTER TABLE wallet_balance ADD COLUMN expires_at TEXT;
ALTER TABLE wallet_balance ADD COLUMN provenance_id TEXT REFERENCES provenance(id);
ALTER TABLE tracked_wallet ADD COLUMN source TEXT;
ALTER TABLE tracked_wallet ADD COLUMN observed_at TEXT;
ALTER TABLE tracked_wallet ADD COLUMN provenance_id TEXT REFERENCES provenance(id);
ALTER TABLE wallet_stats ADD COLUMN expires_at TEXT;
ALTER TABLE wallet_stats ADD COLUMN provenance_id TEXT REFERENCES provenance(id);

ALTER TABLE "drop" ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'unknown' CHECK (source_authority IN ('on_chain', 'operator_record', 'external_source', 'unknown'));
ALTER TABLE "drop" ADD COLUMN expires_at TEXT;
ALTER TABLE "drop" ADD COLUMN provenance_id TEXT REFERENCES provenance(id);
ALTER TABLE campaign ADD COLUMN updated_at TEXT;
ALTER TABLE campaign ADD COLUMN expires_at TEXT;
ALTER TABLE campaign ADD COLUMN provenance_id TEXT REFERENCES provenance(id);
ALTER TABLE opportunity ADD COLUMN updated_at TEXT;
ALTER TABLE opportunity ADD COLUMN expires_at TEXT;
ALTER TABLE opportunity ADD COLUMN provenance_id TEXT REFERENCES provenance(id);

UPDATE wallet SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE campaign SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE opportunity SET updated_at = created_at WHERE updated_at IS NULL;

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) > 0),
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE event (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  run_id TEXT REFERENCES execution_run(id),
  campaign_id TEXT REFERENCES campaign(id),
  wallet_id TEXT REFERENCES wallet(id),
  execution_id TEXT REFERENCES execution(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) > 0),
  payload_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'database',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE readiness_snapshot (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  wallet_id TEXT NOT NULL REFERENCES wallet(id),
  state TEXT NOT NULL CHECK (state IN ('unknown', 'unfunded', 'funded', 'eligible', 'ready', 'executing', 'minted', 'failed', 'skipped')),
  decision TEXT NOT NULL CHECK (decision IN ('ready', 'blocked', 'unknown', 'stale')),
  next_action TEXT NOT NULL,
  blocking_reason_code TEXT,
  blocking_reason TEXT,
  checked_at TEXT NOT NULL,
  expires_at TEXT,
  policy_version TEXT,
  source_block_number TEXT CHECK (source_block_number IS NULL OR (length(source_block_number) > 0 AND source_block_number NOT GLOB '*[^0-9]*')),
  source_block_hash TEXT,
  provenance_id TEXT REFERENCES provenance(id),
  created_at TEXT NOT NULL
);

CREATE TABLE readiness_check (
  id TEXT PRIMARY KEY,
  readiness_snapshot_id TEXT NOT NULL REFERENCES readiness_snapshot(id),
  code TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'unknown', 'stale')),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  message TEXT NOT NULL,
  evaluated_at TEXT,
  valid_until TEXT,
  provenance_id TEXT REFERENCES provenance(id),
  source_record_type TEXT,
  source_record_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE opportunity_evidence (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunity(id),
  evidence_type TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  source_ref TEXT,
  source_block_number TEXT CHECK (source_block_number IS NULL OR (length(source_block_number) > 0 AND source_block_number NOT GLOB '*[^0-9]*')),
  source_block_hash TEXT,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  provenance_id TEXT REFERENCES provenance(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE opportunity_score (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunity(id),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  model_version TEXT NOT NULL,
  confidence_sample_size TEXT NOT NULL CHECK (length(confidence_sample_size) > 0 AND confidence_sample_size NOT GLOB '*[^0-9]*'),
  confidence_denominator TEXT CHECK (confidence_denominator IS NULL OR (length(confidence_denominator) > 0 AND confidence_denominator NOT GLOB '*[^0-9]*')),
  inputs_json TEXT NOT NULL DEFAULT '{}',
  calculated_at TEXT NOT NULL,
  expires_at TEXT,
  provenance_id TEXT REFERENCES provenance(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE opportunity_risk (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunity(id),
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  message TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  provenance_id TEXT REFERENCES provenance(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE opportunity_gate_check (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunity(id),
  code TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'unknown', 'stale')),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  message TEXT NOT NULL,
  evaluated_at TEXT,
  valid_until TEXT,
  provenance_id TEXT REFERENCES provenance(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE alert (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES event(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  subject_type TEXT,
  subject_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  canonical_ref TEXT,
  provenance_id TEXT REFERENCES provenance(id),
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE alert_delivery (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alert(id),
  channel TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'delivering', 'delivered', 'failed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  next_attempt_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(alert_id, channel)
);

CREATE TABLE finality_observation (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES execution(id),
  transaction_attempt_id TEXT REFERENCES transaction_attempt(id),
  transaction_receipt_id TEXT REFERENCES transaction_receipt(id),
  chain_profile_id TEXT NOT NULL REFERENCES chain_profile(id),
  stage TEXT NOT NULL CHECK (stage IN ('unknown', 'confirmed', 'soft', 'posted', 'ethereum_final')),
  required_stage TEXT NOT NULL CHECK (required_stage IN ('confirmed', 'ethereum_final')),
  settlement_reached INTEGER NOT NULL CHECK (settlement_reached IN (0, 1)),
  downgrade_reason TEXT,
  observed_at TEXT NOT NULL,
  provenance_id TEXT REFERENCES provenance(id),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE spend_summary (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('wallet', 'campaign', 'run', 'period', 'day')),
  scope_id TEXT NOT NULL,
  wallet_id TEXT REFERENCES wallet(id),
  campaign_id TEXT REFERENCES campaign(id),
  usage_date TEXT,
  reserved_amount_wei TEXT NOT NULL DEFAULT '0' CHECK (length(reserved_amount_wei) > 0 AND reserved_amount_wei NOT GLOB '*[^0-9]*'),
  settled_amount_wei TEXT NOT NULL DEFAULT '0' CHECK (length(settled_amount_wei) > 0 AND settled_amount_wei NOT GLOB '*[^0-9]*'),
  refunded_amount_wei TEXT NOT NULL DEFAULT '0' CHECK (length(refunded_amount_wei) > 0 AND refunded_amount_wei NOT GLOB '*[^0-9]*'),
  mint_value_wei TEXT NOT NULL DEFAULT '0' CHECK (length(mint_value_wei) > 0 AND mint_value_wei NOT GLOB '*[^0-9]*'),
  l2_execution_gas_wei TEXT NOT NULL DEFAULT '0' CHECK (length(l2_execution_gas_wei) > 0 AND l2_execution_gas_wei NOT GLOB '*[^0-9]*'),
  l1_data_gas_wei TEXT NOT NULL DEFAULT '0' CHECK (length(l1_data_gas_wei) > 0 AND l1_data_gas_wei NOT GLOB '*[^0-9]*'),
  priority_fee_component_wei TEXT NOT NULL DEFAULT '0' CHECK (length(priority_fee_component_wei) > 0 AND priority_fee_component_wei NOT GLOB '*[^0-9]*'),
  source_version TEXT NOT NULL,
  as_of TEXT NOT NULL,
  provenance_id TEXT REFERENCES provenance(id),
  UNIQUE(scope_type, scope_id, usage_date, source_version)
);

CREATE INDEX idx_provenance_record_field ON provenance(record_type, record_id, field_name, observed_at);
CREATE INDEX idx_freshness_subject_time ON freshness_observation(subject_type, subject_id, field_name, checked_at);
CREATE INDEX idx_wallet_metadata_source ON wallet(metadata_observed_at, updated_at);
CREATE INDEX idx_wallet_balance_freshness ON wallet_balance(expires_at, observed_at);
CREATE INDEX idx_tracked_wallet_source_time ON tracked_wallet(source, observed_at);
CREATE INDEX idx_job_due ON job(state, scheduled_at, priority DESC, updated_at);
CREATE INDEX idx_job_lease ON job(state, lease_expires_at);
CREATE INDEX idx_job_entity ON job(entity_type, entity_id, state);
CREATE INDEX idx_event_entity_time ON event(entity_type, entity_id, occurred_at, id);
CREATE INDEX idx_event_run_time ON event(run_id, occurred_at, id);
CREATE INDEX idx_readiness_campaign_wallet_time ON readiness_snapshot(campaign_id, wallet_id, checked_at DESC, id);
CREATE INDEX idx_readiness_check_snapshot ON readiness_check(readiness_snapshot_id, code);
CREATE INDEX idx_opportunity_evidence_time ON opportunity_evidence(opportunity_id, observed_at, id);
CREATE INDEX idx_opportunity_score_latest ON opportunity_score(opportunity_id, calculated_at DESC, id);
CREATE INDEX idx_opportunity_risk_latest ON opportunity_risk(opportunity_id, observed_at DESC, id);
CREATE INDEX idx_opportunity_gate_latest ON opportunity_gate_check(opportunity_id, evaluated_at DESC, id);
CREATE INDEX idx_alert_queue ON alert_delivery(delivery_state, next_attempt_at, created_at);
CREATE INDEX idx_alert_subject_time ON alert(subject_type, subject_id, created_at);
CREATE INDEX idx_finality_execution_time ON finality_observation(execution_id, observed_at, id);
CREATE INDEX idx_finality_attempt_time ON finality_observation(transaction_attempt_id, observed_at, id);
CREATE INDEX idx_spend_summary_scope ON spend_summary(scope_type, scope_id, usage_date, source_version);

INSERT OR IGNORE INTO freshness_policy (id, subject_type, version, max_age_seconds, active, created_at) VALUES
  ('wallet-balance-v1', 'wallet_balance', 'v1', 300, 1, CURRENT_TIMESTAMP),
  ('eligibility-v1', 'eligibility', 'v1', 3600, 1, CURRENT_TIMESTAMP),
  ('simulation-v1', 'simulation', 'v1', 300, 1, CURRENT_TIMESTAMP),
  ('readiness-v1', 'readiness', 'v1', 300, 1, CURRENT_TIMESTAMP),
  ('discovery-v1', 'discovery', 'v1', 900, 1, CURRENT_TIMESTAMP),
  ('calendar-v1', 'calendar', 'v1', 900, 1, CURRENT_TIMESTAMP),
  ('opportunity-v1', 'opportunity', 'v1', 900, 1, CURRENT_TIMESTAMP),
  ('finality-v1', 'finality', 'v1', 3600, 1, CURRENT_TIMESTAMP);

UPDATE retention_policy
   SET id = 'audit-90d', retention_days = 90, retain_indefinitely = 0,
       approval_owner = 'product-owner', approved_at = CURRENT_TIMESTAMP
 WHERE id = 'audit-indefinite' AND entity_type = 'audit_event';
INSERT OR IGNORE INTO retention_policy (id, entity_type, retention_days, retain_indefinitely, active, approval_owner, approved_at) VALUES
  ('read-model-30d', 'read_model_snapshot', 30, 0, 1, 'product-owner', CURRENT_TIMESTAMP),
  ('alert-30d', 'alert', 30, 0, 1, 'product-owner', CURRENT_TIMESTAMP),
  ('phase2-event-90d', 'event', 90, 0, 1, 'product-owner', CURRENT_TIMESTAMP);

CREATE VIEW scheduled_job AS
SELECT id, job_type, entity_type, entity_id, idempotency_key, request_fingerprint,
       payload_json, state, priority, scheduled_at, lease_owner, lease_expires_at,
       attempt_count, last_error, created_at, updated_at, completed_at
  FROM job;

CREATE VIEW recovery_pending_jobs AS
SELECT id, job_type, entity_type, entity_id, idempotency_key, state,
       scheduled_at, lease_owner, lease_expires_at, attempt_count, last_error,
       created_at, updated_at
  FROM job
 WHERE state = 'running'
    AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP);

CREATE VIEW latest_readiness_snapshot AS
SELECT r.*
  FROM readiness_snapshot r
 WHERE r.id = (
   SELECT r2.id FROM readiness_snapshot r2
    WHERE r2.campaign_id = r.campaign_id AND r2.wallet_id = r.wallet_id
    ORDER BY r2.checked_at DESC, r2.id DESC LIMIT 1
 );

CREATE VIEW latest_finality_observation AS
SELECT f.*
  FROM finality_observation f
 WHERE f.id = (
   SELECT f2.id FROM finality_observation f2
    WHERE f2.execution_id = f.execution_id
    ORDER BY f2.observed_at DESC, f2.id DESC LIMIT 1
 );

CREATE TRIGGER provenance_immutable_update
BEFORE UPDATE ON provenance
BEGIN SELECT RAISE(ABORT, 'provenance records are immutable'); END;
CREATE TRIGGER provenance_immutable_delete
BEFORE DELETE ON provenance
BEGIN SELECT RAISE(ABORT, 'provenance records are immutable'); END;

CREATE TRIGGER freshness_immutable_update
BEFORE UPDATE ON freshness_observation
BEGIN SELECT RAISE(ABORT, 'freshness observations are immutable'); END;
CREATE TRIGGER freshness_immutable_delete
BEFORE DELETE ON freshness_observation
BEGIN SELECT RAISE(ABORT, 'freshness observations are immutable'); END;

CREATE TRIGGER job_initial_state_guard
BEFORE INSERT ON job
WHEN NEW.state <> 'pending'
BEGIN SELECT RAISE(ABORT, 'jobs must be created pending'); END;
CREATE TRIGGER job_state_transition_guard
BEFORE UPDATE OF state ON job
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'pending' AND NEW.state IN ('running', 'cancelled')) OR
  (OLD.state = 'running' AND NEW.state IN ('pending', 'succeeded', 'failed', 'cancelled')) OR
  (OLD.state = 'failed' AND NEW.state IN ('pending', 'cancelled')) OR
  (OLD.state IN ('succeeded', 'cancelled') AND NEW.state = OLD.state)
)
BEGIN SELECT RAISE(ABORT, 'invalid job state transition'); END;
CREATE TRIGGER job_identity_immutable
BEFORE UPDATE ON job
WHEN OLD.id IS NOT NEW.id
  OR OLD.job_type IS NOT NEW.job_type
  OR OLD.entity_type IS NOT NEW.entity_type
  OR OLD.entity_id IS NOT NEW.entity_id
  OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.request_fingerprint IS NOT NEW.request_fingerprint
  OR OLD.payload_json IS NOT NEW.payload_json
  OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'job identity is immutable'); END;

CREATE TRIGGER event_immutable_update
BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER event_immutable_delete
BEFORE DELETE ON event
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER readiness_snapshot_immutable_update
BEFORE UPDATE ON readiness_snapshot
BEGIN SELECT RAISE(ABORT, 'readiness snapshots are append-only'); END;
CREATE TRIGGER readiness_snapshot_immutable_delete
BEFORE DELETE ON readiness_snapshot
BEGIN SELECT RAISE(ABORT, 'readiness snapshots are append-only'); END;
CREATE TRIGGER readiness_check_immutable_update
BEFORE UPDATE ON readiness_check
BEGIN SELECT RAISE(ABORT, 'readiness checks are append-only'); END;
CREATE TRIGGER readiness_check_immutable_delete
BEFORE DELETE ON readiness_check
BEGIN SELECT RAISE(ABORT, 'readiness checks are append-only'); END;

CREATE TRIGGER opportunity_evidence_immutable_update
BEFORE UPDATE ON opportunity_evidence
BEGIN SELECT RAISE(ABORT, 'opportunity evidence is append-only'); END;
CREATE TRIGGER opportunity_evidence_immutable_delete
BEFORE DELETE ON opportunity_evidence
BEGIN SELECT RAISE(ABORT, 'opportunity evidence is append-only'); END;
CREATE TRIGGER opportunity_score_immutable_update
BEFORE UPDATE ON opportunity_score
BEGIN SELECT RAISE(ABORT, 'opportunity scores are append-only'); END;
CREATE TRIGGER opportunity_score_immutable_delete
BEFORE DELETE ON opportunity_score
BEGIN SELECT RAISE(ABORT, 'opportunity scores are append-only'); END;
CREATE TRIGGER opportunity_risk_immutable_update
BEFORE UPDATE ON opportunity_risk
BEGIN SELECT RAISE(ABORT, 'opportunity risks are append-only'); END;
CREATE TRIGGER opportunity_risk_immutable_delete
BEFORE DELETE ON opportunity_risk
BEGIN SELECT RAISE(ABORT, 'opportunity risks are append-only'); END;
CREATE TRIGGER opportunity_gate_immutable_update
BEFORE UPDATE ON opportunity_gate_check
BEGIN SELECT RAISE(ABORT, 'opportunity gate checks are append-only'); END;
CREATE TRIGGER opportunity_gate_immutable_delete
BEFORE DELETE ON opportunity_gate_check
BEGIN SELECT RAISE(ABORT, 'opportunity gate checks are append-only'); END;

CREATE TRIGGER alert_immutable_update
BEFORE UPDATE ON alert
BEGIN SELECT RAISE(ABORT, 'alerts are immutable'); END;
CREATE TRIGGER alert_immutable_delete
BEFORE DELETE ON alert
BEGIN SELECT RAISE(ABORT, 'alerts are immutable'); END;
CREATE TRIGGER alert_delivery_state_guard
BEFORE UPDATE OF delivery_state ON alert_delivery
WHEN NEW.delivery_state <> OLD.delivery_state AND NOT (
  (OLD.delivery_state = 'pending' AND NEW.delivery_state IN ('delivering', 'failed')) OR
  (OLD.delivery_state = 'delivering' AND NEW.delivery_state IN ('pending', 'delivered', 'failed')) OR
  (OLD.delivery_state = 'failed' AND NEW.delivery_state IN ('pending', 'dead_letter')) OR
  (OLD.delivery_state IN ('delivered', 'dead_letter') AND NEW.delivery_state = OLD.delivery_state)
)
BEGIN SELECT RAISE(ABORT, 'invalid alert delivery transition'); END;

CREATE TRIGGER finality_immutable_update
BEFORE UPDATE ON finality_observation
BEGIN SELECT RAISE(ABORT, 'finality observations are append-only'); END;
CREATE TRIGGER finality_immutable_delete
BEFORE DELETE ON finality_observation
BEGIN SELECT RAISE(ABORT, 'finality observations are append-only'); END;
CREATE TRIGGER finality_settlement_guard
BEFORE INSERT ON finality_observation
WHEN NEW.settlement_reached = 1 AND NOT (
  (NEW.required_stage = 'confirmed' AND NEW.stage IN ('confirmed', 'ethereum_final')) OR
  (NEW.required_stage = 'ethereum_final' AND NEW.stage = 'ethereum_final')
)
BEGIN SELECT RAISE(ABORT, 'finality stage is below settlement requirement'); END;

CREATE TRIGGER spend_summary_money_guard
BEFORE INSERT ON spend_summary
WHEN NEW.reserved_amount_wei GLOB '*[^0-9]*'
  OR NEW.settled_amount_wei GLOB '*[^0-9]*'
  OR NEW.refunded_amount_wei GLOB '*[^0-9]*'
  OR NEW.mint_value_wei GLOB '*[^0-9]*'
  OR NEW.l2_execution_gas_wei GLOB '*[^0-9]*'
  OR NEW.l1_data_gas_wei GLOB '*[^0-9]*'
  OR NEW.priority_fee_component_wei GLOB '*[^0-9]*'
BEGIN SELECT RAISE(ABORT, 'spend summary monetary values must be non-negative decimals'); END;
