DROP INDEX IF EXISTS idx_chain_verification_current;
CREATE INDEX idx_chain_verification_history ON chain_verification(chain_profile_id, checked_at DESC);

CREATE TRIGGER campaign_state_domain_insert
BEFORE INSERT ON campaign
WHEN NEW.state NOT IN ('draft', 'validating', 'ready', 'armed', 'paused', 'active', 'completed', 'failed', 'aborted', 'cancelled', 'prepared')
BEGIN SELECT RAISE(ABORT, 'invalid campaign lifecycle state'); END;

CREATE TRIGGER lifecycle_event_entity_domain
BEFORE INSERT ON state_transition
WHEN NEW.entity_type NOT IN ('run', 'execution_run', 'campaign', 'wallet', 'execution', 'transaction_intent', 'transaction_attempt', 'transaction_receipt', 'spend_reservation', 'reconciliation', 'chain_verification', 'opportunity', 'fire_lane', 'eligibility', 'notification', 'simulation', 'audit_event')
BEGIN SELECT RAISE(ABORT, 'invalid lifecycle event entity'); END;

CREATE TRIGGER audit_event_entity_domain
BEFORE INSERT ON audit_event
WHEN NEW.entity_type NOT IN ('run', 'execution_run', 'campaign', 'wallet', 'execution', 'transaction_intent', 'transaction_attempt', 'transaction_receipt', 'reservation', 'spend_reservation', 'reconciliation', 'chain_verification', 'opportunity', 'fire_lane', 'eligibility', 'notification', 'simulation', 'state_transition')
BEGIN SELECT RAISE(ABORT, 'invalid audit event entity'); END;

CREATE TRIGGER campaign_state_domain_update
BEFORE UPDATE OF state ON campaign
WHEN NEW.state NOT IN ('draft', 'validating', 'ready', 'armed', 'paused', 'active', 'completed', 'failed', 'aborted', 'cancelled', 'prepared')
BEGIN SELECT RAISE(ABORT, 'invalid campaign lifecycle state'); END;

CREATE TRIGGER campaign_state_transition_guard
BEFORE UPDATE OF state ON campaign
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'draft' AND NEW.state IN ('validating', 'cancelled')) OR
  (OLD.state = 'validating' AND NEW.state IN ('ready', 'failed', 'cancelled')) OR
  (OLD.state = 'ready' AND NEW.state IN ('armed', 'failed', 'cancelled')) OR
  (OLD.state = 'armed' AND NEW.state IN ('active', 'paused', 'aborted', 'cancelled')) OR
  (OLD.state = 'paused' AND NEW.state IN ('armed', 'aborted', 'cancelled')) OR
  (OLD.state = 'active' AND NEW.state IN ('completed', 'failed', 'aborted')) OR
  (OLD.state = 'prepared' AND NEW.state IN ('validating', 'ready', 'armed', 'active', 'completed', 'failed', 'aborted', 'cancelled')) OR
  (OLD.state IN ('completed', 'failed', 'aborted', 'cancelled') AND NEW.state = OLD.state)
)
BEGIN SELECT RAISE(ABORT, 'invalid campaign lifecycle transition'); END;

CREATE TRIGGER execution_state_domain_insert
BEFORE INSERT ON execution
WHEN NEW.state NOT IN ('prepared', 'signed', 'submitted', 'included', 'posted_to_ethereum', 'ethereum_final', 'confirmed', 'executing', 'minted', 'pending', 'replaced', 'reorged', 'failed', 'dropped', 'aborted', 'skipped', 'killed', 'settled')
BEGIN SELECT RAISE(ABORT, 'invalid execution lifecycle state'); END;

CREATE TRIGGER execution_state_domain_update
BEFORE UPDATE OF state ON execution
WHEN NEW.state NOT IN ('prepared', 'signed', 'submitted', 'included', 'posted_to_ethereum', 'ethereum_final', 'confirmed', 'executing', 'minted', 'pending', 'replaced', 'reorged', 'failed', 'dropped', 'aborted', 'skipped', 'killed', 'settled')
BEGIN SELECT RAISE(ABORT, 'invalid execution lifecycle state'); END;

