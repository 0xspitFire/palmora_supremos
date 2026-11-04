-- Owner-approved free watched-wallet replication. Preserve unattended provenance at arm and execute.
ALTER TABLE live_run_request ADD COLUMN automation_event_id TEXT REFERENCES event(id);

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
  OR (NEW.execution_provenance = 'attended' AND (NEW.schedule_id IS NOT NULL OR NEW.automation_event_id IS NOT NULL))
  OR (NEW.execution_provenance = 'scheduled' AND NEW.automation_event_id IS NULL AND (NEW.schedule_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM fire_schedule s WHERE s.id = NEW.schedule_id AND s.campaign_id = NEW.campaign_id
  )))
  OR (NEW.automation_event_id IS NOT NULL AND (NEW.execution_provenance <> 'scheduled' OR NEW.schedule_id IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM event e WHERE e.id = NEW.automation_event_id AND e.event_type = 'replication_prepared'
      AND json_extract(e.payload_json, '$.campaignId') = NEW.campaign_id
      AND json_extract(e.payload_json, '$.mintPriceWei') = '0'
      AND json_extract(e.payload_json, '$.policyVersion') = 'free-watched-v1'
      AND json_extract(e.payload_json, '$.score') BETWEEN 70 AND 100
      AND json_type(e.payload_json, '$.wallets') = 'array'
      AND CAST(NEW.max_fee_gwei AS REAL) <= json_extract(e.payload_json, '$.maxFeeGwei')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.wallets_json) w WHERE lower(w.value) NOT IN (
          SELECT lower(allowed.value) FROM json_each(e.payload_json, '$.wallets') allowed
        )
      )
  )))
BEGIN SELECT RAISE(ABORT, 'live run request is incomplete'); END;

CREATE UNIQUE INDEX live_request_automation_once ON live_run_request(automation_event_id) WHERE automation_event_id IS NOT NULL;
