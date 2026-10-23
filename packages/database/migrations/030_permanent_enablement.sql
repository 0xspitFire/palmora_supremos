-- D-062: Base and Robinhood enablement is permanent until the owner revokes it.
--
-- A new enablement row carries the fixed expiry '9999-12-31T23:59:59.999Z', which means "until revoked"; rows written before this
-- migration keep their own (at most 7-day) expiry and simply run out. A revocation is a new immutable row in
-- chain_enablement_revocation naming the enablement it ends; the chain-profile guards refuse a revoked enablement exactly as they
-- refuse an expired one, and turning a chain off is always allowed. Every other rule of 023, 024 and 027 is unchanged: complete
-- immutable rows, E1 to E7 (and the paid keys) exactly true, the newest row alone decides, independent Base endpoints.

CREATE TABLE chain_enablement_revocation (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id IN (4663, 8453)),
  enablement_id TEXT NOT NULL,
  approved_by TEXT NOT NULL CHECK (approved_by = 'owner-cli'),
  revoked_at TEXT NOT NULL,
  confirmation_digest TEXT NOT NULL CHECK (length(confirmation_digest) = 64 AND confirmation_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);

-- Only the newest enablement of that chain can be revoked, once, and not before it was approved.
CREATE TRIGGER chain_enablement_revocation_valid
BEFORE INSERT ON chain_enablement_revocation
WHEN julianday(NEW.revoked_at) IS NULL
  OR EXISTS (SELECT 1 FROM chain_enablement_revocation r WHERE r.enablement_id = NEW.enablement_id)
  OR (NEW.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM robinhood_enablement e WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement) AND e.id = NEW.enablement_id AND julianday(NEW.revoked_at) >= julianday(e.approved_at)))
  OR (NEW.chain_id = 8453 AND NOT EXISTS (SELECT 1 FROM base_enablement e WHERE e.rowid = (SELECT max(rowid) FROM base_enablement) AND e.id = NEW.enablement_id AND julianday(NEW.revoked_at) >= julianday(e.approved_at)))
BEGIN SELECT RAISE(ABORT, 'revocation must name the newest enablement of that chain'); END;

CREATE TRIGGER chain_enablement_revocation_immutable_update BEFORE UPDATE ON chain_enablement_revocation
BEGIN SELECT RAISE(ABORT, 'enablement revocations are immutable'); END;
CREATE TRIGGER chain_enablement_revocation_immutable_delete BEFORE DELETE ON chain_enablement_revocation
BEGIN SELECT RAISE(ABORT, 'enablement revocations are immutable'); END;

-- New Robinhood rows: everything 024 required, and the "until revoked" expiry.
DROP TRIGGER IF EXISTS robinhood_enablement_complete;
CREATE TRIGGER robinhood_enablement_complete
BEFORE INSERT ON robinhood_enablement
WHEN NEW.approved_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
  OR julianday(NEW.approved_at) IS NULL
  OR NEW.expires_at <> '9999-12-31T23:59:59.999Z'
  OR json_valid(NEW.evidence_json) = 0
  OR json_type(NEW.evidence_json) IS NOT 'object'
  OR json_type(NEW.evidence_json, '$.E1') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E2') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E3') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E4') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E5') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E6') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E7') IS NOT 'true'
  OR (NEW.paid_allowed = 0 AND (SELECT count(*) FROM json_each(NEW.evidence_json)) <> 7)
  OR (NEW.paid_allowed = 1 AND (
    (SELECT count(*) FROM json_each(NEW.evidence_json)) <> 9
    OR json_type(NEW.evidence_json, '$.paidRehearsal') IS NOT 'true'
    OR json_type(NEW.evidence_json, '$.paidPolicyApproved') IS NOT 'true'))
BEGIN SELECT RAISE(ABORT, 'Robinhood enablement record is incomplete'); END;

-- New Base rows: everything 027 required, and the "until revoked" expiry.
DROP TRIGGER IF EXISTS base_enablement_complete;
CREATE TRIGGER base_enablement_complete
BEFORE INSERT ON base_enablement
WHEN julianday(NEW.approved_at) IS NULL
  OR NEW.expires_at <> '9999-12-31T23:59:59.999Z'
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

-- The chain-profile guards: as in 027, plus "the newest enablement has not been revoked".
DROP TRIGGER IF EXISTS chain_execution_enable_guard;
DROP TRIGGER IF EXISTS chain_execution_enable_update_guard;
DROP TRIGGER IF EXISTS chain_verification_status_guard;

CREATE TRIGGER chain_execution_enable_guard
BEFORE INSERT ON chain_profile
WHEN NEW.execution_enabled = 1 AND (
  NEW.verification_status <> 'verified'
  OR (NEW.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM robinhood_enablement e WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement) AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at) AND NOT EXISTS (SELECT 1 FROM chain_enablement_revocation r WHERE r.enablement_id = e.id)))
  OR (NEW.chain_id = 8453 AND NOT EXISTS (SELECT 1 FROM base_enablement e WHERE e.rowid = (SELECT max(rowid) FROM base_enablement) AND e.free_allowed = 1 AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at) AND NOT EXISTS (SELECT 1 FROM chain_enablement_revocation r WHERE r.enablement_id = e.id))))
BEGIN SELECT RAISE(ABORT, 'execution requires verified non-Robinhood chain'); END;

CREATE TRIGGER chain_execution_enable_update_guard
BEFORE UPDATE OF execution_enabled, verification_status, chain_id, verification_approved_at ON chain_profile
WHEN NEW.execution_enabled = 1 AND (
  NEW.verification_status <> 'verified'
  OR (NEW.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM robinhood_enablement e WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement) AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at) AND NOT EXISTS (SELECT 1 FROM chain_enablement_revocation r WHERE r.enablement_id = e.id)))
  OR (NEW.chain_id = 8453 AND NOT EXISTS (SELECT 1 FROM base_enablement e WHERE e.rowid = (SELECT max(rowid) FROM base_enablement) AND e.free_allowed = 1 AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at) AND NOT EXISTS (SELECT 1 FROM chain_enablement_revocation r WHERE r.enablement_id = e.id))))
BEGIN SELECT RAISE(ABORT, 'execution requires verified non-Robinhood chain'); END;

CREATE TRIGGER chain_verification_status_guard
BEFORE UPDATE OF verification_status, verification_approved_at ON chain_profile
WHEN NEW.verification_status = 'verified' AND (
  (NEW.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM robinhood_enablement e WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement) AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at) AND NOT EXISTS (SELECT 1 FROM chain_enablement_revocation r WHERE r.enablement_id = e.id)))
  OR (NEW.chain_id = 8453 AND NOT EXISTS (SELECT 1 FROM base_enablement e WHERE e.rowid = (SELECT max(rowid) FROM base_enablement) AND e.free_allowed = 1 AND NEW.verification_approved_at IS NOT NULL AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at) AND julianday(NEW.verification_approved_at) < julianday(e.expires_at) AND julianday('now') < julianday(e.expires_at) AND NOT EXISTS (SELECT 1 FROM chain_enablement_revocation r WHERE r.enablement_id = e.id))))
BEGIN SELECT RAISE(ABORT, 'Robinhood chain cannot be execution verified'); END;
