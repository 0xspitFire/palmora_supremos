ALTER TABLE spend_reservation ADD COLUMN chain_profile_id TEXT REFERENCES chain_profile(id);
ALTER TABLE spend_reservation ADD COLUMN campaign_id TEXT REFERENCES campaign(id);
ALTER TABLE spend_reservation ADD COLUMN mint_value_wei TEXT NOT NULL DEFAULT '0' CHECK (length(mint_value_wei) > 0 AND mint_value_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN l2_execution_gas_wei TEXT NOT NULL DEFAULT '0' CHECK (length(l2_execution_gas_wei) > 0 AND l2_execution_gas_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN l1_data_gas_wei TEXT NOT NULL DEFAULT '0' CHECK (length(l1_data_gas_wei) > 0 AND l1_data_gas_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN priority_fee_component_wei TEXT NOT NULL DEFAULT '0' CHECK (length(priority_fee_component_wei) > 0 AND priority_fee_component_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN policy_snapshot_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_reservation_scope ON spend_reservation(chain_profile_id, campaign_id, wallet_id, usage_date, status);
CREATE INDEX idx_reservation_pending ON spend_reservation(status, usage_date);
CREATE TRIGGER spend_reservation_policy_snapshot_immutable
BEFORE UPDATE ON spend_reservation
WHEN OLD.chain_profile_id IS NOT NEW.chain_profile_id OR OLD.campaign_id IS NOT NEW.campaign_id
  OR OLD.policy_id IS NOT NEW.policy_id OR OLD.mint_value_wei IS NOT NEW.mint_value_wei
  OR OLD.l2_execution_gas_wei IS NOT NEW.l2_execution_gas_wei OR OLD.l1_data_gas_wei IS NOT NEW.l1_data_gas_wei
  OR OLD.priority_fee_component_wei IS NOT NEW.priority_fee_component_wei OR OLD.policy_snapshot_json IS NOT NEW.policy_snapshot_json
BEGIN SELECT RAISE(ABORT, 'reservation policy snapshot is immutable'); END;
