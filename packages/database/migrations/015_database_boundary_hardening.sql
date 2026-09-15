ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;
ALTER TABLE spend_policy ADD COLUMN campaign_cap_wei TEXT CHECK (campaign_cap_wei IS NULL OR (length(campaign_cap_wei) > 0 AND campaign_cap_wei NOT GLOB '*[^0-9]*'));
ALTER TABLE spend_reservation ADD COLUMN mint_class TEXT NOT NULL DEFAULT 'legacy' CHECK (mint_class IN ('free', 'paid', 'legacy'));
ALTER TABLE spend_reservation ADD COLUMN fee_policy_id TEXT REFERENCES fee_policy(id);
ALTER TABLE spend_reservation ADD COLUMN fee_policy_version TEXT;
ALTER TABLE spend_reservation ADD COLUMN fee_policy_snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE transaction_attempt ADD COLUMN chain_profile_id TEXT REFERENCES chain_profile(id);
ALTER TABLE backup_restore_evidence ADD COLUMN verification_sha256 TEXT;
ALTER TABLE reorg_event ADD COLUMN execution_id TEXT REFERENCES execution(id);

CREATE TABLE campaign_wallet (
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  wallet_id TEXT NOT NULL REFERENCES wallet(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  selected_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, wallet_id)
);

CREATE TABLE campaign_period (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  period_key TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(campaign_id, period_key),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);

INSERT INTO campaign_period (id, campaign_id, period_key, starts_at, ends_at, created_at)
SELECT 'campaign:' || c.id, c.id, 'campaign-default', d.start_time, d.end_time, c.created_at
  FROM campaign c
  JOIN "drop" d ON d.id = c.drop_id;

CREATE TABLE reorg_resolution (
  id TEXT PRIMARY KEY,
  reorg_event_id TEXT NOT NULL REFERENCES reorg_event(id),
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  replacement_execution_id TEXT REFERENCES execution(id),
  reason TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);

UPDATE spend_reservation SET mint_class = 'legacy' WHERE mint_class IS NULL;
UPDATE spend_reservation SET fee_policy_id = (
  SELECT fp.id FROM fee_policy fp
   WHERE fp.chain_profile_id = spend_reservation.chain_profile_id
   ORDER BY fp.active DESC, fp.rowid DESC LIMIT 1
) WHERE fee_policy_id IS NULL AND chain_profile_id IS NOT NULL;
UPDATE spend_reservation SET fee_policy_version = (
  SELECT fp.version FROM fee_policy fp WHERE fp.id = spend_reservation.fee_policy_id
) WHERE fee_policy_version IS NULL AND fee_policy_id IS NOT NULL;
UPDATE spend_reservation SET fee_policy_snapshot_json = policy_snapshot_json WHERE fee_policy_snapshot_json = '{}' AND policy_snapshot_json <> '{}';
UPDATE transaction_attempt SET chain_profile_id = (
  SELECT i.chain_profile_id FROM transaction_intent i WHERE i.id = transaction_attempt.transaction_intent_id
) WHERE chain_profile_id IS NULL;

UPDATE fee_policy
   SET active = 0
 WHERE active = 1
   AND rowid NOT IN (SELECT MAX(rowid) FROM fee_policy WHERE active = 1 GROUP BY chain_profile_id);
CREATE UNIQUE INDEX idx_fee_policy_one_active ON fee_policy(chain_profile_id) WHERE active = 1;
CREATE UNIQUE INDEX idx_reservation_execution_identity ON spend_reservation(execution_id) WHERE execution_id IS NOT NULL;
CREATE UNIQUE INDEX idx_reservation_intent_identity ON spend_reservation(transaction_intent_id) WHERE transaction_intent_id IS NOT NULL;
CREATE UNIQUE INDEX idx_intent_request_identity ON transaction_intent(request_id, wallet_id) WHERE request_id IS NOT NULL;
DROP INDEX IF EXISTS idx_reservation_request_identity;
CREATE UNIQUE INDEX idx_reservation_request_identity ON spend_reservation(request_id, wallet_id) WHERE request_id IS NOT NULL;
CREATE INDEX idx_campaign_wallet_enabled ON campaign_wallet(campaign_id, enabled, wallet_id);
CREATE INDEX idx_campaign_period_scope ON campaign_period(campaign_id, period_key, starts_at, ends_at);
CREATE INDEX idx_reorg_resolution_event_time ON reorg_resolution(reorg_event_id, resolved_at);
CREATE INDEX idx_reorg_execution_time ON reorg_event(execution_id, detected_at);
CREATE INDEX idx_attempt_replacement_lineage ON transaction_attempt(replacement_of_id, attempted_at);

