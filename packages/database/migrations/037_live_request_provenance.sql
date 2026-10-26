-- D-017 review: a request created by the unattended scheduler must remain identifiable as unattended all the way to arm/execute.
-- Existing requests are `legacy`: v36 did not record whether they came from the scheduler, so they can never be treated as attended.
-- New owner-attended requests are explicitly `attended`; a scheduled request names the immutable schedule that created it.

ALTER TABLE live_run_request ADD COLUMN execution_provenance TEXT NOT NULL DEFAULT 'legacy'
  CHECK (execution_provenance IN ('legacy', 'attended', 'scheduled'));
ALTER TABLE live_run_request ADD COLUMN schedule_id TEXT REFERENCES fire_schedule(id);

DROP TRIGGER live_run_request_complete;
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
  OR NEW.execution_provenance = 'legacy'
  OR (NEW.execution_provenance = 'attended' AND NEW.schedule_id IS NOT NULL)
  OR (NEW.execution_provenance = 'scheduled' AND (NEW.schedule_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM fire_schedule s WHERE s.id = NEW.schedule_id AND s.campaign_id = NEW.campaign_id
  )))
BEGIN SELECT RAISE(ABORT, 'live run request is incomplete'); END;
