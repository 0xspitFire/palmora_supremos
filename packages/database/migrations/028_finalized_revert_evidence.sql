-- A reverted transaction still has an authoritative Ethereum-final outcome.
-- Retain that finality so L2 gas can settle and a bounded proof can be retried.

DROP TRIGGER receipt_status_finality_guard;

CREATE TRIGGER receipt_status_finality_guard
BEFORE INSERT ON transaction_receipt
WHEN (NEW.finality_stage IN ('posted', 'ethereum_final') AND NEW.status NOT IN ('pending', 'confirmed', 'reverted'))
  OR (NEW.status IN ('reorged', 'dropped') AND NEW.finality_stage IN ('posted', 'ethereum_final'))
  OR (NEW.status = 'reverted' AND NEW.finality_stage = 'posted')
BEGIN SELECT RAISE(ABORT, 'receipt status and finality are inconsistent'); END;