DROP TRIGGER IF EXISTS lifecycle_event_entity_domain;
CREATE TRIGGER lifecycle_event_entity_domain
BEFORE INSERT ON state_transition
WHEN NEW.entity_type NOT IN ('run', 'execution_run', 'chain_profile', 'campaign', 'wallet', 'execution', 'transaction_intent', 'transaction_attempt', 'transaction_receipt', 'spend_reservation', 'reconciliation', 'chain_verification', 'opportunity', 'fire_lane', 'eligibility', 'notification', 'simulation', 'audit_event')
BEGIN SELECT RAISE(ABORT, 'invalid lifecycle event entity'); END;

DROP TRIGGER IF EXISTS audit_event_entity_domain;
CREATE TRIGGER audit_event_entity_domain
BEFORE INSERT ON audit_event
WHEN NEW.entity_type NOT IN ('run', 'execution_run', 'chain_profile', 'campaign', 'wallet', 'execution', 'transaction_intent', 'transaction_attempt', 'transaction_receipt', 'reservation', 'spend_reservation', 'reconciliation', 'chain_verification', 'opportunity', 'fire_lane', 'eligibility', 'notification', 'simulation', 'state_transition')
BEGIN SELECT RAISE(ABORT, 'invalid audit event entity'); END;

CREATE TRIGGER chain_execution_enable_guard
BEFORE INSERT ON chain_profile
WHEN NEW.execution_enabled = 1 AND (NEW.verification_status <> 'verified' OR NEW.chain_id = 4663)
BEGIN SELECT RAISE(ABORT, 'execution requires verified non-Robinhood chain'); END;

CREATE TRIGGER chain_execution_enable_update_guard
BEFORE UPDATE OF execution_enabled, verification_status, chain_id ON chain_profile
WHEN NEW.execution_enabled = 1 AND (NEW.verification_status <> 'verified' OR NEW.chain_id = 4663)
BEGIN SELECT RAISE(ABORT, 'execution requires verified non-Robinhood chain'); END;

CREATE TRIGGER chain_verification_status_guard
BEFORE UPDATE OF verification_status ON chain_profile
WHEN NEW.verification_status = 'verified' AND NEW.chain_id = 4663
BEGIN SELECT RAISE(ABORT, 'Robinhood chain cannot be execution verified'); END;

CREATE TRIGGER campaign_period_after_insert
AFTER INSERT ON campaign
WHEN NOT EXISTS (SELECT 1 FROM campaign_period WHERE campaign_id = NEW.id)
BEGIN
  INSERT INTO campaign_period (id, campaign_id, period_key, created_at) VALUES ('campaign:' || NEW.id, NEW.id, 'campaign-default', NEW.created_at);
END;

CREATE TRIGGER campaign_period_immutable_update
BEFORE UPDATE ON campaign_period
BEGIN SELECT RAISE(ABORT, 'campaign periods are append-only'); END;

CREATE TRIGGER campaign_period_immutable_delete
BEFORE DELETE ON campaign_period
BEGIN SELECT RAISE(ABORT, 'campaign periods are append-only'); END;

CREATE TRIGGER reservation_execution_identity_guard
BEFORE INSERT ON spend_reservation
WHEN NEW.execution_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM execution e JOIN transaction_intent i ON i.id = e.transaction_intent_id
   WHERE e.id = NEW.execution_id AND e.wallet_id = NEW.wallet_id AND e.campaign_id = NEW.campaign_id
     AND (NEW.transaction_intent_id IS NULL OR e.transaction_intent_id = NEW.transaction_intent_id)
)
BEGIN SELECT RAISE(ABORT, 'reservation execution identity mismatch'); END;

CREATE TRIGGER reservation_intent_chain_guard
BEFORE INSERT ON spend_reservation
WHEN NEW.transaction_intent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM transaction_intent i
   WHERE i.id = NEW.transaction_intent_id AND i.wallet_id = NEW.wallet_id
     AND i.campaign_id = NEW.campaign_id AND i.chain_profile_id = NEW.chain_profile_id
)
BEGIN SELECT RAISE(ABORT, 'reservation intent identity mismatch'); END;

