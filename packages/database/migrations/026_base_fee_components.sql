ALTER TABLE transaction_receipt ADD COLUMN l1_data_fee_wei TEXT
  CHECK (l1_data_fee_wei IS NULL OR (l1_data_fee_wei <> '' AND l1_data_fee_wei NOT GLOB '*[^0-9]*'));

ALTER TABLE transaction_receipt ADD COLUMN operator_fee_wei TEXT
  CHECK (operator_fee_wei IS NULL OR (operator_fee_wei <> '' AND operator_fee_wei NOT GLOB '*[^0-9]*'));