CREATE TRIGGER execution_state_transition_guard
BEFORE UPDATE OF state ON execution
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state IN ('prepared', 'pending', 'executing') AND NEW.state IN ('signed', 'submitted', 'failed', 'aborted', 'skipped')) OR
  (OLD.state = 'signed' AND NEW.state IN ('submitted', 'failed', 'aborted')) OR
  (OLD.state = 'submitted' AND NEW.state IN ('included', 'posted_to_ethereum', 'ethereum_final', 'confirmed', 'replaced', 'reorged', 'failed', 'dropped', 'aborted')) OR
  (OLD.state = 'included' AND NEW.state IN ('posted_to_ethereum', 'ethereum_final', 'confirmed', 'reorged', 'failed', 'dropped')) OR
  (OLD.state = 'posted_to_ethereum' AND NEW.state IN ('ethereum_final', 'reorged', 'failed')) OR
  (OLD.state IN ('confirmed', 'ethereum_final') AND NEW.state IN ('minted', 'reorged', 'settled')) OR
  (OLD.state = 'minted' AND NEW.state IN ('reorged', 'settled')) OR
  (OLD.state = 'replaced' AND NEW.state IN ('submitted', 'failed', 'dropped')) OR
  (OLD.state = 'reorged' AND NEW.state IN ('submitted', 'failed', 'dropped')) OR
  (OLD.state IN ('failed', 'dropped', 'aborted', 'skipped', 'killed', 'settled', 'minted') AND NEW.state = OLD.state)
)
BEGIN SELECT RAISE(ABORT, 'invalid execution lifecycle transition'); END;

CREATE TRIGGER execution_identity_immutable
BEFORE UPDATE ON execution
WHEN OLD.campaign_id IS NOT NEW.campaign_id
  OR OLD.wallet_id IS NOT NEW.wallet_id
  OR OLD.transaction_intent_id IS NOT NEW.transaction_intent_id
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.request_id IS NOT NEW.request_id
  OR OLD.request_fingerprint IS NOT NEW.request_fingerprint
  OR OLD.reservation_id IS NOT NEW.reservation_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'execution identity is immutable'); END;

CREATE TRIGGER execution_run_identity_immutable
BEFORE UPDATE ON execution_run
WHEN OLD.id IS NOT NEW.id
  OR OLD.request_id IS NOT NEW.request_id
  OR OLD.request_fingerprint IS NOT NEW.request_fingerprint
  OR OLD.campaign_id IS NOT NEW.campaign_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'execution run identity is immutable'); END;

CREATE TRIGGER fire_lane_state_domain_insert
BEFORE INSERT ON fire_lane
WHEN NEW.state NOT IN ('assembling', 'warmed', 'armed', 'firing', 'settled', 'aborted', 'prepared')
BEGIN SELECT RAISE(ABORT, 'invalid fire-lane lifecycle state'); END;

CREATE TRIGGER fire_lane_state_domain_update
BEFORE UPDATE OF state ON fire_lane
WHEN NEW.state NOT IN ('assembling', 'warmed', 'armed', 'firing', 'settled', 'aborted', 'prepared')
BEGIN SELECT RAISE(ABORT, 'invalid fire-lane lifecycle state'); END;

CREATE TRIGGER opportunity_disposition_domain_insert
BEFORE INSERT ON opportunity
WHEN NEW.disposition NOT IN ('discovered', 'new', 'evaluating', 'scored', 'notified', 'approved', 'promoted', 'rejected', 'expired')
BEGIN SELECT RAISE(ABORT, 'invalid opportunity disposition'); END;