CREATE TRIGGER reservation_execution_reverse_guard
BEFORE INSERT ON spend_reservation
WHEN NEW.execution_id IS NOT NULL AND EXISTS (SELECT 1 FROM execution WHERE id = NEW.execution_id AND reservation_id IS NOT NULL AND reservation_id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'execution already has a different reservation'); END;

DROP TRIGGER IF EXISTS execution_identity_immutable;
CREATE TRIGGER execution_identity_immutable
BEFORE UPDATE ON execution
WHEN OLD.campaign_id IS NOT NEW.campaign_id
  OR OLD.wallet_id IS NOT NEW.wallet_id
  OR OLD.transaction_intent_id IS NOT NEW.transaction_intent_id
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.request_id IS NOT NEW.request_id
  OR OLD.request_fingerprint IS NOT NEW.request_fingerprint
  OR (OLD.reservation_id IS NOT NULL AND OLD.reservation_id IS NOT NEW.reservation_id)
  OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'execution identity is immutable'); END;

CREATE TRIGGER execution_reservation_update_guard
BEFORE UPDATE OF reservation_id ON execution
WHEN NEW.reservation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spend_reservation WHERE id = NEW.reservation_id AND execution_id = NEW.id AND wallet_id = NEW.wallet_id)
BEGIN SELECT RAISE(ABORT, 'execution reservation linkage mismatch'); END;

CREATE TRIGGER transaction_attempt_nonce_guard
BEFORE INSERT ON transaction_attempt
WHEN (SELECT nonce FROM transaction_intent WHERE id = NEW.transaction_intent_id) IS NOT NULL
 AND NEW.nonce IS NOT NULL
 AND NEW.nonce <> (SELECT nonce FROM transaction_intent WHERE id = NEW.transaction_intent_id)
BEGIN SELECT RAISE(ABORT, 'attempt nonce does not match intent'); END;

CREATE TRIGGER transaction_attempt_chain_guard
BEFORE INSERT ON transaction_attempt
WHEN NEW.chain_profile_id IS NOT NULL AND NEW.chain_profile_id <> (SELECT chain_profile_id FROM transaction_intent WHERE id = NEW.transaction_intent_id)
BEGIN SELECT RAISE(ABORT, 'attempt chain does not match intent'); END;

CREATE TRIGGER replacement_attempt_identity_guard
BEFORE INSERT ON transaction_attempt
WHEN NEW.replacement_of_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM transaction_attempt old
   WHERE old.id = NEW.replacement_of_id AND old.transaction_intent_id = NEW.transaction_intent_id
     AND old.nonce = NEW.nonce AND lower(COALESCE(old.from_address, '')) = lower(COALESCE(NEW.from_address, ''))
)
BEGIN SELECT RAISE(ABORT, 'replacement attempt identity mismatch'); END;

CREATE TRIGGER receipt_status_finality_guard
BEFORE INSERT ON transaction_receipt
WHEN (NEW.finality_stage IN ('posted', 'ethereum_final') AND NEW.status <> 'confirmed')
  OR (NEW.status IN ('reverted', 'reorged', 'dropped') AND NEW.finality_stage IN ('posted', 'ethereum_final'))
BEGIN SELECT RAISE(ABORT, 'receipt status and finality are inconsistent'); END;

CREATE TRIGGER receipt_hash_required_guard
BEFORE INSERT ON transaction_receipt
WHEN (SELECT tx_hash FROM transaction_attempt WHERE id = NEW.transaction_attempt_id) IS NULL
  OR lower(NEW.tx_hash) <> lower((SELECT tx_hash FROM transaction_attempt WHERE id = NEW.transaction_attempt_id))
BEGIN SELECT RAISE(ABORT, 'receipt hash must match a submitted attempt'); END;

CREATE TRIGGER receipt_money_domain_guard
BEFORE INSERT ON transaction_receipt
WHEN (NEW.gas_used IS NOT NULL AND (length(NEW.gas_used) = 0 OR NEW.gas_used GLOB '*[^0-9]*'))
  OR (NEW.effective_gas_price IS NOT NULL AND (length(NEW.effective_gas_price) = 0 OR NEW.effective_gas_price GLOB '*[^0-9]*'))
BEGIN SELECT RAISE(ABORT, 'receipt monetary values must be non-negative decimals'); END;

