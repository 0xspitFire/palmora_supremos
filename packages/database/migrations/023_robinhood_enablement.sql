-- Robinhood live enablement record (D-040 Key 2, D-050, D-051, T-032 part B).
--
-- Until this migration, three triggers (migration 015) made it impossible to mark chain 4663 verified or execution-enabled.
-- They are replaced here by versions that allow it ONLY while the newest row of robinhood_enablement is valid at the
-- approval time written on the chain profile. Every other trigger (017, 018, 019, 021) is unchanged: they only look at
-- chain_profile.execution_enabled, which stays 0 for chain 4663 unless this record exists.
--
-- A row can only be added complete (owner command, a typed-confirmation digest, E1 to E7 each exactly true, an expiry at
-- most 7 days after approval, paid mints not allowed yet), can never be changed or deleted, and a newer row supersedes it.
-- The record's own times are the ones the application writes. In addition, the three chain-profile triggers below also compare the
-- record's expiry with the database clock, so a profile cannot be switched back on after the record has expired without a new record.

CREATE TABLE robinhood_enablement (
  id TEXT PRIMARY KEY,
  approved_by TEXT NOT NULL CHECK (approved_by = 'owner-cli'),
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Part C (paid fork rehearsal and settlement checks) relaxes this by a later migration.
  paid_allowed INTEGER NOT NULL DEFAULT 0 CHECK (paid_allowed = 0),
  evidence_json TEXT NOT NULL,
  confirmation_digest TEXT NOT NULL CHECK (length(confirmation_digest) = 64 AND confirmation_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);

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
  OR (SELECT count(*) FROM json_each(NEW.evidence_json)) <> 7
  OR json_type(NEW.evidence_json, '$.E1') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E2') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E3') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E4') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E5') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E6') IS NOT 'true'
  OR json_type(NEW.evidence_json, '$.E7') IS NOT 'true'
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

-- Replace the three migration 015 triggers. For chain 4663 the profile may be verified or execution-enabled only if the
-- newest enablement row was valid at the profile's own approval time. For every other chain nothing changes.
DROP TRIGGER IF EXISTS chain_execution_enable_guard;
DROP TRIGGER IF EXISTS chain_execution_enable_update_guard;
DROP TRIGGER IF EXISTS chain_verification_status_guard;

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
