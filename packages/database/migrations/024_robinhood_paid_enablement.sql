-- Robinhood paid enablement (D-054, T-035 piece 4).
-- Existing seven-key FREE records remain valid and immutable. A PAID record has exactly two additional
-- evidence keys and paid_allowed = 1. Rebuild the table because SQLite cannot relax its CHECK in place.

DROP TRIGGER IF EXISTS chain_execution_enable_guard;
DROP TRIGGER IF EXISTS chain_execution_enable_update_guard;
DROP TRIGGER IF EXISTS chain_verification_status_guard;
DROP TRIGGER IF EXISTS robinhood_enablement_complete;
DROP TRIGGER IF EXISTS robinhood_enablement_newer_only;
DROP TRIGGER IF EXISTS robinhood_enablement_immutable_update;
DROP TRIGGER IF EXISTS robinhood_enablement_immutable_delete;

ALTER TABLE robinhood_enablement RENAME TO robinhood_enablement_023;

CREATE TABLE robinhood_enablement (
  id TEXT PRIMARY KEY,
  approved_by TEXT NOT NULL CHECK (approved_by = 'owner-cli'),
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_allowed INTEGER NOT NULL DEFAULT 0 CHECK (paid_allowed IN (0, 1)),
  evidence_json TEXT NOT NULL,
  confirmation_digest TEXT NOT NULL CHECK (length(confirmation_digest) = 64 AND confirmation_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);

INSERT INTO robinhood_enablement (id, approved_by, approved_at, expires_at, paid_allowed, evidence_json, confirmation_digest, created_at)
SELECT id, approved_by, approved_at, expires_at, paid_allowed, evidence_json, confirmation_digest, created_at
FROM robinhood_enablement_023;

DROP TABLE robinhood_enablement_023;

CREATE TRIGGER robinhood_enablement_complete
BEFORE INSERT ON robinhood_enablement
WHEN NEW.approved_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
  OR NEW.expires_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
  OR julianday(NEW.approved_at) IS NULL
  OR julianday(NEW.expires_at) IS NULL
  OR julianday(NEW.expires_at) <= julianday(NEW.approved_at)
  OR julianday(NEW.expires_at) - julianday(NEW.approved_at) > 7.000001
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

CREATE TRIGGER robinhood_enablement_newer_only
BEFORE INSERT ON robinhood_enablement
WHEN EXISTS (SELECT 1 FROM robinhood_enablement WHERE julianday(approved_at) > julianday(NEW.approved_at))
BEGIN SELECT RAISE(ABORT, 'Robinhood enablement record must be newer than the previous one'); END;

CREATE TRIGGER robinhood_enablement_immutable_update
BEFORE UPDATE ON robinhood_enablement
BEGIN SELECT RAISE(ABORT, 'Robinhood enablement records are immutable'); END;

CREATE TRIGGER robinhood_enablement_immutable_delete
BEFORE DELETE ON robinhood_enablement
BEGIN SELECT RAISE(ABORT, 'Robinhood enablement records are immutable'); END;

CREATE TRIGGER chain_execution_enable_guard
BEFORE INSERT ON chain_profile
WHEN NEW.execution_enabled = 1 AND (
  NEW.verification_status <> 'verified'
  OR (NEW.chain_id = 4663 AND NOT EXISTS (
    SELECT 1 FROM robinhood_enablement e
    WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement)
      AND NEW.verification_approved_at IS NOT NULL
      AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at)
      AND julianday(NEW.verification_approved_at) < julianday(e.expires_at)
      AND julianday('now') < julianday(e.expires_at))))
BEGIN SELECT RAISE(ABORT, 'execution requires verified non-Robinhood chain'); END;

CREATE TRIGGER chain_execution_enable_update_guard
BEFORE UPDATE OF execution_enabled, verification_status, chain_id, verification_approved_at ON chain_profile
WHEN NEW.execution_enabled = 1 AND (
  NEW.verification_status <> 'verified'
  OR (NEW.chain_id = 4663 AND NOT EXISTS (
    SELECT 1 FROM robinhood_enablement e
    WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement)
      AND NEW.verification_approved_at IS NOT NULL
      AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at)
      AND julianday(NEW.verification_approved_at) < julianday(e.expires_at)
      AND julianday('now') < julianday(e.expires_at))))
BEGIN SELECT RAISE(ABORT, 'execution requires verified non-Robinhood chain'); END;

CREATE TRIGGER chain_verification_status_guard
BEFORE UPDATE OF verification_status, verification_approved_at ON chain_profile
WHEN NEW.verification_status = 'verified' AND NEW.chain_id = 4663 AND NOT EXISTS (
  SELECT 1 FROM robinhood_enablement e
  WHERE e.rowid = (SELECT max(rowid) FROM robinhood_enablement)
    AND NEW.verification_approved_at IS NOT NULL
    AND julianday(NEW.verification_approved_at) >= julianday(e.approved_at)
    AND julianday(NEW.verification_approved_at) < julianday(e.expires_at)
    AND julianday('now') < julianday(e.expires_at))
BEGIN SELECT RAISE(ABORT, 'Robinhood chain cannot be execution verified'); END;