CREATE TRIGGER reservation_settlement_money_domain_guard
BEFORE UPDATE OF settled_amount_wei, settled_mint_value_wei, settled_l2_execution_gas_wei, settled_l1_data_gas_wei, settled_priority_fee_component_wei, settled_replacement_budget_wei ON spend_reservation
WHEN (NEW.settled_amount_wei IS NOT NULL AND (length(NEW.settled_amount_wei) = 0 OR NEW.settled_amount_wei GLOB '*[^0-9]*'))
  OR (NEW.settled_mint_value_wei IS NOT NULL AND (length(NEW.settled_mint_value_wei) = 0 OR NEW.settled_mint_value_wei GLOB '*[^0-9]*'))
  OR (NEW.settled_l2_execution_gas_wei IS NOT NULL AND (length(NEW.settled_l2_execution_gas_wei) = 0 OR NEW.settled_l2_execution_gas_wei GLOB '*[^0-9]*'))
  OR (NEW.settled_l1_data_gas_wei IS NOT NULL AND (length(NEW.settled_l1_data_gas_wei) = 0 OR NEW.settled_l1_data_gas_wei GLOB '*[^0-9]*'))
  OR (NEW.settled_priority_fee_component_wei IS NOT NULL AND (length(NEW.settled_priority_fee_component_wei) = 0 OR NEW.settled_priority_fee_component_wei GLOB '*[^0-9]*'))
  OR (NEW.settled_replacement_budget_wei IS NOT NULL AND (length(NEW.settled_replacement_budget_wei) = 0 OR NEW.settled_replacement_budget_wei GLOB '*[^0-9]*'))
BEGIN SELECT RAISE(ABORT, 'settlement monetary values must be non-negative decimals'); END;

CREATE TRIGGER reservation_settlement_component_sum_guard
BEFORE UPDATE OF settled_amount_wei, settled_mint_value_wei, settled_l2_execution_gas_wei, settled_l1_data_gas_wei, settled_priority_fee_component_wei, settled_replacement_budget_wei ON spend_reservation
 WHEN NEW.settled_mint_value_wei IS NOT NULL
 AND (NEW.settled_amount_wei IS NULL OR NEW.settled_l2_execution_gas_wei IS NULL OR NEW.settled_l1_data_gas_wei IS NULL OR NEW.settled_priority_fee_component_wei IS NULL OR NEW.settled_replacement_budget_wei IS NULL
      OR (length(NEW.settled_amount_wei) <= 18 AND length(NEW.settled_mint_value_wei) <= 18 AND length(NEW.settled_l2_execution_gas_wei) <= 18 AND length(NEW.settled_l1_data_gas_wei) <= 18 AND length(NEW.settled_priority_fee_component_wei) <= 18 AND length(NEW.settled_replacement_budget_wei) <= 18
          AND CAST(NEW.settled_amount_wei AS INTEGER) <> CAST(NEW.settled_mint_value_wei AS INTEGER) + CAST(NEW.settled_l2_execution_gas_wei AS INTEGER) + CAST(NEW.settled_l1_data_gas_wei AS INTEGER) + CAST(NEW.settled_priority_fee_component_wei AS INTEGER) + CAST(NEW.settled_replacement_budget_wei AS INTEGER)))
BEGIN SELECT RAISE(ABORT, 'settled components do not equal settled amount'); END;

CREATE TRIGGER transaction_attempt_nonce_domain_guard
BEFORE INSERT ON transaction_attempt
WHEN NEW.nonce IS NOT NULL AND NEW.nonce < 0
BEGIN SELECT RAISE(ABORT, 'transaction nonce must be non-negative'); END;

CREATE TRIGGER execution_initial_state_guard
BEFORE INSERT ON execution
WHEN NEW.state <> 'prepared'
BEGIN SELECT RAISE(ABORT, 'executions must be created in prepared state'); END;

CREATE TRIGGER campaign_initial_state_guard
BEFORE INSERT ON campaign
WHEN NEW.state NOT IN ('draft', 'prepared')
BEGIN SELECT RAISE(ABORT, 'campaigns must be created in draft state'); END;

