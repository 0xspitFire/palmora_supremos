ALTER TABLE spend_reservation ADD COLUMN transaction_intent_id TEXT REFERENCES transaction_intent(id);
ALTER TABLE spend_reservation ADD COLUMN request_id TEXT;
ALTER TABLE spend_reservation ADD COLUMN request_fingerprint TEXT;
ALTER TABLE spend_reservation ADD COLUMN replacement_budget_wei TEXT NOT NULL DEFAULT '0' CHECK (length(replacement_budget_wei) > 0 AND replacement_budget_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN mint_value_buffer_wei TEXT NOT NULL DEFAULT '0' CHECK (length(mint_value_buffer_wei) > 0 AND mint_value_buffer_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN l2_execution_gas_buffer_wei TEXT NOT NULL DEFAULT '0' CHECK (length(l2_execution_gas_buffer_wei) > 0 AND l2_execution_gas_buffer_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN l1_data_gas_buffer_wei TEXT NOT NULL DEFAULT '0' CHECK (length(l1_data_gas_buffer_wei) > 0 AND l1_data_gas_buffer_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN priority_fee_buffer_wei TEXT NOT NULL DEFAULT '0' CHECK (length(priority_fee_buffer_wei) > 0 AND priority_fee_buffer_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN reserved_amount_wei TEXT NOT NULL DEFAULT '0' CHECK (length(reserved_amount_wei) > 0 AND reserved_amount_wei NOT GLOB '*[^0-9]*');
ALTER TABLE spend_reservation ADD COLUMN settled_amount_wei TEXT;
ALTER TABLE spend_reservation ADD COLUMN settled_mint_value_wei TEXT;
ALTER TABLE spend_reservation ADD COLUMN settled_l2_execution_gas_wei TEXT;
ALTER TABLE spend_reservation ADD COLUMN settled_l1_data_gas_wei TEXT;
ALTER TABLE spend_reservation ADD COLUMN settled_priority_fee_component_wei TEXT;
ALTER TABLE spend_reservation ADD COLUMN settled_replacement_budget_wei TEXT;

UPDATE spend_reservation SET reserved_amount_wei = amount_wei WHERE reserved_amount_wei = '0';

ALTER TABLE spend_ledger_entry ADD COLUMN component TEXT NOT NULL DEFAULT 'total' CHECK (component IN ('total', 'mint_value', 'l2_execution_gas', 'l1_data_gas', 'priority_fee', 'replacement_budget', 'buffer', 'refund'));
CREATE INDEX idx_reservation_request_identity ON spend_reservation(request_id, request_fingerprint);
CREATE INDEX idx_reservation_intent ON spend_reservation(transaction_intent_id, status);
CREATE INDEX idx_reservation_execution ON spend_reservation(execution_id, status);
CREATE INDEX idx_reservation_reserved_amount ON spend_reservation(wallet_id, usage_date, status, reserved_amount_wei);
CREATE INDEX idx_ledger_reservation_component ON spend_ledger_entry(reservation_id, component, created_at);
