CREATE TABLE runtime_control (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  kill_switch_engaged INTEGER NOT NULL CHECK (kill_switch_engaged IN (0, 1)),
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
INSERT INTO runtime_control (id, kill_switch_engaged, changed_by, changed_at) VALUES ('global', 0, 'migration', CURRENT_TIMESTAMP);

CREATE TABLE runtime_readiness_snapshot (
  id TEXT PRIMARY KEY,
  chain_profile_id TEXT REFERENCES chain_profile(id),
  readiness_state TEXT NOT NULL,
  kill_switch_engaged INTEGER NOT NULL CHECK (kill_switch_engaged IN (0, 1)),
  reconciliation_age_seconds INTEGER CHECK (reconciliation_age_seconds IS NULL OR reconciliation_age_seconds >= 0),
  policy_snapshot_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE INDEX idx_runtime_readiness_time ON runtime_readiness_snapshot(chain_profile_id, captured_at);

CREATE TABLE backup_restore_evidence (
  id TEXT PRIMARY KEY,
  store_reference TEXT NOT NULL,
  backup_reference TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-fA-F]*'),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  operation TEXT NOT NULL CHECK (operation IN ('backup', 'restore', 'verification')),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
  kill_switch_engaged INTEGER NOT NULL CHECK (kill_switch_engaged IN (0, 1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_backup_evidence_time ON backup_restore_evidence(recorded_at);
