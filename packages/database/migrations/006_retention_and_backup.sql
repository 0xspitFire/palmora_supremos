CREATE TABLE raw_observation (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  deduplication_key TEXT UNIQUE
);
CREATE INDEX idx_raw_observation_retention ON raw_observation(observed_at);
