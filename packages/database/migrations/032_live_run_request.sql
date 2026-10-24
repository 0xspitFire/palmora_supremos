-- T-058 (owner-approved 2026-10-24): the owner asks the host service to arm and run one specific live mint.
--
-- A request is written only by the owner command, with a typed-confirmation digest, for one campaign and an exact wallet list, the
-- per-wallet simulation records and the owner's approval it relies on, and a fee ceiling. It is short-lived (at most 30 minutes, the
-- life of a simulation record) and can never be changed or deleted. The service claims a request at most once by writing its single
-- outcome row; the run itself still goes through every gate (approval, simulation, admission, caps, reservations, custody, the kill
-- switch, enablement). Nothing here can sign or send by itself.

CREATE TABLE live_run_request (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  wallets_json TEXT NOT NULL,
  simulation_ids_json TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  evidence_at TEXT NOT NULL,
  max_fee_gwei TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK (requested_by = 'owner-cli'),
  confirmation_digest TEXT NOT NULL CHECK (length(confirmation_digest) = 64 AND confirmation_digest NOT GLOB '*[^0-9a-f]*'),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TRIGGER live_run_request_complete
BEFORE INSERT ON live_run_request
WHEN julianday(NEW.requested_at) IS NULL
  OR julianday(NEW.expires_at) IS NULL
  OR julianday(NEW.expires_at) <= julianday(NEW.requested_at)
  OR (julianday(NEW.expires_at) - julianday(NEW.requested_at)) * 1440 > 30.001
  OR json_valid(NEW.wallets_json) = 0 OR json_type(NEW.wallets_json) IS NOT 'array' OR json_array_length(NEW.wallets_json) = 0
  OR json_valid(NEW.simulation_ids_json) = 0 OR json_type(NEW.simulation_ids_json) IS NOT 'array'
  OR json_array_length(NEW.simulation_ids_json) <> json_array_length(NEW.wallets_json)
  OR length(NEW.approval_id) = 0
  OR NEW.max_fee_gwei NOT GLOB '[0-9]*' OR NEW.max_fee_gwei GLOB '*[^0-9.]*' OR NEW.max_fee_gwei GLOB '*.*.*' OR NEW.max_fee_gwei GLOB '*.' OR CAST(NEW.max_fee_gwei AS REAL) <= 0 OR CAST(NEW.max_fee_gwei AS REAL) > 500
BEGIN SELECT RAISE(ABORT, 'live run request is incomplete'); END;

CREATE TRIGGER live_run_request_immutable_update BEFORE UPDATE ON live_run_request
BEGIN SELECT RAISE(ABORT, 'live run requests are immutable'); END;
CREATE TRIGGER live_run_request_immutable_delete BEFORE DELETE ON live_run_request
BEGIN SELECT RAISE(ABORT, 'live run requests are immutable'); END;

-- The service's single record of what it did with a request. One row per request (the claim), never changed.
CREATE TABLE live_run_request_outcome (
  request_id TEXT PRIMARY KEY REFERENCES live_run_request(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'expired')),
  claimed_at TEXT NOT NULL
);

-- A second claim is ignored, so INSERT OR REPLACE cannot rewrite the first one.
CREATE TRIGGER live_run_request_outcome_once BEFORE INSERT ON live_run_request_outcome
WHEN EXISTS (SELECT 1 FROM live_run_request_outcome o WHERE o.request_id = NEW.request_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER live_run_request_outcome_immutable_update BEFORE UPDATE ON live_run_request_outcome
BEGIN SELECT RAISE(ABORT, 'live run request outcomes are immutable'); END;
CREATE TRIGGER live_run_request_outcome_immutable_delete BEFORE DELETE ON live_run_request_outcome
BEGIN SELECT RAISE(ABORT, 'live run request outcomes are immutable'); END;
