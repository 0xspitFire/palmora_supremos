-- A later pending receipt supersedes older reconciliation evidence. Settlement
-- authority is determined across both evidence streams by observation time.

DROP TRIGGER reservation_settlement_finality_guard;

CREATE TRIGGER reservation_settlement_finality_guard
BEFORE UPDATE OF status ON spend_reservation
WHEN NEW.status = 'settled'
  AND NEW.execution_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM transaction_receipt r
      JOIN transaction_attempt a ON a.id = r.transaction_attempt_id
      JOIN transaction_intent i ON i.id = a.transaction_intent_id
      JOIN wallet w ON w.id = i.wallet_id
      JOIN chain_profile c ON c.id = w.chain_profile_id
     WHERE a.execution_id = NEW.execution_id
       AND r.status = 'confirmed'
       AND r.finality_stage = c.success_finality_stage
       AND c.execution_enabled = 1
       AND r.id = (SELECT r2.id FROM transaction_receipt r2 JOIN transaction_attempt a2 ON a2.id = r2.transaction_attempt_id WHERE a2.execution_id = NEW.execution_id ORDER BY r2.observed_at DESC, r2.id DESC LIMIT 1)
  )
  AND NOT EXISTS (
    SELECT 1
      FROM transaction_receipt r
      JOIN transaction_attempt a ON a.id = r.transaction_attempt_id
     WHERE a.execution_id = NEW.execution_id
       AND r.status IN ('reverted', 'dropped', 'reorged')
       AND r.id = (SELECT r2.id FROM transaction_receipt r2 JOIN transaction_attempt a2 ON a2.id = r2.transaction_attempt_id WHERE a2.execution_id = NEW.execution_id ORDER BY r2.observed_at DESC, r2.id DESC LIMIT 1)
  )
  AND NOT EXISTS (
    SELECT 1 FROM reconciliation_record rr
     WHERE rr.execution_id = NEW.execution_id
       AND rr.state IN ('final', 'reorged')
       AND rr.id = (SELECT rr2.id FROM reconciliation_record rr2 WHERE rr2.execution_id = NEW.execution_id ORDER BY rr2.checked_at DESC, rr2.id DESC LIMIT 1)
       AND NOT EXISTS (
         SELECT 1
           FROM transaction_receipt later_receipt
           JOIN transaction_attempt later_attempt ON later_attempt.id = later_receipt.transaction_attempt_id
          WHERE later_attempt.execution_id = NEW.execution_id
            AND later_receipt.observed_at > rr.checked_at
       )
  )
BEGIN SELECT RAISE(ABORT, 'settlement requires latest authoritative finality or reconciliation'); END;
