CREATE TABLE admission_clock_watermark (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  last_admission_at TEXT NOT NULL
);

CREATE INDEX idx_spend_reservation_rolling_wallet
  ON spend_reservation(wallet_id, status, settled_at);

CREATE INDEX idx_spend_reservation_rolling_fleet
  ON spend_reservation(status, settled_at, mint_class);

CREATE INDEX idx_spend_reservation_pending_age
  ON spend_reservation(status, created_at)
  WHERE status = 'reserved';

CREATE TRIGGER admission_clock_watermark_no_delete
BEFORE DELETE ON admission_clock_watermark
BEGIN SELECT RAISE(ABORT, 'admission clock watermark cannot be deleted'); END;

CREATE TRIGGER admission_clock_watermark_monotonic
BEFORE UPDATE OF last_admission_at ON admission_clock_watermark
WHEN julianday(NEW.last_admission_at) IS NULL
  OR julianday(OLD.last_admission_at) IS NULL
  OR julianday(NEW.last_admission_at) < julianday(OLD.last_admission_at)
BEGIN SELECT RAISE(ABORT, 'admission clock watermark cannot move backwards'); END;