CREATE TRIGGER opportunity_disposition_domain_update
BEFORE UPDATE OF disposition ON opportunity
WHEN NEW.disposition NOT IN ('discovered', 'new', 'evaluating', 'scored', 'notified', 'approved', 'promoted', 'rejected', 'expired')
BEGIN SELECT RAISE(ABORT, 'invalid opportunity disposition'); END;

CREATE TRIGGER notification_delivery_domain_insert
BEFORE INSERT ON notification
WHEN NEW.delivery_state NOT IN ('pending', 'queued', 'sent', 'delivered', 'failed', 'dead_letter')
BEGIN SELECT RAISE(ABORT, 'invalid notification delivery state'); END;

CREATE TRIGGER notification_delivery_domain_update
BEFORE UPDATE OF delivery_state ON notification
WHEN NEW.delivery_state NOT IN ('pending', 'queued', 'sent', 'delivered', 'failed', 'dead_letter')
BEGIN SELECT RAISE(ABORT, 'invalid notification delivery state'); END;

CREATE TRIGGER eligibility_lifecycle_domain_insert
BEFORE INSERT ON eligibility
WHEN NEW.lifecycle_state NOT IN ('unknown', 'unfunded', 'funded', 'eligible', 'ready', 'executing', 'minted', 'failed', 'skipped')
BEGIN SELECT RAISE(ABORT, 'invalid eligibility lifecycle state'); END;

CREATE TRIGGER eligibility_lifecycle_domain_update
BEFORE UPDATE OF lifecycle_state ON eligibility
WHEN NEW.lifecycle_state NOT IN ('unknown', 'unfunded', 'funded', 'eligible', 'ready', 'executing', 'minted', 'failed', 'skipped')
BEGIN SELECT RAISE(ABORT, 'invalid eligibility lifecycle state'); END;

CREATE TRIGGER transaction_attempt_append_only_update
BEFORE UPDATE ON transaction_attempt
BEGIN SELECT RAISE(ABORT, 'transaction attempts are append-only'); END;

CREATE TRIGGER transaction_attempt_append_only_delete
BEFORE DELETE ON transaction_attempt
BEGIN SELECT RAISE(ABORT, 'transaction attempts are append-only'); END;

CREATE TRIGGER transaction_receipt_append_only_update
BEFORE UPDATE ON transaction_receipt
BEGIN SELECT RAISE(ABORT, 'transaction receipts are append-only'); END;

CREATE TRIGGER transaction_receipt_append_only_delete
BEFORE DELETE ON transaction_receipt
BEGIN SELECT RAISE(ABORT, 'transaction receipts are append-only'); END;

CREATE TRIGGER simulation_append_only_update
BEFORE UPDATE ON simulation
BEGIN SELECT RAISE(ABORT, 'simulations are append-only'); END;

CREATE TRIGGER simulation_append_only_delete
BEFORE DELETE ON simulation
BEGIN SELECT RAISE(ABORT, 'simulations are append-only'); END;

CREATE TRIGGER reconciliation_append_only_update
BEFORE UPDATE ON reconciliation_record
BEGIN SELECT RAISE(ABORT, 'reconciliation records are append-only'); END;

CREATE TRIGGER reconciliation_append_only_delete
BEFORE DELETE ON reconciliation_record
BEGIN SELECT RAISE(ABORT, 'reconciliation records are append-only'); END;

CREATE TRIGGER reorg_event_append_only_update
BEFORE UPDATE ON reorg_event
BEGIN SELECT RAISE(ABORT, 'reorg events are append-only'); END;

CREATE TRIGGER reorg_event_append_only_delete
BEFORE DELETE ON reorg_event
BEGIN SELECT RAISE(ABORT, 'reorg events are append-only'); END;

CREATE TRIGGER ledger_entry_append_only_update
BEFORE UPDATE ON spend_ledger_entry
BEGIN SELECT RAISE(ABORT, 'spend ledger entries are append-only'); END;

CREATE TRIGGER ledger_entry_append_only_delete
BEFORE DELETE ON spend_ledger_entry
BEGIN SELECT RAISE(ABORT, 'spend ledger entries are append-only'); END;

