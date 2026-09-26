-- Canonical-store compatibility and settlement safety. The compatibility
-- names are views only; job/readiness rows remain owned by the normalized
-- Phase 2 tables.

ALTER TABLE job ADD COLUMN kind TEXT;
ALTER TABLE job ADD COLUMN run_id TEXT;
ALTER TABLE job ADD COLUMN campaign_id TEXT;
ALTER TABLE job ADD COLUMN target_at TEXT;
ALTER TABLE job ADD COLUMN t_minus_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job ADD COLUMN chain_time_offset_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job ADD COLUMN request_digest TEXT;
ALTER TABLE job ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE job ADD COLUMN next_attempt_at TEXT;
ALTER TABLE job ADD COLUMN started_at TEXT;

ALTER TABLE readiness_snapshot ADD COLUMN canonical_state TEXT;
ALTER TABLE readiness_snapshot ADD COLUMN source_block TEXT;
ALTER TABLE readiness_snapshot ADD COLUMN fresh_until TEXT;
ALTER TABLE readiness_snapshot ADD COLUMN blocking_reasons_json TEXT;
ALTER TABLE readiness_snapshot ADD COLUMN checks_json TEXT;
ALTER TABLE readiness_snapshot ADD COLUMN check_states_json TEXT;
ALTER TABLE readiness_snapshot ADD COLUMN provenance_json TEXT;

CREATE VIEW orchestrator_job AS
SELECT id,
       COALESCE(kind, job_type) AS kind,
       run_id,
       campaign_id,
       CASE state WHEN 'pending' THEN 'scheduled' WHEN 'cancelled' THEN 'blocked' ELSE state END AS state,
       scheduled_at,
       target_at,
       t_minus_ms,
       chain_time_offset_ms,
       idempotency_key,
       COALESCE(request_digest, request_fingerprint) AS request_digest,
       payload_json,
       attempt_count AS attempts,
       max_attempts,
       last_error,
       next_attempt_at,
       lease_owner,
       lease_expires_at,
       started_at,
       completed_at,
       created_at,
       updated_at
  FROM job;

CREATE TRIGGER orchestrator_job_insert
INSTEAD OF INSERT ON orchestrator_job
BEGIN
  INSERT INTO job (id, job_type, kind, run_id, campaign_id, entity_type, entity_id,
                   idempotency_key, request_fingerprint, request_digest, payload_json,
                   state, priority, scheduled_at, target_at, t_minus_ms,
                   chain_time_offset_ms, attempt_count, max_attempts, last_error,
                   next_attempt_at, lease_owner, lease_expires_at, started_at,
                   completed_at, created_at, updated_at)
  VALUES (NEW.id, NEW.kind, NEW.kind, NEW.run_id, NEW.campaign_id,
          CASE WHEN NEW.run_id IS NOT NULL THEN 'run' WHEN NEW.campaign_id IS NOT NULL THEN 'campaign' END,
          COALESCE(NEW.run_id, NEW.campaign_id), NEW.idempotency_key,
          NEW.request_digest, NEW.request_digest, NEW.payload_json,
          CASE NEW.state WHEN 'scheduled' THEN 'pending' WHEN 'blocked' THEN 'cancelled' ELSE NEW.state END,
          0, NEW.scheduled_at, NEW.target_at, NEW.t_minus_ms,
          NEW.chain_time_offset_ms, NEW.attempts, NEW.max_attempts, NEW.last_error,
          NEW.next_attempt_at, NEW.lease_owner, NEW.lease_expires_at, NEW.started_at,
          NEW.completed_at, NEW.created_at, NEW.updated_at);
END;

CREATE TRIGGER orchestrator_job_update
INSTEAD OF UPDATE ON orchestrator_job
BEGIN
  UPDATE job
     SET kind = NEW.kind,
         run_id = NEW.run_id,
         campaign_id = NEW.campaign_id,
         job_type = NEW.kind,
         state = CASE NEW.state WHEN 'scheduled' THEN 'pending' WHEN 'blocked' THEN 'cancelled' ELSE NEW.state END,
         scheduled_at = NEW.scheduled_at,
         target_at = NEW.target_at,
         t_minus_ms = NEW.t_minus_ms,
         chain_time_offset_ms = NEW.chain_time_offset_ms,
         request_digest = NEW.request_digest,
         request_fingerprint = NEW.request_digest,
         payload_json = NEW.payload_json,
         attempt_count = NEW.attempts,
         max_attempts = NEW.max_attempts,
         last_error = NEW.last_error,
         next_attempt_at = NEW.next_attempt_at,
         lease_owner = NEW.lease_owner,
         lease_expires_at = NEW.lease_expires_at,
         started_at = NEW.started_at,
         completed_at = NEW.completed_at,
         updated_at = NEW.updated_at
   WHERE id = OLD.id;
END;

CREATE TRIGGER orchestrator_job_delete
INSTEAD OF DELETE ON orchestrator_job
BEGIN
  DELETE FROM job WHERE id = OLD.id;
END;

