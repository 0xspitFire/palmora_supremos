-- Cross-layer safety correction: compatibility writes must target normalized
-- authority without weakening append-only evidence or identity invariants.

DROP TRIGGER orchestrator_readiness_insert;
DROP TRIGGER orchestrator_readiness_update;
DROP TRIGGER orchestrator_readiness_delete;
DROP VIEW orchestrator_readiness;

CREATE TABLE readiness_compat_tombstone (
  campaign_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL REFERENCES wallet(id),
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, wallet_id)
);

CREATE VIEW orchestrator_readiness AS
SELECT CASE WHEN instr(r.id, ':update:') > 0 THEN substr(r.id, 1, instr(r.id, ':update:') - 1) ELSE r.id END AS id,
       r.campaign_id,
       COALESCE(w.address, r.wallet_id) AS wallet,
       COALESCE(r.canonical_state, CASE r.state WHEN 'failed' THEN 'blocked' ELSE r.state END) AS state,
       COALESCE(r.fresh_until, r.expires_at) AS fresh_until,
       COALESCE(r.source_block, r.source_block_number) AS source_block,
       r.source_block_hash,
       r.checked_at AS observed_at,
       COALESCE(r.blocking_reasons_json, json_array(r.blocking_reason)) AS blocking_reasons_json,
       COALESCE(r.checks_json, '{}') AS checks_json,
       r.check_states_json,
       r.provenance_json
  FROM readiness_snapshot r
  LEFT JOIN wallet w ON w.id = r.wallet_id
 WHERE NOT EXISTS (
   SELECT 1 FROM readiness_compat_tombstone t
    WHERE t.campaign_id = r.campaign_id AND t.wallet_id = r.wallet_id
 )
   AND NOT EXISTS (
     SELECT 1 FROM readiness_snapshot newer
      WHERE newer.campaign_id = r.campaign_id AND newer.wallet_id = r.wallet_id
        AND (newer.checked_at > r.checked_at OR (newer.checked_at = r.checked_at AND newer.id > r.id))
   );

CREATE TRIGGER orchestrator_readiness_insert
INSTEAD OF INSERT ON orchestrator_readiness
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM wallet w WHERE lower(w.address) = lower(NEW.wallet) OR w.id = NEW.wallet
  ) THEN RAISE(ABORT, 'orchestrator readiness wallet not found') END;
  DELETE FROM readiness_compat_tombstone
   WHERE campaign_id = NEW.campaign_id
     AND wallet_id = (SELECT w.id FROM wallet w WHERE lower(w.address) = lower(NEW.wallet) OR w.id = NEW.wallet LIMIT 1);
  INSERT INTO readiness_snapshot (id, campaign_id, wallet_id, canonical_state, state,
                                  decision, next_action, checked_at, expires_at, fresh_until,
                                  source_block, source_block_number, source_block_hash,
                                  blocking_reason, blocking_reasons_json, checks_json,
                                  check_states_json, provenance_json, created_at)
  SELECT NEW.id,
         NEW.campaign_id,
         w.id,
         lower(NEW.state),
         CASE lower(NEW.state) WHEN 'blocked' THEN 'failed' WHEN 'stale' THEN 'unknown' ELSE lower(NEW.state) END,
         CASE lower(NEW.state) WHEN 'ready' THEN 'ready' WHEN 'blocked' THEN 'blocked' WHEN 'stale' THEN 'stale' ELSE 'unknown' END,
         CASE lower(NEW.state) WHEN 'ready' THEN 'ready' ELSE 'Inspect' END,
         COALESCE(NEW.observed_at, CURRENT_TIMESTAMP),
         NEW.fresh_until,
         NEW.fresh_until,
         NEW.source_block,
         NEW.source_block,
         NEW.source_block_hash,
         NEW.blocking_reasons_json,
         NEW.blocking_reasons_json,
         NEW.checks_json,
         NEW.check_states_json,
         NEW.provenance_json,
         COALESCE(NEW.observed_at, CURRENT_TIMESTAMP)
    FROM wallet w
   WHERE lower(w.address) = lower(NEW.wallet) OR w.id = NEW.wallet
   LIMIT 1;
END;