CREATE TRIGGER chain_verification_append_only_update
BEFORE UPDATE ON chain_verification
BEGIN SELECT RAISE(ABORT, 'chain verification evidence is append-only'); END;

CREATE TRIGGER chain_verification_append_only_delete
BEFORE DELETE ON chain_verification
BEGIN SELECT RAISE(ABORT, 'chain verification evidence is append-only'); END;

CREATE TRIGGER documentation_fixture_append_only_update
BEFORE UPDATE ON documentation_fixture
BEGIN SELECT RAISE(ABORT, 'documentation fixtures are append-only'); END;

CREATE TRIGGER documentation_fixture_append_only_delete
BEFORE DELETE ON documentation_fixture
BEGIN SELECT RAISE(ABORT, 'documentation fixtures are append-only'); END;

CREATE TRIGGER backup_evidence_append_only_update
BEFORE UPDATE ON backup_restore_evidence
BEGIN SELECT RAISE(ABORT, 'backup evidence is append-only'); END;

CREATE TRIGGER backup_evidence_append_only_delete
BEFORE DELETE ON backup_restore_evidence
BEGIN SELECT RAISE(ABORT, 'backup evidence is append-only'); END;

CREATE TRIGGER transaction_attempt_identity_guard
BEFORE INSERT ON transaction_attempt
WHEN NEW.from_address IS NOT NULL AND lower(NEW.from_address) <> lower((SELECT w.address FROM wallet w JOIN transaction_intent i ON i.wallet_id = w.id WHERE i.id = NEW.transaction_intent_id))
BEGIN SELECT RAISE(ABORT, 'transaction attempt sender does not match wallet'); END;

CREATE TRIGGER transaction_receipt_intent_guard
BEFORE INSERT ON transaction_receipt
WHEN (SELECT tx_hash FROM transaction_attempt WHERE id = NEW.transaction_attempt_id) IS NOT NULL
  AND lower(NEW.tx_hash) <> lower((SELECT tx_hash FROM transaction_attempt WHERE id = NEW.transaction_attempt_id))
BEGIN SELECT RAISE(ABORT, 'receipt hash does not match transaction attempt'); END;

CREATE TRIGGER transaction_intent_wallet_chain_guard
BEFORE INSERT ON transaction_intent
WHEN NEW.chain_profile_id IS NOT NULL AND NEW.chain_profile_id <> (SELECT chain_profile_id FROM wallet WHERE id = NEW.wallet_id)
BEGIN SELECT RAISE(ABORT, 'transaction intent chain does not match wallet'); END;

CREATE TRIGGER transaction_intent_sender_guard
BEFORE INSERT ON transaction_intent
WHEN NEW.from_address IS NOT NULL AND lower(NEW.from_address) <> lower((SELECT address FROM wallet WHERE id = NEW.wallet_id))
BEGIN SELECT RAISE(ABORT, 'transaction intent sender does not match wallet'); END;

CREATE TRIGGER execution_link_guard
BEFORE INSERT ON execution
WHEN NOT EXISTS (SELECT 1 FROM transaction_intent i WHERE i.id = NEW.transaction_intent_id AND i.campaign_id = NEW.campaign_id AND i.wallet_id = NEW.wallet_id)
BEGIN SELECT RAISE(ABORT, 'execution does not match transaction intent'); END;

CREATE TRIGGER execution_reservation_link_guard
BEFORE INSERT ON execution
WHEN NEW.reservation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spend_reservation r WHERE r.id = NEW.reservation_id AND r.wallet_id = NEW.wallet_id AND (r.execution_id IS NULL OR r.execution_id = NEW.id))
BEGIN SELECT RAISE(ABORT, 'execution does not match spend reservation'); END;

CREATE TRIGGER attempt_execution_link_guard
BEFORE INSERT ON transaction_attempt
WHEN NEW.execution_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM execution e WHERE e.id = NEW.execution_id AND e.transaction_intent_id = NEW.transaction_intent_id)
BEGIN SELECT RAISE(ABORT, 'transaction attempt does not match execution'); END;

