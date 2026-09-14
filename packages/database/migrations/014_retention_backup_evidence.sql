CREATE TABLE retention_policy (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL UNIQUE,
  retention_days INTEGER,
  retain_indefinitely INTEGER NOT NULL DEFAULT 0 CHECK (retain_indefinitely IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  approval_owner TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  CHECK ((retain_indefinitely = 1 AND retention_days IS NULL) OR (retain_indefinitely = 0 AND retention_days IS NOT NULL AND retention_days > 0))
);

INSERT INTO retention_policy (id, entity_type, retention_days, retain_indefinitely, active, approval_owner, approved_at)
VALUES ('raw-observation-30d', 'raw_observation', 30, 0, 1, 'migration', CURRENT_TIMESTAMP);

CREATE TABLE retention_evidence (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES retention_policy(id),
  entity_type TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  rows_deleted INTEGER NOT NULL CHECK (rows_deleted >= 0),
  rows_retained INTEGER NOT NULL CHECK (rows_retained >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL
);

ALTER TABLE backup_restore_evidence ADD COLUMN encryption_verified INTEGER NOT NULL DEFAULT 0 CHECK (encryption_verified IN (0, 1));
ALTER TABLE backup_restore_evidence ADD COLUMN integrity_check TEXT NOT NULL DEFAULT 'not_recorded' CHECK (integrity_check IN ('ok', 'failed', 'not_recorded'));

CREATE INDEX idx_retention_policy_active ON retention_policy(entity_type, active);
CREATE INDEX idx_retention_evidence_policy_time ON retention_evidence(policy_id, recorded_at);
CREATE INDEX idx_backup_evidence_schema_time ON backup_restore_evidence(schema_version, recorded_at);

CREATE TRIGGER retention_evidence_append_only_update
BEFORE UPDATE ON retention_evidence
BEGIN SELECT RAISE(ABORT, 'retention evidence is append-only'); END;

CREATE TRIGGER retention_evidence_append_only_delete
BEFORE DELETE ON retention_evidence
BEGIN SELECT RAISE(ABORT, 'retention evidence is append-only'); END;