DROP TRIGGER IF EXISTS campaign_state_transition_guard;
CREATE TRIGGER campaign_state_transition_guard
BEFORE UPDATE OF state ON campaign
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'draft' AND NEW.state IN ('validating', 'cancelled')) OR
  (OLD.state = 'validating' AND NEW.state IN ('ready', 'failed', 'cancelled')) OR
  (OLD.state = 'ready' AND NEW.state IN ('armed', 'failed', 'cancelled')) OR
  (OLD.state = 'armed' AND NEW.state IN ('active', 'paused', 'aborted', 'cancelled')) OR
  (OLD.state = 'paused' AND NEW.state IN ('armed', 'aborted', 'cancelled')) OR
  (OLD.state = 'active' AND NEW.state IN ('completed', 'failed', 'aborted')) OR
  (OLD.state = 'prepared' AND NEW.state IN ('validating', 'ready', 'failed', 'aborted', 'cancelled')) OR
  (OLD.state IN ('completed', 'failed', 'aborted', 'cancelled') AND NEW.state = OLD.state)
)
BEGIN SELECT RAISE(ABORT, 'invalid campaign lifecycle transition'); END;

CREATE TRIGGER fire_lane_initial_state_guard
BEFORE INSERT ON fire_lane
WHEN NEW.state NOT IN ('assembling', 'prepared')
BEGIN SELECT RAISE(ABORT, 'fire lanes must be created in assembling state'); END;

CREATE TRIGGER fire_lane_state_transition_guard
BEFORE UPDATE OF state ON fire_lane
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state IN ('prepared', 'assembling') AND NEW.state IN ('warmed', 'armed', 'aborted')) OR
  (OLD.state = 'warmed' AND NEW.state IN ('armed', 'aborted')) OR
  (OLD.state = 'armed' AND NEW.state IN ('firing', 'aborted')) OR
  (OLD.state = 'firing' AND NEW.state IN ('settled', 'aborted')) OR
  (OLD.state IN ('settled', 'aborted') AND NEW.state = OLD.state)
)
BEGIN SELECT RAISE(ABORT, 'invalid fire-lane lifecycle transition'); END;

CREATE TRIGGER opportunity_initial_disposition_guard
BEFORE INSERT ON opportunity
WHEN NEW.disposition NOT IN ('discovered', 'new')
BEGIN SELECT RAISE(ABORT, 'opportunities must be created in discovered state'); END;

CREATE TRIGGER opportunity_disposition_transition_guard
BEFORE UPDATE OF disposition ON opportunity
WHEN NEW.disposition <> OLD.disposition AND NOT (
  (OLD.disposition IN ('discovered', 'new') AND NEW.disposition IN ('evaluating', 'rejected', 'expired')) OR
  (OLD.disposition = 'evaluating' AND NEW.disposition IN ('scored', 'rejected', 'expired')) OR
  (OLD.disposition = 'scored' AND NEW.disposition IN ('notified', 'approved', 'rejected', 'expired')) OR
  (OLD.disposition = 'notified' AND NEW.disposition IN ('approved', 'rejected', 'expired')) OR
  (OLD.disposition = 'approved' AND NEW.disposition IN ('promoted', 'rejected')) OR
  (OLD.disposition IN ('promoted', 'rejected', 'expired') AND NEW.disposition = OLD.disposition)
)
BEGIN SELECT RAISE(ABORT, 'invalid opportunity disposition transition'); END;

CREATE TRIGGER notification_initial_delivery_guard
BEFORE INSERT ON notification
WHEN NEW.delivery_state NOT IN ('pending', 'queued')
BEGIN SELECT RAISE(ABORT, 'notifications must be created pending'); END;

CREATE TRIGGER notification_delivery_transition_guard
BEFORE UPDATE OF delivery_state ON notification
WHEN NEW.delivery_state <> OLD.delivery_state AND NOT (
  (OLD.delivery_state IN ('pending', 'queued') AND NEW.delivery_state IN ('sent', 'failed')) OR
  (OLD.delivery_state = 'sent' AND NEW.delivery_state IN ('delivered', 'failed')) OR
  (OLD.delivery_state = 'failed' AND NEW.delivery_state IN ('queued', 'dead_letter')) OR
  (OLD.delivery_state IN ('delivered', 'dead_letter') AND NEW.delivery_state = OLD.delivery_state)
)
BEGIN SELECT RAISE(ABORT, 'invalid notification delivery transition'); END;

