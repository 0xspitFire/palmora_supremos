-- T-066 (owner-approved 2026-10-24): fee alerts the owner sets from Telegram ("/gasalert ethereum below 1").
--
-- A row is a threshold on a chain's current gas price. It can only be created complete and removed once; nothing else about it
-- ever changes and nothing is deleted. An alert never signs, sends or changes a limit: the service only reads the chain's gas price
-- and messages the owner when it crosses the threshold.

CREATE TABLE gas_alert (
  id TEXT PRIMARY KEY CHECK (id GLOB 'gas_alert_*' AND length(id) BETWEEN 12 AND 80),
  chain_id INTEGER NOT NULL CHECK (chain_id IN (1, 8453, 4663)),
  direction TEXT NOT NULL CHECK (direction IN ('below', 'above')),
  threshold_gwei TEXT NOT NULL CHECK (length(threshold_gwei) BETWEEN 1 AND 16 AND threshold_gwei GLOB '[0-9]*' AND threshold_gwei NOT GLOB '*[^0-9.]*' AND threshold_gwei NOT GLOB '*.*.*' AND threshold_gwei NOT GLOB '*.'),
  created_at TEXT NOT NULL,
  removed_at TEXT
);

CREATE TRIGGER gas_alert_complete BEFORE INSERT ON gas_alert
WHEN julianday(NEW.created_at) IS NULL OR NEW.removed_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM gas_alert a WHERE a.id = NEW.id)
  OR CAST(NEW.threshold_gwei AS REAL) <= 0 OR CAST(NEW.threshold_gwei AS REAL) > 100000
  OR (SELECT count(*) FROM gas_alert a WHERE a.removed_at IS NULL) >= 20
BEGIN SELECT RAISE(ABORT, 'gas alert is incomplete or there are too many'); END;

-- Only the removal time can be set, once.
CREATE TRIGGER gas_alert_remove_once BEFORE UPDATE ON gas_alert
WHEN OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR julianday(NEW.removed_at) IS NULL
  OR NEW.removed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'
  OR NEW.id IS NOT OLD.id OR NEW.chain_id IS NOT OLD.chain_id OR NEW.direction IS NOT OLD.direction
  OR NEW.threshold_gwei IS NOT OLD.threshold_gwei OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'gas alerts can only be removed, once'); END;
CREATE TRIGGER gas_alert_immutable_delete BEFORE DELETE ON gas_alert
BEGIN SELECT RAISE(ABORT, 'gas alerts cannot be deleted'); END;