CREATE TRIGGER receipt_execution_link_guard
BEFORE INSERT ON transaction_receipt
WHEN NEW.execution_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transaction_attempt a WHERE a.id = NEW.transaction_attempt_id AND a.execution_id = NEW.execution_id)
BEGIN SELECT RAISE(ABORT, 'receipt does not match execution'); END;

CREATE TRIGGER reconciliation_execution_link_guard
BEFORE INSERT ON reconciliation_record
WHEN NEW.execution_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transaction_attempt a WHERE a.id = NEW.transaction_attempt_id AND a.execution_id = NEW.execution_id)
BEGIN SELECT RAISE(ABORT, 'reconciliation does not match execution'); END;

CREATE TRIGGER reservation_link_guard
BEFORE INSERT ON spend_reservation
WHEN NEW.transaction_intent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transaction_intent i WHERE i.id = NEW.transaction_intent_id AND i.wallet_id = NEW.wallet_id)
BEGIN SELECT RAISE(ABORT, 'reservation does not match transaction intent'); END;

CREATE TRIGGER reservation_identity_immutable
BEFORE UPDATE ON spend_reservation
WHEN OLD.wallet_id IS NOT NEW.wallet_id
  OR OLD.execution_id IS NOT NEW.execution_id
  OR OLD.transaction_intent_id IS NOT NEW.transaction_intent_id
  OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.request_id IS NOT NEW.request_id
  OR OLD.request_fingerprint IS NOT NEW.request_fingerprint
  OR OLD.usage_date IS NOT NEW.usage_date
  OR OLD.reserved_amount_wei IS NOT NEW.reserved_amount_wei
  OR OLD.replacement_budget_wei IS NOT NEW.replacement_budget_wei
  OR OLD.mint_value_buffer_wei IS NOT NEW.mint_value_buffer_wei
  OR OLD.l2_execution_gas_buffer_wei IS NOT NEW.l2_execution_gas_buffer_wei
  OR OLD.l1_data_gas_buffer_wei IS NOT NEW.l1_data_gas_buffer_wei
OR OLD.priority_fee_buffer_wei IS NOT NEW.priority_fee_buffer_wei
BEGIN SELECT RAISE(ABORT, 'reservation authorization is immutable'); END;

CREATE TRIGGER reservation_all_in_amount_guard
BEFORE UPDATE OF amount_wei, status ON spend_reservation
WHEN length(CASE WHEN ltrim(NEW.amount_wei, '0') = '' THEN '0' ELSE ltrim(NEW.amount_wei, '0') END) > length(CASE WHEN ltrim(NEW.reserved_amount_wei, '0') = '' THEN '0' ELSE ltrim(NEW.reserved_amount_wei, '0') END)
  OR (length(CASE WHEN ltrim(NEW.amount_wei, '0') = '' THEN '0' ELSE ltrim(NEW.amount_wei, '0') END) = length(CASE WHEN ltrim(NEW.reserved_amount_wei, '0') = '' THEN '0' ELSE ltrim(NEW.reserved_amount_wei, '0') END)
      AND CASE WHEN ltrim(NEW.amount_wei, '0') = '' THEN '0' ELSE ltrim(NEW.amount_wei, '0') END > CASE WHEN ltrim(NEW.reserved_amount_wei, '0') = '' THEN '0' ELSE ltrim(NEW.reserved_amount_wei, '0') END)
BEGIN SELECT RAISE(ABORT, 'settled amount exceeds all-in reservation'); END;

CREATE TRIGGER reservation_settlement_evidence_guard
BEFORE UPDATE OF status ON spend_reservation
WHEN NEW.status = 'settled' AND NEW.settled_amount_wei IS NULL
BEGIN SELECT RAISE(ABORT, 'settled reservation requires component evidence'); END;