CREATE TRIGGER eligibility_lifecycle_transition_guard
BEFORE UPDATE OF lifecycle_state ON eligibility
WHEN NEW.lifecycle_state <> OLD.lifecycle_state AND NOT (
  (OLD.lifecycle_state = 'unknown' AND NEW.lifecycle_state IN ('unfunded', 'funded', 'eligible', 'failed', 'skipped')) OR
  (OLD.lifecycle_state = 'unfunded' AND NEW.lifecycle_state IN ('funded', 'failed', 'skipped')) OR
  (OLD.lifecycle_state = 'funded' AND NEW.lifecycle_state IN ('eligible', 'failed', 'skipped')) OR
  (OLD.lifecycle_state = 'eligible' AND NEW.lifecycle_state IN ('executing', 'failed', 'skipped')) OR
  (OLD.lifecycle_state = 'executing' AND NEW.lifecycle_state IN ('minted', 'failed', 'skipped')) OR
  (OLD.lifecycle_state IN ('minted', 'failed', 'skipped') AND NEW.lifecycle_state = OLD.lifecycle_state)
)
BEGIN SELECT RAISE(ABORT, 'invalid eligibility lifecycle transition'); END;

CREATE TRIGGER lifecycle_entity_reference_guard
BEFORE INSERT ON state_transition
 WHEN (NEW.entity_type IN ('chain_profile') AND NOT EXISTS (SELECT 1 FROM chain_profile WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('campaign') AND NOT EXISTS (SELECT 1 FROM campaign WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('wallet') AND NOT EXISTS (SELECT 1 FROM wallet WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('run', 'execution_run') AND NOT EXISTS (SELECT 1 FROM execution_run WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('execution') AND NOT EXISTS (SELECT 1 FROM execution WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('transaction_intent') AND NOT EXISTS (SELECT 1 FROM transaction_intent WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('transaction_attempt') AND NOT EXISTS (SELECT 1 FROM transaction_attempt WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('transaction_receipt') AND NOT EXISTS (SELECT 1 FROM transaction_receipt WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('reservation', 'spend_reservation') AND NOT EXISTS (SELECT 1 FROM spend_reservation WHERE id = NEW.entity_id))
BEGIN SELECT RAISE(ABORT, 'lifecycle event entity does not exist'); END;

CREATE TRIGGER audit_entity_reference_guard
BEFORE INSERT ON audit_event
 WHEN (NEW.entity_type IN ('chain_profile') AND NOT EXISTS (SELECT 1 FROM chain_profile WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('campaign') AND NOT EXISTS (SELECT 1 FROM campaign WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('wallet') AND NOT EXISTS (SELECT 1 FROM wallet WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('run', 'execution_run') AND NOT EXISTS (SELECT 1 FROM execution_run WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('execution') AND NOT EXISTS (SELECT 1 FROM execution WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('transaction_intent') AND NOT EXISTS (SELECT 1 FROM transaction_intent WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('transaction_attempt') AND NOT EXISTS (SELECT 1 FROM transaction_attempt WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('transaction_receipt') AND NOT EXISTS (SELECT 1 FROM transaction_receipt WHERE id = NEW.entity_id))
  OR (NEW.entity_type IN ('reservation', 'spend_reservation') AND NOT EXISTS (SELECT 1 FROM spend_reservation WHERE id = NEW.entity_id))
BEGIN SELECT RAISE(ABORT, 'audit event entity does not exist'); END;

CREATE TRIGGER reorg_resolution_append_only_update
BEFORE UPDATE ON reorg_resolution
BEGIN SELECT RAISE(ABORT, 'reorg resolutions are append-only'); END;

CREATE TRIGGER reorg_resolution_append_only_delete
BEFORE DELETE ON reorg_resolution
BEGIN SELECT RAISE(ABORT, 'reorg resolutions are append-only'); END;

CREATE TRIGGER backup_pass_evidence_guard
BEFORE INSERT ON backup_restore_evidence
WHEN NEW.outcome = 'passed' AND (NEW.encryption_verified <> 1 OR NEW.integrity_check <> 'ok')
BEGIN SELECT RAISE(ABORT, 'passed backup evidence requires encryption and integrity verification'); END;

CREATE TRIGGER backup_pass_evidence_update_guard
BEFORE UPDATE ON backup_restore_evidence
WHEN NEW.outcome = 'passed' AND (NEW.encryption_verified <> 1 OR NEW.integrity_check <> 'ok')
BEGIN SELECT RAISE(ABORT, 'passed backup evidence requires encryption and integrity verification'); END;

INSERT INTO retention_policy (id, entity_type, retention_days, retain_indefinitely, active, approval_owner, approved_at) VALUES
  ('execution-run-indefinite', 'execution_run', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('execution-indefinite', 'execution', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('intent-indefinite', 'transaction_intent', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('attempt-indefinite', 'transaction_attempt', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('receipt-indefinite', 'transaction_receipt', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('reconciliation-indefinite', 'reconciliation_record', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('ledger-indefinite', 'spend_ledger_entry', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('lifecycle-indefinite', 'state_transition', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('audit-indefinite', 'audit_event', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('simulation-indefinite', 'simulation', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('opportunity-indefinite', 'opportunity', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('portfolio-event-indefinite', 'portfolio_event', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('performance-indefinite', 'performance_metric', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP),
  ('backup-evidence-indefinite', 'backup_restore_evidence', NULL, 1, 1, 'migration', CURRENT_TIMESTAMP);

DROP VIEW IF EXISTS recovery_unresolved_submissions;
DROP VIEW IF EXISTS recovery_orphan_reservations;
DROP VIEW IF EXISTS recovery_duplicate_nonce_identities;
DROP VIEW IF EXISTS recovery_reorg_exposure;
DROP VIEW IF EXISTS recovery_stale_simulations;
DROP VIEW IF EXISTS recovery_replacement_exposure;

CREATE VIEW recovery_unresolved_submissions AS
SELECT e.id AS execution_id,
       e.run_id,
       e.campaign_id,
       e.wallet_id,
       e.transaction_intent_id,
       a.id AS attempt_id,
       a.tx_hash,
       a.from_address,
       a.nonce,
       COALESCE(rr.state, 'unresolved') AS reconciliation_state,
       e.state AS execution_state,
       e.updated_at
  FROM execution e
  JOIN transaction_attempt a ON a.transaction_intent_id = e.transaction_intent_id
  LEFT JOIN (
    SELECT transaction_attempt_id, state
      FROM reconciliation_record r1
     WHERE r1.id = (SELECT r2.id FROM reconciliation_record r2 WHERE r2.transaction_attempt_id = r1.transaction_attempt_id ORDER BY r2.checked_at DESC, r2.id DESC LIMIT 1)
  ) rr ON rr.transaction_attempt_id = a.id
 WHERE e.state NOT IN ('confirmed', 'ethereum_final', 'minted', 'completed', 'failed', 'dropped', 'aborted', 'skipped', 'killed', 'settled')
    OR rr.state IS NULL OR rr.state NOT IN ('matched', 'final');

CREATE VIEW recovery_orphan_reservations AS
SELECT r.id AS reservation_id,
       r.wallet_id,
       r.execution_id,
       r.transaction_intent_id,
       r.idempotency_key,
       r.status,
       r.amount_wei,
       r.reserved_amount_wei,
       r.created_at
  FROM spend_reservation r
  LEFT JOIN execution e ON e.id = r.execution_id
  LEFT JOIN transaction_intent i ON i.id = r.transaction_intent_id
 WHERE r.status = 'reserved'
   AND (r.execution_id IS NULL OR r.transaction_intent_id IS NULL OR e.id IS NULL OR e.wallet_id <> r.wallet_id OR e.campaign_id <> r.campaign_id OR i.id IS NULL OR e.state IN ('failed', 'dropped', 'aborted', 'skipped', 'killed', 'settled'));

CREATE VIEW recovery_duplicate_nonce_identities AS
SELECT COALESCE(a.chain_profile_id, i.chain_profile_id, w.chain_profile_id) AS chain_profile_id,
       COALESCE(a.from_address, i.from_address, w.address) AS from_address,
       COALESCE(a.nonce, i.nonce) AS nonce,
       COUNT(DISTINCT i.id) AS intent_count,
       GROUP_CONCAT(DISTINCT i.id) AS intent_ids
  FROM transaction_intent i
  JOIN wallet w ON w.id = i.wallet_id
  LEFT JOIN transaction_attempt a ON a.transaction_intent_id = i.id
 WHERE COALESCE(a.nonce, i.nonce) IS NOT NULL
 GROUP BY COALESCE(a.chain_profile_id, i.chain_profile_id, w.chain_profile_id), lower(COALESCE(a.from_address, i.from_address, w.address)), COALESCE(a.nonce, i.nonce)
HAVING COUNT(DISTINCT i.id) > 1;

CREATE VIEW recovery_reorg_exposure AS
WITH latest_receipt AS (
  SELECT r.* FROM transaction_receipt r WHERE r.id = (SELECT r2.id FROM transaction_receipt r2 WHERE r2.transaction_attempt_id = r.transaction_attempt_id ORDER BY r2.observed_at DESC, r2.id DESC LIMIT 1)
), latest_reconciliation AS (
  SELECT r.* FROM reconciliation_record r WHERE r.id = (SELECT r2.id FROM reconciliation_record r2 WHERE r2.transaction_attempt_id = r.transaction_attempt_id ORDER BY r2.checked_at DESC, r2.id DESC LIMIT 1)
), latest_reorg AS (
  SELECT r.* FROM reorg_event r WHERE r.id = (SELECT r2.id FROM reorg_event r2 WHERE r2.transaction_attempt_id = r.transaction_attempt_id ORDER BY r2.detected_at DESC, r2.id DESC LIMIT 1)
)
SELECT e.id AS execution_id,
       e.campaign_id,
       e.wallet_id,
       e.transaction_intent_id,
       a.id AS attempt_id,
       a.tx_hash,
       lr.status AS receipt_status,
       lr.finality_stage,
       COALESCE(lrc.state, 'unresolved') AS reconciliation_state,
       lr.observed_at,
       lrg.id AS reorg_event_id
  FROM execution e
  JOIN transaction_attempt a ON a.transaction_intent_id = e.transaction_intent_id
  LEFT JOIN latest_receipt lr ON lr.transaction_attempt_id = a.id
  LEFT JOIN latest_reconciliation lrc ON lrc.transaction_attempt_id = a.id
  LEFT JOIN latest_reorg lrg ON lrg.transaction_attempt_id = a.id
 WHERE (lr.status = 'reorged' OR lrc.state = 'reorged' OR lrg.id IS NOT NULL)
   AND (lrg.id IS NULL OR NOT EXISTS (SELECT 1 FROM reorg_resolution rs WHERE rs.reorg_event_id = lrg.id AND rs.state = 'resolved'));

CREATE VIEW recovery_stale_simulations AS
WITH latest_intent AS (
  SELECT i.* FROM transaction_intent i WHERE i.id = (SELECT i2.id FROM transaction_intent i2 WHERE i2.campaign_id = i.campaign_id AND i2.wallet_id = i.wallet_id ORDER BY i2.created_at DESC, i2.id DESC LIMIT 1)
), latest_simulation AS (
  SELECT s.* FROM simulation s WHERE s.id = (SELECT s2.id FROM simulation s2 WHERE s2.campaign_id = s.campaign_id AND s2.wallet_id = s.wallet_id ORDER BY s2.checked_at DESC, s2.id DESC LIMIT 1)
)
SELECT s.id AS simulation_id,
       s.wallet_id,
       s.campaign_id,
       s.transaction_intent_id,
       s.outcome,
       s.checked_at,
       s.freshness_seconds,
       s.source_block_number
  FROM latest_simulation s
  LEFT JOIN latest_intent i ON i.campaign_id = s.campaign_id AND i.wallet_id = s.wallet_id
 WHERE (i.id IS NULL OR s.transaction_intent_id = i.id)
   AND julianday(s.checked_at) + (s.freshness_seconds / 86400.0) < julianday('now');

CREATE VIEW recovery_replacement_exposure AS
SELECT child.id AS attempt_id,
       child.execution_id,
       child.transaction_intent_id,
       child.tx_hash,
       child.nonce,
       parent.id AS replacement_of_id,
       COALESCE(rr.state, 'unresolved') AS reconciliation_state,
       child.attempted_at
  FROM transaction_attempt child
  JOIN transaction_attempt parent ON parent.id = child.replacement_of_id
  LEFT JOIN (
    SELECT transaction_attempt_id, state
      FROM reconciliation_record r1
     WHERE r1.id = (SELECT r2.id FROM reconciliation_record r2 WHERE r2.transaction_attempt_id = r1.transaction_attempt_id ORDER BY r2.checked_at DESC, r2.id DESC LIMIT 1)
  ) rr ON rr.transaction_attempt_id = child.id
 WHERE rr.state IS NULL OR rr.state NOT IN ('matched', 'final');