CREATE VIEW orchestrator_readiness AS
SELECT id,
       campaign_id,
       wallet_id AS wallet,
       COALESCE(canonical_state, CASE state WHEN 'failed' THEN 'blocked' ELSE state END) AS state,
       COALESCE(fresh_until, expires_at) AS fresh_until,
       COALESCE(source_block, source_block_number) AS source_block,
       source_block_hash,
       checked_at AS observed_at,
       COALESCE(blocking_reasons_json, json_array(blocking_reason)) AS blocking_reasons_json,
       COALESCE(checks_json, '{}') AS checks_json,
       check_states_json,
       provenance_json
  FROM readiness_snapshot;

CREATE TRIGGER orchestrator_readiness_insert
INSTEAD OF INSERT ON orchestrator_readiness
BEGIN
  INSERT INTO readiness_snapshot (id, campaign_id, wallet_id, canonical_state, state,
                                  next_action, checked_at, expires_at, fresh_until,
                                  source_block, source_block_number, source_block_hash,
                                  blocking_reason, blocking_reasons_json, checks_json,
                                  check_states_json, provenance_json, created_at)
  VALUES (NEW.id, NEW.campaign_id, NEW.wallet, NEW.state,
          CASE NEW.state WHEN 'blocked' THEN 'failed' WHEN 'stale' THEN 'unknown' ELSE NEW.state END,
          CASE NEW.state WHEN 'ready' THEN 'ready' ELSE 'Inspect' END,
          COALESCE(NEW.observed_at, CURRENT_TIMESTAMP), NEW.fresh_until, NEW.fresh_until,
          NEW.source_block, NEW.source_block, NEW.source_block_hash,
          NEW.blocking_reasons_json, NEW.blocking_reasons_json, NEW.checks_json,
          NEW.check_states_json, NEW.provenance_json,
          COALESCE(NEW.observed_at, CURRENT_TIMESTAMP));
END;

CREATE TRIGGER orchestrator_readiness_update
INSTEAD OF UPDATE ON orchestrator_readiness
BEGIN
  UPDATE readiness_snapshot
     SET canonical_state = NEW.state,
         state = CASE NEW.state WHEN 'blocked' THEN 'failed' WHEN 'stale' THEN 'unknown' ELSE NEW.state END,
         checked_at = COALESCE(NEW.observed_at, checked_at),
         expires_at = NEW.fresh_until,
         fresh_until = NEW.fresh_until,
         source_block = NEW.source_block,
         source_block_number = NEW.source_block,
         source_block_hash = NEW.source_block_hash,
         blocking_reason = NEW.blocking_reasons_json,
         blocking_reasons_json = NEW.blocking_reasons_json,
         checks_json = NEW.checks_json,
         check_states_json = NEW.check_states_json,
         provenance_json = NEW.provenance_json
   WHERE id = OLD.id;
END;

CREATE TRIGGER orchestrator_readiness_delete
INSTEAD OF DELETE ON orchestrator_readiness
BEGIN
  DELETE FROM readiness_snapshot WHERE id = OLD.id;
END;

CREATE TRIGGER receipt_confirmed_finality_guard
BEFORE INSERT ON transaction_receipt
WHEN NEW.status = 'confirmed'
 AND NOT EXISTS (
   SELECT 1
     FROM transaction_attempt a
     JOIN transaction_intent i ON i.id = a.transaction_intent_id
     JOIN wallet w ON w.id = i.wallet_id
     JOIN chain_profile c ON c.id = w.chain_profile_id
    WHERE a.id = NEW.transaction_attempt_id
      AND c.execution_enabled = 1
      AND NEW.finality_stage = c.success_finality_stage
 )
BEGIN SELECT RAISE(ABORT, 'confirmed receipt requires enabled-chain finality'); END;

CREATE TRIGGER finality_settlement_chain_guard
BEFORE INSERT ON finality_observation
WHEN NEW.settlement_reached = 1
 AND NOT EXISTS (
   SELECT 1 FROM chain_profile
    WHERE id = NEW.chain_profile_id
      AND execution_enabled = 1
      AND success_finality_stage = NEW.stage
 )
BEGIN SELECT RAISE(ABORT, 'settlement finality requires enabled-chain finality'); END;

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
   SELECT 1 FROM transaction_receipt r
    JOIN transaction_attempt a ON a.id = r.transaction_attempt_id
   WHERE a.execution_id = NEW.execution_id
     AND r.status IN ('reverted', 'dropped', 'reorged')
     AND r.id = (SELECT r2.id FROM transaction_receipt r2 JOIN transaction_attempt a2 ON a2.id = r2.transaction_attempt_id WHERE a2.execution_id = NEW.execution_id ORDER BY r2.observed_at DESC, r2.id DESC LIMIT 1)
 )
BEGIN SELECT RAISE(ABORT, 'settlement requires enabled-chain finality'); END;

CREATE TRIGGER spend_summary_immutable_update
BEFORE UPDATE ON spend_summary
BEGIN SELECT RAISE(ABORT, 'spend summaries are append-only snapshots'); END;
CREATE TRIGGER spend_summary_immutable_delete
BEFORE DELETE ON spend_summary
BEGIN SELECT RAISE(ABORT, 'spend summaries are append-only snapshots'); END;