CREATE TRIGGER orchestrator_readiness_update
INSTEAD OF UPDATE ON orchestrator_readiness
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM wallet w WHERE lower(w.address) = lower(NEW.wallet) OR w.id = NEW.wallet
  ) THEN RAISE(ABORT, 'orchestrator readiness wallet not found') END;
  DELETE FROM readiness_compat_tombstone
   WHERE campaign_id = NEW.campaign_id
     AND wallet_id = (SELECT w.id FROM wallet w WHERE lower(w.address) = lower(NEW.wallet) OR w.id = NEW.wallet LIMIT 1);
  INSERT INTO readiness_snapshot (id, campaign_id, wallet_id, canonical_state, state,
                                  decision, next_action, checked_at, expires_at, fresh_until,
                                  source_block, source_block_number, source_block_hash,
                                  blocking_reason, blocking_reasons_json, checks_json,
                                  check_states_json, provenance_json, created_at)
  SELECT OLD.id || ':update:' || lower(hex(randomblob(8))),
         NEW.campaign_id,
         w.id,
         lower(NEW.state),
         CASE lower(NEW.state) WHEN 'blocked' THEN 'failed' WHEN 'stale' THEN 'unknown' ELSE lower(NEW.state) END,
         CASE lower(NEW.state) WHEN 'ready' THEN 'ready' WHEN 'blocked' THEN 'blocked' WHEN 'stale' THEN 'stale' ELSE 'unknown' END,
         CASE lower(NEW.state) WHEN 'ready' THEN 'ready' ELSE 'Inspect' END,
         COALESCE(NEW.observed_at, CURRENT_TIMESTAMP),
         NEW.fresh_until,
         NEW.fresh_until,
         NEW.source_block,
         NEW.source_block,
         NEW.source_block_hash,
         NEW.blocking_reasons_json,
         NEW.blocking_reasons_json,
         NEW.checks_json,
         NEW.check_states_json,
         NEW.provenance_json,
         COALESCE(NEW.observed_at, CURRENT_TIMESTAMP)
    FROM wallet w
   WHERE lower(w.address) = lower(NEW.wallet) OR w.id = NEW.wallet
   LIMIT 1;
END;

CREATE TRIGGER orchestrator_readiness_delete
INSTEAD OF DELETE ON orchestrator_readiness
BEGIN
  INSERT OR REPLACE INTO readiness_compat_tombstone (campaign_id, wallet_id, deleted_at)
  SELECT OLD.campaign_id, w.id, CURRENT_TIMESTAMP
    FROM wallet w
   WHERE lower(w.address) = lower(OLD.wallet) OR w.id = OLD.wallet
   LIMIT 1;
END;

DROP TRIGGER reservation_settlement_finality_guard;
CREATE TRIGGER reservation_settlement_finality_guard
BEFORE UPDATE OF status ON spend_reservation
WHEN NEW.status = 'settled'
  AND NEW.execution_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM transaction_receipt r
      JOIN transaction_attempt a ON a.id = r.transaction_attempt_id
      JOIN transaction_intent i ON i.id = a.transaction_intent_id
      JOIN wallet w ON w.id = i.wallet_id
      JOIN chain_profile c ON c.id = w.chain_profile_id
     WHERE a.execution_id = NEW.execution_id
       AND r.status = 'confirmed'
       AND r.finality_stage = c.success_finality_stage
       AND c.execution_enabled = 1
       AND r.id = (SELECT r2.id FROM transaction_receipt r2 JOIN transaction_attempt a2 ON a2.id = r2.transaction_attempt_id WHERE a2.execution_id = NEW.execution_id ORDER BY r2.observed_at DESC, r2.id DESC LIMIT 1)
  )
  AND NOT EXISTS (
    SELECT 1
      FROM transaction_receipt r
      JOIN transaction_attempt a ON a.id = r.transaction_attempt_id
     WHERE a.execution_id = NEW.execution_id
       AND r.status IN ('reverted', 'dropped', 'reorged')
       AND r.id = (SELECT r2.id FROM transaction_receipt r2 JOIN transaction_attempt a2 ON a2.id = r2.transaction_attempt_id WHERE a2.execution_id = NEW.execution_id ORDER BY r2.observed_at DESC, r2.id DESC LIMIT 1)
  )
  AND NOT EXISTS (
    SELECT 1 FROM reconciliation_record rr
     WHERE rr.execution_id = NEW.execution_id
       AND rr.state IN ('final', 'reorged')
       AND rr.id = (SELECT rr2.id FROM reconciliation_record rr2 WHERE rr2.execution_id = NEW.execution_id ORDER BY rr2.checked_at DESC, rr2.id DESC LIMIT 1)
  )
BEGIN SELECT RAISE(ABORT, 'settlement requires enabled-chain finality or final reconciliation'); END;

CREATE TRIGGER campaign_wallet_identity_guard_update
BEFORE UPDATE OF campaign_id, wallet_id ON campaign_wallet
WHEN NOT EXISTS (
  SELECT 1
    FROM campaign c
    JOIN "drop" d ON d.id = c.drop_id
    JOIN collection col ON col.id = d.collection_id
    JOIN contract ct ON ct.id = col.contract_id
    JOIN wallet w ON w.id = NEW.wallet_id
   WHERE c.id = NEW.campaign_id AND ct.chain_profile_id = w.chain_profile_id
)
BEGIN SELECT RAISE(ABORT, 'campaign wallet chain identity mismatch'); END;

