-- D-057: immutable owner record is the second key for Base Personal Live.
CREATE TABLE base_enablement (
  id TEXT PRIMARY KEY,
  approved_by TEXT NOT NULL CHECK (approved_by = 'owner-cli'),
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  free_allowed INTEGER NOT NULL CHECK (free_allowed = 1),
  paid_allowed INTEGER NOT NULL CHECK (paid_allowed = 0),
  evidence_json TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  confirmation_digest TEXT NOT NULL CHECK (length(confirmation_digest) = 64 AND confirmation_digest NOT GLOB '*[^0-9a-f]*'),
  strategy_version TEXT NOT NULL,
  fee_policy_version TEXT NOT NULL,
  primary_endpoint_reference TEXT NOT NULL,
  fallback_endpoint_reference TEXT NOT NULL,
  custody_mode TEXT NOT NULL CHECK (custody_mode = 'local-personal-live'),
  created_at TEXT NOT NULL
);

CREATE TRIGGER base_enablement_complete
BEFORE INSERT ON base_enablement
WHEN julianday(NEW.approved_at) IS NULL
  OR julianday(NEW.expires_at) IS NULL
  OR julianday(NEW.expires_at) <= julianday(NEW.approved_at)
  OR julianday(NEW.expires_at) - julianday(NEW.approved_at) > 7.000001
  OR json_valid(NEW.evidence_json) = 0
  OR json_type(NEW.evidence_json) IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.evidence_json)) <> 7
  OR json_type(NEW.evidence_json, '$.reviewedCode') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.forkRehearsal') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.finality') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.endpointAgreement') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.feeObservation') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.liveSimulation') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.custodyReadiness') IS NOT 'true'
  OR NEW.primary_endpoint_reference = NEW.fallback_endpoint_reference
  OR length(NEW.strategy_version) = 0 OR length(NEW.fee_policy_version) = 0
BEGIN SELECT RAISE(ABORT, 'Base enablement record is incomplete'); END;

CREATE TRIGGER base_enablement_newer_only
BEFORE INSERT ON base_enablement
WHEN EXISTS (SELECT 1 FROM base_enablement WHERE julianday(approved_at) > julianday(NEW.approved_at))
BEGIN SELECT RAISE(ABORT, 'Base enablement record must be newer than the previous one'); END;

CREATE TRIGGER base_enablement_immutable_update BEFORE UPDATE ON base_enablement
BEGIN SELECT RAISE(ABORT, 'Base enablement records are immutable'); END;
CREATE TRIGGER base_enablement_immutable_delete BEFORE DELETE ON base_enablement
BEGIN SELECT RAISE(ABORT, 'Base enablement records are immutable'); END;

DROP TRIGGER IF EXISTS chain_execution_enable_guard;
DROP TRIGGER IF EXISTS chain_execution_enable_update_guard;
DROP TRIGGER IF EXISTS chain_verification_status_guard;

CREATE TRIGGER chain_execution_enable_guard
BEFORE INSERT ON chain_profile
WHEN NEW.execution_enabled = 1 AND (
  NEW.verification_status <> 'verified'
  OR (NEW.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM robinhood_enablement e WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement) AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at)))
  OR (NEW.chain_id = 8453 AND NOT EXISTS (SELECT 1 FROM base_enablement e WHERE e.rowid = (SELECT max(rowid) FROM base_enablement) AND e.free_allowed = 1 AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at))))
BEGIN SELECT RAISE(ABORT, 'execution requires verified non-Robinhood chain'); END;

CREATE TRIGGER chain_execution_enable_update_guard
BEFORE UPDATE OF execution_enabled, verification_status, chain_id, verification_approved_at ON chain_profile
WHEN NEW.execution_enabled = 1 AND (
  NEW.verification_status <> 'verified'
  OR (NEW.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM robinhood_enablement e WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement) AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at)))
  OR (NEW.chain_id = 8453 AND NOT EXISTS (SELECT 1 FROM base_enablement e WHERE e.rowid = (SELECT max(rowid) FROM base_enablement) AND e.free_allowed = 1 AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at))))
BEGIN SELECT RAISE(ABORT, 'execution requires verified non-Robinhood chain'); END;

CREATE TRIGGER chain_verification_status_guard
BEFORE UPDATE OF verification_status, verification_approved_at ON chain_profile
WHEN NEW.verification_status = 'verified' AND (
  (NEW.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM robinhood_enablement e WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement) AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at)))
  OR (NEW.chain_id = 8453 AND NOT EXISTS (SELECT 1 FROM base_enablement e WHERE e.rowid = (SELECT max(rowid) FROM base_enablement) AND e.free_allowed = 1 AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at))))
BEGIN SELECT RAISE(ABORT, 'Robinhood chain cannot be execution verified'); END;
