-- D-062 item 3: paid Base becomes possible, with the numbers D-057 item 4 proposed and the owner approved. A paid Base record has
-- exactly two more evidence keys (paidRehearsal: the Base paid fork rehearsal passed the D-054 scenarios; paidPolicyApproved: the
-- D-062 approval), both exactly true, and paid_allowed = 1. Existing free rows stay valid and immutable. Everything from 027 and 030
-- is kept: permanent until revoked, newest row decides, independent endpoints, local attended custody only.
-- SQLite cannot relax a CHECK in place, so the table is rebuilt; every trigger that names it is dropped first and recreated.

DROP TRIGGER IF EXISTS chain_execution_enable_guard;
DROP TRIGGER IF EXISTS chain_execution_enable_update_guard;
DROP TRIGGER IF EXISTS chain_verification_status_guard;
DROP TRIGGER IF EXISTS chain_enablement_revocation_valid;
DROP TRIGGER IF EXISTS base_enablement_complete;
DROP TRIGGER IF EXISTS base_enablement_newer_only;
DROP TRIGGER IF EXISTS base_enablement_immutable_update;
DROP TRIGGER IF EXISTS base_enablement_immutable_delete;

ALTER TABLE base_enablement RENAME TO base_enablement_027;

CREATE TABLE base_enablement (
  id TEXT PRIMARY KEY,
  approved_by TEXT NOT NULL CHECK (approved_by = 'owner-cli'),
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  free_allowed INTEGER NOT NULL CHECK (free_allowed = 1),
  paid_allowed INTEGER NOT NULL CHECK (paid_allowed IN (0, 1)),
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

INSERT INTO base_enablement (id, approved_by, approved_at, expires_at, free_allowed, paid_allowed, evidence_json, evidence_digest, confirmation_digest, strategy_version, fee_policy_version, primary_endpoint_reference, fallback_endpoint_reference, custody_mode, created_at)
SELECT id, approved_by, approved_at, expires_at, free_allowed, paid_allowed, evidence_json, evidence_digest, confirmation_digest, strategy_version, fee_policy_version, primary_endpoint_reference, fallback_endpoint_reference, custody_mode, created_at
FROM base_enablement_027 ORDER BY rowid;

DROP TABLE base_enablement_027;

CREATE TRIGGER base_enablement_complete
BEFORE INSERT ON base_enablement
WHEN julianday(NEW.approved_at) IS NULL
  OR NEW.expires_at <> '9999-12-31T23:59:59.999Z'
  OR json_valid(NEW.evidence_json) = 0
  OR json_type(NEW.evidence_json) IS NOT 'object'
  OR json_type(NEW.evidence_json, '$.reviewedCode') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.forkRehearsal') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.finality') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.endpointAgreement') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.feeObservation') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.liveSimulation') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.custodyReadiness') IS NOT 'true'
  OR (NEW.paid_allowed = 0 AND (SELECT count(*) FROM json_each(NEW.evidence_json)) <> 7)
  OR (NEW.paid_allowed = 1 AND (
    (SELECT count(*) FROM json_each(NEW.evidence_json)) <> 9
    OR json_type(NEW.evidence_json, '$.paidRehearsal') IS NOT 'true'
    OR json_type(NEW.evidence_json, '$.paidPolicyApproved') IS NOT 'true'))
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

-- Recreated exactly as in 030.
CREATE TRIGGER chain_enablement_revocation_valid
BEFORE INSERT ON chain_enablement_revocation
WHEN julianday(NEW.revoked_at) IS NULL
  OR EXISTS (SELECT 1 FROM chain_enablement_revocation r WHERE r.enablement_id = NEW.enablement_id)
  OR (NEW.chain_id = 4663 AND NOT EXISTS (SELECT 1 FROM robinhood_enablement e WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement) AND e.id = NEW.enablement_id AND julianday(NEW.revoked_at) >= julianday(e.approved_at)))
  OR (NEW.chain_id = 8453 AND NOT EXISTS (SELECT 1 FROM base_enablement e WHERE e.rowid = (SELECT max(rowid) FROM base_enablement) AND e.id = NEW.enablement_id AND julianday(NEW.revoked_at) >= julianday(e.approved_at)))
BEGIN SELECT RAISE(ABORT, 'revocation must name the newest enablement of that chain'); END;

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