CREATE TRIGGER finality_observation_identity_guard
BEFORE INSERT ON finality_observation
WHEN NOT EXISTS (
  SELECT 1
    FROM execution e
    JOIN transaction_intent i ON i.id = e.transaction_intent_id
    JOIN wallet w ON w.id = e.wallet_id
   WHERE e.id = NEW.execution_id AND w.chain_profile_id = NEW.chain_profile_id AND i.wallet_id = e.wallet_id AND i.campaign_id = e.campaign_id
)
 OR (NEW.transaction_attempt_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM transaction_attempt a
     WHERE a.id = NEW.transaction_attempt_id AND a.execution_id = NEW.execution_id
 ))
 OR (NEW.transaction_receipt_id IS NOT NULL AND NOT EXISTS (
   SELECT 1
     FROM transaction_receipt r
     JOIN transaction_attempt a ON a.id = r.transaction_attempt_id
    WHERE r.id = NEW.transaction_receipt_id AND a.execution_id = NEW.execution_id
      AND (NEW.transaction_attempt_id IS NULL OR a.id = NEW.transaction_attempt_id)
 ))
BEGIN SELECT RAISE(ABORT, 'finality evidence identity does not match execution chain'); END;

CREATE TRIGGER reconciliation_evidence_guard
BEFORE INSERT ON reconciliation_record
WHEN NEW.policy_version IS NULL
  OR length(trim(NEW.policy_version)) = 0
  OR json_valid(NEW.details_json) = 0
  OR json_type(NEW.details_json) <> 'object'
  OR length(trim(NEW.details_json)) <= 2
BEGIN SELECT RAISE(ABORT, 'reconciliation requires policy and source evidence'); END;

CREATE TRIGGER chain_verification_substantive_guard
BEFORE INSERT ON chain_verification
WHEN NEW.status = 'verified'
 AND (json_valid(NEW.evidence_json) = 0
   OR json_type(NEW.evidence_json) <> 'object'
   OR json_extract(NEW.evidence_json, '$.finalityPassed') IS NOT 1
   OR NEW.approved_by IS NULL
   OR NEW.approved_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'verified chain requires substantive finality evidence'); END;

CREATE TRIGGER chain_profile_substantive_guard
BEFORE INSERT ON chain_profile
WHEN NEW.execution_enabled = 1
 AND (NEW.verification_status <> 'verified'
   OR json_valid(NEW.verification_evidence_json) = 0
   OR json_type(NEW.verification_evidence_json) <> 'object'
   OR json_extract(NEW.verification_evidence_json, '$.finalityPassed') IS NOT 1)
BEGIN SELECT RAISE(ABORT, 'enabled chain requires substantive finality evidence'); END;

CREATE TRIGGER chain_profile_substantive_guard_update
BEFORE UPDATE OF execution_enabled, verification_status, verification_evidence_json ON chain_profile
WHEN NEW.execution_enabled = 1
 AND (NEW.verification_status <> 'verified'
   OR json_valid(NEW.verification_evidence_json) = 0
   OR json_type(NEW.verification_evidence_json) <> 'object'
   OR json_extract(NEW.verification_evidence_json, '$.finalityPassed') IS NOT 1)
BEGIN SELECT RAISE(ABORT, 'enabled chain requires substantive finality evidence'); END;

CREATE TRIGGER backup_passed_evidence_guard
BEFORE INSERT ON backup_restore_evidence
WHEN NEW.outcome = 'passed'
 AND (NEW.kill_switch_engaged <> 1
   OR NEW.verification_sha256 IS NULL
   OR lower(NEW.verification_sha256) <> lower(NEW.sha256)
   OR json_valid(NEW.evidence_json) = 0
   OR json_extract(NEW.evidence_json, '$.offHost') IS NOT 1
   OR json_extract(NEW.evidence_json, '$.restoreVerified') IS NOT 1
   OR json_extract(NEW.evidence_json, '$.postRestoreReconciliation') IS NOT 1
   OR CAST(json_extract(NEW.evidence_json, '$.retentionDays') AS INTEGER) <= 0)
BEGIN SELECT RAISE(ABORT, 'passed backup evidence is incomplete'); END;

CREATE TRIGGER backup_passed_evidence_guard_update
BEFORE UPDATE OF outcome, kill_switch_engaged, verification_sha256, sha256, evidence_json ON backup_restore_evidence
WHEN NEW.outcome = 'passed'
 AND (NEW.kill_switch_engaged <> 1
   OR NEW.verification_sha256 IS NULL
   OR lower(NEW.verification_sha256) <> lower(NEW.sha256)
   OR json_valid(NEW.evidence_json) = 0
   OR json_extract(NEW.evidence_json, '$.offHost') IS NOT 1
   OR json_extract(NEW.evidence_json, '$.restoreVerified') IS NOT 1
   OR json_extract(NEW.evidence_json, '$.postRestoreReconciliation') IS NOT 1
   OR CAST(json_extract(NEW.evidence_json, '$.retentionDays') AS INTEGER) <= 0)
BEGIN SELECT RAISE(ABORT, 'passed backup evidence is incomplete'); END;
