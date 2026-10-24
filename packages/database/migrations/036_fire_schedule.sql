-- T-067 (D-067, accepted 2026-10-24): a scheduled mint. The owner pre-authorises ONE exact mint, and the service fires it when the mint opens.
--
-- A schedule is written only by the owner's Telegram `/schedule`, after a typed phrase inside an unlocked session. It names one
-- prepared campaign (and a digest of that campaign's numbers), the exact wallets, the fee ceiling and a window of at most 6 hours. It
-- can never be changed or deleted. The service claims a schedule at most once by writing its single outcome row; firing it still goes
-- through every gate (test mints, approval, arm, caps, reservations, custody, the Turnkey policy, the kill switch). Nothing here can
-- sign or send by itself.

CREATE TABLE fire_schedule (
  id TEXT PRIMARY KEY CHECK (id GLOB 'fire_schedule_*' AND length(id) BETWEEN 16 AND 80),
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  campaign_digest TEXT NOT NULL CHECK (length(campaign_digest) = 64 AND campaign_digest NOT GLOB '*[^0-9a-f]*'),
  wallets_json TEXT NOT NULL,
  max_fee_gwei TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_until TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK (requested_by = 'owner-telegram'),
  confirmation_digest TEXT NOT NULL CHECK (length(confirmation_digest) = 64 AND confirmation_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);

CREATE TRIGGER fire_schedule_complete BEFORE INSERT ON fire_schedule
WHEN julianday(NEW.created_at) IS NULL OR julianday(NEW.window_from) IS NULL OR julianday(NEW.window_until) IS NULL
  OR NEW.window_from NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'
  OR NEW.window_until NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'
  OR julianday(NEW.window_until) <= julianday(NEW.window_from)
  OR (julianday(NEW.window_until) - julianday(NEW.window_from)) * 24 > 6.001
  OR julianday(NEW.window_until) <= julianday(NEW.created_at)
  OR (julianday(NEW.window_from) - julianday(NEW.created_at)) * 24 > 168
  OR EXISTS (SELECT 1 FROM fire_schedule s WHERE s.id = NEW.id)
  OR json_valid(NEW.wallets_json) = 0 OR json_type(NEW.wallets_json) IS NOT 'array' OR json_array_length(NEW.wallets_json) = 0 OR json_array_length(NEW.wallets_json) > 10
  OR NEW.max_fee_gwei NOT GLOB '[0-9]*' OR NEW.max_fee_gwei GLOB '*[^0-9.]*' OR NEW.max_fee_gwei GLOB '*.*.*' OR NEW.max_fee_gwei GLOB '*.'
  OR CAST(NEW.max_fee_gwei AS REAL) <= 0 OR CAST(NEW.max_fee_gwei AS REAL) > 500
  OR (SELECT count(*) FROM fire_schedule s WHERE NOT EXISTS (SELECT 1 FROM fire_schedule_outcome o WHERE o.schedule_id = s.id) AND julianday(s.window_until) > julianday(NEW.created_at)) >= 5
BEGIN SELECT RAISE(ABORT, 'fire schedule is incomplete or there are too many open'); END;

CREATE TRIGGER fire_schedule_immutable_update BEFORE UPDATE ON fire_schedule
BEGIN SELECT RAISE(ABORT, 'fire schedules are immutable'); END;
CREATE TRIGGER fire_schedule_immutable_delete BEFORE DELETE ON fire_schedule
BEGIN SELECT RAISE(ABORT, 'fire schedules are immutable'); END;

-- The service's (or the owner's) single record of what happened to a schedule. One row per schedule, never changed.
CREATE TABLE fire_schedule_outcome (
  schedule_id TEXT PRIMARY KEY REFERENCES fire_schedule(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'expired', 'cancelled')),
  claimed_at TEXT NOT NULL CHECK (julianday(claimed_at) IS NOT NULL)
);

-- A second claim is ignored, so INSERT OR REPLACE cannot rewrite the first one.
CREATE TRIGGER fire_schedule_outcome_once BEFORE INSERT ON fire_schedule_outcome
WHEN EXISTS (SELECT 1 FROM fire_schedule_outcome o WHERE o.schedule_id = NEW.schedule_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER fire_schedule_outcome_immutable_update BEFORE UPDATE ON fire_schedule_outcome
BEGIN SELECT RAISE(ABORT, 'fire schedule outcomes are immutable'); END;
CREATE TRIGGER fire_schedule_outcome_immutable_delete BEFORE DELETE ON fire_schedule_outcome
BEGIN SELECT RAISE(ABORT, 'fire schedule outcomes are immutable'); END;
